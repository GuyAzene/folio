import { grantsOf, questionText, type Attachment } from "../conversation.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CourseNote, ProposalRecord } from "../library/notes.ts";
import { noteFacts } from "../library/note-meta.ts";
import type { CourseRecord, DocumentRecord } from "../library/store.ts";
import { refOf } from "../model-refs.ts";
import type { SessionRecord, SessionSummary } from "../session-store.ts";
import type { CommandRecord } from "../commands.ts";
import type { ServerState } from "../mcp/servers.ts";
import type {
  ActionView,
  ApprovalView,
  AttachmentView,
  ChatKind,
  ChatMessageView,
  ChatSummary,
  ChatView,
  CommandInput,
  CourseView,
  McpView,
  DocumentView,
  NoteEditView,
  NoteView,
  ProposalView,
  SourceView,
  StepView,
  VisualView,
} from "./api.ts";
import { visualKind, visualTitle } from "../visual.ts";

/** Visible text only: reasoning, signatures and other native blocks stay in the main process. */
export function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n\n");
}

type Step = StepView & { id: string; tool: string };
type Turn = Omit<
  ChatMessageView,
  "steps" | "sources" | "proposals" | "noteEdits" | "webSources" | "visuals"
> & {
  steps: Step[];
  sources: SourceView[];
  proposals: string[];
  noteEdits: NoteEditView[];
  webSources: { url: string; title: string }[];
  visuals: VisualView[];
};

/** A `show_visual` call as the window shows it, before its result settles it. */
export function visualView(id: string, args: unknown, at: number): VisualView {
  const source = (args as { source?: unknown } | undefined)?.source;
  const text = typeof source === "string" ? source : "";
  return {
    id,
    kind: visualKind(text),
    title: visualTitle(text) ?? "",
    source: text,
    state: "streaming",
    at,
  };
}

/** An argument that looks like a key or a password, which Settings would show in full. */
function looksSecret(arg: string): boolean {
  return (
    /^(sk-|ghp_|github_pat_|xox[abp]-|AIza)/.test(arg) ||
    /(token|key|secret|password)=/i.test(arg) ||
    (arg.length >= 24 && /^[A-Za-z0-9_-]+$/.test(arg) && /\d/.test(arg) && /[A-Za-z]/.test(arg))
  );
}

/** A remote server's address with the values of its query hidden. */
function maskedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of new Set(parsed.searchParams.keys())) parsed.searchParams.set(key, "…");
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

/** The student's servers for Settings: names of settings and headers, never their values. */
export function mcpView(states: ServerState[], problems: string[]): McpView {
  return {
    servers: states.map(({ entry, status, tools, prompts, error, log, instructions }) => ({
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      command: entry.kind === "remote" ? maskedUrl(entry.url ?? "") : (entry.command ?? ""),
      args: [...entry.args],
      cwd: entry.cwd ?? null,
      env: Object.keys(entry.env),
      headers: Object.keys(entry.headers),
      enabled: entry.enabled,
      approval: entry.approval,
      status,
      error: error ?? null,
      log,
      instructions: instructions ?? null,
      tools: tools.map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.annotations?.title ?? null,
        description: (tool.description ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
        rule: entry.tools[tool.name] ?? "ask",
        hints: {
          ...(tool.annotations?.readOnlyHint !== undefined
            ? { readOnly: tool.annotations.readOnlyHint }
            : {}),
          ...(tool.annotations?.destructiveHint !== undefined
            ? { destructive: tool.annotations.destructiveHint }
            : {}),
          ...(tool.annotations?.openWorldHint !== undefined
            ? { openWorld: tool.annotations.openWorldHint }
            : {}),
        },
      })),
      prompts: prompts.map((prompt) => ({
        name: prompt.name,
        title: prompt.title ?? null,
        description: (prompt.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
        arguments: (prompt.arguments ?? []).map((argument) => ({
          name: argument.name,
          description: argument.description ?? "",
          required: argument.required === true,
        })),
      })),
      argWarning: entry.args.some(looksSecret),
    })),
    problems,
  };
}

/** What the window knows of a chat beyond its saved file: calls waiting for the student, and service names. */
export interface LiveChat {
  approvals: ApprovalView[];
  /** The callIds of `approvals`, in order. */
  waiting: string[];
  /** A service tool's server and own name, by the name the tutor sees. */
  service: (name: string) => { label: string; tool: string } | undefined;
}

function runningLabel(name: string, args: unknown, live?: LiveChat): string {
  const service = live?.service(name);
  if (service) return `Using ${service.label} · ${service.tool}`;
  const page = (args as { page?: unknown } | undefined)?.page;
  const closer = (args as { region?: unknown } | undefined)?.region !== undefined;
  if (name === "read_page")
    return typeof page === "number"
      ? `${closer ? "Looking closer at" : "Reading"} page ${page}`
      : "Reading a page";
  if (name === "view_note")
    return (args as { find?: unknown } | undefined)?.find !== undefined
      ? "Looking closely at your note"
      : "Looking at your note";
  if (name === "add_note_figure")
    return typeof page === "number" ? `Cropping a figure from page ${page}` : "Cropping a figure";
  if (name === "list_documents") return "Looking through the course";
  if (name === "search_course") return "Searching the course";
  if (name === "read_sections") return "Reading the course's notes";
  if (name === "related_sections") return "Following related topics";
  if (name === "list_notes") return "Looking through your notes";
  if (name === "read_note") return "Reading your note";
  if (name === "propose_note_edit") return "Drafting a note edit";
  if (name === "search_web") {
    const query = (args as { query?: unknown } | undefined)?.query;
    return typeof query === "string" ? `Searching the web: ${query}` : "Searching the web";
  }
  if (name === "create_note") return "Writing a note";
  if (name === "edit_note") return "Editing your note";
  if (name === "rename_note") return "Renaming your note";
  if (name === "use_skill") {
    const { name: skill, file } = (args ?? {}) as { name?: unknown; file?: unknown };
    if (typeof skill !== "string") return "Opening a routine";
    return typeof file === "string"
      ? `Reading ${skill}'s ${file}`
      : `Following your routine ${skill}`;
  }
  return APP_STEPS[name]?.[0] ?? name;
}

/** The tools that change Folio: what each says while it runs, and once it has. */
const APP_STEPS: Record<string, readonly [string, string, string]> = {
  edit_course: ["Changing a course", "Changed a course", "Couldn't change the course"],
  edit_files: ["Changing files", "Changed files", "Couldn't change the files"],
  add_file: ["Adding your file", "Added your file", "Couldn't add your file"],
  trash_files: ["Moving files to the Trash", "Moved files to the Trash", "Couldn't move the files"],
  trash_course: [
    "Moving a course to the Trash",
    "Moved a course to the Trash",
    "Couldn't move the course",
  ],
  edit_categories: [
    "Changing your categories",
    "Changed your categories",
    "Couldn't change your categories",
  ],
  set_model: ["Choosing a model", "Chose a model", "Couldn't choose that model"],
  study: ["Studying", "Started studying", "Couldn't start studying"],
};

function finishedLabel(name: string, details: unknown, failed: boolean, fallback: string): string {
  const service = (
    details as { mcp?: { label?: unknown; tool?: unknown; decision?: unknown } } | undefined
  )?.mcp;
  if (typeof service?.label === "string" && typeof service.tool === "string") {
    const what = `${service.label} · ${service.tool}`;
    if (service.decision === "declined") return `You declined ${what}`;
    return failed ? `Couldn't use ${what}` : `Used ${what}`;
  }
  // A service call cut off before it finished (the reply stopped, or Folio closed).
  if (failed && fallback.startsWith("Using ")) return `Couldn't use ${fallback.slice(6)}`;
  if (name === "list_documents")
    return failed ? "Couldn't list the course" : "Looked through the course";
  if (name === "read_page") {
    const reading = details as (Partial<SourceView> & { region?: unknown }) | undefined;
    if (failed)
      return fallback
        .replace("Looking closer at", "Couldn't look closer at")
        .replace("Reading", "Couldn't read");
    if (reading?.title && reading.page)
      return reading.region
        ? `Looked closer at ${reading.title}, page ${reading.page}`
        : `Read ${reading.title}, page ${reading.page}`;
  }
  if (name === "view_note") {
    if (failed) return "Couldn't look at your note";
    const shown = (details ?? {}) as {
      title?: unknown;
      view?: unknown;
      part?: unknown;
      parts?: unknown;
      closeUp?: unknown;
    };
    const which = shown.view === "read" ? "read view" : "edit view";
    const where = shown.closeUp
      ? `${which}, close-up`
      : typeof shown.part === "number" && typeof shown.parts === "number" && shown.parts > 1
        ? `${which}, part ${shown.part} of ${shown.parts}`
        : which;
    return typeof shown.title === "string"
      ? `Looked at your note ${shown.title} (${where})`
      : "Looked at your note";
  }
  if (name === "add_note_figure") {
    if (failed) return "Couldn't crop that figure";
    const figure = (details ?? {}) as { source?: unknown; page?: unknown };
    return typeof figure.source === "string" && typeof figure.page === "number"
      ? `Saved a figure from ${figure.source}, page ${figure.page}`
      : "Saved a figure";
  }
  if (name === "search_course")
    return failed ? "Couldn't search the course" : "Searched the course";
  if (name === "read_sections") {
    const handles = (details as { handles?: unknown } | undefined)?.handles;
    const count = Array.isArray(handles) ? handles.length : 0;
    if (failed) return "Couldn't read the course's notes";
    return `Read ${count} section${count === 1 ? "" : "s"} of the course`;
  }
  if (name === "related_sections")
    return failed ? "Couldn't follow related topics" : "Followed related topics";
  if (name === "list_notes")
    return failed ? "Couldn't list your notes" : "Looked through your notes";
  if (name === "read_note") {
    const title = (details as { title?: unknown } | undefined)?.title;
    if (failed) return "Couldn't read your note";
    if (typeof title === "string") return `Read your note ${title}`;
  }
  if (name === "propose_note_edit")
    return failed ? "Couldn't draft the note edit" : "Drafted a note edit for you to review";
  if (name === "search_web") {
    const query = (details as { query?: unknown } | undefined)?.query;
    if (failed) return "Couldn't search the web";
    return typeof query === "string" ? `Searched the web: ${query}` : "Searched the web";
  }
  const edit = (details as { noteEdit?: { title?: unknown } } | undefined)?.noteEdit;
  const title = typeof edit?.title === "string" ? ` ${edit.title}` : "";
  if (name === "create_note") return failed ? "Couldn't write the note" : `Wrote the note${title}`;
  if (name === "edit_note") return failed ? "Couldn't edit your note" : `Edited your note${title}`;
  if (name === "rename_note")
    return failed ? "Couldn't rename your note" : `Renamed your note to${title}`;
  if (name === "use_skill") {
    const skill = (details as { skill?: { name?: unknown; file?: unknown } } | undefined)?.skill;
    if (failed || typeof skill?.name !== "string") return "Couldn't open that routine";
    return typeof skill.file === "string"
      ? `Read ${skill.name}'s ${skill.file}`
      : `Following your routine ${skill.name}`;
  }
  const app = APP_STEPS[name];
  if (app) {
    if (failed) return app[2];
    // A change waiting for the student's Apply hasn't happened yet.
    return (details as { pending?: unknown } | undefined)?.pending
      ? "Proposed a change for you to apply"
      : app[1];
  }
  return fallback;
}

/** What a question started with `/`, as saved on the student's message. */
function commandView(message: AgentMessage): CommandInput | undefined {
  const record = (message as { folioCommand?: Partial<CommandRecord> }).folioCommand;
  if (record?.kind === "skill" && typeof record.name === "string")
    return { kind: "skill", name: record.name };
  if (
    record?.kind === "prompt" &&
    typeof record.name === "string" &&
    typeof record.server === "string"
  )
    return {
      kind: "prompt",
      server: record.server,
      name: record.name,
      args: { ...record.args },
      label: typeof record.label === "string" ? record.label : record.server,
    };
  return undefined;
}

/**
 * A renderer-safe view of a saved chat. Each answer groups the assistant's messages and tool
 * results after a question into one turn with plain-language steps and the pages it read.
 */
export function chatView(record: SessionRecord, streaming?: string, now?: LiveChat): ChatView {
  const messages: ChatMessageView[] = [];
  let turn: Turn | undefined;
  for (const message of record.messages as AgentMessage[]) {
    if (message.role === "user" && "folioSummary" in message) {
      // Folio's summary for the model, shown as a quiet divider rather than a question.
      turn = undefined;
      messages.push({ role: "assistant", text: "", state: "complete", kind: "summary" });
    } else if (message.role === "user") {
      turn = undefined;
      const attachments = attachmentViews(message);
      const command = commandView(message);
      messages.push({
        role: "user",
        text: questionText(message),
        state: "complete",
        ...(attachments.length ? { attachments } : {}),
        ...(command ? { command } : {}),
      });
    } else if (message.role === "assistant") {
      if (!turn) {
        turn = {
          role: "assistant",
          text: "",
          state: "complete",
          steps: [],
          sources: [],
          proposals: [],
          noteEdits: [],
          webSources: [],
          visuals: [],
        };
        messages.push(turn);
      }
      const text = visibleText(message.content);
      if (text) turn.text = turn.text ? `${turn.text}\n\n${text}` : text;
      for (const block of message.content)
        if (block.type === "toolCall" && block.name === "show_visual")
          turn.visuals.push(visualView(block.id, block.arguments, turn.text.length));
        else if (block.type === "toolCall")
          turn.steps.push({
            id: block.id,
            tool: block.name,
            label: runningLabel(block.name, block.arguments, now),
            state: "running",
          });
      if (message.stopReason === "aborted") {
        turn.state = "interrupted";
        turn.error = message.errorMessage;
      } else if (message.stopReason === "error") {
        turn.state = "failed";
        turn.error = message.errorMessage ?? "The reply failed.";
      }
    } else if (message.role === "toolResult" && turn) {
      const visual = turn.visuals.find((candidate) => candidate.id === message.toolCallId);
      if (visual) {
        visual.state = message.isError ? "invalid" : "ready";
        if (message.isError) visual.error = visibleText(message.content);
      }
      const step = turn.steps.find((candidate) => candidate.id === message.toolCallId);
      if (step) {
        step.state = message.isError ? "failed" : "done";
        step.label = finishedLabel(message.toolName, message.details, message.isError, step.label);
      }
      const reading = message.details as Partial<SourceView> | undefined;
      if (
        !message.isError &&
        message.toolName === "read_page" &&
        reading?.documentId &&
        // A file the student added to the chat is in no course, so it has no source to open.
        !/^[0-9a-f]{64}$/.test(reading.documentId) &&
        reading.title &&
        reading.page &&
        !turn.sources.some((s) => s.documentId === reading.documentId && s.page === reading.page)
      )
        turn.sources.push({
          documentId: reading.documentId,
          title: reading.title,
          page: reading.page,
        });
      const cited = (message.details as { sources?: unknown } | undefined)?.sources;
      if (!message.isError && message.toolName === "read_sections" && Array.isArray(cited))
        for (const source of cited as SourceView[])
          if (
            !turn.sources.some((s) => s.documentId === source.documentId && s.page === source.page)
          )
            turn.sources.push({
              documentId: source.documentId,
              title: source.title,
              page: source.page,
            });
      const proposalId = (message.details as { proposalId?: unknown } | undefined)?.proposalId;
      if (
        !message.isError &&
        message.toolName === "propose_note_edit" &&
        typeof proposalId === "string"
      )
        turn.proposals.push(proposalId);
      const found = (message.details as { sources?: unknown } | undefined)?.sources;
      if (!message.isError && message.toolName === "search_web" && Array.isArray(found))
        for (const source of found as { url?: unknown; title?: unknown }[])
          if (
            typeof source.url === "string" &&
            source.url.startsWith("https://") &&
            !turn.webSources.some((known) => known.url === source.url)
          )
            turn.webSources.push({
              url: source.url,
              title: typeof source.title === "string" ? source.title : source.url,
            });
      const changed = (message.details as { action?: Partial<ActionView> } | undefined)?.action;
      if (!message.isError && changed && typeof changed.summary === "string")
        (turn.actions ??= []).push({
          summary: changed.summary,
          undo: changed.undo ?? null,
          courseId: typeof changed.courseId === "string" ? changed.courseId : null,
          documentId: typeof changed.documentId === "string" ? changed.documentId : null,
        });
      const waiting = (message.details as { pending?: { id?: unknown } } | undefined)?.pending;
      if (!message.isError && typeof waiting?.id === "string")
        (turn.pending ??= []).push(waiting.id);
      const edit = (message.details as { noteEdit?: NoteEditView & { v?: number } } | undefined)
        ?.noteEdit;
      if (!message.isError && edit && typeof edit.noteId === "string")
        turn.noteEdits.push({
          action: edit.action,
          noteId: edit.noteId,
          title: edit.title,
          before: edit.before,
          after: edit.after,
        });
    }
  }
  // A step whose reply stopped before it finished (interrupted, failed, or closed mid-call) did
  // not happen; only the reply still arriving has steps in progress.
  const live = record.status === "running" ? turn : undefined;
  for (const view of messages)
    if (view.role === "assistant" && view !== live && view.kind !== "summary") {
      for (const step of (view as Turn).steps)
        if (step.state === "running") {
          step.state = "failed";
          step.label = finishedLabel(step.tool, undefined, true, step.label);
        }
      for (const visual of (view as Turn).visuals)
        if (visual.state === "streaming") visual.state = "stopped";
    }
  if (record.status === "running") {
    if (!turn) {
      turn = {
        role: "assistant",
        text: "",
        state: "streaming",
        steps: [],
        sources: [],
        proposals: [],
        noteEdits: [],
        webSources: [],
        visuals: [],
      };
      messages.push(turn);
    }
    turn.state = "streaming";
    if (streaming) turn.text = turn.text ? `${turn.text}\n\n${streaming}` : streaming;
    // Calls waiting for the student show on the reply that made them.
    if (now?.approvals.length) {
      turn.approvals = now.approvals;
      for (const step of turn.steps) {
        const service = now.waiting.includes(step.id) ? now.service(step.tool) : undefined;
        if (service) step.label = `Waiting for you: ${service.label} · ${service.tool}`;
      }
    }
  }
  return {
    id: record.id,
    kind: chatKind(record.scope),
    title: record.title,
    status: record.status,
    model: refOf(record.provider, record.modelId),
    updatedAt: record.updatedAt,
    courseId: "library" in record.scope ? record.scope.courseId : null,
    focus:
      record.focus?.documentId !== undefined
        ? { documentId: record.focus.documentId, page: record.focus.page }
        : null,
    messages: messages.map((view) => {
      if (view.role !== "assistant" || view.kind === "summary") return view;
      const { visuals, noteEdits, webSources, ...turn } = view as Turn;
      return {
        ...turn,
        steps: turn.steps.map(({ label, state }) => ({ label, state })),
        // Only turns that showed a visual or changed a note carry those lists.
        ...(visuals.length ? { visuals } : {}),
        ...(noteEdits.length ? { noteEdits } : {}),
        ...(webSources.length ? { webSources } : {}),
      };
    }),
    reads:
      chatKind(record.scope) === "course"
        ? grantsOf(record.messages)
        : { courses: [], documents: [] },
  };
}

/** What the student added to a question; chats saved before the + button may carry a page. */
function attachmentViews(message: object): AttachmentView[] {
  const { folioAttachments, folioPage } = message as {
    folioAttachments?: Attachment[];
    folioPage?: { documentId: string; page: number };
  };
  if (folioAttachments)
    return folioAttachments.map((attachment): AttachmentView => {
      if (attachment.kind === "image")
        return {
          kind: "image",
          name: attachment.name,
          thumbnail: `data:image/jpeg;base64,${attachment.thumbnail}`,
        };
      if (attachment.kind === "file")
        return { kind: "file", name: attachment.name, pages: attachment.pages };
      return { ...attachment };
    });
  return folioPage
    ? [{ kind: "page", documentId: folioPage.documentId, page: folioPage.page }]
    : [];
}

function chatKind(scope: SessionRecord["scope"]): ChatKind {
  if (scope.courseId === null) return "library" in scope ? "library" : "chat";
  return "course";
}

/** Plain, library and course chats; the CLI's synthetic demo chats stay in the CLI. */
export function chatSummaries(sessions: SessionSummary[]): ChatSummary[] {
  return sessions
    .filter((session) => session.scope.courseId === null || "library" in session.scope)
    .map(({ id, title, updatedAt, status, scope, focus }) => ({
      id,
      kind: chatKind(scope),
      title,
      updatedAt,
      status,
      courseId: "library" in scope ? scope.courseId : null,
      focus:
        focus?.documentId !== undefined ? { documentId: focus.documentId, page: focus.page } : null,
    }));
}

export function courseView(course: CourseRecord, documents: number): CourseView {
  const { id, name, code, term, color, revision } = course;
  return { id, name, code, term, color, revision, documents };
}

export function documentView(document: DocumentRecord): DocumentView {
  const { id, courseId, title, role, kind, pages, size, dueAt, importedAt, revision } = document;
  return {
    id,
    courseId,
    title,
    role,
    kind,
    pages,
    size,
    dueAt,
    category: document.category ?? null,
    number: document.number ?? null,
    named: document.named ?? "own",
    importedAt,
    revision,
  };
}

export function noteView(note: CourseNote): NoteView {
  const { id, courseId, title, revision, updatedAt, content } = note;
  return { id, courseId, title, revision, updatedAt, ...noteFacts(content) };
}

export function proposalView(
  proposal: ProposalRecord,
  noteTitle: string,
  stale: boolean,
): ProposalView {
  const { id, courseId, chatId, noteId, find, text, reason, state, createdAt, resultNoteId } =
    proposal;
  return {
    id,
    courseId,
    chatId,
    noteId,
    noteTitle,
    find,
    text,
    reason,
    state,
    stale,
    createdAt,
    resultNoteId,
  };
}
