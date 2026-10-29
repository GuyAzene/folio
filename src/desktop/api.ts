import type { SessionStatus } from "../session-store.ts";

/** The IPC contract between Folio's Electron main process and its renderer. */
export const CHANNELS = { invoke: "folio:invoke", event: "folio:event" } as const;

export type MessageState = "complete" | "streaming" | "interrupted" | "failed";
export type DocumentRole = "lecture" | "recitation" | "assignment" | "solution" | "asset";
export type Pencil = "graphite" | "blue" | "red" | "green" | "violet" | "orange" | "teal" | "pink";

/** The page a course chat follows. */
export interface Focus {
  documentId: string;
  page: number;
}

/** One plain-language step of Folio's work, such as reading a page. */
export interface StepView {
  label: string;
  state: "running" | "done" | "failed";
}

/** A page Folio read while answering; the reader can jump to it. */
export interface SourceView {
  documentId: string;
  title: string;
  page: number;
}

export interface ChatMessageView {
  role: "user" | "assistant";
  text: string;
  state: MessageState;
  error?: string;
  steps?: StepView[];
  sources?: SourceView[];
  /** Note edits Folio suggested in this turn, by proposal ID. */
  proposals?: string[];
  /** What the student added to a question with the composer's +. */
  attachments?: AttachmentView[];
  /** Drawings and demos the tutor showed in this turn, each at its place in `text`. */
  visuals?: VisualView[];
  /** "summary": where Folio summarized the chat so far for the tutor; shown as a divider. */
  kind?: "summary";
}

/** A drawing or demo the tutor showed with `show_visual`. */
export interface VisualView {
  /** The tool call's ID. */
  id: string;
  kind: "svg" | "html";
  title: string;
  source: string;
  /** "invalid": Folio refused it (`error` says why); "stopped": the reply ended before it did. */
  state: "streaming" | "ready" | "invalid" | "stopped";
  error?: string;
  /** Its place in the turn's text: the length of the text that comes before it. */
  at: number;
}

/** Something added to a question, as the chat shows it. */
export type AttachmentView =
  | { kind: "page"; documentId: string; page: number }
  /** `thumbnail` is a data URL of a small JPEG. */
  | { kind: "image"; name: string; thumbnail: string }
  | { kind: "document"; documentId: string }
  | { kind: "course"; courseId: string };

/** Something the student adds to a question: a page, their own image, a lecture or a course. */
export type AttachmentInput =
  | { kind: "page"; documentId: string; page: number }
  | { kind: "image"; name: string; data: Uint8Array }
  | { kind: "document"; documentId: string }
  | { kind: "course"; courseId: string };

/** Plain (no sources), library (any of the student's courses) or course (one course). */
export type ChatKind = "chat" | "library" | "course";

export interface ChatView {
  id: string;
  kind: ChatKind;
  title: string;
  status: SessionStatus;
  modelId: string;
  updatedAt: string;
  /** Null for a plain chat. */
  courseId: string | null;
  focus: Focus | null;
  messages: ChatMessageView[];
  /** Courses and documents the student added to a course chat; it may read them too. */
  reads: { courses: string[]; documents: string[] };
}

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  title: string;
  updatedAt: string;
  status: SessionStatus;
  courseId: string | null;
}

export interface CourseView {
  id: string;
  name: string;
  code: string;
  term: string;
  color: Pencil;
  revision: number;
  documents: number;
}

export interface DocumentView {
  id: string;
  courseId: string;
  title: string;
  role: DocumentRole;
  kind: "pdf" | "markdown";
  pages: number | null;
  size: number;
  dueAt: string | null;
  importedAt: string;
  revision: number;
}

/** One of the student's Markdown notes. */
export interface NoteView {
  id: string;
  courseId: string;
  title: string;
  /** Pass back when saving; a different revision on disk means it changed elsewhere. */
  revision: string;
  updatedAt: string | null;
}

export interface NoteContent {
  note: NoteView;
  content: string;
}

/** An edit Folio suggested for a note. Nothing is written until the student keeps it. */
export interface ProposalView {
  id: string;
  courseId: string;
  chatId: string;
  /** Null when Folio suggests a new note. */
  noteId: string | null;
  /** The note's current title, or the new note's title. */
  noteTitle: string;
  /** The passage the edit replaces; null adds the text at the end. */
  find: string | null;
  text: string;
  reason: string;
  state: "pending" | "kept" | "inserted" | "discarded";
  /** Pending, but the note changed since: keeping it is refused, inserting below still works. */
  stale: boolean;
  createdAt: string;
  resultNoteId: string | null;
}

export type ProposalAction = "keep" | "insert" | "discard";

/** A file found in a folder the student chose; nothing is copied until they create the course. */
export interface ScannedFileView {
  path: string;
  /** The path inside the folder. */
  name: string;
  title: string;
  role: DocumentRole;
  kind: "pdf" | "markdown";
  size: number;
}

export interface FolderScanView {
  path: string;
  folderName: string;
  files: ScannedFileView[];
  skipped: number;
  truncated: boolean;
}

/** A syllabus the student chose, and the course details Folio found in it. */
export interface SyllabusDraft {
  path: string;
  fileName: string;
  name: string;
  code: string;
  term: string;
  /** True when Folio read the syllabus with the model. */
  read: boolean;
  /** Why Folio could not fill the details in. */
  note?: string;
}

/** Where a node of a running job stands, as in an agent tree. */
export type AgentStatus = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";

/** What a node of the agent tree does. */
export type AgentRole =
  | "run"
  | "document"
  | "prepare"
  | "brief"
  | "reader"
  | "escalation"
  | "author"
  | "reviewer"
  | "ledger"
  | "publish";

/** What a finished step produced, as counts a student can read. */
export interface StepOutcome {
  /** Pages in the document. */
  pages?: number;
  /** Regions read again up close. */
  figures?: number;
  /** Wiki pages and evidence sections written. */
  topics?: number;
  sections?: number;
  /** Claims checked against the page images, and how many the checker could not confirm. */
  claims?: number;
  disagreements?: number;
  /** Regions still unplaced after revision: a record for diagnosis, never shown as such. */
  uncovered?: number;
}

/** One card in a job's agent tree: the run, a document, a step, or a model call. */
export interface AgentNodeView {
  id: string;
  parentId: string | null;
  role: AgentRole;
  /** Short card title, such as "Pages 1–3" or "Author". */
  title: string;
  /** What it is doing, in a sentence. */
  task: string;
  /** Null for work done by Folio's own code. */
  provider: string | null;
  model: string | null;
  status: AgentStatus;
  /** What a waiting node needs, or why a failed one stopped. */
  note: string | null;
  /** Physical pages this node covers. */
  pages: number[];
  /** Model requests made, and their tokens; a node with children reports its own only. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: string | null;
  endedAt: string | null;
  /** 1 for the first try; a retry is a new node with a higher attempt. */
  attempt: number;
  /** What the step produced, once it has finished. */
  outcome: StepOutcome | null;
}

/** One cell of a job's coverage strip. */
export interface PageCoverageView {
  documentId: string;
  page: number;
  state: "pending" | "read" | "escalated" | "represented" | "gap" | "unaccounted";
}

/**
 * Why a study started: the student asked, a lecture was added, an unstudied one was found in the
 * library, or an earlier study is being redone.
 */
export type JobOrigin = "student" | "upload" | "backlog" | "restudy";

export interface JobView {
  id: string;
  kind: "ingest";
  origin: JobOrigin;
  /** A queued job that is waiting for ChatGPT to be connected before it can start. */
  waitingFor: "connection" | null;
  courseId: string;
  documentIds: string[];
  title: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  pages: number;
  pagesRead: number;
  regions: number;
  regionsAccounted: number;
  coverage: PageCoverageView[];
  nodes: AgentNodeView[];
  /** Paused, interrupted or waiting on the plan's limit; a cancelled job is not. */
  resumable: boolean;
}

/** A course's published, reviewed knowledge. */
export interface KnowledgeView {
  courseId: string;
  generation: number;
  publishedAt: string;
  summary: string;
  sessions: { slug: string; title: string; documentId: string }[];
  pages: number;
  blocks: number;
  /** True when an earlier version can be restored. */
  canRollBack: boolean;
}

/** What Folio wrote from studying a course's lectures and recitations, as published. */
export interface StudyNotesView {
  courseId: string;
  generation: number;
  publishedAt: string;
  sessions: StudySessionView[];
  topics: StudyTopicView[];
}

/** One studied lecture or recitation. */
export interface StudySessionView {
  slug: string;
  title: string;
  type: "lecture" | "recitation";
  documentId: string;
  covers: string;
  worthRemembering: string[];
  openThreads: string[];
  workedExamples: { title: string; page: number }[];
  /** Topics this session introduced, in order. */
  topics: string[];
}

export interface StudyTopicView {
  slug: string;
  title: string;
  type: "concept" | "technique";
  intuition: string;
  /** The session that introduced the topic. */
  introducedIn: string;
  /** Topics this one builds on, and topics that build on it; only ones the course has. */
  prerequisites: { slug: string; title: string }[];
  usedBy: { slug: string; title: string }[];
  sections: StudySectionView[];
}

export interface StudySectionView {
  handle: string;
  title: string;
  /** Markdown, possibly with TeX math. */
  body: string;
  session: string;
  documentId: string;
  /** Slide pages the section was written from. */
  pages: number[];
  questions: string[];
}

/** Something in Folio's Trash. */
export interface TrashEntryView {
  id: string;
  kind: "document" | "note" | "chat" | "course";
  title: string;
  courseId: string | null;
  courseName: string | null;
  removedAt: string;
  /** When it moves on to the Mac's Trash by itself. */
  expiresAt: string;
  /** What a removed course held. */
  contents: { documents: number; notes: number; chats: number } | null;
  /** A studied file: restoring it brings its study notes back into the course. */
  withStudyNotes: boolean;
}

export interface CourseInput {
  name?: string;
  code?: string;
  term?: string;
  color?: Pencil;
}

export interface DocumentPatch {
  title?: string;
  role?: DocumentRole;
  courseId?: string;
  dueAt?: string | null;
}

export interface ImportResult {
  name: string;
  document?: DocumentView;
  duplicate?: boolean;
  error?: string;
}

export interface ConnectionView {
  connected: boolean;
  signingIn: boolean;
}

export interface ModelView {
  id: string;
  name: string;
  /** An earlier model, listed under "Older models". */
  older?: boolean;
}

/** A subscription and the models Folio offers through it. */
export interface SubscriptionView {
  provider: string;
  name: string;
  /** False until Folio can sign in to this subscription. */
  available: boolean;
  connected: boolean;
  models: ModelView[];
}

export interface DesktopBootstrap {
  connection: ConnectionView;
  /** The default model for new chats. */
  model: ModelView;
  subscriptions: SubscriptionView[];
  chats: ChatSummary[];
  /** Saved files that could not be read; they are preserved on disk. */
  unavailableChats: number;
  platform: string;
}

/**
 * How long the tutor thinks before it answers, from quick to thorough. Every offered model takes
 * all five (checked with one request each on a ChatGPT Pro plan, 2026-10-29); higher is slower
 * and uses more of the plan.
 */
export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];
export const DEFAULT_THINKING: Thinking = "high";

export interface SendInput {
  chatId: string | null;
  text: string;
  submissionId: string;
  /** For a new chat: the course it belongs to (null for a plain chat) and the page in view. */
  courseId?: string | null;
  focus?: Focus | null;
  /** For a new chat: one of the offered models; existing chats keep theirs. */
  modelId?: string | null;
  /** What the student added to the question with the composer's +. */
  attachments?: AttachmentInput[];
  /** How long the tutor thinks about this question; it applies from this question on. */
  thinking?: Thinking;
  /** Answer this question on OpenAI's faster tier, which uses more of the plan. */
  fast?: boolean;
}

export type DesktopEvent =
  | { type: "chat"; chat: ChatView }
  | { type: "stream"; chatId: string; text: string }
  /** A visual the tutor is still writing, sent as it arrives. */
  | { type: "visual"; chatId: string; visual: VisualView }
  | { type: "chats"; chats: ChatSummary[] }
  | { type: "library" }
  | { type: "job"; job: JobView }
  | { type: "jobRemoved"; id: string }
  | { type: "trash" }
  | { type: "connection"; connection: ConnectionView }
  | { type: "error"; chatId: string | null; message: string };

export interface FolioApi {
  bootstrap(): Promise<DesktopBootstrap>;
  openChat(id: string): Promise<ChatView>;
  /** Returns as soon as the chat exists; the reply arrives as events. */
  send(input: SendInput): Promise<{ chatId: string }>;
  cancel(chatId: string): Promise<void>;
  setFocus(chatId: string, focus: Focus | null): Promise<void>;
  signIn(): Promise<void>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  listCourses(): Promise<CourseView[]>;
  createCourse(input: CourseInput): Promise<CourseView>;
  updateCourse(id: string, patch: CourseInput, revision: number): Promise<CourseView>;
  listDocuments(courseId?: string): Promise<DocumentView[]>;
  /**
   * Copies files into the course; each result says whether it was imported, reused or refused.
   * Without a role, each file's role is guessed from its name.
   */
  importFiles(courseId: string, paths: string[], role?: DocumentRole): Promise<ImportResult[]>;
  /** Opens the system file picker, then imports what was chosen. */
  chooseFiles(courseId: string): Promise<ImportResult[]>;
  updateDocument(id: string, patch: DocumentPatch, revision: number): Promise<DocumentView>;
  /** The original's bytes, verified against the hash taken at import. */
  readDocument(id: string): Promise<Uint8Array>;
  listNotes(courseId?: string): Promise<NoteView[]>;
  readNote(id: string): Promise<NoteContent>;
  createNote(courseId: string, title: string): Promise<NoteView>;
  /** Refused when the note changed since `revision` (in Folio or another app). */
  saveNote(id: string, content: string, revision: string): Promise<NoteView>;
  /** Adds text at the end of the note as it is now. */
  appendToNote(id: string, text: string): Promise<NoteView>;
  listProposals(): Promise<ProposalView[]>;
  resolveProposal(id: string, action: ProposalAction): Promise<ProposalView>;
  /** Lists a folder's PDFs and Markdown; null opens the folder picker. Null when cancelled. */
  scanFolder(path: string | null): Promise<FolderScanView | null>;
  /** Reads a syllabus with the model; null opens the file picker. Null when cancelled. */
  readSyllabus(path: string | null): Promise<SyllabusDraft | null>;
  listJobs(): Promise<JobView[]>;
  /** Studies lectures and recitations of one course and adds the notes to it when done. */
  startIngest(courseId: string, documentIds: string[]): Promise<JobView>;
  pauseJob(id: string): Promise<JobView>;
  /** Continues a paused or interrupted job from its checkpoints; it spends plan usage. */
  resumeJob(id: string): Promise<JobView>;
  cancelJob(id: string): Promise<JobView>;
  /** Removes a finished, failed or paused job from the list. */
  dismissJob(id: string): Promise<void>;
  knowledge(courseId: string): Promise<KnowledgeView | null>;
  /** The current version's study notes in full; null before the course is studied. */
  studyNotes(courseId: string): Promise<StudyNotesView | null>;
  rollbackKnowledge(courseId: string): Promise<KnowledgeView>;
  /** Moves files to Folio's Trash; a studied file's study notes leave the course with it. */
  trashDocuments(ids: string[]): Promise<TrashEntryView[]>;
  /** Moves a note, with Folio's pending edits for it, to the Trash. */
  trashNote(id: string): Promise<TrashEntryView>;
  /** Refused while Folio is replying in the chat. */
  trashChat(id: string): Promise<TrashEntryView>;
  /** The course with its files, notes, chats and study notes. */
  trashCourse(id: string): Promise<TrashEntryView>;
  listTrash(): Promise<TrashEntryView[]>;
  /** Puts it back where it was. */
  restoreFromTrash(id: string): Promise<void>;
  /** Moves it on to the Mac's Trash, out of Folio. */
  deleteFromTrash(id: string): Promise<void>;
  emptyTrash(): Promise<void>;
  /** Hands a demo to the main process and returns the address its sealed frame loads. */
  registerArtifact(input: { source: string }): Promise<{ url: string }>;
  /** Saves a file the student made (a diagram as SVG) where they choose; false if they cancel. */
  saveFile(file: { name: string; type: "svg"; data: string }): Promise<boolean>;
  loadWorkspace(): Promise<unknown>;
  saveWorkspace(state: unknown): Promise<void>;
  /** The file-system path of a file dropped onto the window (local, not IPC). */
  pathForFile(file: File): string;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}

export type InvokeMethod = Exclude<keyof FolioApi, "onEvent" | "pathForFile">;
export type InvokeResult<T> = { ok: true; value: T } | { ok: false; error: string };
