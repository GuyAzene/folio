import type { AssignmentPatch, AssignmentRecord } from "../library/assignments.ts";
import type { Category } from "../library/categories.ts";
import type { ImportItem, NamingScope, Rename } from "../library/naming.ts";
import type { AppAction } from "../library/app-actions.ts";

/** A change the tutor proposed, as its card shows it. */
export interface PendingView {
  id: string;
  chatId: string;
  summary: string;
  state: "pending" | "applied" | "cancelled" | "failed";
  note: string | null;
  createdAt: string;
  /** What undoes it, once applied. */
  undo: AppAction | null;
}

/** A change the tutor made, as its card in the reply shows it. */
export interface ActionView {
  summary: string;
  undo: AppAction | null;
  courseId: string | null;
  documentId: string | null;
}
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
  /** Note edits Folio suggested in this turn, by proposal ID (chats from before 2026-10-29). */
  proposals?: string[];
  /** Notes the tutor created, changed or renamed in this turn. */
  noteEdits?: NoteEditView[];
  /** Changes the tutor made to Folio in this turn, each with its Undo. */
  actions?: ActionView[];
  /** Changes the tutor proposed in this turn that wait for the student, by ID. */
  pending?: string[];
  /** Pages the tutor's web searches found in this turn, listed apart from course sources. */
  webSources?: { url: string; title: string }[];
  /** What the student added to a question with the composer's +. */
  attachments?: AttachmentView[];
  /** Drawings and demos the tutor showed in this turn, each at its place in `text`. */
  visuals?: VisualView[];
  /** The routine the student started with this question (`/name`). */
  command?: CommandInput;
  /** Calls to the student's services in this reply that wait for their answer. */
  approvals?: ApprovalView[];
  /** "summary": where Folio summarized the chat so far for the tutor; shown as a divider. */
  kind?: "summary";
}

/** A call to one of the student's services that waits for them: Allow once, Always allow or Deny. */
export interface ApprovalView {
  id: string;
  chatId: string;
  label: string;
  tool: string;
  description: string;
  /** What the server says about its tool; shown, never trusted. */
  hints: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
  /** Exactly what Folio will send, as indented JSON. */
  args: string;
}

export type ApprovalDecision = "once" | "always" | "deny";
export type ToolRuleView = "ask" | "allow" | "off";

/** One of the student's MCP servers, as Settings shows it. No setting's or header's value is ever here. */
export interface McpServerView {
  id: string;
  label: string;
  kind: "local" | "remote";
  /** A local server's program; a remote one's address, with any query hidden. */
  command: string;
  args: string[];
  cwd: string | null;
  /** The names of its settings (environment) and headers; their values stay in the main process. */
  env: string[];
  headers: string[];
  enabled: boolean;
  /** "allow": every tool runs without asking. */
  approval: "ask" | "allow";
  status: "off" | "starting" | "ready" | "stopped" | "failed";
  error: string | null;
  /** The end of what it printed to its error output, its secrets hidden. */
  log: string;
  instructions: string | null;
  tools: {
    name: string;
    title: string | null;
    description: string;
    rule: ToolRuleView;
    hints: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
  }[];
  /** Prompts it offers while it runs, started with `/server:name`. */
  prompts: {
    name: string;
    title: string | null;
    description: string;
    arguments: { name: string; description: string; required: boolean }[];
  }[];
  /** An argument that looks like a key, which Settings shows in full. */
  argWarning: boolean;
}

export interface McpView {
  servers: McpServerView[];
  /** Entries in mcp.json Folio couldn't use, and why. */
  problems: string[];
}

/** A server to add or change; a setting's or header's null removes it, one left out stays. */
export interface McpServerInput {
  id: string;
  label?: string;
  command?: string;
  args?: string[];
  cwd?: string | null;
  url?: string;
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
}

/**
 * What a question starts with `/`: one of the student's routines (`/name`), or a prompt one of
 * their services offers (`/server:name`) with their answers to its arguments. The question's
 * text starts with it.
 */
export type CommandInput =
  | { kind: "skill"; name: string }
  | {
      kind: "prompt";
      server: string;
      name: string;
      args: Record<string, string>;
      /** The service's name, shown on the question; Folio fills it in. */
      label?: string;
    };

/** One of the student's routines (Agent Skills), as Settings lists it. */
export interface SkillView {
  /** Its folder, with ~ for the home folder. */
  key: string;
  name: string;
  description: string;
  source: "folio" | "folder";
  /** Where it came from: "Folio", or a folder the student added. */
  from: string;
  on: boolean;
  /** False when only the student starts it. */
  model: boolean;
  /** False when it isn't one to start with `/name`. */
  user: boolean;
  /** Another routine that is on with the same name, which is used instead. */
  hiddenBy?: string;
  note?: string;
  /** Tools it asks for in other agents; Folio grants none. */
  allowedTools?: string;
}

export interface SkillsView {
  skills: SkillView[];
  /** SKILL.md files Folio couldn't use, and why. */
  skipped: { key: string; from: string; reason: string }[];
  /** Folders of routines the student added. */
  folders: string[];
  /** Folio's own routines folder. */
  folder: string;
}

/** An assignment as the board shows it. */
export type AssignmentView = Omit<AssignmentRecord, "version">;
export type { AssignmentPatch };

/** A change the tutor made to the student's notes, with what Undo puts back. */
export interface NoteEditView {
  action: "created" | "edited" | "renamed";
  noteId: string;
  title: string;
  /** The revision before the change (null for a new note), and the one it made. */
  before: string | null;
  after: string;
}

/** One kept earlier version of a note. */
export interface NoteVersionView {
  revision: string;
  at: string;
  /** Who made the change that replaced this version. */
  author: "student" | "tutor";
  title: string;
  characters: number;
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
  | { kind: "course"; courseId: string }
  | { kind: "file"; name: string; pages: number | null };

/** Something the student adds to a question: a page, their own image, a lecture or a course. */
export type AttachmentInput =
  | { kind: "page"; documentId: string; page: number }
  | { kind: "image"; name: string; data: Uint8Array }
  | { kind: "document"; documentId: string }
  | { kind: "course"; courseId: string }
  /** A PDF or Markdown file of their own, by its path on this Mac. */
  | { kind: "file"; path: string };

/** Plain (no sources), library (any of the student's courses) or course (one course). */
export type ChatKind = "chat" | "library" | "course";

export interface ChatView {
  id: string;
  kind: ChatKind;
  title: string;
  status: SessionStatus;
  /** The chat's model, as a `connection/model` reference; a saved chat keeps it. */
  model: string;
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
  /** The document a course chat was last beside, at its page; it reopens there. */
  focus: Focus | null;
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
  /** The student's category for it; null for files from before categories, shown by role. */
  category: string | null;
  /** Whatever orders it in its category, such as its week; null until Folio has numbered it. */
  number: number | null;
  /** Whether its title follows its category's naming pattern, or is its own. */
  named: "pattern" | "own";
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
  /** The text after the title, on one line, for a list. */
  preview: string;
  tags: string[];
  /** Titles of the notes it links to. */
  links: string[];
  /** Documents it cites a page of. */
  cites: string[];
}

/** A note that matches a search, with the line that matched. */
export interface NoteHitView {
  noteId: string;
  snippet: string;
}

/** Another note that mentions this one: lines that link to it, and lines that only name it. */
export interface NoteMentionsView {
  noteId: string;
  title: string;
  revision: string;
  linked: { line: number; text: string }[];
  unlinked: { line: number; text: string }[];
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
  /** The category its name points to, by id. */
  category: string;
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
  | "fix"
  | "recheck"
  | "ledger"
  | "publish";

/** The note on a step whose saved result was used again, so it made no request. */
export const REUSED_STEP = "Reused from an earlier run.";

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
  /** Regions whose facts the checker looked for in the notes. */
  regions?: number;
  /** Regions still unplaced after fixing: a record for diagnosis, never shown as such. */
  uncovered?: number;
  /** What the first check found to fix, and how many of those fixing settled. */
  discrepancies?: number;
  fixed?: number;
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
  /** Studying documents, or regrouping a course's existing notes into shared topics. */
  kind: "ingest" | "regroup";
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
  /** Every topic this session writes into, in slide order: its anchor page's outline. */
  topics: string[];
  /** The slide-order outline: which topic each run of pages feeds. */
  outline: { topic: string; pages: number[] }[];
  /** Topics no other session of the course teaches. */
  onlyHere: string[];
  /** The document's own symbols and what they mean. */
  notation: { symbol: string; meaning: string }[];
}

export interface StudyTopicView {
  slug: string;
  title: string;
  type: "concept" | "technique";
  intuition: string;
  /** For a topic taught in several sessions: a short overview that cites the sections it uses. */
  overview: { text: string; handles: string[] } | null;
  /** The session that introduced the topic. */
  introducedIn: string;
  /** Every session that teaches it, in course order. */
  taughtIn: { session: string; documentId: string; type: "lecture" | "recitation" }[];
  /** Topics this one builds on, and topics that build on it; only ones the course has. */
  prerequisites: { slug: string; title: string }[];
  usedBy: { slug: string; title: string }[];
  /** Topics this one is part of, has as parts, or is taught alongside. */
  related: { slug: string; title: string; relation: "part_of" | "has_part" | "related" }[];
  /** In teaching order: definitions, properties, technique, examples, the rest. */
  sections: StudySectionView[];
}

export interface StudySectionView {
  handle: string;
  title: string;
  kind: string;
  /** Markdown, possibly with TeX math. */
  body: string;
  session: string;
  documentId: string;
  /** The same statement in other sessions, folded into this one with their own pages. */
  alsoIn: { handle: string; documentId: string; pages: number[]; body: string }[];
  /** Slide pages the section was written from. */
  pages: number[];
  questions: string[];
}

/** Something in Folio's Trash. */
export interface TrashEntryView {
  id: string;
  kind: "document" | "note" | "chat" | "course" | "assignment";
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
  /** A category brings its kind as the role. */
  category?: string;
  number?: number;
  /** "pattern" names it by its category's pattern again; a title given by hand makes it "own". */
  named?: "pattern" | "own";
  courseId?: string;
  dueAt?: string | null;
}

export interface ImportResult {
  name: string;
  document?: DocumentView;
  duplicate?: boolean;
  error?: string;
}

/** The ChatGPT plan, or a service Folio reaches with the student's own API key. */
export interface ConnectionView {
  /** "chatgpt", "openai", "anthropic", "google" or "openrouter". */
  id: string;
  name: string;
  /** The plan signs in through the browser; the others take an API key. */
  kind: "plan" | "key";
  connected: boolean;
  /** The ChatGPT sign-in is waiting for the browser. */
  signingIn: boolean;
}

export interface ModelView {
  /** A `connection/model` reference, such as "chatgpt/gpt-6.1-sol". */
  ref: string;
  name: string;
  /** An earlier model, listed under "Older models". */
  older?: boolean;
  /** False for a model that reads text only: it can't see a page or an image. */
  images: boolean;
  /** OpenRouter: the lab that made the model, by which the composer groups them. */
  lab?: string;
}

/** A connection and the models the composer offers through it. */
export interface ModelGroupView {
  connection: string;
  name: string;
  connected: boolean;
  models: ModelView[];
}

/**
 * What each model does, as the student set it in Settings or config.json: the tutor's model for
 * new chats, web search, each study step, and reading a syllabus.
 */
export const MODEL_ROLES = [
  "teaching",
  "research",
  "planner",
  "reader",
  "closeup",
  "writer",
  "checker",
  "rechecker",
  "topics",
  "syllabus",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Roles whose model must see pages: the study steps that read slides. The others may read text
 * only; a text-only tutor gets a note where a page image would be, and reads the page's text.
 */
export const IMAGE_ROLES: readonly ModelRole[] = [
  "planner",
  "reader",
  "closeup",
  "checker",
  "rechecker",
];

/** The roles studying uses: a study starts only once each one's connection is there. */
export const STUDY_ROLES: readonly ModelRole[] = [
  "planner",
  "reader",
  "closeup",
  "writer",
  "checker",
  "rechecker",
];

export interface ModelsView {
  connections: ConnectionView[];
  groups: ModelGroupView[];
  /** Each role's model, as a reference: config.json's when Folio can use it, else the default. */
  roles: Record<ModelRole, string>;
  /** Entries of config.json Folio could not use, each saying why; their defaults apply. */
  problems: string[];
  /** The OpenRouter models the composer offers. */
  openrouter: string[];
  /** The student's kinds of course file, in their order, from config.json. */
  categories: Category[];
  /** How files are named when their category has no pattern of its own; null keeps names. */
  naming: string | null;
}

export interface DesktopBootstrap {
  models: ModelsView;
  chats: ChatSummary[];
  /** Saved files that could not be read; they are preserved on disk. */
  unavailableChats: number;
  platform: string;
}

/**
 * How long the tutor thinks before it answers, from quick to thorough. Every ChatGPT model takes
 * all five (checked with one request each on a ChatGPT Pro plan, 2026-10-29); Pi brings a level
 * another model lacks to its nearest one. Higher is slower and costs more.
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
  /** For a new chat: an offered model's reference; existing chats keep theirs. */
  model?: string | null;
  /** What the student added to the question with the composer's +. */
  attachments?: AttachmentInput[];
  /** How long the tutor thinks about this question; it applies from this question on. */
  thinking?: Thinking;
  /** Answer this question on OpenAI's faster tier, which costs more. OpenAI models only. */
  fast?: boolean;
  /** False when the student turned web search off in Settings. */
  webSearch?: boolean;
  /** A routine the question starts; its text starts with `/name`. */
  command?: CommandInput;
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
  /** Connections, the composer's models or config.json changed. */
  | { type: "models"; models: ModelsView }
  /** A server started, stopped or changed its tools, or mcp.json changed. */
  | { type: "mcp"; mcp: McpView }
  /** Calls to services that wait for the student, in every chat. */
  | { type: "approvals"; approvals: ApprovalView[] }
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
  /** Checks the key with its provider, then keeps it in Folio's key file. */
  saveKey(connection: string, key: string): Promise<void>;
  removeKey(connection: string): Promise<void>;
  /** Sets one role's model in config.json; refused when the file changed outside Folio. */
  setRoleModel(role: ModelRole, ref: string): Promise<void>;
  /** Sets which OpenRouter models the composer offers, in config.json. */
  setOpenRouterModels(ids: string[]): Promise<void>;
  /**
   * Saves the student's categories in config.json. Refused when a category some file uses would
   * go, or change its kind.
   */
  setCategories(categories: Category[]): Promise<void>;
  /** Sets the library's naming pattern in config.json; null keeps files' own names. */
  setNaming(pattern: string | null): Promise<void>;
  /** The files a pattern would rename in a course, a category or both, and to what. */
  renames(scope: NamingScope): Promise<Rename[]>;
  /** Names those files by their pattern from now on; returns what they were called, for Undo. */
  applyNaming(scope: NamingScope): Promise<Rename[]>;
  /** Puts back names a pattern rename replaced; returns how many it could. */
  undoNaming(renames: Rename[]): Promise<number>;
  /** Changes the tutor proposed, waiting for the student or answered. */
  listPending(): Promise<PendingView[]>;
  /** Applies or cancels a proposed change; applying checks it again first. */
  resolvePending(id: string, apply: boolean): Promise<PendingView>;
  /** Undoes a change the tutor made, refused when what it changed has changed since. */
  undoAction(undo: AppAction): Promise<string>;
  /** Every OpenRouter model Folio can use, for picking the composer's. */
  openrouterCatalog(): Promise<ModelView[]>;
  /** Shows config.json in Finder, writing today's choices to it first if it doesn't exist. */
  revealConfig(): Promise<void>;
  /** The student's routines from every folder Folio reads, and the ones it couldn't. */
  listSkills(): Promise<SkillsView>;
  /** Turns a routine on or off, by its folder's key, in config.json. */
  setSkillOn(key: string, on: boolean): Promise<SkillsView>;
  /** Makes a routine in Folio's own folder. */
  createSkill(input: { name: string; description: string; body: string }): Promise<SkillsView>;
  /** One of Folio's own routines' SKILL.md, to edit. */
  readSkill(name: string): Promise<{ text: string; revision: string }>;
  /** Saves it; refused when it changed since `revision` or no longer reads as a routine. */
  saveSkill(name: string, text: string, revision: string): Promise<SkillsView>;
  /** Opens the folder picker and adds a folder of routines; null when cancelled. */
  addSkillFolder(): Promise<SkillsView | null>;
  removeSkillFolder(key: string): Promise<SkillsView>;
  /** Shows a routine (or Folio's routines folder) in Finder. */
  revealSkill(key: string | null): Promise<void>;
  /** The student's MCP servers and how each is doing. */
  mcpServers(): Promise<McpView>;
  /** Adds the servers in a block pasted from a README or another app, each off until turned on. */
  addMcpServers(text: string): Promise<McpView>;
  /** Adds a server, or changes one named `previous`; a new one is off until turned on. */
  saveMcpServer(input: McpServerInput, previous: string | null): Promise<McpView>;
  removeMcpServer(id: string): Promise<McpView>;
  setMcpServerOn(id: string, on: boolean): Promise<McpView>;
  restartMcpServer(id: string): Promise<McpView>;
  /** "allow" lets every tool of the server run without asking. */
  setMcpServerApproval(id: string, approval: "ask" | "allow"): Promise<McpView>;
  setMcpToolRule(id: string, tool: string, rule: ToolRuleView): Promise<McpView>;
  /** Shows mcp.json in Finder. */
  revealMcpConfig(): Promise<void>;
  /** Calls to services waiting for the student, in every chat. */
  listApprovals(): Promise<ApprovalView[]>;
  /** The student's answer to a waiting call; refused when it no longer waits. */
  answerApproval(id: string, decision: ApprovalDecision): Promise<void>;
  listCourses(): Promise<CourseView[]>;
  createCourse(input: CourseInput): Promise<CourseView>;
  updateCourse(id: string, patch: CourseInput, revision: number): Promise<CourseView>;
  listDocuments(courseId?: string): Promise<DocumentView[]>;
  /**
   * Copies files into the course; each result says whether it was imported, reused or refused.
   * Without a role or a category, each file's category is guessed from its name.
   */
  importFiles(
    courseId: string,
    files: ImportItem[],
    role?: DocumentRole,
    category?: string,
  ): Promise<ImportResult[]>;
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
  /** Notes whose title or text has every word of the query, best first. */
  searchNotes(query: string, courseId?: string | null): Promise<NoteHitView[]>;
  /** The course's other notes that link to this note or name it. */
  noteMentions(id: string): Promise<NoteMentionsView[]>;
  /** Links the first plain mention of `target` in `source`; refused when `source` changed. */
  linkMention(source: string, target: string, revision: string): Promise<NoteView>;
  /** The note's kept earlier versions, newest first. */
  noteHistory(id: string): Promise<NoteVersionView[]>;
  listAssignments(): Promise<AssignmentView[]>;
  createAssignment(input: {
    courseId: string;
    title: string;
    kind?: AssignmentRecord["kind"];
    dueAt?: string | null;
    dueHasTime?: boolean;
  }): Promise<AssignmentView>;
  /** Refused when the assignment changed since `revision`. */
  updateAssignment(id: string, patch: AssignmentPatch, revision: number): Promise<AssignmentView>;
  /**
   * Opens the file picker and keeps the chosen files with the assignment, as a new submission or
   * as returned feedback; null when cancelled.
   */
  addAssignmentFiles(
    id: string,
    into: "attempt" | "feedback",
    revision: number,
    note?: string,
  ): Promise<AssignmentView | null>;
  /** Opens a kept file in the app the Mac uses for it. */
  openAssignmentFile(id: string, fileId: string): Promise<void>;
  trashAssignment(id: string): Promise<TrashEntryView>;
  /** Brings back an earlier version as a new one; refused when the note changed since `revision`. */
  restoreNote(id: string, version: string, revision: string): Promise<NoteView>;
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
