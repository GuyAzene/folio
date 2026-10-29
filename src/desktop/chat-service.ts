import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Conversation, type CourseRuntime } from "../conversation.ts";
import type { AttachReach, ResolvedAttachment } from "../library/attachments.ts";
import { MAX_IMAGE_BYTES } from "../library/images.ts";
import type { SessionStore } from "../session-store.ts";
import {
  THINKING_LEVELS,
  type AttachmentInput,
  type ChatSummary,
  type ChatView,
  type DesktopEvent,
  type Focus,
  type SendInput,
  type Thinking,
} from "./api.ts";
import { chatSummaries, chatView, visibleText, visualView } from "./view.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 100_000;
const MAX_ATTACHMENTS = 8;
const MAX_IMAGES = 4;

export interface ChatServiceOptions {
  store: SessionStore;
  streamFn: StreamFn;
  resolveModel: (id: string) => Model<Api>;
  /** The model for new chats unless the student picks another. */
  modelId: string;
  /** Models a new chat may use; defaults to just `modelId`. */
  models?: readonly string[];
  connected: () => Promise<boolean>;
  emit: (event: DesktopEvent) => void;
  /** Builds a course chat's tools; without it, only plain chats are available. */
  courseRuntime?: (
    courseId: string,
    chatId: string,
    grants: () => { courses: string[]; documents: string[] },
  ) => Promise<CourseRuntime>;
  /**
   * Builds a library chat's tools. With it, chats started without a course are library chats
   * that work out the course from the question; without it, they are plain chats.
   */
  libraryRuntime?: (chatId: string) => Promise<CourseRuntime>;
  /**
   * Checks what the student added to a question against the library and the chat, and prepares
   * it; without it, questions cannot carry attachments.
   */
  attach?: (reach: AttachReach, inputs: AttachmentInput[]) => Promise<ResolvedAttachment[]>;
}

/**
 * Plain, library and course chats for the desktop app, on top of the saved conversation lifecycle.
 * The renderer only ever sees text views; native provider blocks stay here.
 */
export class ChatService {
  readonly #options: ChatServiceOptions;
  readonly #open = new Map<string, Conversation>();
  readonly #opening = new Map<string, Promise<Conversation>>();
  readonly #streaming = new Map<string, string>();
  /** Text already saved in the answer being written, so streamed text extends it. */
  readonly #prefix = new Map<string, string>();
  /** When each streaming visual was last sent to the window, by chat and call. */
  readonly #visualSent = new Map<string, number>();
  #closed = false;

  constructor(options: ChatServiceOptions) {
    this.#options = options;
  }

  async chats(): Promise<{ chats: ChatSummary[]; unavailable: number }> {
    const { store } = this.#options;
    const [sessions, unavailable] = await Promise.all([store.list(), store.listUnavailable()]);
    return { chats: chatSummaries(sessions), unavailable: unavailable.length };
  }

  async openChat(id: unknown): Promise<ChatView> {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("Unknown chat.");
    return this.#view(await this.#conversation(id));
  }

  /** Accepts a message and returns its chat ID; the reply and any failure arrive as events. */
  async send(input: unknown): Promise<{ chatId: string }> {
    const { chatId, text, submissionId, courseId, focus, modelId, attachments, thinking, fast } =
      validSend(input);
    const models = this.#options.models ?? [this.#options.modelId];
    if (modelId && !models.includes(modelId)) throw new Error("That model is not available.");
    if (!(await this.#options.connected()))
      throw new Error("Connect your ChatGPT account in Settings to start chatting.");
    const existing = chatId ? await this.#conversation(chatId) : null;
    // What was added is checked before a new chat is created, so a refusal leaves nothing behind.
    let added: ResolvedAttachment[] = [];
    if (attachments.length) {
      const kind =
        existing?.kind ?? (courseId ? "course" : this.#options.libraryRuntime ? "library" : "chat");
      if (kind === "chat" || !this.#options.attach)
        throw new Error("This older chat can't take attachments. Start a new chat to add them.");
      added = await this.#options.attach(
        existing
          ? { courseId: existing.courseId, grants: existing.grants() }
          : { courseId: courseId ?? null, grants: { courses: [], documents: [] } },
        attachments,
      );
    }
    const conversation =
      existing ??
      (await this.#create(courseId ?? null, focus ?? null, modelId ?? this.#options.modelId));
    const id = conversation.snapshot.id;
    // A course chat's question carries the page in view, so the tutor's prompt stays the same.
    const extras = conversation.kind === "course" ? { focus: focus ?? null } : {};
    conversation.send(text, submissionId, { attachments: added, thinking, fast, ...extras }).then(
      () => this.#settled(conversation),
      (error: unknown) => {
        this.#options.emit({ type: "error", chatId: id, message: errorMessage(error) });
        this.#settled(conversation);
      },
    );
    return { chatId: id };
  }

  cancel(chatId: unknown): void {
    if (typeof chatId === "string") this.#open.get(chatId)?.cancel();
  }

  /** The page a course chat follows; checked against the course before it is saved. */
  async setFocus(chatId: unknown, focus: unknown): Promise<void> {
    if (typeof chatId !== "string" || !UUID.test(chatId)) throw new Error("Unknown chat.");
    const conversation = await this.#conversation(chatId);
    await conversation.setCourseFocus(validFocus(focus));
  }

  /**
   * Closes these chats so their files can move (to the Trash). A chat that is replying stays
   * open and the call fails, so a reply is never cut off by removing its chat.
   */
  async release(ids: string[]): Promise<void> {
    for (const id of ids) {
      const opening = this.#opening.get(id);
      if (opening) await opening.catch(() => {});
      if (this.#open.get(id)?.snapshot.status === "running")
        throw new Error("Folio is still replying in that chat. Stop the reply first.");
    }
    for (const id of ids) {
      const conversation = this.#open.get(id);
      this.#open.delete(id);
      this.#streaming.delete(id);
      this.#prefix.delete(id);
      await conversation?.close();
    }
  }

  /** Tells the window the chat list changed (a chat was removed or restored). */
  announceChats(): Promise<void> {
    return this.#emitChats();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#open.values()].map((conversation) => conversation.close()));
    this.#open.clear();
  }

  async #create(
    courseId: string | null,
    focus: Focus | null,
    modelId: string,
  ): Promise<Conversation> {
    const conversation = await this.#watch(
      Conversation.open({
        store: this.#options.store,
        newSession: true,
        kind: courseId ? "course" : this.#options.libraryRuntime ? "library" : "chat",
        courseId: courseId ?? undefined,
        focus: courseId ? focus : null,
        courseRuntime: this.#options.courseRuntime,
        libraryRuntime: this.#options.libraryRuntime,
        modelId,
        streamFn: this.#options.streamFn,
        resolveModel: this.#options.resolveModel,
      }),
    );
    void this.#emitChats();
    return conversation;
  }

  #conversation(id: string): Promise<Conversation> {
    const open = this.#open.get(id);
    if (open) return Promise.resolve(open);
    let opening = this.#opening.get(id);
    if (!opening) {
      opening = this.#watch(
        Conversation.open({
          store: this.#options.store,
          id,
          allowedKinds: ["chat", "course", "library"],
          courseRuntime: this.#options.courseRuntime,
          libraryRuntime: this.#options.libraryRuntime,
          streamFn: this.#options.streamFn,
          resolveModel: this.#options.resolveModel,
        }),
      ).finally(() => this.#opening.delete(id));
      this.#opening.set(id, opening);
    }
    return opening;
  }

  async #watch(opening: Promise<Conversation>): Promise<Conversation> {
    const conversation = await opening;
    if (this.#closed) {
      await conversation.close();
      throw new Error("Folio is closing.");
    }
    const id = conversation.snapshot.id;
    this.#open.set(id, conversation);
    conversation.subscribe((event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        const text = visibleText(event.message.content);
        const prefix = this.#prefix.get(id);
        const full = prefix && text ? `${prefix}\n\n${text}` : prefix || text;
        // Tool calls and reasoning stream too; the text only goes out when it changed.
        if (this.#streaming.get(id) !== text || !this.#streaming.has(id)) {
          this.#streaming.set(id, text);
          this.#options.emit({ type: "stream", chatId: id, text: full });
        }
        const update = event.assistantMessageEvent;
        if (
          update.type === "toolcall_start" ||
          update.type === "toolcall_delta" ||
          update.type === "toolcall_end"
        ) {
          const block = event.message.content[update.contentIndex];
          if (block?.type === "toolCall" && block.name === "show_visual") {
            // A visual being written goes out a few times a second, and once more when complete.
            const key = `${id}:${block.id}`;
            const now = Date.now();
            if (update.type === "toolcall_end" || now - (this.#visualSent.get(key) ?? 0) >= 150) {
              this.#visualSent.set(key, now);
              this.#options.emit({
                type: "visual",
                chatId: id,
                visual: visualView(block.id, block.arguments, full.length),
              });
            }
          }
        }
      } else if (event.type === "message_start" || event.type === "message_end") {
        if (event.type === "message_start" && event.message.role === "assistant")
          this.#prefix.set(id, this.#view(conversation).messages.at(-1)?.text ?? "");
        if (event.type === "message_end") this.#streaming.delete(id);
        this.#options.emit({ type: "chat", chat: this.#view(conversation) });
        // The accepted question gives a new chat its title and marks it as working.
        if (event.type === "message_start" && event.message.role === "user") void this.#emitChats();
      }
    });
    return conversation;
  }

  #view(conversation: Conversation): ChatView {
    const snapshot = conversation.snapshot;
    return chatView(snapshot, this.#streaming.get(snapshot.id));
  }

  #settled(conversation: Conversation): void {
    this.#streaming.delete(conversation.snapshot.id);
    this.#prefix.delete(conversation.snapshot.id);
    for (const key of this.#visualSent.keys())
      if (key.startsWith(`${conversation.snapshot.id}:`)) this.#visualSent.delete(key);
    this.#options.emit({ type: "chat", chat: this.#view(conversation) });
    void this.#emitChats();
  }

  async #emitChats(): Promise<void> {
    try {
      this.#options.emit({ type: "chats", chats: (await this.chats()).chats });
    } catch {
      // The list refreshes again on the next change; a transient read error is not fatal.
    }
  }
}

function validSend(input: unknown): SendInput & { attachments: AttachmentInput[] } {
  if (typeof input !== "object" || input === null) throw new Error("Invalid message.");
  const { chatId, text, submissionId, courseId, focus, modelId, attachments, thinking, fast } =
    input as Record<string, unknown>;
  if (chatId !== null && (typeof chatId !== "string" || !UUID.test(chatId)))
    throw new Error("Unknown chat.");
  if (typeof text !== "string" || !text.trim()) throw new Error("Enter a message first.");
  if (text.length > MAX_MESSAGE_LENGTH) throw new Error("That message is too long.");
  if (typeof submissionId !== "string" || !UUID.test(submissionId))
    throw new Error("Invalid submission.");
  if (
    courseId !== undefined &&
    courseId !== null &&
    (typeof courseId !== "string" || !UUID.test(courseId))
  )
    throw new Error("Unknown course.");
  if (modelId !== undefined && modelId !== null && typeof modelId !== "string")
    throw new Error("That model is not available.");
  if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as Thinking))
    throw new Error("That thinking level is not available.");
  if (fast !== undefined && typeof fast !== "boolean") throw new Error("Invalid speed.");
  return {
    chatId,
    text,
    submissionId,
    courseId: (courseId as string | null | undefined) ?? null,
    focus: focus === undefined ? null : validFocus(focus),
    modelId: (modelId as string | null | undefined) ?? null,
    attachments: validAttachments(attachments),
    ...(thinking !== undefined ? { thinking: thinking as Thinking } : {}),
    ...(fast ? { fast: true } : {}),
  };
}

function validAttachments(value: unknown): AttachmentInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS)
    throw new Error(`Add at most ${MAX_ATTACHMENTS} things to one question.`);
  const inputs = value.map((item): AttachmentInput => {
    const { kind, documentId, page, courseId, name, data } = (item ?? {}) as Record<
      string,
      unknown
    >;
    const id = (value: unknown) => {
      if (typeof value !== "string" || !UUID.test(value)) throw new Error("Unknown attachment.");
      return value;
    };
    if (kind === "course") return { kind, courseId: id(courseId) };
    if (kind === "document") return { kind, documentId: id(documentId) };
    if (kind === "page") {
      if (!Number.isInteger(page) || (page as number) < 1) throw new Error("Invalid page.");
      return { kind, documentId: id(documentId), page: page as number };
    }
    if (kind === "image") {
      if (!(data instanceof Uint8Array) || !data.byteLength) throw new Error("Invalid image.");
      if (data.byteLength > MAX_IMAGE_BYTES)
        throw new Error("That image is too large. Folio takes images up to 20 MB.");
      // A file name, shown with the image and told to the tutor: printable characters only.
      const label = typeof name === "string" ? name.replace(/\p{Cc}/gu, "").slice(0, 120) : "";
      return { kind, name: label, data };
    }
    throw new Error("Folio can't add that to a question.");
  });
  if (inputs.filter((input) => input.kind === "image").length > MAX_IMAGES)
    throw new Error(`Add at most ${MAX_IMAGES} images to one question.`);
  return inputs;
}

function validFocus(focus: unknown): Focus | null {
  if (focus === null) return null;
  const { documentId, page } = (focus ?? {}) as Record<string, unknown>;
  if (typeof documentId !== "string" || !UUID.test(documentId) || !Number.isInteger(page))
    throw new Error("Invalid page.");
  return { documentId, page: page as number };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}
