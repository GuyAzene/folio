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
  NoteView,
  ProposalAction,
  ProposalView,
  StudyNotesView,
  SubscriptionView,
  TrashEntryView,
} from "../../src/desktop/api.ts";
import { chatTitle } from "../../src/chat-title.ts";
import { courseTab, type CourseTab } from "./course-tabs.ts";

export type { CourseTab };
export type ThemePreference = "system" | "light" | "dark";
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
  | { view: "document"; documentId: string; page: number; panel: PanelMode; chatId: string | null }
  | { view: "note"; noteId: string }
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
  subscriptions = $state<SubscriptionView[]>([]);
  defaultModel = $state("");
  /** The model new chats start with; each chat keeps the model it started with. */
  modelChoice = $state("");
  connection = $state<ConnectionView>({ connected: false, signingIn: false });
  error = $state<string | null>(null);
  notice = $state<string | null>(null);
  /** A button on the notice, such as Undo after moving something to the Trash. */
  noticeAction = $state<{ label: string; run: () => void } | null>(null);
  confirming = $state<Confirmation | null>(null);
  /** Folio's Trash, most recently removed first. */
  trash = $state<TrashEntryView[]>([]);
  settingsOpen = $state(false);
  paletteOpen = $state(false);
  newCourseOpen = $state(false);
  sidebarOpen = $state(true);
  theme = $state<ThemePreference>("light");
  /** The theme on screen now, "system" resolved; demos and drawings follow it. */
  shownTheme = $state<"light" | "dark">("light");

  courses = $state<CourseView[]>([]);
  documents = $state<DocumentView[]>([]);
  notes = $state<NoteView[]>([]);
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
      this.subscriptions = boot.subscriptions;
      this.defaultModel = boot.model.id;
      this.modelChoice = this.#savedModel() ?? boot.model.id;
      this.chats = boot.chats;
      this.unavailableChats = boot.unavailableChats;
      this.connection = boot.connection;
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
  modelName(id: string): string {
    for (const subscription of this.subscriptions)
      for (const model of subscription.models) if (model.id === id) return model.name;
    return id;
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

  /** Opens a note, reusing a tab that already shows it. */
  openNote(noteId: string, options: { newTab?: boolean } = {}): void {
    const existing = this.tabs.find((tab) => {
      const location = tab.history[tab.index];
      return location?.view === "note" && location.noteId === noteId;
    });
    if (existing && !options.newTab) this.selectTab(existing.id);
    else this.navigate({ view: "note", noteId }, options);
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
        modelId: this.modelChoice,
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
        modelId: context.chatId ? null : this.modelChoice,
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
    const [courses, documents, notes, proposals] = await Promise.all([
      this.#api!.listCourses(),
      this.#api!.listDocuments(),
      this.#api!.listNotes(),
      this.#api!.listProposals(),
    ]);
    this.courses = courses;
    this.documents = documents;
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
      (location) => location.view === "note" && location.noteId === id,
      `“${title}”`,
    );
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
            if (location.view === "note") return this.note(location.noteId)?.courseId === id;
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

  async updateDocument(document: DocumentView, patch: DocumentPatch): Promise<void> {
    try {
      await this.#api!.updateDocument(document.id, patch, document.revision);
    } catch (error) {
      this.error = message(error);
    }
    await this.refreshLibrary();
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

  /** Starts studying lectures or recitations, then shows the job's agent tree. */
  async study(courseId: string, documentIds: string[]): Promise<void> {
    try {
      const job = await this.#api!.startIngest(courseId, documentIds);
      this.#putJob(job);
      this.notice = `Folio is studying ${documentIds.length === 1 ? "the document" : `${documentIds.length} documents`}. You can keep working.`;
      this.navigate({ view: "jobs" });
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
      this.openNote(note.id);
    } catch (error) {
      this.error = message(error);
    }
  }

  /**
   * Adds a cited passage below the course's most recently edited note, or a new note named
   * after the document. The student chose to quote it; Folio does not.
   */
  async quoteToNotes(courseId: string, passage: { text: string; source: string }, about: string) {
    try {
      let note = this.notes
        .filter((candidate) => candidate.courseId === courseId)
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
      note ??= await this.#api!.createNote(courseId, `Notes on ${about}`);
      await this.#api!.appendToNote(note.id, `> ${passage.text}\n> (${passage.source})`);
      await this.refreshLibrary();
      this.notice = `Quoted to “${note.title}”`;
    } catch (error) {
      this.error = message(error);
    }
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

  setModelChoice(id: string): void {
    if (!this.subscriptions.some((s) => s.models.some((model) => model.id === id))) return;
    this.modelChoice = id;
    try {
      localStorage.setItem("folio.model", id);
    } catch {
      // A per-device convenience; new chats fall back to the default model.
    }
  }

  #savedModel(): string | undefined {
    try {
      const saved = localStorage.getItem("folio.model");
      return this.subscriptions.some((s) => s.models.some((model) => model.id === saved))
        ? saved!
        : undefined;
    } catch {
      return undefined;
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
        };
      }
      case "note":
        return this.note(location.noteId) ? { view: "note", noteId: location.noteId } : null;
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
      const state = {
        version: 1,
        tabs: this.tabs.map((tab) => ({ id: tab.id, location: tab.history[tab.index] })),
        active: this.activeTabId,
        sidebarOpen: this.sidebarOpen,
      };
      void this.#api?.saveWorkspace($state.snapshot(state)).catch(() => undefined);
    }, 400);
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
    } else if (event.type === "connection") {
      this.connection = event.connection;
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
