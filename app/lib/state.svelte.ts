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
  ApprovalDecision,
  ApprovalView,
  CommandInput,
  McpServerView,
  McpView,
  SkillsView,
  SkillView,
  SourceView,
  ProposalAction,
  PendingView,
  ProposalView,
  ReleaseView,
  StudyNotesView,
  Thinking,
  TrashEntryView,
} from "../../src/desktop/api.ts";
import { DEFAULT_THINKING, STUDY_ROLES, THINKING_LEVELS } from "../../src/desktop/api.ts";
import { chatTitle } from "../../src/chat-title.ts";
import { categoryOf, DEFAULT_CATEGORIES, type Category } from "../../src/library/categories.ts";
import type { AppAction } from "../../src/library/app-actions.ts";
import type { ImportItem, NamingScope } from "../../src/library/naming.ts";
import { citationLink } from "../../src/library/note-meta.ts";
import { courseTab, type CourseTab } from "./course-tabs.ts";
import { moveDraft, putDraft, readDrafts, type Draft } from "./drafts.ts";
import {
  activate,
  activePane as activeIn,
  closePane,
  lastUsed,
  mapPanes,
  openBeside,
  readWorkspace,
  single,
  withLocation,
  withoutPanes,
  type Layout,
  type Location,
  type Pane,
  type Tab,
} from "./layout.ts";
import { shortTitle } from "./titles.ts";

export type { CourseTab, Layout, Location, Pane, Tab };
export type ThemePreference = "system" | "light" | "dark";
export type SettingsSection =
  | "general"
  | "connections"
  | "models"
  | "categories"
  | "skills"
  | "mcp";
/** A question asked before something hard to undo, answered in a dialog. */
export interface Confirmation {
  title: string;
  body: string;
  action: string;
  run: () => Promise<void>;
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
    categories: [],
    naming: null,
  });
  /** How long the tutor thinks, for every chat, from the next question on. */
  thinking = $state<Thinking>(DEFAULT_THINKING);
  /** Questions go on OpenAI's faster tier, which costs more. OpenAI models only. */
  fast = $state(false);
  /** The tutor may search the web; off only when the student turns it off in Settings. */
  webSearch = $state(true);
  /** This Folio's version, whether it checks for a newer release, and one when it was found. */
  release = $state<ReleaseView | null>(null);
  /** The release whose line the student closed in the sidebar; a newer one shows again. */
  dismissedRelease = $state<string | null>(null);
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
  /** Changes the tutor proposed to Folio: waiting for the student's Apply, or answered. */
  proposedChanges = $state<PendingView[]>([]);
  waitingChanges = $derived(this.proposedChanges.filter((change) => change.state === "pending"));
  chats = $state<ChatSummary[]>([]);
  unavailableChats = $state(0);
  /** Loaded chats by ID. */
  chatViews = $state<Record<string, ChatView>>({});
  /** A new chat's optimistic view, by pane, until Folio assigns its ID. */
  pending = $state<Record<string, ChatView>>({});
  /** What the student is writing to each chat, until sent; see drafts.ts. */
  drafts = $state<Record<string, Draft>>(this.#savedDrafts());
  /** Pages, files and images added to a draft: kept while Folio is open, never saved. */
  draftAdded = $state.raw<Record<string, Added[]>>({});
  jump = $state<Jump | null>(null);

  tabs = $state<Tab[]>([{ id: newId(), history: [single(HOME, newId())], index: 0 }]);
  activeTabId = $state("");
  activeTab = $derived(this.tabs.find((tab) => tab.id === this.activeTabId) ?? this.tabs[0]!);
  /** The active tab's panes as they are now. */
  layout = $derived(this.activeTab.history[this.activeTab.index]!);
  activePane = $derived(activeIn(this.layout));
  /** The active pane's place. */
  location = $derived(this.activePane.location);

  #api: FolioApi | null = null;
  #awaiting: string[] = [];
  /** Each assignment's latest pending save, resolving to the revision it left. */
  #assignmentSaves = new Map<string, Promise<number>>();
  /** Each document's latest pending save, resolving to the revision it left. */
  #documentSaves = new Map<string, Promise<number>>();
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #draftTimer: ReturnType<typeof setTimeout> | undefined;
  #libraryTimer: ReturnType<typeof setTimeout> | undefined;
  #nonce = 0;

  get api(): FolioApi {
    return this.#api!;
  }

  /** The student's MCP servers, as Settings shows them; null until first read. */
  mcp = $state<McpView | null>(null);
  /** Calls to services waiting for the student, in every chat. */
  approvals = $state<ApprovalView[]>([]);

  async refreshMcp(): Promise<void> {
    try {
      this.mcp = await this.#api!.mcpServers();
    } catch (error) {
      this.error = message(error);
    }
  }

  /** Runs a change to the servers and shows the list it returns; false when it was refused. */
  async changeMcp(change: (api: FolioApi) => Promise<McpView | void>): Promise<boolean> {
    try {
      const next = await change(this.#api!);
      if (next) this.mcp = next;
      return true;
    } catch (error) {
      this.error = message(error);
      return false;
    }
  }

  /** The student's answer to a call waiting in a chat. */
  async answerApproval(id: string, decision: ApprovalDecision): Promise<void> {
    try {
      await this.#api!.answerApproval(id, decision);
    } catch (error) {
      this.error = message(error);
    }
  }

  /** The student's routines; the composer's / menu offers the ones that are on. */
  skills = $state<SkillsView | null>(null);

  async refreshSkills(): Promise<void> {
    try {
      this.skills = await this.#api!.listSkills();
    } catch (error) {
      this.error = message(error);
    }
  }

  /** Routines the student can start with `/name`: on, used, and meant to be started. */
  get startable(): SkillView[] {
    return this.skills?.skills.filter((skill) => skill.on && !skill.hiddenBy && skill.user) ?? [];
  }

  /** Prompts of the services that are running, each started with `/server:name`. */
  get prompts(): { server: McpServerView; prompt: McpServerView["prompts"][number] }[] {
    return (this.mcp?.servers ?? []).flatMap((server) =>
      server.enabled && server.status === "ready"
        ? server.prompts.map((prompt) => ({ server, prompt }))
        : [],
    );
  }

  /**
   * What a message starts with `/`, when it can be started: a routine (`/name`), or a service's
   * prompt (`/server:name`) with `args`, the draft's answers to its arguments.
   */
  commandIn(text: string, args: Record<string, string> = {}): CommandInput | undefined {
    const token = /^\/(\S+)(?:\s|$)/.exec(text.trimStart())?.[1];
    if (!token) return undefined;
    if (this.startable.some((skill) => skill.name === token)) return { kind: "skill", name: token };
    const found = this.prompts.find(
      ({ server, prompt }) => `${server.id}:${prompt.name}` === token,
    );
    return found
      ? {
          kind: "prompt",
          server: found.server.id,
          name: found.prompt.name,
          label: found.server.label,
          args: Object.fromEntries(
            (found.prompt.arguments ?? []).flatMap((argument) =>
              args[argument.name]?.trim() ? [[argument.name, args[argument.name]!.trim()]] : [],
            ),
          ),
        }
      : undefined;
  }

  /** Runs a change to the routines and shows the list it returns; false when it was refused. */
  async changeSkills(change: (api: FolioApi) => Promise<SkillsView | null>): Promise<boolean> {
    try {
      const next = await change(this.#api!);
      if (next) this.skills = next;
      return true;
    } catch (error) {
      this.error = message(error);
      return false;
    }
  }

  async init(bridge: FolioApi): Promise<void> {
    const api = plainCalls(bridge);
    this.#api = api;
    this.activeTabId = this.tabs[0]!.id;
    // The last words typed before quitting are saved too.
    addEventListener("pagehide", () => this.#writeDrafts());
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
      this.dismissedRelease = this.#savedDismissal();
      this.chats = boot.chats;
      this.unavailableChats = boot.unavailableChats;
      await this.refreshLibrary();
      this.jobs = await api.listJobs();
      this.trash = await api.listTrash();
      void this.refreshSkills();
      void this.refreshMcp();
      this.approvals = await api.listApprovals();
      await this.#restoreWorkspace();
      void this.#watchReleases();
    } catch (error) {
      this.error = message(error);
    }
    this.ready = true;
  }

  /**
   * Shows the release last found at once, then asks a moment after start and every hour; the
   * main process asks GitHub only while the check is on and its answer is a day old.
   */
  async #watchReleases(): Promise<void> {
    try {
      this.release = await this.#api!.release();
    } catch {
      // Without its version, Settings leaves the line out; the check below may still find it.
    }
    setTimeout(() => void this.checkRelease(), 2_000);
    setInterval(() => void this.checkRelease(), 3_600_000);
  }

  async checkRelease(): Promise<void> {
    try {
      this.release = await this.#api!.checkRelease();
    } catch {
      // The main process answers even offline; the next check is an hour away.
    }
  }

  /** Folio asks GitHub once a day whether a newer release is out; off only when turned off. */
  get updates(): boolean {
    return this.release?.on !== false;
  }

  /** The newer release the sidebar mentions: none while the check is off or its line is closed. */
  get announcedRelease(): ReleaseView["newer"] {
    const newer = this.release?.newer;
    return newer && newer.version !== this.dismissedRelease ? newer : null;
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
  /** The student's kinds of course file, in their order; today's five until config.json is read. */
  get categories(): Category[] {
    return this.models.categories.length ? this.models.categories : [...DEFAULT_CATEGORIES];
  }
  /** The category a file shows under. */
  categoryOf(document: Pick<DocumentView, "role" | "category">): Category {
    return categoryOf(document, this.categories);
  }
  proposedChange(id: string): PendingView | undefined {
    return this.proposedChanges.find((change) => change.id === id);
  }

  /** Applies or cancels a change the tutor proposed; applying checks it again first. */
  async answerChange(id: string, apply: boolean): Promise<void> {
    try {
      const answered = await this.#api!.resolvePending(id, apply);
      this.proposedChanges = this.proposedChanges.map((change) =>
        change.id === id ? answered : change,
      );
      if (answered.state === "failed")
        this.error = answered.note ?? "That change couldn't be applied.";
    } catch (error) {
      this.error = message(error);
    }
    await this.refreshLibrary();
  }

  /** Undoes a change the tutor made; refused when what it changed has changed since. */
  async undoChange(undo: AppAction): Promise<boolean> {
    try {
      const summary = await this.#api!.undoAction(undo);
      this.noticeAction = null;
      this.notice = summary;
      await this.refreshLibrary();
      return true;
    } catch (error) {
      this.error = message(error);
      return false;
    }
  }

  /** The pattern that names a category's files, or null when they keep their own names. */
  pattern(category: Category): string | null {
    return category.naming ?? this.models.naming;
  }

  /** Sets the library's naming pattern in config.json; files named by it follow. */
  async setNaming(pattern: string | null): Promise<boolean> {
    try {
      await this.#api!.setNaming(pattern);
      await this.refreshLibrary();
      return true;
    } catch (error) {
      this.error = message(error);
      return false;
    }
  }

  /** Names files by their category's pattern from now on, with Undo. */
  async applyNaming(scope: NamingScope): Promise<void> {
    try {
      const renamed = await this.#api!.applyNaming(scope);
      await this.refreshLibrary();
      // Files whose name already matched now follow the pattern too, but nothing changed there.
      const changed = renamed.filter((rename) => rename.next !== rename.title);
      if (!changed.length) {
        this.noticeAction = null;
        this.notice = "Every name already follows the pattern";
        return;
      }
      this.notice =
        changed.length === 1
          ? `Renamed “${changed[0]!.title}” to “${changed[0]!.next}”`
          : `Renamed ${changed.length} files to match`;
      this.noticeAction = {
        label: "Undo",
        run: () =>
          void this.#api!
            .undoNaming(renamed)
            .then(() => this.refreshLibrary())
            .catch((error: unknown) => (this.error = message(error))),
      };
    } catch (error) {
      this.error = message(error);
    }
  }

  /** Saves the categories in config.json; Settings and the course pages follow. */
  async setCategories(categories: Category[]): Promise<boolean> {
    try {
      await this.#api!.setCategories(categories);
      await this.refreshLibrary();
      return true;
    } catch (error) {
      this.error = message(error);
      return false;
    }
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
  chatFor(chatId: string | null, paneId: string): ChatView | null {
    return chatId ? (this.chatViews[chatId] ?? null) : (this.pending[paneId] ?? null);
  }
  running(chat: ChatView | null): boolean {
    return chat?.messages.at(-1)?.state === "streaming";
  }

  // ── Tabs and panes ──────────────────────────────────────────────────────

  #current(tab: Tab): Layout {
    return tab.history[tab.index]!;
  }

  /** The tab whose current layout has this pane. */
  #tabOf(paneId: string): Tab | undefined {
    return this.tabs.find((tab) => this.#current(tab).panes.some((pane) => pane.id === paneId));
  }

  /** The current layout the pane is in. */
  layoutOf(paneId: string): Layout | undefined {
    const tab = this.#tabOf(paneId);
    return tab && this.#current(tab);
  }

  locationOf(paneId: string): Location {
    return this.layoutOf(paneId)?.panes.find((pane) => pane.id === paneId)?.location ?? HOME;
  }

  /** A navigation: a step Back can undo. */
  #push(tab: Tab, layout: Layout): void {
    tab.history = [...tab.history.slice(0, tab.index + 1), layout];
    tab.index = tab.history.length - 1;
    this.#changed();
  }

  /** A change to where the tab already is (a page turned, a pane resized): no history step. */
  #replace(tab: Tab, layout: Layout): void {
    tab.history[tab.index] = layout;
    this.#changed();
  }

  /**
   * Goes to a place in the active pane, or in `paneId`; in a new tab, or in a new pane beside
   * the active one.
   */
  navigate(
    location: Location,
    options: { newTab?: boolean; beside?: boolean; paneId?: string } = {},
  ): void {
    if (options.newTab) {
      this.openTab(location);
      return;
    }
    const tab = (options.paneId && this.#tabOf(options.paneId)) || this.activeTab;
    const layout = this.#current(tab);
    const target = layout.panes.some((pane) => pane.id === options.paneId)
      ? options.paneId!
      : activeIn(layout).id;
    this.#push(
      tab,
      options.beside
        ? openBeside(layout, location, target, newId())
        : activate(withLocation(layout, target, location), target),
    );
  }

  /** Changes a pane's place without a history step (the page you are on, a course's tab). */
  update(patch: Partial<Location>, paneId = this.activePane.id): void {
    const tab = this.#tabOf(paneId);
    if (!tab) return;
    const layout = this.#current(tab);
    const pane = layout.panes.find((candidate) => candidate.id === paneId)!;
    this.#replace(tab, withLocation(layout, paneId, { ...pane.location, ...patch } as Location));
  }

  /** The pane the student is working in now, which a click or a keystroke makes active. */
  activatePane(paneId: string): void {
    const tab = this.#tabOf(paneId);
    if (!tab) return;
    const layout = this.#current(tab);
    const next = activate(layout, paneId);
    if (next !== layout) this.#replace(tab, next);
  }

  /** Closes a pane; Back brings it back. A tab's last pane closes the tab. */
  closePane(paneId: string): void {
    const tab = this.#tabOf(paneId);
    if (!tab) return;
    const layout = this.#current(tab);
    if (layout.panes.length === 1) {
      this.closeTab(tab.id);
      return;
    }
    const closing = layout.panes.find((pane) => pane.id === paneId)!;
    if (closing.location.view === "chat" && lastUsed(layout, "document")) this.#keepBeside(false);
    this.#push(tab, closePane(layout, paneId));
  }

  /** Shows a pane alone, or all of them again. */
  toggleMaximized(paneId: string): void {
    const tab = this.#tabOf(paneId);
    if (!tab) return;
    const layout = activate(this.#current(tab), paneId);
    this.#replace(tab, { ...layout, maximized: layout.maximized === paneId ? null : paneId });
  }

  resizePanes(tabId: string, sizes: number[]): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (tab) this.#replace(tab, { ...this.#current(tab), sizes });
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
    this.#openTab(this.#withChat(single(location, newId())));
  }

  #openTab(layout: Layout): void {
    const tab: Tab = { id: newId(), history: [layout], index: 0 };
    const at = this.tabs.findIndex((candidate) => candidate.id === this.activeTabId);
    this.tabs.splice(at + 1, 0, tab);
    this.activeTabId = tab.id;
    this.#changed();
  }

  closeTab(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    for (const pane of this.#current(this.tabs[index]!).panes) delete this.pending[pane.id];
    if (this.tabs.length === 1) {
      this.tabs = [{ id: newId(), history: [single(HOME, newId())], index: 0 }];
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

  /** A pane showing a place, in the active tab first, most recently used first. */
  #find(test: (location: Location) => boolean): { tab: Tab; pane: Pane } | undefined {
    for (const tab of [this.activeTab, ...this.tabs.filter((tab) => tab !== this.activeTab)]) {
      const layout = this.#current(tab);
      const pane = layout.recent
        .map((id) => layout.panes.find((candidate) => candidate.id === id)!)
        .find((candidate) => test(candidate.location));
      if (pane) return { tab, pane };
    }
    return undefined;
  }

  #show(found: { tab: Tab; pane: Pane }): void {
    this.activeTabId = found.tab.id;
    this.activatePane(found.pane.id);
  }

  /**
   * A document opened alone gets a new chat beside it, as long as the student keeps one there:
   * closing the chat beside a document stops it, Ask Folio starts it again.
   */
  besideDocuments = $state(this.#savedFlag("folio.besideDocuments") ?? true);

  #keepBeside(on: boolean): void {
    this.besideDocuments = on;
    try {
      localStorage.setItem("folio.besideDocuments", on ? "1" : "0");
    } catch {
      // A per-device convenience.
    }
  }

  #withChat(layout: Layout): Layout {
    const pane = layout.panes[0]!;
    if (layout.panes.length !== 1 || pane.location.view !== "document" || !this.besideDocuments)
      return layout;
    const courseId = this.document(pane.location.documentId)?.courseId ?? null;
    return openBeside(layout, { view: "chat", chatId: null, courseId }, pane.id, newId(), {
      activate: false,
    });
  }

  /**
   * Opens a document at a page. A page link in a chat opens in the document that chat follows,
   * or beside the chat; a document already open goes to the page there. Otherwise it opens in
   * the active pane, or, when that is a chat beside a document, in that document.
   */
  openDocument(
    documentId: string,
    page = 1,
    options: { newTab?: boolean; beside?: boolean; chatId?: string | null } = {},
  ): void {
    const location = { view: "document" as const, documentId, page };
    const tab = this.activeTab;
    const layout = this.layout;
    const fromChat = options.chatId
      ? layout.panes.find(
          (pane) => pane.location.view === "chat" && pane.location.chatId === options.chatId,
        )
      : undefined;
    const followed = lastUsed(layout, "document");
    if (options.newTab) this.openTab(location);
    else if (options.beside) this.navigate(location, { beside: true });
    else if (fromChat && followed) this.#goTo(followed, location);
    else if (fromChat)
      this.#push(tab, openBeside(layout, location, fromChat.id, newId(), { side: "left" }));
    else {
      const open = this.#find(
        (shown) => shown.view === "document" && shown.documentId === documentId,
      );
      const active = activeIn(layout);
      if (open) {
        this.#show(open);
        this.update({ page }, open.pane.id);
      } else if (active.location.view === "chat" && followed) this.#goTo(followed, location);
      else
        this.#push(
          tab,
          this.#withChat(activate(withLocation(layout, active.id, location), active.id)),
        );
    }
    this.jump = { documentId, page, nonce: ++this.#nonce };
  }

  /** A document pane goes to a document: a new step, or only a page turn within the same one. */
  #goTo(pane: Pane, location: Extract<Location, { view: "document" }>): void {
    if (pane.location.view === "document" && pane.location.documentId === location.documentId) {
      this.update({ page: location.page }, pane.id);
      this.activatePane(pane.id);
    } else this.navigate(location, { paneId: pane.id });
  }

  /**
   * The chat pane beside a document pane: the tab's chat used last, or a new chat for the
   * document's course on its right. A course chat can't read another course's pages, so one
   * for another course gives way to a new chat for this one.
   */
  chatBeside(documentPaneId: string): string | null {
    const tab = this.#tabOf(documentPaneId);
    if (!tab) return null;
    const layout = this.#current(tab);
    const shown = layout.panes.find((pane) => pane.id === documentPaneId)?.location;
    if (shown?.view !== "document") return null;
    const courseId = this.document(shown.documentId)?.courseId ?? null;
    const fresh: Location = { view: "chat", chatId: null, courseId };
    const chat = lastUsed(layout, "chat");
    this.#keepBeside(true);
    if (!chat) {
      const id = newId();
      this.#push(tab, openBeside(layout, fresh, documentPaneId, id, { activate: false }));
      return id;
    }
    const summary = this.chats.find((candidate) => candidate.id === chat.location.chatId);
    const other = chat.location.chatId
      ? summary?.kind === "course" && summary.courseId !== courseId
      : chat.location.courseId !== courseId;
    if (other) this.navigate(fresh, { paneId: chat.id });
    return chat.id;
  }

  /**
   * The note pane beside a document pane, opened if needed on the note there, else the note
   * that cites the document, else a new note named after it. Returns the note's ID.
   */
  async noteBeside(documentPaneId: string): Promise<string | null> {
    const shown = this.locationOf(documentPaneId);
    if (shown.view !== "document") return null;
    const before = this.layoutOf(documentPaneId);
    const open = before && lastUsed(before, "notes");
    if (open?.location.noteId) return open.location.noteId;
    const noteId =
      this.noteCiting(shown.documentId)?.id ?? (await this.createNoteBeside(shown.documentId));
    const tab = this.#tabOf(documentPaneId);
    if (!noteId || !tab) return null;
    const layout = this.#current(tab);
    const pane = lastUsed(layout, "notes");
    const courseId = this.document(shown.documentId)?.courseId ?? null;
    this.#push(
      tab,
      pane
        ? withLocation(layout, pane.id, { ...pane.location, noteId })
        : openBeside(layout, { view: "notes", noteId, courseId }, documentPaneId, newId(), {
            activate: false,
          }),
    );
    return noteId;
  }

  /**
   * Opens a chat as it was: beside the document it was last about, at that page, while the
   * document is still there. A tab already showing the chat comes forward; a chat that was
   * never beside a document opens on its own.
   */
  openChat(chatId: string, options: { newTab?: boolean } = {}): void {
    const summary = this.chats.find((chat) => chat.id === chatId);
    const chat: Location = { view: "chat", chatId, courseId: summary?.courseId ?? null };
    const shown = options.newTab
      ? undefined
      : this.#find((location) => location.view === "chat" && location.chatId === chatId);
    if (shown) {
      this.#show(shown);
      return;
    }
    const document = this.document(summary?.focus?.documentId);
    if (!document) {
      this.navigate(chat, options);
      return;
    }
    const page = Math.min(Math.max(1, summary!.focus!.page), document.pages ?? 1);
    const reader = newId();
    const layout = openBeside(
      single({ view: "document", documentId: document.id, page }, reader),
      chat,
      reader,
      newId(),
    );
    if (options.newTab) this.#openTab(layout);
    else this.#push(this.activeTab, layout);
    this.jump = { documentId: document.id, page, nonce: ++this.#nonce };
  }

  /** Text for a note open in some pane, added at its end as the student's own edit. */
  noteInsert = $state<{ noteId: string; text: string; nonce: number } | null>(null);

  insertIntoNote(noteId: string, text: string): void {
    this.noteInsert = { noteId, text, nonce: ++this.#nonce };
  }

  /** A pane whose message box should take the keyboard, such as after Ask…. */
  composerFocus = $state<{ paneId: string; nonce: number } | null>(null);

  focusComposer(paneId: string): void {
    this.composerFocus = { paneId, nonce: ++this.#nonce };
  }

  /** ⌘J: Folio beside the document, or away again. */
  toggleFolio(): void {
    const layout = this.layout;
    const chat = lastUsed(layout, "chat");
    const active = activeIn(layout);
    if (chat && lastUsed(layout, "document")) this.closePane(chat.id);
    else if (active.location.view === "document") {
      const id = this.chatBeside(active.id);
      if (id) this.focusComposer(id);
    }
  }

  /**
   * Opens a note in the notebook, reusing a pane that already shows the notebook. Its course
   * filter stays when the note belongs to that course.
   */
  openNote(noteId: string, options: { newTab?: boolean; courseId?: string | null } = {}): void {
    const courseOf = this.note(noteId)?.courseId ?? null;
    const existing = options.newTab ? undefined : this.#find((shown) => shown.view === "notes");
    const shown = existing?.pane.location;
    const filter =
      options.courseId !== undefined
        ? options.courseId
        : shown?.view === "notes" && shown.courseId === courseOf
          ? courseOf
          : null;
    if (!existing) {
      this.navigate({ view: "notes", noteId, courseId: filter }, { newTab: options.newTab });
      return;
    }
    this.#show(existing);
    if (shown?.view === "notes" && shown.noteId === noteId && shown.courseId === filter) return;
    this.navigate({ view: "notes", noteId, courseId: filter }, { paneId: existing.pane.id });
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

  /** Opens a course's study notes at a topic or session, reusing a pane that shows them. */
  openStudyNotes(
    courseId: string,
    item: string | null = null,
    options: { newTab?: boolean } = {},
  ): void {
    const existing = options.newTab
      ? undefined
      : this.#find((shown) => shown.view === "study" && shown.courseId === courseId);
    if (!existing) {
      this.navigate({ view: "study", courseId, item }, options);
      return;
    }
    this.#show(existing);
    if ((existing.pane.location as { item?: string | null }).item !== item)
      this.navigate({ view: "study", courseId, item }, { paneId: existing.pane.id });
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
   * Sends from a pane's chat. Shows the message at
   * once; returns null (keep the draft) if Folio did not accept it.
   */
  async send(
    text: string,
    context: {
      paneId: string;
      chatId: string | null;
      courseId: string | null;
      focus: Focus | null;
      /** What the student added with the composer's +. */
      attachments?: Added[];
      /** Answers to the arguments of a service's prompt the message starts with. */
      args?: Record<string, string>;
    },
  ): Promise<string | null> {
    if (!this.#api) return null;
    const added = context.attachments ?? [];
    const command = this.commandIn(text, context.args);
    const sent: ChatMessageView[] = [
      {
        role: "user",
        text,
        state: "complete",
        ...(added.length ? { attachments: added.map((item) => item.view) } : {}),
        ...(command ? { command } : {}),
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
      this.pending[context.paneId] = {
        id: "",
        kind: context.courseId ? "course" : "library",
        // A question that starts a routine is named for what follows "/name", as Folio names it.
        title: chatTitle(
          command
            ? text.trimStart().replace(/^\/\S+\s*/, "") ||
                (command.kind === "prompt" ? `${command.label} ${command.name}` : command.name)
            : text,
        ),
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
    if (!context.chatId) this.#awaiting.push(context.paneId);
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
        ...(command ? { command } : {}),
      });
      if (!context.chatId) this.#adopt(context.paneId, chatId);
      return chatId;
    } catch (error) {
      if (context.chatId && previous) this.chatViews[context.chatId] = previous;
      delete this.pending[context.paneId];
      this.error = message(error);
      return null;
    } finally {
      this.#awaiting = this.#awaiting.filter((id) => id !== context.paneId);
    }
  }

  cancel(chatId: string | null): void {
    if (chatId) void this.#api?.cancel(chatId);
  }

  /** Records the page a course chat is beside; the chat list knows it at once, to reopen there. */
  setFocus(chatId: string | null, focus: Focus): void {
    if (!chatId) return;
    void this.#api
      ?.setFocus(chatId, focus)
      .then(() => {
        const summary = this.chats.find((chat) => chat.id === chatId);
        if (summary?.kind === "course") summary.focus = focus;
      })
      .catch(() => undefined);
  }

  #adopt(paneId: string, chatId: string): void {
    const location = this.locationOf(paneId);
    if (location.view === "chat" && location.chatId === null) this.update({ chatId }, paneId);
    if (!this.chatViews[chatId] && this.pending[paneId])
      this.chatViews[chatId] = { ...this.pending[paneId]!, id: chatId };
    delete this.pending[paneId];
    // Anything written while the first question was on its way stays with the new chat.
    this.drafts = moveDraft(this.drafts, `new:${paneId}`, chatId);
    this.draftAdded = moveDraft(this.draftAdded, `new:${paneId}`, chatId);
    this.#saveDrafts();
  }

  // ── Drafts ──────────────────────────────────────────────────────────────

  setDraft(key: string, patch: Partial<Pick<Draft, "text" | "quote" | "args">>): void {
    this.drafts = putDraft(this.drafts, key, patch);
    this.#saveDrafts();
  }

  setDraftAdded(key: string, added: Added[]): void {
    const rest = { ...this.draftAdded };
    delete rest[key];
    this.draftAdded = added.length ? { ...rest, [key]: added } : rest;
  }

  #saveDrafts(): void {
    clearTimeout(this.#draftTimer);
    this.#draftTimer = setTimeout(() => this.#writeDrafts(), 400);
  }

  #writeDrafts(): void {
    clearTimeout(this.#draftTimer);
    try {
      localStorage.setItem("folio.drafts", JSON.stringify(this.drafts));
    } catch {
      // A per-device convenience; drafts last until Folio closes.
    }
  }

  #savedDrafts(): Record<string, Draft> {
    try {
      return readDrafts(JSON.parse(localStorage.getItem("folio.drafts") ?? "{}"));
    } catch {
      return {};
    }
  }

  // ── Library ─────────────────────────────────────────────────────────────

  async refreshLibrary(): Promise<void> {
    const [courses, documents, notes, proposals, changes, assignments] = await Promise.all([
      this.#api!.listCourses(),
      this.#api!.listDocuments(),
      this.#api!.listNotes(),
      this.#api!.listProposals(),
      this.#api!.listPending(),
      this.#api!.listAssignments(),
    ]);
    this.courses = courses;
    this.documents = documents;
    this.assignments = assignments;
    this.proposedChanges = changes;
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
    paths: ImportItem[] | "choose",
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
      tab.history = tab.history.map((layout) =>
        mapPanes(layout, (location) =>
          location.view === "notes" && location.noteId === id
            ? { ...location, noteId: null }
            : location,
        ),
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

  /**
   * Takes removed things out of every tab's history: their panes close, a step left with no
   * pane goes, and a tab left with nothing goes home.
   */
  #forget(showed: (location: Location) => boolean): void {
    for (const tab of this.tabs) {
      const steps = tab.history.map((layout) => withoutPanes(layout, showed));
      if (steps.every((step, index) => step === tab.history[index])) continue;
      const current = steps[tab.index] ?? null;
      const kept = steps.filter((step): step is Layout => step !== null);
      tab.history = kept.length ? kept : [single(HOME, newId())];
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

  /** Kept by the main process, which asks nothing while it is off. */
  async setUpdates(on: boolean): Promise<void> {
    try {
      this.release = await this.#api!.setUpdateChecks(on);
    } catch (error) {
      this.error = message(error);
      return;
    }
    if (on) await this.checkRelease();
  }

  dismissRelease(version: string): void {
    this.dismissedRelease = version;
    try {
      localStorage.setItem("folio.dismissedRelease", version);
    } catch {
      // A per-device convenience; the line comes back on the next start.
    }
  }

  #savedDismissal(): string | null {
    try {
      return localStorage.getItem("folio.dismissedRelease");
    } catch {
      return null;
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

  /** Open tabs, their panes and reading positions come back on relaunch; nothing is re-run. */
  async #restoreWorkspace(): Promise<void> {
    const saved = await this.#api!.loadWorkspace().catch(() => null);
    const workspace = readWorkspace(
      saved,
      (location) => this.#valid(location),
      (documentId) => this.document(documentId)?.courseId ?? null,
      newId,
    );
    if (!workspace) return;
    this.tabs = workspace.tabs.map((tab) => ({ id: tab.id, history: [tab.layout], index: 0 }));
    this.activeTabId = workspace.active ?? this.tabs[0]!.id;
    if (workspace.sidebarOpen !== null) this.sidebarOpen = workspace.sidebarOpen;
  }

  #valid(saved: unknown): Location | null {
    if (!saved || typeof saved !== "object") return null;
    const location = saved as Location;
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
        const zoom = Number(location.zoom);
        return {
          view: "document",
          documentId: document.id,
          page: Math.min(Math.max(1, Number(location.page) || 1), document.pages ?? 1),
          ...(zoom >= 0.5 && zoom <= 3 ? { zoom } : {}),
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
        version: 2,
        tabs: this.tabs.map((tab) => ({ id: tab.id, layout: this.#current(tab) })),
        active: this.activeTabId,
        sidebarOpen: this.sidebarOpen,
      };
      void this.#api?.saveWorkspace($state.snapshot(state)).catch(() => undefined);
    }, 400);
  }

  /** Where the student last read each document, on this device: what "Pick up" resumes. */
  reading = $state<Record<string, { page: number; at: string }>>(this.#savedReading());

  /** Records the open document's page once the student settles on it, chat beside or not. */
  #noteReading(): void {
    const location = lastUsed(this.layout, "document")?.location;
    if (!location) return;
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
    } else if (event.type === "mcp") {
      this.mcp = event.mcp;
    } else if (event.type === "approvals") {
      this.approvals = event.approvals;
    } else {
      this.error = event.message;
    }
  }
}

export const folio = new FolioState();
