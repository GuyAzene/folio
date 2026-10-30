import type {
  AttachmentInput,
  AttachmentView,
  ChatMessageView,
  ChatSummary,
  ChatView,
  ConnectionView,
  CourseInput,
  CourseView,
  DesktopEvent,
  DocumentPatch,
  DocumentView,
  FolioApi,
  Focus,
  JobView,
  KnowledgeView,
  ImportResult,
  ModelRole,
  ModelsView,
  ModelView,
  AssignmentPatch,
  AssignmentView,
  NoteEditView,
  NoteVersionView,
  NoteView,
  SourceView,
  ProposalAction,
  ProposalView,
  StudyNotesView,
  Thinking,
  TrashEntryView,
} from "../../src/desktop/api.ts";
import { DEFAULT_THINKING, STUDY_ROLES, THINKING_LEVELS } from "../../src/desktop/api.ts";
import { chatTitle } from "../../src/chat-title.ts";
import { citationLink } from "../../src/library/note-meta.ts";
import { courseTab, type CourseTab } from "./course-tabs.ts";
import { shortTitle } from "./titles.ts";

export type { CourseTab };
export type ThemePreference = "system" | "light" | "dark";
export type SettingsSection = "general" | "connections" | "models";
/** Folio beside a document, Folio full screen over it, or reading alone. */
export type PanelMode = "docked" | "full" | "closed";

export type Location =
  | { view: "home" }
  | { view: "library" }
  | { view: "chats" }
  | { view: "assignments" }
  | { view: "jobs" }
  | { view: "trash" }
  | { view: "course"; courseId: string; tab: CourseTab }
  | {
      view: "document";
      documentId: string;
      page: number;
      panel: PanelMode;
      chatId: string | null;
      /** What the panel beside the document shows: Folio's chat (the default) or a note. */
      side?: "chat" | "note";
      /** The note open beside the document; none picked yet when null. */
      noteId?: string | null;
    }
  /** The notebook: every note, or one course's, with one open beside the list. */
  | { view: "notes"; noteId: string | null; courseId: string | null }
  /** A course's study notes, open at "topic:<slug>", "session:<slug>", or the first session. */
  | { view: "study"; courseId: string; item: string | null }
  | { view: "chat"; chatId: string | null; courseId: string | null };

/** A question asked before something hard to undo, answered in a dialog. */
export interface Confirmation {
  title: string;
  body: string;
  action: string;
  run: () => Promise<void>;
}

export interface Tab {
  id: string;
  history: Location[];
  index: number;
}

/** The last place a citation asked the reader to go; the nonce makes repeats count. */
export interface Jump {
  documentId: string;
  page: number;
  nonce: number;
}

const HOME: Location = { view: "home" };

/** Something added in the composer: what is sent, and how the question shows it meanwhile. */
export interface Added {
  key: string;
  input: AttachmentInput;
  view: AttachmentView;
}

/**
 * The main process receives arguments by structured clone, which refuses Svelte's state
 * proxies ("An object could not be cloned."). Every call sends plain snapshots instead, so a
 * value read from state can be passed as it is. The bridge object is frozen, so this copies
 * its methods rather than proxying it.
 */
function plainCalls(api: FolioApi): FolioApi {
  const calls: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(api))
    calls[key] =
      typeof value === "function" && key !== "onEvent" && key !== "pathForFile"
        ? (...args: unknown[]) =>
            (value as (...args: unknown[]) => unknown).apply(
              api,
              args.map((arg) => $state.snapshot(arg)),
            )
        : value;
  return calls as unknown as FolioApi;
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}
function newId(): string {
  return crypto.randomUUID();
}

class FolioState {
  ready = $state(false);
  platform = $state("darwin");
  /** Connections, the composer's models and what each role uses, as the main process says. */
  models = $state<ModelsView>({
    connections: [],
    groups: [],
    roles: {} as ModelsView["roles"],
    problems: [],
    openrouter: [],
  });
  /** How long the tutor thinks, for every chat, from the next question on. */
  thinking = $state<Thinking>(DEFAULT_THINKING);
  /** Questions go on OpenAI's faster tier, which costs more. OpenAI models only. */
  fast = $state(false);
  /** The tutor may search the web; off only when the student turns it off in Settings. */
  webSearch = $state(true);
  error = $state<string | null>(null);
  notice = $state<string | null>(null);
  /** A button on the notice, such as Undo after moving something to the Trash. */
  noticeAction = $state<{ label: string; run: () => void } | null>(null);
  confirming = $state<Confirmation | null>(null);
  /** Folio's Trash, most recently removed first. */
  trash = $state<TrashEntryView[]>([]);
  settingsOpen = $state(false);
  settingsSection = $state<SettingsSection>("general");
  paletteOpen = $state(false);
  /** The ⌘O note switcher. */
  switcherOpen = $state(false);
  /** A note just created, which opens with its title selected. */
  freshNoteId: string | null = null;
  newCourseOpen = $state(false);
  sidebarOpen = $state(true);
  theme = $state<ThemePreference>("light");
  /** The theme on screen now, "system" resolved; demos and drawings follow it. */
  shownTheme = $state<"light" | "dark">("light");

  courses = $state<CourseView[]>([]);
  documents = $state<DocumentView[]>([]);
  notes = $state<NoteView[]>([]);
  /** Notes pinned to the top of the notebook and to the sidebar, on this device. */
  pinnedNotes = $state<string[]>(this.#savedPins());
  assignments = $state<AssignmentView[]>([]);
  /** Background jobs, newest first; each carries its agent tree. */
  jobs = $state<JobView[]>([]);
  /** Each course's published knowledge, or null before its first publication. */
  knowledge = $state<Record<string, KnowledgeView | null>>({});
  /** Study notes loaded so far, by course; each is refetched when its version changes. */
  studyNotes = $state<Record<string, StudyNotesView | null>>({});
  proposals = $state<ProposalView[]>([]);
  /** Edits Folio suggested that wait for the student. */
  needsYou = $derived(this.proposals.filter((proposal) => proposal.state === "pending"));
  chats = $state<ChatSummary[]>([]);
  unavailableChats = $state(0);
  /** Loaded chats by ID. */
  chatViews = $state<Record<string, ChatView>>({});
  /** A new chat's optimistic view, by tab, until Folio assigns its ID. */
  pending = $state<Record<string, ChatView>>({});
  jump = $state<Jump | null>(null);

  tabs = $state<Tab[]>([{ id: newId(), history: [HOME], index: 0 }]);
  activeTabId = $state("");
  activeTab = $derived(this.tabs.find((tab) => tab.id === this.activeTabId) ?? this.tabs[0]!);
  location = $derived(this.activeTab.history[this.activeTab.index] ?? HOME);

  #api: FolioApi | null = null;
  #awaiting: string[] = [];
  /** Each assignment's latest pending save, resolving to the revision it left. */
  #assignmentSaves = new Map<string, Promise<number>>();
  /** Each document's latest pending save, resolving to the revision it left. */
  #documentSaves = new Map<string, Promise<number>>();
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #libraryTimer: ReturnType<typeof setTimeout> | undefined;
  #nonce = 0;

  get api(): FolioApi {
    return this.#api!;
  }

  async init(bridge: FolioApi): Promise<void> {
    const api = plainCalls(bridge);
    this.#api = api;
    this.activeTabId = this.tabs[0]!.id;
    this.#loadTheme();
    api.onEvent((event) => this.#onEvent(event));
    try {
      const boot = await api.bootstrap();
      this.platform = boot.platform;
      this.models = boot.models;
      this.#adoptSavedModel();
      this.thinking = this.#savedThinking() ?? DEFAULT_THINKING;
      this.fast = this.#savedFast();
      this.webSearch = this.#savedFlag("folio.webSearch") ?? true;
      this.chats = boot.chats;
      this.unavailableChats = boot.unavailableChats;
      await this.refreshLibrary();
      this.jobs = await api.listJobs();
      this.trash = await api.listTrash();
      await this.#restoreWorkspace();
    } catch (error) {
      this.error = message(error);
    }
    this.ready = true;
  }

  // ── Lookups ─────────────────────────────────────────────────────────────

  /** The course the open place belongs to, if any: where a new note or chat would go. */
  get currentCourseId(): string | null {
    const location = this.location;
    switch (location.view) {
      case "course":
      case "study":
        return location.courseId;
      case "chat":
        return location.courseId;
      case "notes":
        return location.courseId ?? this.note(location.noteId)?.courseId ?? null;
      case "document":
        return this.document(location.documentId)?.courseId ?? null;
      default:
        return null;
    }
  }

  course(id: string | null | undefined): CourseView | undefined {
    return id ? this.courses.find((course) => course.id === id) : undefined;
  }
  document(id: string | null | undefined): DocumentView | undefined {
    return id ? this.documents.find((document) => document.id === id) : undefined;
  }
  note(id: string | null | undefined): NoteView | undefined {
    return id ? this.notes.find((note) => note.id === id) : undefined;
  }
  proposal(id: string): ProposalView | undefined {
    return this.proposals.find((proposal) => proposal.id === id);
  }
  /** The model new chats start with, config.json's teaching model; each chat keeps its own. */
  get modelChoice(): string {
    return this.models.roles.teaching ?? "";
  }
  connection(id: string): ConnectionView | undefined {
    return this.models.connections.find((connection) => connection.id === id);
  }
  /** The connection a `connection/model` reference names. */
  connectionFor(ref: string): ConnectionView | undefined {
    return this.connection(ref.slice(0, ref.indexOf("/")));
  }
  model(ref: string): ModelView | undefined {
    for (const group of this.models.groups)
      for (const model of group.models) if (model.ref === ref) return model;
    return undefined;
  }
  modelName(ref: string): string {
    return this.model(ref)?.name ?? ref.slice(ref.indexOf("/") + 1);
  }
  /** Whether Folio has the sign-in or key a model needs. */
  canUse(ref: string): boolean {
    return !!this.connectionFor(ref)?.connected;
  }
  /** OpenAI's faster tier exists only for its models, on the plan or a key. */
  fastFor(ref: string): boolean {
    return ref.startsWith("chatgpt/") || ref.startsWith("openai/");
  }
  /** The first connection studying uses that Folio lacks, or null when it has them all. */
  get studyMissing(): string | null {
    for (const role of STUDY_ROLES) {
      const connection = this.connectionFor(this.models.roles[role] ?? "");
      if (connection && !connection.connected) return connection.name;
    }
    return null;
  }
  openSettings(section: SettingsSection = "general"): void {
    this.settingsSection = section;
    this.settingsOpen = true;
  }
  chatFor(chatId: string | null, tabId: string): ChatView | null {
    return chatId ? (this.chatViews[chatId] ?? null) : (this.pending[tabId] ?? null);
  }
  running(chat: ChatView | null): boolean {
    return chat?.messages.at(-1)?.state === "streaming";
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  navigate(location: Location, options: { newTab?: boolean } = {}): void {
    if (options.newTab) {
      this.openTab(location);
      return;
    }
    const tab = this.activeTab;
    tab.history = [...tab.history.slice(0, tab.index + 1), location];
    tab.index = tab.history.length - 1;
    this.#changed();
  }

  /** Changes the current place without adding a history step (the page you are on, panel mode). */
  update(patch: Partial<Location>, tabId = this.activeTabId): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    tab.history[tab.index] = { ...tab.history[tab.index]!, ...patch } as Location;
    this.#changed();
  }

  locationOf(tabId: string): Location {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    return tab?.history[tab.index] ?? HOME;
  }

  back(): void {
    if (this.activeTab.index > 0) this.activeTab.index--;
    this.#changed();
  }
  forward(): void {
    if (this.activeTab.index < this.activeTab.history.length - 1) this.activeTab.index++;
    this.#changed();
  }

  openTab(location: Location = HOME): void {
    const tab: Tab = { id: newId(), history: [location], index: 0 };
    const at = this.tabs.findIndex((candidate) => candidate.id === this.activeTabId);
    this.tabs.splice(at + 1, 0, tab);
    this.activeTabId = tab.id;
    this.#changed();
  }

  closeTab(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    delete this.pending[id];
    if (this.tabs.length === 1) {
      this.tabs = [{ id: newId(), history: [HOME], index: 0 }];
      this.activeTabId = this.tabs[0]!.id;
    } else {
      this.tabs.splice(index, 1);
      if (this.activeTabId === id)
        this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)]!.id;
    }
    this.#changed();
  }

  selectTab(id: string): void {
    if (this.tabs.some((tab) => tab.id === id)) this.activeTabId = id;
    this.#changed();
  }

  moveTab(from: number, to: number): void {
    const [tab] = this.tabs.splice(from, 1);
    if (tab) this.tabs.splice(to, 0, tab);
    this.#changed();
  }

  /** Opens a document, reusing a tab that already shows it, and goes to the page. */
  openDocument(
    documentId: string,
    page = 1,
    options: { newTab?: boolean; chatId?: string | null } = {},
  ): void {
    const existing = this.tabs.find((tab) => {
      const location = tab.history[tab.index];
      return location?.view === "document" && location.documentId === documentId;
    });
    if (existing && !options.newTab) {
      this.activeTabId = existing.id;
      this.update({ page } as Partial<Location>, existing.id);
    } else {
      this.navigate(
        { view: "document", documentId, page, panel: "docked", chatId: options.chatId ?? null },
        { newTab: options.newTab },
      );
    }
    this.jump = { documentId, page, nonce: ++this.#nonce };
  }

  /**
   * Opens a note in the notebook, reusing a tab that already shows the notebook. Its course
   * filter stays when the note belongs to that course.
   */
  openNote(noteId: string, options: { newTab?: boolean; courseId?: string | null } = {}): void {
    const courseOf = this.note(noteId)?.courseId ?? null;
    const existing = options.newTab
      ? undefined
      : (this.tabs.find(
          (tab) => tab.id === this.activeTabId && tab.history[tab.index]?.view === "notes",
        ) ?? this.tabs.find((tab) => tab.history[tab.index]?.view === "notes"));
    const shown = existing?.history[existing.index];
    const filter =
      options.courseId !== undefined
        ? options.courseId
        : shown?.view === "notes" && shown.courseId === courseOf
          ? courseOf
          : null;
    if (existing) {
      this.selectTab(existing.id);
      if (shown?.view === "notes" && shown.noteId === noteId && shown.courseId === filter) return;
    }
    this.navigate({ view: "notes", noteId, courseId: filter }, { newTab: options.newTab });
  }

  togglePin(noteId: string): void {
    this.pinnedNotes = this.pinnedNotes.includes(noteId)
      ? this.pinnedNotes.filter((id) => id !== noteId)
      : [noteId, ...this.pinnedNotes];
    try {
      localStorage.setItem("folio.pinnedNotes", JSON.stringify(this.pinnedNotes));
    } catch {
      // A per-device convenience; pins last until Folio closes.
    }
  }

  #savedPins(): string[] {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("folio.pinnedNotes") ?? "[]");
      return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  /** Opens a course's study notes at a topic or session, reusing a tab that shows them. */
  openStudyNotes(
    courseId: string,
    item: string | null = null,
    options: { newTab?: boolean } = {},
  ): void {
    const existing = this.tabs.find((tab) => {
      const location = tab.history[tab.index];
      return location?.view === "study" && location.courseId === courseId;
    });
    if (existing && !options.newTab) {
      this.selectTab(existing.id);
      if ((this.location as { item?: string | null }).item !== item)
        this.navigate({ view: "study", courseId, item });
    } else this.navigate({ view: "study", courseId, item }, options);
  }

  /**
   * Text for the message box, offered by a demo's button or "Ask the tutor to fix this": the
   * student reads it and chooses whether to send. Composers pick it up; see Composer.svelte.
   */
  prefill = $state<{ text: string; chatId: string } | null>(null);

  offerQuestion(chatId: string, text: string): void {
    this.prefill = { text: text.slice(0, 1000), chatId };
  }

  /** The address a demo's sealed frame loads; empty where demos can't run (the browser preview). */
  async demoUrl(source: string): Promise<string> {
    if (!this.#api) return "";
    return (await this.#api.registerArtifact({ source })).url;
  }

  /** Loads the course's current study notes unless the loaded ones are already current. */
  async loadStudyNotes(courseId: string): Promise<void> {
    const generation = this.knowledge[courseId]?.generation ?? null;
    const loaded = this.studyNotes[courseId];
    if (loaded !== undefined && (loaded?.generation ?? null) === generation) return;
    try {
      this.studyNotes[courseId] = await this.#api!.studyNotes(courseId);
    } catch (error) {
      this.error = message(error);
    }
  }

  newChat(courseId: string | null = null): void {
    this.navigate({ view: "chat", chatId: null, courseId });
  }

  // ── Chats ───────────────────────────────────────────────────────────────

  async loadChat(id: string): Promise<void> {
    if (this.chatViews[id]) return;
    try {
      this.chatViews[id] = await this.#api!.openChat(id);
    } catch (error) {
      this.error = message(error);
    }
  }

  /**
   * Sends from a tab's chat (a full chat or the panel beside a document). Shows the message at
   * once; returns null (keep the draft) if Folio did not accept it.
   */
  async send(
    text: string,
    context: {
      tabId: string;
      chatId: string | null;
      courseId: string | null;
      focus: Focus | null;
      /** What the student added with the composer's +. */
      attachments?: Added[];
    },
  ): Promise<string | null> {
    if (!this.#api) return null;
    const added = context.attachments ?? [];
    const sent: ChatMessageView[] = [
      {
        role: "user",
        text,
        state: "complete",
        ...(added.length ? { attachments: added.map((item) => item.view) } : {}),
      },
      { role: "assistant", text: "", state: "streaming", steps: [], sources: [] },
    ];
    const previous = context.chatId ? this.chatViews[context.chatId] : undefined;
    const reads = (before: ChatView["reads"]): ChatView["reads"] => ({
      courses: [
        ...new Set([
          ...before.courses,
          ...added.flatMap(({ input }) => (input.kind === "course" ? [input.courseId] : [])),
        ]),
      ],
      documents: [
        ...new Set([
          ...before.documents,
          ...added.flatMap(({ input }) => (input.kind === "document" ? [input.documentId] : [])),
        ]),
      ],
    });
    if (context.chatId && previous)
      this.chatViews[context.chatId] = {
        ...previous,
        status: "running",
        messages: [...previous.messages, ...sent],
        reads: previous.kind === "course" ? reads(previous.reads) : previous.reads,
      };
    else
      this.pending[context.tabId] = {
        id: "",
        kind: context.courseId ? "course" : "library",
        title: chatTitle(text),
        status: "running",
        model: this.modelChoice,
        updatedAt: new Date().toISOString(),
        courseId: context.courseId,
        focus: context.focus,
        messages: sent,
        reads: context.courseId
          ? reads({ courses: [], documents: [] })
          : { courses: [], documents: [] },
      };
    this.error = null;
    if (!context.chatId) this.#awaiting.push(context.tabId);
    try {
      const { chatId } = await this.#api.send({
        chatId: context.chatId,
        text,
        submissionId: crypto.randomUUID(),
        courseId: context.courseId,
        focus: context.focus,
        model: context.chatId ? null : this.modelChoice,
        thinking: this.thinking,
        ...(this.fast &&
        this.fastFor((context.chatId && this.chatViews[context.chatId]?.model) || this.modelChoice)
          ? { fast: true }
          : {}),
        ...(this.webSearch ? {} : { webSearch: false }),
        ...(added.length ? { attachments: added.map((item) => item.input) } : {}),
      });
      if (!context.chatId) this.#adopt(context.tabId, chatId);
      return chatId;
    } catch (error) {
      if (context.chatId && previous) this.chatViews[context.chatId] = previous;
      delete this.pending[context.tabId];
      this.error = message(error);
      return null;
    } finally {
      this.#awaiting = this.#awaiting.filter((id) => id !== context.tabId);
    }
  }

  cancel(chatId: string | null): void {
    if (chatId) void this.#api?.cancel(chatId);
  }

  setFocus(chatId: string | null, focus: Focus): void {
    if (chatId) void this.#api?.setFocus(chatId, focus).catch(() => undefined);
  }

  #adopt(tabId: string, chatId: string): void {
    const location = this.locationOf(tabId);
    if ((location.view === "chat" || location.view === "document") && location.chatId === null)
      this.update({ chatId } as Partial<Location>, tabId);
    if (!this.chatViews[chatId] && this.pending[tabId])
      this.chatViews[chatId] = { ...this.pending[tabId]!, id: chatId };
    delete this.pending[tabId];
  }

  // ── Library ─────────────────────────────────────────────────────────────

  async refreshLibrary(): Promise<void> {
    const [courses, documents, notes, proposals, assignments] = await Promise.all([
      this.#api!.listCourses(),
      this.#api!.listDocuments(),
      this.#api!.listNotes(),
      this.#api!.listProposals(),
      this.#api!.listAssignments(),
    ]);
    this.courses = courses;
    this.documents = documents;
    this.assignments = assignments;
    const knowledge = await Promise.all(
      courses.map(async (course) => [course.id, await this.#api!.knowledge(course.id)] as const),
    );
    this.knowledge = Object.fromEntries(knowledge);
    this.notes = notes;
    this.proposals = proposals;
  }

  async createCourse(input: CourseInput): Promise<CourseView | null> {
    try {
      const course = await this.#api!.createCourse(input);
      await this.refreshLibrary();
      return course;
    } catch (error) {
      this.error = message(error);
      return null;
    }
  }

  async updateCourse(course: CourseView, patch: CourseInput): Promise<void> {
    try {
      await this.#api!.updateCourse(course.id, patch, course.revision);
    } catch (error) {
      this.error = message(error);
    }
    await this.refreshLibrary();
  }

  async importFiles(
    courseId: string,
    paths: string[] | "choose",
    role?: DocumentView["role"],
  ): Promise<void> {
    try {
      const results =
        paths === "choose"
          ? await this.#api!.chooseFiles(courseId)
          : await this.#api!.importFiles(courseId, paths, role);
      await this.refreshLibrary();
      this.#reportImport(results);
    } catch (error) {
      this.error = message(error);
    }
  }

  // ── Trash ───────────────────────────────────────────────────────────────

  async refreshTrash(): Promise<void> {
    try {
      this.trash = await this.#api!.listTrash();
    } catch (error) {
      this.error = message(error);
    }
  }

  /** Moves files to the Trash and closes what showed them; the notice offers Undo. */
  async trashDocuments(ids: string[]): Promise<void> {
    const titles = ids.map((id) => this.document(id)?.title ?? "file");
    await this.#trash(
      () => this.#api!.trashDocuments(ids),
      (location) => location.view === "document" && ids.includes(location.documentId),
      ids.length === 1 ? `“${titles[0]}”` : `${ids.length} files`,
    );
  }

  async trashNote(id: string): Promise<void> {
    const title = this.note(id)?.title ?? "the note";
    await this.#trash(
      async () => [await this.#api!.trashNote(id)],
      () => false,
      `“${title}”`,
    );
    // The notebook stays open, with nothing selected where the note was.
    for (const tab of this.tabs)
      tab.history = tab.history.map((location) =>
        location.view === "notes" && location.noteId === id
          ? { ...location, noteId: null }
          : location,
      );
    this.#changed();
  }

  async trashChat(id: string): Promise<void> {
    const title = this.chats.find((chat) => chat.id === id)?.title ?? "the chat";
    await this.#trash(
      async () => [await this.#api!.trashChat(id)],
      (location) => location.view === "chat" && location.chatId === id,
      `“${title}”`,
    );
    delete this.chatViews[id];
  }

  /** Asks first: a course takes its files, notes, chats and study notes with it. */
  trashCourse(id: string): void {
    const course = this.course(id);
    if (!course) return;
    const files = this.documents.filter((document) => document.courseId === id).length;
    const notes = this.notes.filter((note) => note.courseId === id).length;
    const chats = this.chats.filter((chat) => chat.courseId === id).length;
    const parts = [
      files && `${files} file${files === 1 ? "" : "s"}`,
      notes && `${notes} note${notes === 1 ? "" : "s"}`,
      chats && `${chats} chat${chats === 1 ? "" : "s"}`,
    ].filter(Boolean);
    this.confirming = {
      title: `Move ${course.name} to the Trash?`,
      body: `${parts.length ? `Its ${parts.join(", ")} and study notes go with it. ` : ""}You can restore it from the Trash for 30 days.`,
      action: "Move to Trash",
      run: () =>
        this.#trash(
          async () => [await this.#api!.trashCourse(id)],
          (location) => {
            if ("courseId" in location && location.courseId === id) return true;
            if (location.view === "document")
              return this.document(location.documentId)?.courseId === id;
            if (location.view === "notes" && location.noteId)
              return this.note(location.noteId)?.courseId === id;
            return false;
          },
          course.name,
        ),
    };
  }

  async restoreFromTrash(id: string): Promise<void> {
    const entry = this.trash.find((item) => item.id === id);
    try {
      await this.#api!.restoreFromTrash(id);
      this.trash = this.trash.filter((item) => item.id !== id);
      this.noticeAction = null;
      this.notice = `Restored ${entry ? `“${entry.title}”` : "it"}`;
      await this.refreshLibrary();
    } catch (error) {
      this.error = message(error);
    }
  }

  deleteFromTrash(id: string): void {
    const entry = this.trash.find((item) => item.id === id);
    if (!entry) return;
    this.confirming = {
      title: `Delete “${entry.title}” from Folio?`,
      body: "It moves to your Mac's Trash. Emptying that Trash deletes it for good.",
      action: "Delete",
      run: async () => {
        await this.#api!.deleteFromTrash(id);
        this.trash = this.trash.filter((item) => item.id !== id);
      },
    };
  }

  emptyTrash(): void {
    const count = this.trash.length;
    if (!count) return;
    this.confirming = {
      title: "Empty Folio's Trash?",
      body: `${count === 1 ? "The item moves" : `All ${count} items move`} to your Mac's Trash. Emptying that Trash deletes ${count === 1 ? "it" : "them"} for good.`,
      action: "Empty Trash",
      run: async () => {
        await this.#api!.emptyTrash();
        this.trash = [];
      },
    };
  }

  async #trash(
    remove: () => Promise<TrashEntryView[]>,
    showed: (location: Location) => boolean,
    what: string,
  ): Promise<void> {
    try {
      const entries = await remove();
      this.#forget(showed);
      await this.refreshTrash();
      this.notice = `Moved ${what} to the Trash`;
      this.noticeAction = {
        label: "Undo",
        run: () => {
          for (const entry of entries) void this.restoreFromTrash(entry.id);
        },
      };
      await this.refreshLibrary();
    } catch (error) {
      this.error = message(error);
    }
  }

  /** Takes removed things out of every tab's history; a tab left with nothing goes home. */
  #forget(showed: (location: Location) => boolean): void {
    for (const tab of this.tabs) {
      const current = tab.history[tab.index];
      const kept = tab.history.filter((location) => !showed(location));
      if (kept.length === tab.history.length) continue;
      tab.history = kept.length ? kept : [HOME];
      const at = current ? tab.history.indexOf(current) : -1;
      tab.index = at >= 0 ? at : Math.min(tab.index, tab.history.length - 1);
    }
    this.#changed();
  }

  /** The assignment a handed-out document belongs to, if any. */
  assignmentFor(documentId: string): AssignmentView | undefined {
    return this.assignments.find((item) => item.documents.statement === documentId);
  }

  async createAssignment(
    courseId: string,
    title: string,
    kind?: AssignmentView["kind"],
    /** Quick-add from a column or a day: the card starts there. */
    start: { status?: AssignmentView["status"]; dueAt?: string } = {},
  ): Promise<AssignmentView | null> {
    try {
      let created = await this.#api!.createAssignment({
        courseId,
        title,
        ...(kind ? { kind } : {}),
        ...(start.dueAt ? { dueAt: start.dueAt } : {}),
      });
      if (start.status && start.status !== created.status)
        created = await this.#api!.updateAssignment(
          created.id,
          { status: start.status },
          created.revision,
        );
      await this.refreshLibrary();
      return created;
    } catch (error) {
      this.error = message(error);
      return null;
    }
  }

  /**
   * Saves a change to an assignment. Changes to one assignment go one at a time, each from the
   * revision the previous one returned, as for documents.
   */
  updateAssignment(assignment: AssignmentView, patch: AssignmentPatch): Promise<void> {
    const previous =
      this.#assignmentSaves.get(assignment.id) ?? Promise.resolve(assignment.revision);
    const saved = previous.then(async (known) => {
      const revision = Math.max(
        known,
        this.assignments.find((item) => item.id === assignment.id)?.revision ?? 0,
      );
      try {
        return (await this.#api!.updateAssignment(assignment.id, patch, revision)).revision;
      } catch (error) {
        this.error = message(error);
        return revision;
      }
    });
    this.#assignmentSaves.set(assignment.id, saved);
    return saved.then(async () => {
      if (this.#assignmentSaves.get(assignment.id) === saved)
        this.#assignmentSaves.delete(assignment.id);
      await this.refreshLibrary();
    });
  }

  async addAssignmentFiles(
    assignment: AssignmentView,
    into: "attempt" | "feedback",
    note = "",
  ): Promise<void> {
    try {
      const updated = await this.#api!.addAssignmentFiles(
        assignment.id,
        into,
        assignment.revision,
        note,
      );
      if (updated) this.notice = into === "attempt" ? "Submission kept" : "Feedback kept";
    } catch (error) {
      this.error = message(error);
    }
    await this.refreshLibrary();
  }

  async openAssignmentFile(assignmentId: string, fileId: string): Promise<void> {
    try {
      await this.#api!.openAssignmentFile(assignmentId, fileId);
    } catch (error) {
      this.error = message(error);
    }
  }

  async trashAssignment(id: string): Promise<void> {
    const title = this.assignments.find((item) => item.id === id)?.title ?? "the assignment";
    await this.#trash(
      async () => [await this.#api!.trashAssignment(id)],
      () => false,
      `“${title}”`,
    );
  }

  /**
   * Saves a change to a document's details. Changes to one document go one at a time, each from
   * the revision the previous one returned, so two quick edits never refuse each other.
   */
  updateDocument(document: DocumentView, patch: DocumentPatch): Promise<void> {
    const previous = this.#documentSaves.get(document.id) ?? Promise.resolve(document.revision);
    const saved = previous.then(async (known) => {
      const revision = Math.max(known, this.document(document.id)?.revision ?? 0);
      try {
        return (await this.#api!.updateDocument(document.id, patch, revision)).revision;
      } catch (error) {
        this.error = message(error);
        return revision;
      }
    });
    this.#documentSaves.set(document.id, saved);
    return saved.then(async () => {
      if (this.#documentSaves.get(document.id) === saved) this.#documentSaves.delete(document.id);
      await this.refreshLibrary();
    });
  }

  // ── Studying ────────────────────────────────────────────────────────────

  /** Documents with a job that is still working on them (running, queued or waiting). */
  studying(documentId: string): boolean {
    return this.jobs.some(
      (job) =>
        job.documentIds.includes(documentId) &&
        (job.status === "running" || job.status === "queued" || job.status === "waiting"),
    );
  }

  studied(documentId: string): boolean {
    const document = this.document(documentId);
    return (
      !!document &&
      !!this.knowledge[document.courseId]?.sessions.some(
        (session) => session.documentId === documentId,
      )
    );
  }

  /**
   * Studies lectures or recitations now, ahead of anything Folio queued on its own. Folio already
   * studies what is added; this is for studying a document again.
   */
  async study(courseId: string, documentIds: string[]): Promise<void> {
    try {
      const job = await this.#api!.startIngest(courseId, documentIds);
      this.#putJob(job);
      this.notice = `Folio is studying ${documentIds.length === 1 ? "it" : `${documentIds.length} documents`} again. You can keep working.`;
    } catch (error) {
      this.error = message(error);
    }
  }

  async rollbackKnowledge(courseId: string): Promise<void> {
    try {
      const knowledge = await this.#api!.rollbackKnowledge(courseId);
      this.notice = `Back to version ${knowledge.generation}`;
    } catch (error) {
      this.error = message(error);
    }
    await this.refreshLibrary();
  }

  // ── Notes ───────────────────────────────────────────────────────────────

  async createNote(courseId: string, title = "Untitled note"): Promise<void> {
    try {
      const note = await this.#api!.createNote(courseId, title);
      await this.refreshLibrary();
      // An untitled note opens with its title selected; a named one is already named.
      if (title === "Untitled note") this.freshNoteId = note.id;
      this.openNote(note.id);
    } catch (error) {
      this.error = message(error);
    }
  }

  /** The note citing a document that changed last: the one to keep writing beside it. */
  noteCiting(documentId: string): NoteView | undefined {
    return this.notes
      .filter((note) => note.cites.includes(documentId))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  }

  /** A page citation as a note writes it, read as "Lecture 3 · p. 12". */
  citation(documentId: string, page: number): string {
    const document = this.document(documentId);
    const title = document
      ? shortTitle(document.title, this.course(document.courseId)?.name)
      : "Document";
    return citationLink(documentId, page, `${title} · p. ${page}`);
  }

  /** Starts a note for writing beside a document, named after it, without leaving the page. */
  async createNoteBeside(documentId: string): Promise<string | null> {
    const document = this.document(documentId);
    if (!document) return null;
    try {
      const title = shortTitle(document.title, this.course(document.courseId)?.name);
      const note = await this.#api!.createNote(document.courseId, `Notes on ${title}`);
      await this.refreshLibrary();
      return note.id;
    } catch (error) {
      this.error = message(error);
      return null;
    }
  }

  /**
   * Saves a tutor's reply into a note, with a line saying which chat it came from and the
   * pages it cited: into a new note named after it, or at the end of `noteId`. The student
   * chose to save it; Undo takes it back out while the note is still as it left it.
   */
  async saveToNote(
    answer: { text: string; sources?: SourceView[] },
    chat: { id: string | null; title: string },
    target: { courseId: string; noteId: string | null },
  ): Promise<void> {
    const cited = (answer.sources ?? [])
      .filter((source) => this.document(source.documentId))
      .slice(0, 6)
      .map((source) => this.citation(source.documentId, source.page));
    const from = chat.id
      ? `From [[chat:${chat.id}|${chat.title.replace(/[[\]|\n]+/g, " ").trim() || "a chat"}]]`
      : "From a chat";
    const text = `${answer.text.trim()}\n\n${[from, ...cited].join(" · ")}`;
    try {
      if (!target.noteId) {
        const heading = /^#{1,3}\s+(.+)$/m.exec(answer.text)?.[1]?.trim();
        const note = await this.#api!.createNote(
          target.courseId,
          heading || chat.title || "Saved answer",
        );
        await this.#api!.appendToNote(note.id, text);
        await this.refreshLibrary();
        this.notice = `Saved to a new note, “${note.title}”`;
        this.noticeAction = { label: "Open", run: () => this.openNote(note.id) };
        return;
      }
      const before = await this.#api!.readNote(target.noteId);
      const after = await this.#api!.appendToNote(target.noteId, text);
      await this.refreshLibrary();
      this.notice = `Saved to “${after.title}”`;
      this.noticeAction = {
        label: "Undo",
        run: async () => {
          try {
            await this.#api!.saveNote(after.id, before.content, after.revision);
            this.notice = `Took it back out of “${after.title}”`;
          } catch {
            this.error = "The note changed since. Open its History to go back further.";
          }
          await this.refreshLibrary();
        },
      };
    } catch (error) {
      this.error = message(error);
    }
  }

  /**
   * Undoes a change the tutor made to a note: a new note goes to the Trash; an edit or rename
   * brings back the version before it. Only while the note is still as the tutor left it.
   */
  async undoNoteEdit(edit: NoteEditView): Promise<void> {
    const current = this.note(edit.noteId);
    if (!current) {
      this.error = "That note is no longer in Folio.";
      return;
    }
    if (current.revision !== edit.after) {
      this.error = "The note changed since then. Open its History to go back further.";
      return;
    }
    if (edit.before === null) return this.trashNote(edit.noteId);
    try {
      await this.#api!.restoreNote(edit.noteId, edit.before, edit.after);
      this.notice = `Undid the change to “${edit.title}”`;
    } catch (error) {
      this.error = message(error);
    }
    await this.refreshLibrary();
  }

  noteHistory(id: string): Promise<NoteVersionView[]> {
    return this.#api!.noteHistory(id);
  }

  async restoreNote(id: string, version: string, revision: string): Promise<void> {
    try {
      await this.#api!.restoreNote(id, version, revision);
      this.notice = "Brought back an earlier version. The one it replaced is in History.";
    } catch (error) {
      this.error = message(error);
    }
    await this.refreshLibrary();
  }

  async resolveProposal(id: string, action: ProposalAction): Promise<void> {
    try {
      const resolved = await this.#api!.resolveProposal(id, action);
      if (resolved.state === "kept" || resolved.state === "inserted")
        this.notice = `Saved to “${resolved.noteTitle}”`;
    } catch (error) {
      this.error = message(error);
    }
    await this.refreshLibrary();
  }

  // ── Jobs ────────────────────────────────────────────────────────────────

  /** Pauses, resumes or cancels a background job. Resuming spends plan usage. */
  async controlJob(id: string, action: "pause" | "resume" | "cancel" | "dismiss"): Promise<void> {
    try {
      const api = this.#api!;
      if (action === "dismiss") {
        await api.dismissJob(id);
        this.jobs = this.jobs.filter((job) => job.id !== id);
        return;
      }
      this.#putJob(
        await (action === "pause"
          ? api.pauseJob(id)
          : action === "resume"
            ? api.resumeJob(id)
            : api.cancelJob(id)),
      );
    } catch (error) {
      this.error = message(error);
    }
  }

  #putJob(job: JobView): void {
    const at = this.jobs.findIndex((candidate) => candidate.id === job.id);
    if (at === -1) this.jobs = [job, ...this.jobs];
    else this.jobs[at] = job;
  }

  #reportImport(results: ImportResult[]): void {
    if (!results.length) return;
    const added = results.filter((result) => result.document && !result.duplicate).length;
    const reused = results.filter((result) => result.duplicate).length;
    const failed = results.filter((result) => result.error);
    const parts = [
      added && `Added ${added} file${added === 1 ? "" : "s"}`,
      reused && `${reused} already in this course`,
    ].filter(Boolean);
    if (parts.length) this.notice = parts.join(" · ");
    if (failed.length) this.error = failed.map((result) => result.error).join(" ");
  }

  // ── Models ──────────────────────────────────────────────────────────────

  /** Checks the key with its provider and keeps it; throws with why when it is refused. */
  async saveKey(connection: string, key: string): Promise<void> {
    await this.api.saveKey(connection, key);
  }

  async removeKey(connection: string): Promise<void> {
    try {
      await this.api.removeKey(connection);
    } catch (error) {
      this.error = message(error);
    }
  }

  async setOpenRouterModels(ids: string[]): Promise<void> {
    const before = this.models.openrouter;
    this.models.openrouter = ids;
    try {
      await this.api.setOpenRouterModels(ids);
    } catch (error) {
      this.models.openrouter = before;
      this.error = message(error);
    }
  }

  /** New chats use this model from now on: it becomes config.json's teaching model. */
  setModelChoice(ref: string): void {
    void this.setRoleModel("teaching", ref);
  }

  async setRoleModel(role: ModelRole, ref: string): Promise<void> {
    const before = this.models.roles[role];
    if (before === ref) return;
    this.models.roles[role] = ref;
    try {
      await this.api.setRoleModel(role, ref);
    } catch (error) {
      if (this.models.roles[role] === ref) this.models.roles[role] = before;
      this.error = message(error);
    }
  }

  setThinking(level: Thinking): void {
    if (!THINKING_LEVELS.includes(level)) return;
    this.thinking = level;
    try {
      localStorage.setItem("folio.thinking", level);
    } catch {
      // A per-device convenience; chats fall back to the default level.
    }
  }

  setWebSearch(on: boolean): void {
    this.webSearch = on;
    try {
      localStorage.setItem("folio.webSearch", on ? "1" : "0");
    } catch {
      // A per-device convenience; the tutor may search until it is set again.
    }
  }

  #savedFlag(key: string): boolean | undefined {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? undefined : saved === "1";
    } catch {
      return undefined;
    }
  }

  setFast(fast: boolean): void {
    this.fast = fast;
    try {
      localStorage.setItem("folio.fast", fast ? "1" : "0");
    } catch {
      // A per-device convenience; chats fall back to the standard tier.
    }
  }

  #savedFast(): boolean {
    try {
      return localStorage.getItem("folio.fast") === "1";
    } catch {
      return false;
    }
  }

  #savedThinking(): Thinking | undefined {
    try {
      const saved = localStorage.getItem("folio.thinking");
      return THINKING_LEVELS.find((level) => level === saved);
    } catch {
      return undefined;
    }
  }

  /**
   * Builds before config.json kept the model new chats use on this device, as a ChatGPT model's
   * ID. It moves into the config once, then leaves.
   */
  #adoptSavedModel(): void {
    try {
      const saved = localStorage.getItem("folio.model");
      if (saved === null) return;
      localStorage.removeItem("folio.model");
      if (this.model(`chatgpt/${saved}`)) this.setModelChoice(`chatgpt/${saved}`);
    } catch {
      // A per-device convenience; new chats use the config's model.
    }
  }

  // ── Appearance ──────────────────────────────────────────────────────────

  setTheme(theme: ThemePreference): void {
    this.theme = theme;
    try {
      localStorage.setItem("folio.theme", theme);
    } catch {
      // A per-device convenience; the default theme still works without storage.
    }
    this.#applyTheme();
  }

  #loadTheme(): void {
    try {
      const saved = localStorage.getItem("folio.theme");
      if (saved === "light" || saved === "dark" || saved === "system") this.theme = saved;
    } catch {
      // Fall back to the default theme.
    }
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.#applyTheme());
    this.#applyTheme();
  }

  #applyTheme(): void {
    const dark =
      this.theme === "dark" ||
      (this.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    this.shownTheme = dark ? "dark" : "light";
  }

  // ── Workspace ───────────────────────────────────────────────────────────

  /** Open tabs and reading positions come back on relaunch; nothing is re-run. */
  async #restoreWorkspace(): Promise<void> {
    const saved = (await this.#api!.loadWorkspace().catch(() => null)) as {
      version?: number;
      tabs?: { id?: string; location?: Location }[];
      active?: string;
      sidebarOpen?: boolean;
    } | null;
    if (saved?.version !== 1 || !Array.isArray(saved.tabs)) return;
    const tabs: Tab[] = [];
    for (const tab of saved.tabs) {
      const location = this.#valid(tab.location);
      if (location)
        tabs.push({
          id: typeof tab.id === "string" ? tab.id : newId(),
          history: [location],
          index: 0,
        });
    }
    if (!tabs.length) return;
    this.tabs = tabs;
    this.activeTabId = tabs.some((tab) => tab.id === saved.active) ? saved.active! : tabs[0]!.id;
    if (typeof saved.sidebarOpen === "boolean") this.sidebarOpen = saved.sidebarOpen;
  }

  #valid(location: Location | undefined): Location | null {
    if (!location || typeof location !== "object") return null;
    // Practice was a placeholder place until 2026-10-29; a tab saved on it reopens at Home.
    if ((location as { view: unknown }).view === "practice") return HOME;
    // A note opened alone until 2026-10-29; it reopens in the notebook.
    if ((location as { view: unknown }).view === "note")
      return {
        view: "notes",
        noteId: this.note((location as { noteId?: string }).noteId)?.id ?? null,
        courseId: null,
      };
    switch (location.view) {
      case "home":
      case "library":
      case "chats":
      case "assignments":
      case "jobs":
      case "trash":
        return { view: location.view };
      case "course":
        return this.course(location.courseId)
          ? { view: "course", courseId: location.courseId, tab: courseTab(location.tab) }
          : null;
      case "document": {
        const document = this.document(location.documentId);
        if (!document) return null;
        const chatId = this.chats.some((chat) => chat.id === location.chatId)
          ? location.chatId
          : null;
        return {
          view: "document",
          documentId: document.id,
          page: Math.min(Math.max(1, Number(location.page) || 1), document.pages ?? 1),
          panel: ["docked", "full", "closed"].includes(location.panel) ? location.panel : "docked",
          chatId,
          side: location.side === "note" ? "note" : "chat",
          noteId: this.note(location.noteId)?.id ?? null,
        };
      }
      case "notes":
        return {
          view: "notes",
          noteId: this.note(location.noteId)?.id ?? null,
          courseId: this.course(location.courseId)?.id ?? null,
        };
      case "study":
        return this.course(location.courseId)
          ? {
              view: "study",
              courseId: location.courseId,
              item: typeof location.item === "string" ? location.item : null,
            }
          : null;
      case "chat":
        return location.chatId && !this.chats.some((chat) => chat.id === location.chatId)
          ? null
          : {
              view: "chat",
              chatId: location.chatId ?? null,
              courseId: this.course(location.courseId)?.id ?? null,
            };
      default:
        return null;
    }
  }

  #changed(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#noteReading();
      const state = {
        version: 1,
        tabs: this.tabs.map((tab) => ({ id: tab.id, location: tab.history[tab.index] })),
        active: this.activeTabId,
        sidebarOpen: this.sidebarOpen,
      };
      void this.#api?.saveWorkspace($state.snapshot(state)).catch(() => undefined);
    }, 400);
  }

  /** Where the student last read each document, on this device: what "Pick up" resumes. */
  reading = $state<Record<string, { page: number; at: string }>>(this.#savedReading());

  /** Records the open document's page once the student settles on it. */
  #noteReading(): void {
    const location = this.location;
    if (location.view !== "document") return;
    const last = this.reading[location.documentId];
    if (last?.page === location.page && Date.now() - Date.parse(last.at) < 60_000) return;
    this.reading[location.documentId] = { page: location.page, at: new Date().toISOString() };
    // Only the most recent documents are kept.
    const kept = Object.entries(this.reading)
      .sort(([, a], [, b]) => b.at.localeCompare(a.at))
      .slice(0, 200);
    try {
      localStorage.setItem("folio.reading", JSON.stringify(Object.fromEntries(kept)));
    } catch {
      // A per-device convenience.
    }
  }

  #savedReading(): Record<string, { page: number; at: string }> {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("folio.reading") ?? "{}");
      if (!saved || typeof saved !== "object") return {};
      return Object.fromEntries(
        Object.entries(saved).filter(
          ([, value]) => typeof value?.page === "number" && typeof value?.at === "string",
        ),
      ) as Record<string, { page: number; at: string }>;
    } catch {
      return {};
    }
  }

  persistLayout(): void {
    this.#changed();
  }

  // ── Events ──────────────────────────────────────────────────────────────

  #onEvent(event: DesktopEvent): void {
    if (event.type === "chat") {
      const known =
        this.chatViews[event.chat.id] !== undefined ||
        this.chats.some((chat) => chat.id === event.chat.id);
      if (!known && this.#awaiting.length) this.#adopt(this.#awaiting.shift()!, event.chat.id);
      this.chatViews[event.chat.id] = event.chat;
    } else if (event.type === "stream") {
      const last = this.chatViews[event.chatId]?.messages.at(-1);
      if (last?.state === "streaming") last.text = event.text;
    } else if (event.type === "visual") {
      // A visual still being written: shown as it arrives, until the saved reply replaces it.
      const last = this.chatViews[event.chatId]?.messages.at(-1);
      if (last?.state === "streaming") {
        const visuals = last.visuals ?? [];
        last.visuals = visuals.some((visual) => visual.id === event.visual.id)
          ? visuals.map((visual) => (visual.id === event.visual.id ? event.visual : visual))
          : [...visuals, event.visual];
      }
    } else if (event.type === "chats") {
      this.chats = event.chats;
    } else if (event.type === "library") {
      clearTimeout(this.#libraryTimer);
      this.#libraryTimer = setTimeout(() => void this.refreshLibrary(), 120);
    } else if (event.type === "models") {
      this.models = event.models;
    } else if (event.type === "job") {
      this.#putJob(event.job);
    } else if (event.type === "jobRemoved") {
      this.jobs = this.jobs.filter((job) => job.id !== event.id);
    } else if (event.type === "trash") {
      void this.refreshTrash();
    } else {
      this.error = event.message;
    }
  }
}

export const folio = new FolioState();
