import { createHash, randomUUID } from "node:crypto";
import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { chatTitle } from "./chat-title.ts";
import { DEMO_PAGE_COUNT, readDemoPage, type DemoPage } from "./demo-source.ts";
import { createChatAgent, createCourseAgent, createDemoAgent, DEFAULT_MODEL } from "./agents.ts";
import type { SessionFocus, SessionLease, SessionRecord, SessionStore } from "./session-store.ts";
import type { Thinking } from "./desktop/api.ts";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  modelContextMessages,
  validateTranscript,
  type SummaryMark,
  type TrimMark,
} from "./transcript.ts";

export const DEMO_SOURCE_VERSION = createHash("sha256")
  .update(
    JSON.stringify(
      Array.from({ length: DEMO_PAGE_COUNT }, (_, i) =>
        readDemoPage({ courseId: "demo", page: i + 1 }),
      ),
    ),
  )
  .digest("hex");

/**
 * "demo": the CLI tutor over the synthetic course. "chat": a plain chat with no tools.
 * "course": a chat that reads one course from the student's library.
 * "library": a chat that may read any course in the library and works out which one is meant.
 */
export type ConversationKind = "demo" | "chat" | "course" | "library";

/** What a course chat may do, built by the app for one course and enforced in its tools. */
export interface CourseRuntime {
  tools: AgentTool[];
  /**
   * The app's prompt, installed before every request. It stays the same from turn to turn, so
   * the provider can reuse the start of the request; what changes per question (the page being
   * read, what was added) travels on the student's message instead.
   */
  prompt(): Promise<string>;
  /** Throws unless the document belongs to this course and the page exists. */
  checkFocus(focus: SessionFocus): Promise<FocusAbout>;
}

/** What the tutor is told about a page the student is reading. */
export interface FocusAbout {
  title: string;
  pages: number;
}

/**
 * The page a course chat's student was reading when they asked, recorded on their message at
 * send time (null: not reading). The title is kept as it was then, so renaming the document later
 * never changes what earlier questions said.
 */
export type FocusSnapshot = { v: 1; documentId: string; page: number } & FocusAbout;

export interface OpenConversationOptions {
  store: SessionStore;
  id?: string;
  newSession?: boolean;
  /** The kind of a new chat, and the kind a resumed chat must have. Defaults to "demo" for new chats. */
  kind?: ConversationKind;
  /** Resumable kinds when they differ from `kind` (the desktop app opens plain and course chats). */
  allowedKinds?: ConversationKind[];
  /** A new course chat's course and starting page. */
  courseId?: string;
  focus?: SessionFocus | null;
  /**
   * Builds a course chat's tools and prompt; required to open course chats. `grants` reads what
   * the student has added to the chat so far, so the tools follow it as the chat goes on.
   */
  courseRuntime?: (
    courseId: string,
    chatId: string,
    grants: () => Grants,
  ) => Promise<CourseRuntime>;
  /** Builds a library chat's tools and prompt; required to open library chats. */
  libraryRuntime?: (chatId: string) => Promise<CourseRuntime>;
  modelId?: string;
  streamFn: StreamFn;
  resolveModel: (id: string) => Model<Api>;
}

/**
 * What the student added to a question with the composer's +, recorded on their own message by
 * Folio. The model never writes user messages, so it cannot add to these.
 */
export type Attachment =
  | { kind: "page"; documentId: string; page: number }
  /** The student's own image; `thumbnail` is a small base64 JPEG for the chat. */
  | { kind: "image"; name: string; thumbnail: string }
  | { kind: "document"; documentId: string }
  | { kind: "course"; courseId: string };

/** Courses and documents the student added to a chat, which it may read from then on. */
export interface Grants {
  courses: string[];
  documents: string[];
}

/** Past this share of the model's context, earlier tool results reach it as short notes. */
const STUB_AT = 0.25;
/** Past this share even so, the chat so far is summarized for the model. */
const SUMMARY_AT = 0.6;
/** The most recent questions whose tool results always reach the model whole. */
const KEEP_TURNS = 4;

const SUMMARY_PROMPT = [
  "You are summarizing a tutoring chat for yourself, so you can go on teaching from the summary instead of the full history.",
  "Keep: what the student asked and is working on now; the course material discussed, with each citation (title and page) and section handle; standing requests about pace, quizzes, language or format, which still hold; questions still open; and visuals or notes you made, by title.",
  "Do not judge what the student understands, knows or has mastered; say only what was discussed and asked.",
  "Write compact notes in the chat's language, under 500 words. Do not address the student.",
].join("\n");

type SubmittedMessage = UserMessage & {
  folioSubmissionId: string;
  folioTrim?: TrimMark;
  folioSummary?: SummaryMark;
  /** Chats saved before attachments: the page in view, sent with the question as an image. */
  folioPage?: SessionFocus & { documentId: string };
  folioAttachments?: Attachment[];
  folioFocus?: FocusSnapshot | null;
};

/** What can go with a question besides its text. */
export interface SendExtras {
  /** What the student added, each with what the tutor is told and, for pages and images, the image. */
  attachments?: { attachment: Attachment; note: string; image?: ImageContent }[];
  /** A course chat's page in view as the question is sent; null when no document is open. */
  focus?: SessionFocus | null;
  /** How long the tutor thinks about this question and the requests that answer it. */
  thinking?: Thinking;
}

/** Every course and document the student added in a chat, read from their own messages only. */
export function grantsOf(messages: readonly unknown[]): Grants {
  const courses = new Set<string>();
  const documents = new Set<string>();
  for (const message of messages as SubmittedMessage[]) {
    if (message.role !== "user") continue;
    for (const attachment of message.folioAttachments ?? []) {
      if (attachment.kind === "course") courses.add(attachment.courseId);
      else if (attachment.kind === "document") documents.add(attachment.documentId);
    }
  }
  return { courses: [...courses], documents: [...documents] };
}

/** The text the student typed, whatever else went with it. */
export function questionText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return (
    (message.content.find((block) => block.type === "text") as TextContent | undefined)?.text ?? ""
  );
}

export function kindOf(record: Pick<SessionRecord, "scope">): ConversationKind {
  const { scope } = record;
  if (scope.courseId === null) return "library" in scope ? "library" : "chat";
  return "library" in scope ? "course" : "demo";
}

const WRONG_KIND: Record<ConversationKind, string> = {
  demo: "This saved conversation is a course tutoring chat. Open it from the terminal.",
  chat: "This saved conversation is a plain chat without course pages.",
  course: "This saved conversation belongs to a course. Open it from the desktop app.",
  library: "This saved conversation reads your course library. Open it from the desktop app.",
};
type Listener = (event: AgentEvent) => void | Promise<void>;

/** Saved conversation lifecycle shared by the CLI and a future desktop UI. */
export class Conversation {
  readonly resumed: boolean;
  readonly #store: SessionStore;
  readonly #lease: SessionLease;
  readonly #options: OpenConversationOptions;
  readonly #runtime?: CourseRuntime;
  readonly #listeners = new Set<Listener>();
  #record: SessionRecord;
  #agent: Agent;
  #closed = false;
  #saveError: unknown;
  #run?: Promise<void>;
  #submissionId?: string;
  #submissionText?: string;
  #cancelRequested = false;
  #partialSavedAt = 0;
  #summaryAbort?: AbortController;

  private constructor(
    options: OpenConversationOptions,
    record: SessionRecord,
    lease: SessionLease,
    resumed: boolean,
    runtime?: CourseRuntime,
  ) {
    this.#options = options;
    this.#runtime = runtime;
    this.#store = options.store;
    this.#record = record;
    this.#lease = lease;
    this.resumed = resumed;
    this.#agent = this.#makeAgent();
  }

  static async open(options: OpenConversationOptions): Promise<Conversation> {
    if (options.newSession && options.id)
      throw new Error("Choose a new chat or a saved chat, not both.");
    let record = options.newSession
      ? undefined
      : options.id
        ? await options.store.load(options.id)
        : await options.store.latest();
    const resumed = record !== undefined;
    if (!record) {
      const model = options.resolveModel(options.modelId ?? DEFAULT_MODEL);
      if (options.kind === "course" && !options.courseId)
        throw new Error("A course chat needs a course.");
      record = await options.store.create(
        options.kind === "chat"
          ? { modelId: model.id, scope: { courseId: null }, focus: null }
          : options.kind === "library"
            ? { modelId: model.id, scope: { courseId: null, library: 1 }, focus: null }
            : options.kind === "course"
              ? {
                  modelId: model.id,
                  scope: { courseId: options.courseId!, library: 1 },
                  focus: options.focus ?? null,
                }
              : {
                  modelId: model.id,
                  scope: { courseId: "demo", sourceVersion: DEMO_SOURCE_VERSION },
                  focus: { page: 1 },
                },
      );
    }
    const lease = await options.store.lockSession(record.id);
    try {
      record = await options.store.load(record.id);
      if (
        record.runtime.name !== "pi" ||
        record.runtime.version !== "1.4.0" ||
        record.runtime.transcriptVersion !== 1
      ) {
        throw new Error(
          "This chat uses an unsupported runtime format. Start a new chat; the saved file was preserved.",
        );
      }
      const kind = kindOf(record);
      const allowed = options.allowedKinds ?? (options.kind ? [options.kind] : undefined);
      if (allowed && !allowed.includes(kind)) throw new Error(WRONG_KIND[kind]);
      if (
        kind === "demo" &&
        (!("sourceVersion" in record.scope) || record.scope.sourceVersion !== DEMO_SOURCE_VERSION)
      ) {
        throw new Error(
          "This chat's source scope or version is unavailable. Start a new chat; the saved file was preserved.",
        );
      }
      if (record.provider !== "openai") throw new Error("This saved provider is unsupported.");
      if (options.modelId && record.modelId !== options.modelId) {
        throw new Error(
          "This chat uses a different model. Resume without --model, or use --new to choose another.",
        );
      }
      if (kind === "demo") readDemoPage({ courseId: "demo", page: record.focus?.page });
      let runtime: CourseRuntime | undefined;
      let conversation: Conversation | undefined;
      const opened = record;
      if (kind === "course") {
        if (!options.courseRuntime) throw new Error(WRONG_KIND.course);
        runtime = await options.courseRuntime(record.scope.courseId!, record.id, () =>
          conversation ? conversation.grants() : grantsOf(opened.messages),
        );
        // A document that moved or left the course no longer anchors this chat.
        if (record.focus)
          await runtime.checkFocus(record.focus).catch(() => (record!.focus = null));
      } else if (kind === "library") {
        if (!options.libraryRuntime) throw new Error(WRONG_KIND.library);
        runtime = await options.libraryRuntime(record.id);
      }
      validateTranscript(record.messages);
      conversation = new Conversation(options, record, lease, resumed, runtime);
      if (record.status === "running") {
        const partial = record.partialAssistant;
        if (partial)
          conversation.#agent.state.messages = [
            ...conversation.#agent.state.messages,
            {
              ...partial,
              stopReason: "aborted",
              errorMessage: "This reply was interrupted when Folio closed.",
            },
          ];
        conversation.#record.status = "interrupted";
        conversation.#record.activeRun = undefined;
        conversation.#record.partialAssistant = undefined;
      }
      // Opening a chosen chat makes it the latest active conversation and saves
      // the current application-owned prompt; it never starts model work.
      await conversation.#checkpoint();
      return conversation;
    } catch (error) {
      await lease();
      throw error;
    }
  }

  get snapshot(): SessionRecord {
    return structuredClone(this.#record);
  }

  get kind(): ConversationKind {
    return kindOf(this.#record);
  }

  /** A course chat's course; null for library and plain chats. */
  get courseId(): string | null {
    const { courseId } = this.#record.scope;
    return courseId && courseId !== "demo" ? courseId : null;
  }

  /** The courses and documents the student has added to this chat. */
  grants(): Grants {
    return grantsOf(this.#record.messages);
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #makeAgent(): Agent {
    const model = this.#options.resolveModel(this.#record.modelId);
    const runtime = this.#runtime;
    const agent = runtime
      ? createCourseAgent(model, this.#options.streamFn, {
          messages: this.#record.messages,
          sessionId: this.#record.id,
          tools: runtime.tools,
          prompt: () => runtime.prompt(),
        })
      : this.#record.focus === null
        ? createChatAgent(model, this.#options.streamFn, {
            messages: this.#record.messages,
            sessionId: this.#record.id,
          })
        : createDemoAgent(model, this.#options.streamFn, {
            messages: this.#record.messages,
            focusPage: this.#record.focus.page,
            getFocusPage: () => this.#record.focus?.page ?? 1,
            sessionId: this.#record.id,
          });
    agent.subscribe(async (event) => {
      // No writes after an autosave conflict/failure, including Pi's failure events.
      if (!this.#saveError) {
        try {
          if (event.type === "message_end") {
            this.#record.partialAssistant = undefined;
            await this.#checkpoint();
          } else if (
            event.type === "message_update" &&
            // A long tool call (a demo being written) is saved less often: each save writes the
            // whole chat.
            Date.now() - this.#partialSavedAt >=
              (event.assistantMessageEvent.type.startsWith("toolcall") ? 2000 : 250)
          ) {
            this.#record.partialAssistant = structuredClone(event.message as AssistantMessage);
            this.#partialSavedAt = Date.now();
            await this.#checkpoint();
          } else if (
            event.type === "tool_execution_end" &&
            event.toolName === "read_demo_page" &&
            !event.isError
          ) {
            const details = event.result.details as DemoPage;
            const page = readDemoPage({ courseId: details.courseId, page: details.page });
            this.#record.focus = { page: page.page };
          }
        } catch (error) {
          this.#saveError = error;
          agent.abort();
          throw error;
        }
      }
      for (const listener of this.#listeners) await listener(event);
    });
    return agent;
  }

  async #checkpoint(): Promise<void> {
    this.#record = await this.#store.save(
      { ...this.#record, messages: structuredClone(this.#agent.state.messages) },
      this.#record.revision,
      this.#lease,
    );
  }

  /** An optional stable submission ID makes a repeated UI delivery a no-op. */
  send(text: string, submissionId: string = randomUUID(), extras: SendExtras = {}): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("This chat is closed."));
    if (this.#saveError) return Promise.reject(this.#saveError);
    if (!text.trim()) return Promise.reject(new Error("Enter a message first."));
    if (this.#run) {
      if (this.#submissionId === submissionId && this.#submissionText !== text) {
        return Promise.reject(
          new Error("This submission ID was already used for a different message."),
        );
      }
      return this.#submissionId === submissionId
        ? this.#run
        : Promise.reject(new Error("A reply is already running."));
    }
    const duplicate = this.#record.messages.find(
      (message) =>
        message.role === "user" && (message as SubmittedMessage).folioSubmissionId === submissionId,
    );
    if (duplicate) {
      return questionText(duplicate as UserMessage) === text
        ? Promise.resolve()
        : Promise.reject(new Error("This submission ID was already used for a different message."));
    }
    this.#submissionId = submissionId;
    this.#submissionText = text;
    this.#cancelRequested = false;
    this.#partialSavedAt = 0;
    this.#run = this.#send(text, submissionId, extras).finally(() => {
      this.#run = undefined;
      this.#submissionId = undefined;
      this.#submissionText = undefined;
    });
    return this.#run;
  }

  async #send(text: string, submissionId: string, extras: SendExtras): Promise<void> {
    const added = extras.attachments ?? [];
    const focus = await this.#focusSnapshot(extras.focus);
    // The typed text stays first, so the chat shows only what the student wrote.
    const input: SubmittedMessage = {
      role: "user",
      content: added.length
        ? [
            { type: "text", text },
            {
              type: "text",
              text: `[Added by the student: ${added.map((item) => item.note).join("; ")}]`,
            },
            ...added.flatMap((item) => (item.image ? [item.image] : [])),
          ]
        : text,
      timestamp: Date.now(),
      folioSubmissionId: submissionId,
      ...(added.length ? { folioAttachments: added.map((item) => item.attachment) } : {}),
      ...(focus !== undefined ? { folioFocus: focus } : {}),
      ...(extras.thinking ? { folioThinking: extras.thinking } : {}),
    };
    if (extras.thinking) this.#agent.state.thinkingLevel = extras.thinking;
    const summarize = this.#trim(input);
    if (focus !== undefined)
      this.#record.focus = focus ? { documentId: focus.documentId, page: focus.page } : null;
    if (!this.#record.messages.some((message) => message.role === "user"))
      this.#record.title = chatTitle(text);
    this.#record.status = "running";
    this.#record.partialAssistant = undefined;
    this.#record.activeRun = {
      id: submissionId,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };
    // Commit accepted input before starting a provider request. Agent.prompt will
    // append this exact message once; a crash here cannot silently lose it.
    try {
      this.#record = await this.#store.save(
        { ...this.#record, messages: [...this.#agent.state.messages, input] },
        this.#record.revision,
        this.#lease,
      );
      // A chat near the model's limit is summarized first; without a summary, it goes on as is.
      const summary = summarize ? await this.#summary(this.#agent.state.messages) : null;
      if (summary && !this.#cancelRequested)
        this.#agent.state.messages = [...this.#agent.state.messages, summary];
      if (this.#cancelRequested) this.#agent.state.messages = this.#record.messages;
      else await this.#agent.prompt(input);
    } catch (error) {
      if (!this.#saveError) this.#saveError = error;
    }
    if (this.#saveError) throw this.#saveError;
    const last = this.#agent.state.messages.findLast((message) => message.role === "assistant");
    const stopReason = last?.role === "assistant" ? last.stopReason : undefined;
    this.#record.status =
      this.#cancelRequested || stopReason === "aborted"
        ? "interrupted"
        : stopReason === "error"
          ? "error"
          : "idle";
    this.#record.activeRun = undefined;
    this.#record.partialAssistant = undefined;
    try {
      await this.#checkpoint();
    } catch (error) {
      this.#saveError = error;
      throw error;
    }
    if (this.#record.status === "error")
      throw new Error(
        last?.role === "assistant"
          ? (last.errorMessage ?? "Provider request failed.")
          : "Provider request failed.",
      );
  }

  /**
   * The page a course chat's question was asked from, checked against the course. A page that
   * is no longer readable (the document moved or was removed) counts as not reading.
   */
  async #focusSnapshot(
    focus: SessionFocus | null | undefined,
  ): Promise<FocusSnapshot | null | undefined> {
    if (focus === undefined || this.kind !== "course" || !this.#runtime) return undefined;
    if (!focus?.documentId) return null;
    const { documentId, page } = focus;
    return this.#runtime.checkFocus(focus).then(
      (about) => ({ v: 1, documentId, page, title: about.title, pages: about.pages }),
      () => null,
    );
  }

  /**
   * Decides, once, as a question is sent, how much of a long chat reaches the model whole. Past
   * a quarter of the model's context, tool results before the last few questions are shortened
   * (recorded on the question, so the cut only moves forward and reopening sends the same).
   * Returns whether the chat is still too long, so it should be summarized.
   */
  #trim(input: SubmittedMessage): boolean {
    const window = this.#options.resolveModel(this.#record.modelId).contextWindow;
    if (!this.#runtime || !window) return false;
    const messages = this.#agent.state.messages;
    const size = () =>
      modelContextMessages([...messages, input]).reduce(
        (sum, message) => sum + estimateMessageTokens(message),
        0,
      );
    if (size() > STUB_AT * window) {
      const questions = messages.flatMap((message, index) =>
        message.role === "user" && !(message as SubmittedMessage).folioSummary ? [index] : [],
      );
      const boundary = questions.length >= KEEP_TURNS ? questions.at(-KEEP_TURNS)! : 0;
      const before = Math.max(
        0,
        ...messages.map((message) => (message as SubmittedMessage).folioTrim?.stubBefore ?? 0),
      );
      if (boundary > before) input.folioTrim = { v: 1, stubBefore: boundary };
    }
    return size() > SUMMARY_AT * window;
  }

  /**
   * One request for a summary of the chat so far, saved as a message of Folio's just before the
   * question that needed it. Which courses and documents the student added is restated by
   * Folio, not by the model. Null when the request fails or the student stops the reply.
   */
  async #summary(messages: AgentMessage[]): Promise<AgentMessage | null> {
    const model = this.#options.resolveModel(this.#record.modelId);
    const controller = new AbortController();
    this.#summaryAbort = controller;
    try {
      const stream = await this.#options.streamFn(
        model,
        normalizeContext({
          systemPrompt: SUMMARY_PROMPT,
          messages: [
            ...modelContextMessages(messages).filter((message) => message.role !== "system"),
            {
              role: "user",
              content: "Summarize this chat as instructed.",
              timestamp: Date.now(),
            },
          ],
        }),
        { signal: controller.signal, sessionId: this.#record.id },
      );
      let text = "";
      for await (const event of stream) {
        if (event.type === "error") return null;
        if (event.type === "done")
          text = event.message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n\n");
      }
      if (!text.trim() || controller.signal.aborted) return null;
      const grants = grantsOf(messages);
      const added = [
        ...grants.courses.map((id) => `the course ${id}`),
        ...grants.documents.map((id) => `the document ${id}`),
      ];
      const summary = {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `<folio_summary>\nFolio's summary of the chat so far; earlier messages are not sent again.\n\n${text.trim()}${added.length ? `\n\nThe student added ${added.join(", ")} to this chat; they can still be read.` : ""}\n</folio_summary>`,
          },
        ],
        timestamp: Date.now(),
        folioSummary: {
          v: 1 as const,
          covers: messages.length,
          model: model.id,
          createdAt: new Date().toISOString(),
        },
      };
      return summary as AgentMessage;
    } catch {
      return null;
    } finally {
      this.#summaryAbort = undefined;
    }
  }

  cancel(): void {
    this.#cancelRequested = true;
    this.#summaryAbort?.abort();
    this.#agent.abort();
  }

  async setFocus(page: number): Promise<DemoPage> {
    if (this.kind !== "demo") throw new Error("This chat has no course pages.");
    if (this.#closed || this.#run) throw new Error("Change pages after the current reply settles.");
    if (this.#saveError) throw this.#saveError;
    const source = readDemoPage({ courseId: this.#record.scope.courseId, page });
    this.#record.focus = { page: source.page };
    try {
      await this.#checkpoint();
    } catch (error) {
      this.#saveError = error;
      throw error;
    }
    this.#agent = this.#makeAgent();
    return source;
  }

  /** Course chats remember the page the student is reading, so a reopened chat starts there. */
  async setCourseFocus(focus: SessionFocus | null): Promise<void> {
    if (!this.#runtime) throw new Error("Only course chats follow a document.");
    if (this.#closed) throw new Error("This chat is closed.");
    if (this.#saveError) throw this.#saveError;
    if (focus) await this.#runtime.checkFocus(focus);
    this.#record.focus = focus ? { documentId: focus.documentId, page: focus.page } : null;
    // During a reply the next autosave carries it; otherwise save now.
    if (this.#run) return;
    try {
      await this.#checkpoint();
    } catch (error) {
      this.#saveError = error;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.cancel();
    try {
      await this.#run;
    } finally {
      await this.#lease();
      this.#listeners.clear();
    }
  }
}
