import { grantsOf, questionText, type Attachment } from "../conversation.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CourseNote, ProposalRecord } from "../library/notes.ts";
import type { CourseRecord, DocumentRecord } from "../library/store.ts";
import type { SessionRecord, SessionSummary } from "../session-store.ts";
import type {
  AttachmentView,
  ChatKind,
  ChatMessageView,
  ChatSummary,
  ChatView,
  CourseView,
  DocumentView,
  NoteView,
  ProposalView,
  SourceView,
  StepView,
} from "./api.ts";

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

type Step = StepView & { id: string };
type Turn = Omit<ChatMessageView, "steps" | "sources" | "proposals"> & {
  steps: Step[];
  sources: SourceView[];
  proposals: string[];
};

function runningLabel(name: string, args: unknown): string {
  const page = (args as { page?: unknown } | undefined)?.page;
  if (name === "read_page")
    return typeof page === "number" ? `Reading page ${page}` : "Reading a page";
  if (name === "list_documents") return "Looking through the course";
  if (name === "search_course") return "Searching the course";
  if (name === "read_sections") return "Reading the course's notes";
  if (name === "related_sections") return "Following related topics";
  if (name === "list_notes") return "Looking through your notes";
  if (name === "read_note") return "Reading your note";
  if (name === "propose_note_edit") return "Drafting a note edit";
  return name;
}

function finishedLabel(name: string, details: unknown, failed: boolean, fallback: string): string {
  if (name === "list_documents")
    return failed ? "Couldn't list the course" : "Looked through the course";
  if (name === "read_page") {
    const reading = details as Partial<SourceView> | undefined;
    if (failed) return fallback.replace("Reading", "Couldn't read");
    if (reading?.title && reading.page) return `Read ${reading.title}, p.${reading.page}`;
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
  return fallback;
}

/**
 * A renderer-safe view of a saved chat. Each answer groups the assistant's messages and tool
 * results after a question into one turn with plain-language steps and the pages it read.
 */
export function chatView(record: SessionRecord, streaming?: string): ChatView {
  const messages: ChatMessageView[] = [];
  let turn: Turn | undefined;
  for (const message of record.messages as AgentMessage[]) {
    if (message.role === "user") {
      turn = undefined;
      const attachments = attachmentViews(message);
      messages.push({
        role: "user",
        text: questionText(message),
        state: "complete",
        ...(attachments.length ? { attachments } : {}),
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
        };
        messages.push(turn);
      }
      const text = visibleText(message.content);
      if (text) turn.text = turn.text ? `${turn.text}\n\n${text}` : text;
      for (const block of message.content)
        if (block.type === "toolCall")
          turn.steps.push({
            id: block.id,
            label: runningLabel(block.name, block.arguments),
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
    }
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
      };
      messages.push(turn);
    }
    turn.state = "streaming";
    if (streaming) turn.text = turn.text ? `${turn.text}\n\n${streaming}` : streaming;
  }
  return {
    id: record.id,
    kind: chatKind(record.scope),
    title: record.title,
    status: record.status,
    modelId: record.modelId,
    updatedAt: record.updatedAt,
    courseId: "library" in record.scope ? record.scope.courseId : null,
    focus:
      record.focus?.documentId !== undefined
        ? { documentId: record.focus.documentId, page: record.focus.page }
        : null,
    messages: messages.map((view) =>
      view.role === "assistant"
        ? {
            ...view,
            steps: (view as Turn).steps.map(({ label, state }) => ({ label, state })),
            sources: (view as Turn).sources,
            proposals: (view as Turn).proposals,
          }
        : view,
    ),
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
    return folioAttachments.map((attachment) =>
      attachment.kind === "image"
        ? {
            kind: "image",
            name: attachment.name,
            thumbnail: `data:image/jpeg;base64,${attachment.thumbnail}`,
          }
        : { ...attachment },
    );
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
    .map(({ id, title, updatedAt, status, scope }) => ({
      id,
      kind: chatKind(scope),
      title,
      updatedAt,
      status,
      courseId: "library" in scope ? scope.courseId : null,
    }));
}

export function courseView(course: CourseRecord, documents: number): CourseView {
  const { id, name, code, term, color, revision } = course;
  return { id, name, code, term, color, revision, documents };
}

export function documentView(document: DocumentRecord): DocumentView {
  const { id, courseId, title, role, kind, pages, size, dueAt, importedAt, revision } = document;
  return { id, courseId, title, role, kind, pages, size, dueAt, importedAt, revision };
}

export function noteView(note: CourseNote): NoteView {
  const { id, courseId, title, revision, updatedAt } = note;
  return { id, courseId, title, revision, updatedAt };
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
