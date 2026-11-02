import { lstat, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { createFolioModels, readConnections } from "../auth.ts";
import { FolioConfig, studyRoles } from "../config.ts";
import { checkKey, cleanKey, modelCatalog } from "../connections.ts";
import { LiveCatalog, liveSource } from "../live-catalog.ts";
import { privateDirectory, writeAtomic } from "../files.ts";
import { IngestRunner, trialRoles } from "../ingest/pipeline.ts";
import { piComplete } from "../ingest/pi-complete.ts";
import { prepareSource } from "../ingest/source.ts";
import { JobStore } from "../jobs/store.ts";
import { KnowledgeStore } from "../kb/store.ts";
import { TOPIC_POLICY, topicModel } from "../kb/topics.ts";
import { createAttach } from "../library/attachments.ts";
import { createRuntimes } from "../library/course-tools.ts";
import {
  checkAction,
  perform,
  PendingActions,
  type AppControls,
  type PendingAction,
} from "../library/app-actions.ts";
import type { Category } from "../library/categories.ts";
import { ChatFiles } from "../library/chat-files.ts";
import type { ImportItem, NamingScope, Rename } from "../library/naming.ts";
import { LibraryOperations } from "../library/operations.ts";
import { hostedSearch, type SearchFn } from "../library/web-search.ts";
import {
  ASSIGNMENT_KINDS,
  type AssignmentPatch,
  type AssignmentRecord,
} from "../library/assignments.ts";
import { CourseNotes, noteTitle, type ProposalRecord } from "../library/notes.ts";
import { scanFolder } from "../library/scan.ts";
import { parseCourseDetails, SYLLABUS_PROMPT, syllabusText } from "../library/syllabus.ts";
import {
  checkId,
  DOCUMENT_ROLES,
  LibraryError,
  LibraryStore,
  studied,
  type DocumentRole,
} from "../library/store.ts";
import { folioModel } from "../model-catalog.ts";
import { modelGroups, offered, openrouterCatalog } from "../model-choices.ts";
import {
  CONNECTIONS,
  connectionById,
  parseRef,
  studyModel,
  type Connection,
  type ConnectionId,
} from "../model-refs.ts";
import { createSessionStore } from "../session-store.ts";
import { ARTIFACT_SCHEME, ArtifactRegistry, artifactResponse, MAX_ARTIFACT } from "./artifacts.ts";
import {
  frameNavigationDecision,
  originOf,
  permissionDecision,
  requestDecision,
  trustedSender,
} from "./hardening.ts";
import {
  CHANNELS,
  type CourseInput,
  type DesktopBootstrap,
  type DesktopEvent,
  type DocumentPatch,
  type ImportResult,
  type InvokeMethod,
  type InvokeResult,
  type JobOrigin,
  type KnowledgeView,
  STUDY_ROLES,
  type ModelRole,
  type ModelsView,
  type PendingView,
  type TrashEntryView,
  type ProposalAction,
  type SkillsView,
  type SyllabusDraft,
  type ApprovalView,
  type McpView,
} from "./api.ts";
import { ChatService, errorMessage } from "./chat-service.ts";
import { PageReader } from "../library/page-reader.ts";
import { Removal } from "../library/removal.ts";
import { Trash, TRASH_DAYS, type TrashEntry } from "../library/trash.ts";
import { studyNotesView } from "./study-notes.ts";
import {
  courseView,
  documentView,
  mcpView,
  noteView,
  proposalView,
  type LiveChat,
} from "./view.ts";
import { folioHome, prepareHome } from "../home.ts";
import { SkillError, SkillLibrary } from "../skills/library.ts";
import { Approvals, type ApprovalRequest, type Decision } from "../mcp/approvals.ts";
import { McpConfig, type ServerInput, type ToolRule } from "../mcp/config.ts";
import { toolNames } from "../mcp/names.ts";
import { McpServers } from "../mcp/servers.ts";
import { mergePath, shellPath } from "../mcp/shell-path.ts";
import { promptCommand } from "../mcp/prompts.ts";
import { serviceTools } from "../mcp/tools.ts";
import { skillCommand, skillTool } from "../skills/tool.ts";

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, "..", "build", "renderer");
// Development only: the Vite dev server on loopback. Production serves the built files from a
// private standard scheme, so module workers (pdf.js) and the CSP's 'self' behave normally.
const devUrl = process.env.FOLIO_RENDERER_URL;
if (devUrl && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(devUrl))
  throw new Error("FOLIO_RENDERER_URL must be a loopback dev server.");
const rendererUrl = devUrl ?? "folio://app/index.html";
const rendererOrigin = originOf(rendererUrl);
// "log" grants what Electron would and prints each request, to take stock of what the page uses.
const permissionMode = process.env.FOLIO_PERMISSIONS === "log" ? "log" : "enforce";
app.setName("Folio");
// Another home is another instance: its own browser storage and its own single-instance lock.
if (process.env.FOLIO_HOME) app.setPath("userData", resolve(folioHome(), "electron"));
// A second Folio on the same home leaves here, before it moves, opens or creates anything in
// it: app.quit() would let the rest of this module start opening the stores. The first Folio
// comes forward on "second-instance".
if (!app.requestSingleInstanceLock()) app.exit(0);
// Everything Folio owns lives in ~/.folio; an earlier build's folder moves there once.
const home = prepareHome();
// A disposable test home may use an existing ChatGPT connection, read in place, never copied.
const connectionHome = resolve(process.env.FOLIO_CONNECTION_HOME ?? home);
const MAX_WORKSPACE_BYTES = 256 * 1024;
const MAX_SAVED_FILE = 5 * 1024 * 1024;
const artifacts = new ArtifactRegistry();

protocol.registerSchemesAsPrivileged([
  { scheme: "folio", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // The tutor's demos: standard and secure so each is its own origin; never bypassing CSP.
  { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true } },
]);

let window: BrowserWindow | undefined;
const emit = (event: DesktopEvent) => window?.webContents.send(CHANNELS.event, event);

// OpenRouter's models Pi published since its release, kept in Folio's home and checked again every
// four hours. FOLIO_MODEL_CATALOG names another source (tests), or "off". It is fetched like the
// model requests themselves, with Node's fetch: Electron's net goes through the window's session,
// which refuses every web request.
const live = new LiveCatalog({ home, source: liveSource(process.env.FOLIO_MODEL_CATALOG) });
const liveLoaded = live.load();
const catalog = modelCatalog(live);
const resolveModel = (id: string, provider = "openai") => {
  const model = folioModel(catalog, id, provider);
  if (!model) throw new Error(`Model '${id}' is not in Pi's catalog.`);
  return model;
};
/** A model by its `connection/model` reference; a bare ID is a ChatGPT model. */
const resolveRef = (ref: string) => {
  const parsed = parseRef(ref);
  return parsed ? resolveModel(parsed.id, parsed.connection.provider) : resolveModel(ref);
};
const connection = createFolioModels({ home: connectionHome });
const streamFn: StreamFn = async (model, context, options) =>
  (await connection).models.streamSimple(model, context, options);
// Which model does what: config.json in Folio's home, edited in Settings or by hand. It is read
// once the kept live list is, so a model picked from that list is still known.
const config = liveLoaded.then(() => FolioConfig.open(home, catalog));

let signIn: AbortController | undefined;
const connected = async (): Promise<Set<ConnectionId>> => readConnections((await connection).store);
/** The connection behind a role's model. */
const roleConnection = async (role: ModelRole): Promise<Connection> =>
  parseRef((await config).roles[role])!.connection;
/** The role's connection when Folio has its sign-in or key; otherwise its name, to ask for it. */
async function roleReady(role: ModelRole): Promise<{ ready: boolean; name: string }> {
  const needed = await roleConnection(role);
  return { ready: (await connected()).has(needed.id), name: needed.name };
}
/** The first connection studying uses that Folio lacks, or null when it has them all. */
async function studyMissing(): Promise<string | null> {
  for (const role of STUDY_ROLES) {
    const { ready, name } = await roleReady(role);
    if (!ready) return name;
  }
  return null;
}

async function modelsView(): Promise<ModelsView> {
  const [on, settings] = await Promise.all([connected(), config]);
  return {
    connections: CONNECTIONS.map((each) => ({
      id: each.id,
      name: each.name,
      kind: each.kind,
      connected: on.has(each.id),
      signingIn: each.id === "chatgpt" && !!signIn,
    })),
    groups: modelGroups(catalog, on, settings.openrouter),
    roles: settings.roles,
    problems: settings.problems,
    openrouter: settings.openrouter,
    categories: settings.categories,
    naming: settings.naming,
  };
}

/** Tells the window, and lets waiting studies start when what they need is there. */
async function modelsChanged(): Promise<void> {
  emit({ type: "models", models: await modelsView() });
  (await jobs).runner.connectionChanged();
}
void config.then((settings) =>
  settings.watch(() => {
    void modelsChanged();
  }),
);

/**
 * Asks pi.dev for a newer list when the kept one is four hours old. New models may make an entry
 * in config.json usable, so it is read again, and the window is told.
 */
async function refreshLive(): Promise<void> {
  if (!(await live.refresh())) return;
  await (await config).reload();
  await modelsChanged();
}
setInterval(() => void refreshLive(), 3_600_000).unref();

/**
 * The student's routines: Folio's own, and other agents' folders once turned on. Tests point
 * `FOLIO_SKILL_HOME` at a disposable folder, so they never read the developer's own skills.
 */
const skills = config.then(
  (settings) =>
    new SkillLibrary({
      home,
      user: process.env.FOLIO_SKILL_HOME ? resolve(process.env.FOLIO_SKILL_HOME) : homedir(),
      switches: () => settings.skills,
    }),
);

/**
 * The student's MCP servers: mcp.json, the servers it starts, and calls waiting for the student.
 * A packaged Folio, opened from the Dock, asks the login shell for the PATH once, so commands
 * installed with uv or Homebrew are found.
 */
const mcpConfig = McpConfig.open(home);
let serverPath: Promise<string> | undefined;
const servers = mcpConfig.then(
  (config) =>
    new McpServers({
      config,
      home,
      path: () =>
        (serverPath ??= app.isPackaged
          ? shellPath().then((path) => mergePath(path, process.env.PATH))
          : Promise.resolve(mergePath(process.env.PATH))),
      changed: () => void emitMcp(),
      fetch: (input, init) => net.fetch(input as string, init as RequestInit),
    }),
);
void Promise.all([mcpConfig, servers]).then(([config, running]) =>
  config.watch(() => void running.reconcile()),
);

async function currentMcpView(): Promise<McpView> {
  const [config, running] = await Promise.all([mcpConfig, servers]);
  return mcpView(running.list(), config.problems);
}
async function emitMcp(): Promise<void> {
  emit({ type: "mcp", mcp: await currentMcpView() });
}

const approvalView = (request: ApprovalRequest): ApprovalView => ({
  id: request.id,
  chatId: request.chatId,
  label: request.label,
  tool: request.tool,
  description: request.description,
  hints: request.hints,
  args: JSON.stringify(request.args, null, 2),
});
const approvals = new Approvals((chatId) => {
  emit({ type: "approvals", approvals: approvals.list().map(approvalView) });
  void service.then((chats) => chats.refresh(chatId));
});

/** A chat's waiting calls, and the server and tool behind each service tool's name. */
async function liveChats(): Promise<(chatId: string) => LiveChat> {
  const running = await servers;
  return (chatId) => {
    const waiting = approvals.list(chatId);
    const names = new Map<string, { label: string; tool: string }>();
    const taken = new Set<string>();
    for (const state of running.list()) {
      const tools = state.tools.map((tool) => tool.name);
      toolNames(state.entry.id, tools, taken).forEach((name, index) => {
        taken.add(name);
        names.set(name, { label: state.entry.label, tool: tools[index]! });
      });
    }
    return {
      approvals: waiting.map(approvalView),
      waiting: waiting.map((request) => request.callId),
      service: (name) => names.get(name),
    };
  };
}

async function skillsView(): Promise<SkillsView> {
  const [library, settings] = await Promise.all([skills, config]);
  const { skills: found, skipped } = await library.scan();
  return {
    skills: found.map(({ digest: _digest, ...skill }) => skill),
    skipped,
    folders: settings.skills.folders,
    folder: library.key(library.folder),
  };
}

/**
 * Web search on the research role's model. Each search is its own request carrying the query
 * and nothing else.
 */
const search: SearchFn = async (query, signal) => {
  const ref = (await config).roles.research;
  const { ready, name } = await roleReady("research");
  if (!ready)
    throw new LibraryError(
      `Web search runs on ${name}, which isn't connected. Answer from the course and general knowledge, and say what you could not check.`,
    );
  return hostedSearch(streamFn, resolveRef(ref))(query, signal);
};

const library = LibraryStore.open({ home });
const notes = library.then((store) => new CourseNotes(store));
// One reader of course PDFs for the tutor: page text, and pages as images.
const pageReader = library.then((store) => new PageReader(store));
// Topics are compared and given overviews at low effort, by the model set for them.
const knowledgeStore = Promise.all([library, config]).then(([store, settings]) =>
  KnowledgeStore.open(store, {
    topics: topicModel(
      piComplete(async () => (await connection).models, resolveRef),
      () => studyModel(settings.roles.topics),
    ),
  }),
);
/**
 * How many model requests studying keeps in flight at once, and how many documents it studies
 * side by side. Two documents share the requests, so one's waits (its plan, its last checks, its
 * fixes) are the other's turn; both can be changed to try what the student's plan allows.
 */
function setting(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
const jobs = Promise.all([JobStore.open(home), library, config]).then(
  ([store, courses, settings]) => {
    const runner = new IngestRunner({
      store,
      library: courses,
      // Each step on the model set for it, through the connection that model needs.
      roles: () => trialRoles(process.env, studyRoles(settings.roles)),
      concurrency: setting(process.env.FOLIO_STUDY_CONCURRENCY, 16),
      parallelJobs: setting(process.env.FOLIO_STUDY_JOBS, 2),
      complete: piComplete(async () => (await connection).models, resolveRef),
      prepare: prepareSource,
      emit: (job) => emit({ type: "job", job }),
      async publish(bundle) {
        const published = await (await knowledgeStore).publish(bundle);
        emit({ type: "library" });
        return published.generation;
      },
      removed: (id) => emit({ type: "jobRemoved", id }),
      connected: async () => (await studyMissing()) === null,
      knowledge: async (courseId) => (await knowledgeStore).knowledge(courseId),
      async regroup(courseId) {
        const result = await (await knowledgeStore).regroup(courseId);
        emit({ type: "library" });
        return result ? { merged: result.merged } : null;
      },
    });
    // Jobs interrupted by a quit go back in the queue and continue where they stopped.
    runner.recover();
    return { store, runner };
  },
);

/**
 * Lectures and recitations are studied as soon as they arrive, after a moment in which a wrong
 * role can still be fixed for free. The runner skips anything already studying, cancelled by
 * the student, or not a PDF lecture or recitation.
 */
const STUDY_DELAY = Number(process.env.FOLIO_STUDY_DELAY_MS ?? 15_000);
/** The never-studied backlog is looked for a little after start, once the window is up. */
const BACKLOG_DELAY = process.env.FOLIO_STUDY_DELAY_MS ? STUDY_DELAY : 5_000;
function studySoon(courseId: string, documentIds: string[], origin: JobOrigin): void {
  if (!documentIds.length) return;
  setTimeout(() => {
    void jobs
      .then(({ runner }) => runner.queue(courseId, documentIds, origin))
      .catch((error: unknown) => console.error("Folio could not queue a study:", error));
  }, STUDY_DELAY).unref();
}

/** Every lecture and recitation in the library that was never studied, queued once at start. */
setTimeout(() => {
  void Promise.all([library, knowledgeStore])
    .then(async ([courses, knowledge]) => {
      const documents = (await courses.listDocuments()).filter(studied);
      const byCourse = new Map<string, string[]>();
      for (const document of documents) {
        const known = (await knowledge.knowledge(document.courseId))?.sessions.some(
          (session) => session.documentId === document.id,
        );
        if (!known)
          byCourse.set(document.courseId, [
            ...(byCourse.get(document.courseId) ?? []),
            document.id,
          ]);
      }
      const { runner } = await jobs;
      // Notes written before topics were shared are regrouped once, ahead of the backlog.
      for (const course of await courses.listCourses()) {
        const published = await knowledge.knowledge(course.id);
        const pending = runner
          .list()
          .some(
            (job) => job.kind === "regroup" && job.courseId === course.id && job.status !== "done",
          );
        // And again once when the merging rules change.
        const stale = !published?.grouped || (published.groupedPolicy ?? 1) < TOPIC_POLICY;
        if (published?.pages.length && stale && !pending) await runner.regroup(course.id);
      }
      for (const [courseId, ids] of byCourse) await runner.queue(courseId, ids, "backlog");
    })
    .catch((error: unknown) => console.error("Folio could not queue unstudied lectures:", error));
}, BACKLOG_DELAY).unref();
/** Every change to courses and files goes through here, from the window or from the tutor. */
const operations = Promise.all([library, knowledgeStore, config]).then(
  ([store, knowledge, settings]) =>
    new LibraryOperations({
      library: store,
      categories: () => settings.categories,
      async saveCategories(categories) {
        try {
          await settings.setCategories(categories);
        } finally {
          await modelsChanged();
        }
      },
      naming: () => settings.naming,
      async saveNaming(pattern) {
        try {
          await settings.setNaming(pattern);
        } finally {
          await modelsChanged();
        }
      },
      knowledge,
      async withdraw(id) {
        await (await jobs).runner.withdraw((job) => job.documentIds.includes(id));
      },
      studySoon: (courseId, documentIds) => studySoon(courseId, documentIds, "upload"),
      syncAssignments,
      changed: () => emit({ type: "library" }),
    }),
);
// Files from before numbers get theirs once, from their names or the order they came in.
void operations
  .then((all) => all.numberAll())
  .catch((error: unknown) => console.error("Folio could not number files:", error));

/** The tutor's controls, once the chat service has made them; Apply and Undo use them too. */
const appControls = Promise.withResolvers<AppControls>();

// Files the student adds to chats, and changes the tutor proposed that wait for the student.
const chatFiles = new ChatFiles(home);
const pendingActions = new PendingActions(home, () => emit({ type: "library" }));

const sessionStore = createSessionStore({ home });
const service = Promise.all([
  sessionStore,
  library,
  notes,
  knowledgeStore,
  pageReader,
  config,
  operations,
  mcpConfig,
  servers,
  liveChats(),
]).then(
  ([store, courses, courseNotes, knowledge, pages, settings, changes, mcp, running, live]) => {
    // What the tutor can do in Folio: the same code the window's controls run.
    const controls: AppControls = {
      library: courses,
      operations: changes,
      categories: () => settings.categories,
      naming: () => settings.naming,
      async trashDocument(id) {
        const entry = await (await removal).removeDocument(id);
        await trashChanged();
        return entry.id;
      },
      async trashCourse(id) {
        const entry = await (await removal).removeCourse(id);
        await trashChanged();
        return entry.id;
      },
      async restore(entryId) {
        await (await removal).restore(entryId);
        await trashChanged();
      },
      roles: () => settings.roles,
      async setModel(step, ref) {
        try {
          await settings.setRole(step, ref);
        } finally {
          await modelsChanged();
        }
      },
      async study(courseId, documentIds) {
        const missing = await studyMissing();
        if (missing) throw new LibraryError(`Connect ${missing} in Settings to study documents.`);
        await (await jobs).runner.start(courseId, documentIds);
      },
      async stopStudying(documentIds) {
        await (
          await jobs
        ).runner.withdraw((job) => job.documentIds.some((id) => documentIds.includes(id)));
      },
      chatFile: (file) => chatFiles.path({ fileId: file.fileId, kind: file.fileKind }),
    };
    appControls.resolve(controls);
    const runtimes = createRuntimes(courses, {
      categories: () => settings.categories,
      files: chatFiles,
      app: { controls, pending: pendingActions },
      notes: courseNotes,
      changed: () => emit({ type: "library" }),
      knowledge,
      pages,
      visuals: true,
      search,
      // The routines that are on, as each question is sent.
      async extras(chat) {
        const library = await skills;
        const active = await library.active();
        return [
          ...(active.length ? [skillTool(library, active, () => chat.grants().skills ?? [])] : []),
          ...serviceTools({
            servers: running,
            config: mcp,
            approvals,
            chatId: chat.chatId,
            home,
            budget: { used: 0 },
            notice: (message) => emit({ type: "error", chatId: chat.chatId, message }),
          }),
        ];
      },
    });
    return new ChatService({
      store,
      streamFn,
      resolveModel,
      model: () => settings.roles.teaching,
      offered: (ref) => offered(ref, settings.openrouter),
      connected: async (needed) => (await connected()).has(needed.id),
      emit,
      courseRuntime: runtimes.course,
      libraryRuntime: runtimes.library,
      // Pages, images, files, lectures and courses the student adds, checked against the chat.
      attach: createAttach(courses, pages, {
        studied: (id) => !!knowledge.current(id),
        files: chatFiles,
      }),
      command: async (input) =>
        input.kind === "skill"
          ? skillCommand(await skills, input.name)
          : promptCommand(running, mcp, input),
      live,
      // How the student answered the tutor's proposals since its last reply.
      async notes(chatId) {
        return (await pendingActions.untold(chatId)).map((record) =>
          record.state === "applied"
            ? `The student applied "${record.summary}".`
            : record.state === "cancelled"
              ? `The student cancelled "${record.summary}".`
              : `"${record.summary}" could not be applied: ${record.note ?? "it failed"}.`,
        );
      },
    });
  },
);

// Removed things wait 30 days in Folio's Trash, then move on to the Mac's Trash.
const trash = new Trash(home, { discard: (path) => shell.trashItem(path) });
const removal = Promise.all([library, notes, sessionStore, knowledgeStore, jobs, service]).then(
  ([courses, courseNotes, sessions, knowledge, { runner }, chats]) =>
    new Removal({
      library: courses,
      notes: courseNotes,
      sessions,
      trash,
      knowledge,
      stopStudying: (scope) =>
        runner.withdraw((job) =>
          "courseId" in scope
            ? job.courseId === scope.courseId
            : job.documentIds.some((id) => scope.documentIds.includes(id)),
        ),
      releaseChats: (ids) => chats.release(ids),
      forgetJobs(courseId) {
        for (const job of runner.list())
          if (job.courseId === courseId) {
            runner.dismiss(job.id);
            emit({ type: "jobRemoved", id: job.id });
          }
      },
    }),
);

function trashView(entry: TrashEntry): TrashEntryView {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    courseId: entry.courseId,
    courseName: entry.courseName,
    removedAt: entry.removedAt,
    expiresAt: new Date(Date.parse(entry.removedAt) + TRASH_DAYS * 86_400_000).toISOString(),
    contents: entry.contents ?? null,
    withStudyNotes: !!entry.knowledge,
  };
}

/** After something moved in or out of the Trash: the library, chats and Trash refresh. */
async function trashChanged(): Promise<void> {
  emit({ type: "library" });
  emit({ type: "trash" });
  await (await service).announceChats();
}

async function emptyExpired(): Promise<void> {
  try {
    if (await trash.purge()) emit({ type: "trash" });
  } catch {
    // Tried again at the next check; nothing in Folio depends on it.
  }
}
void emptyExpired();
setInterval(() => void emptyExpired(), 6 * 3_600_000).unref();

async function startSignIn(): Promise<void> {
  if (signIn) return;
  const controller = new AbortController();
  signIn = controller;
  emit({ type: "models", models: await modelsView() });
  const { models, store } = await connection;
  const interaction: AuthInteraction = {
    signal: controller.signal,
    // The browser callback completes sign-in; the manual-paste fallback waits until cancelled.
    prompt: (prompt) =>
      prompt.type === "select"
        ? Promise.reject(new Error("Only ChatGPT browser sign-in is supported."))
        : new Promise<string>((_, reject) => {
            const signal = prompt.signal ?? controller.signal;
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Sign-in canceled.", "AbortError")),
              { once: true },
            );
          }),
    notify(event) {
      if (event.type === "auth_url" && event.url.startsWith("https://"))
        void shell.openExternal(event.url);
    },
  };
  try {
    await models.login("openai", "oauth", interaction, {
      getDeviceId: store.getDeviceId,
      agentName: "Folio",
    });
  } catch (error) {
    if (!controller.signal.aborted)
      emit({ type: "error", chatId: null, message: errorMessage(error) });
  } finally {
    signIn = undefined;
    await modelsChanged();
  }
}

async function courses() {
  const store = await library;
  const [list, documents] = await Promise.all([store.listCourses(), store.listDocuments()]);
  return list.map((course) =>
    courseView(course, documents.filter((document) => document.courseId === course.id).length),
  );
}

async function proposal(record: ProposalRecord) {
  const courseNotes = await notes;
  const title = record.noteId
    ? ((await courseNotes.read(record.noteId).catch(() => undefined))?.title ?? "A removed note")
    : (record.title ?? "New note");
  return proposalView(record, title, await courseNotes.stale(record));
}

async function choose(options: Electron.OpenDialogOptions): Promise<string | undefined> {
  const picked = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return picked.canceled ? undefined : picked.filePaths[0];
}

const MAX_SYLLABUS_BYTES = 50 * 1024 * 1024;

/** Reads the syllabus the student chose and asks the model for the course's name, code and term. */
async function readSyllabus(path: string): Promise<SyllabusDraft> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error("Choose a regular file.");
  if (info.size > MAX_SYLLABUS_BYTES) throw new Error("That syllabus is too large.");
  const fileName = basename(path);
  const kind = /\.pdf$/i.test(path) ? "pdf" : /\.(md|markdown)$/i.test(path) ? "markdown" : null;
  if (!kind) throw new Error("Folio can read PDF and Markdown syllabi.");
  const draft: SyllabusDraft = { path, fileName, name: "", code: "", term: "", read: false };
  let text: string;
  try {
    text = await syllabusText(new Uint8Array(await readFile(path)), kind);
  } catch {
    return { ...draft, note: `Folio couldn't open ${fileName}. Fill in the details yourself.` };
  }
  if (!text.trim())
    return {
      ...draft,
      note: "This file has no text Folio can read, for example a scan. Fill in the details yourself.",
    };
  const { ready, name } = await roleReady("syllabus");
  if (!ready)
    return { ...draft, note: `Connect ${name} and Folio can fill these in from the syllabus.` };
  const reply = await (
    await connection
  ).models.completeSimple(
    resolveRef((await config).roles.syllabus),
    {
      systemPrompt: SYLLABUS_PROMPT,
      messages: [{ role: "user", content: text, timestamp: Date.now() }],
    },
    { maxTokens: 1200 },
  );
  const details = parseCourseDetails(
    reply.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
  );
  if (!details)
    return { ...draft, note: "Folio couldn't find the course details. Fill them in yourself." };
  return { ...draft, ...details, read: true };
}

async function knowledgeView(courseId: string): Promise<KnowledgeView | null> {
  const store = await knowledgeStore;
  const current = store.current(courseId);
  const knowledge = await store.knowledge(courseId);
  if (!current || !knowledge) return null;
  return {
    courseId,
    generation: current.generation,
    publishedAt: current.publishedAt,
    summary: current.summary,
    sessions: knowledge.sessions.map(({ slug, title, documentId }) => ({
      slug,
      title,
      documentId,
    })),
    pages: knowledge.pages.length,
    blocks: knowledge.pages.reduce((sum, page) => sum + page.blocks.length, 0),
    canRollBack: store.history(courseId).length > 1,
  };
}

/** An assignment for the window: the record without its storage version. */
function assignmentView({ version: _version, ...assignment }: AssignmentRecord) {
  return assignment;
}

/** Assignment documents become board cards; run after anything that can add or re-role one. */
function syncAssignments(): void {
  void library
    .then((store) => store.syncAssignments())
    .then((created) => created.length && emit({ type: "library" }))
    .catch((error: unknown) => console.error("Folio could not add assignments:", error));
}
syncAssignments();

/** A change the tutor proposed, for its card. */
function pendingView(record: PendingAction): PendingView {
  return {
    id: record.id,
    chatId: record.chatId,
    summary: record.summary,
    state: record.state,
    note: record.note ?? null,
    createdAt: record.createdAt,
    undo: record.undo ?? null,
  };
}

/** Which files a pattern rename covers, as the window sends it. */
function namingScope(value: unknown): NamingScope {
  const { courseId, categoryId, documentIds } = (value ?? {}) as Record<string, unknown>;
  if (courseId !== undefined) checkId(courseId);
  if (categoryId !== undefined && typeof categoryId !== "string")
    throw new Error("Unknown category.");
  if (
    documentIds !== undefined &&
    (!Array.isArray(documentIds) || !documentIds.every((id) => typeof id === "string"))
  )
    throw new Error("Choose files to rename.");
  return {
    courseId: courseId as string | undefined,
    categoryId: categoryId as string | undefined,
    documentIds: documentIds as string[] | undefined,
  };
}

/** A file to import as the window sends it: a path, or a path with what the student chose. */
function importItem(value: unknown): ImportItem | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return null;
  const { path, category, number, title } = value as Record<string, unknown>;
  if (typeof path !== "string") return null;
  if (category !== undefined && typeof category !== "string") return null;
  if (number !== undefined && (!Number.isInteger(number) || Number(number) < 0)) return null;
  if (title !== undefined && typeof title !== "string") return null;
  return { path, category, number: number as number | undefined, title };
}

async function importPaths(
  courseId: unknown,
  paths: unknown,
  role?: unknown,
  category?: unknown,
): Promise<ImportResult[]> {
  checkId(courseId);
  const items = Array.isArray(paths) ? paths.map(importItem) : [];
  if (!Array.isArray(paths) || items.some((item) => item === null))
    throw new Error("Choose files to import.");
  if (role !== undefined && role !== null && !DOCUMENT_ROLES.includes(role as DocumentRole))
    throw new Error("Unknown role.");
  if (category !== undefined && category !== null && typeof category !== "string")
    throw new Error("Unknown category.");
  const results = await (
    await operations
  ).importFiles(courseId, items as ImportItem[], {
    role: (role as DocumentRole | null) ?? undefined,
    category: (category as string | null) ?? undefined,
  });
  return results.map((result) =>
    "error" in result ? result : { ...result, document: documentView(result.document) },
  );
}

const handlers: Record<InvokeMethod, (...args: unknown[]) => Promise<unknown>> = {
  async bootstrap(): Promise<DesktopBootstrap> {
    const { chats, unavailable } = await (await service).chats();
    return {
      models: await modelsView(),
      chats,
      unavailableChats: unavailable,
      platform: process.platform,
    };
  },
  openChat: async (id) => (await service).openChat(id),
  send: async (input) => (await service).send(input),
  cancel: async (id) => (await service).cancel(id),
  setFocus: async (id, focus) => (await service).setFocus(id, focus),
  async signIn() {
    void startSignIn();
  },
  async cancelSignIn() {
    signIn?.abort();
  },
  async signOut() {
    signIn?.abort();
    await (await connection).models.logout("openai");
    await modelsChanged();
  },
  async saveKey(id, key) {
    const target = connectionById(id);
    if (target?.kind !== "key") throw new Error("Folio does not take a key for that.");
    const clean = cleanKey(target, key);
    await checkKey(target.id, clean);
    await (
      await connection
    ).store.modify(target.provider, async () => ({ type: "api_key", key: clean }));
    await modelsChanged();
  },
  async removeKey(id) {
    const target = connectionById(id);
    if (target?.kind !== "key") throw new Error("Folio does not take a key for that.");
    await (await connection).models.logout(target.provider);
    await modelsChanged();
  },
  async setRoleModel(role, ref) {
    try {
      await (await config).setRole(role as ModelRole, ref as string);
    } finally {
      await modelsChanged();
    }
  },
  async setOpenRouterModels(ids) {
    try {
      await (await config).setOpenRouter(ids);
    } finally {
      await modelsChanged();
    }
  },
  setCategories: async (categories) => (await operations).setCategories(categories as Category[]),
  setNaming: async (pattern) =>
    (await operations).setNaming(typeof pattern === "string" ? pattern : null),
  renames: async (scope) => (await operations).renames(namingScope(scope)),
  applyNaming: async (scope) => (await operations).applyNaming(namingScope(scope)),
  async listPending() {
    return (await pendingActions.list()).map(pendingView);
  },
  async resolvePending(id, apply) {
    checkId(id);
    const controls = await appControls.promise;
    const record = await pendingActions.resolve(id as string, async (record) => {
      if (apply !== true) return { state: "cancelled" };
      try {
        const done = await perform(record.action, controls);
        return { state: "applied", note: done.summary, ...(done.undo ? { undo: done.undo } : {}) };
      } catch (error) {
        return { state: "failed", note: errorMessage(error) };
      }
    });
    emit({ type: "library" });
    return pendingView(record);
  },
  async undoAction(undo) {
    const done = await perform(checkAction(undo), await appControls.promise);
    emit({ type: "library" });
    return done.summary;
  },
  async undoNaming(renames) {
    if (!Array.isArray(renames)) throw new Error("Nothing to undo.");
    return (await operations).undoNaming(renames as Rename[]);
  },
  openrouterCatalog: async () => openrouterCatalog(catalog),
  async revealConfig() {
    const settings = await config;
    await settings.ensure();
    shell.showItemInFolder(settings.path);
  },
  listSkills: skillsView,
  async setSkillOn(key, on) {
    const found = (await (await skills).scan()).skills.find((skill) => skill.key === key);
    if (!found) throw new SkillError("That routine is no longer there.");
    await (await config).setSkill(found.key, on === true, found.source === "folio");
    return skillsView();
  },
  async createSkill(input) {
    const { name, description, body } = (input ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || typeof description !== "string" || typeof body !== "string")
      throw new SkillError("Give the routine a name, a description and instructions.");
    await (await skills).create(name.trim(), description, body);
    return skillsView();
  },
  readSkill: async (name) => (await skills).read(String(name)),
  async saveSkill(name, text, revision) {
    if (typeof text !== "string" || typeof revision !== "string")
      throw new SkillError("Nothing to save.");
    await (await skills).save(String(name), text, revision);
    return skillsView();
  },
  async addSkillFolder() {
    const folder = await choose({
      title: "Choose a folder of skills",
      buttonLabel: "Add",
      properties: ["openDirectory"],
    });
    if (!folder) return null;
    await (await config).setSkillFolder((await skills).key(folder), true);
    return skillsView();
  },
  async removeSkillFolder(key) {
    await (await config).setSkillFolder(String(key), false);
    return skillsView();
  },
  mcpServers: currentMcpView,
  async addMcpServers(text) {
    if (typeof text !== "string" || !text.trim())
      throw new Error("Paste the server's block first.");
    await (await mcpConfig).addPasted(text);
    await (await servers).reconcile();
    return currentMcpView();
  },
  async saveMcpServer(input, previous) {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof (input as ServerInput).id !== "string"
    )
      throw new Error("Name the server.");
    await (
      await mcpConfig
    ).saveServer(input as ServerInput, typeof previous === "string" ? previous : undefined);
    await (await servers).reconcile();
    return currentMcpView();
  },
  async removeMcpServer(id) {
    await (await mcpConfig).removeServer(String(id));
    await (await servers).reconcile();
    return currentMcpView();
  },
  async setMcpServerOn(id, on) {
    await (await mcpConfig).setEnabled(String(id), on === true);
    await (await servers).reconcile();
    return currentMcpView();
  },
  async restartMcpServer(id) {
    await (await servers).restart(String(id));
    return currentMcpView();
  },
  async setMcpServerApproval(id, approval) {
    await (await mcpConfig).setApproval(String(id), approval === "allow" ? "allow" : "ask");
    return currentMcpView();
  },
  async setMcpToolRule(id, tool, rule) {
    await (await mcpConfig).setToolRule(String(id), String(tool), rule as ToolRule);
    return currentMcpView();
  },
  async revealMcpConfig() {
    const config = await mcpConfig;
    // Shown with nothing in it yet, rather than not at all.
    if ((await lstat(config.path).catch(() => null)) === null)
      await writeAtomic(config.path, '{\n  "version": 1,\n  "mcpServers": {}\n}\n', {
        mode: 0o600,
      });
    shell.showItemInFolder(config.path);
  },
  listApprovals: async () => approvals.list().map(approvalView),
  async answerApproval(id, decision) {
    approvals.answer(String(id), decision as Decision);
  },
  async revealSkill(key) {
    const library = await skills;
    if (typeof key !== "string") {
      await privateDirectory(library.folder, "skills", SkillError);
      return void (await shell.openPath(library.folder));
    }
    const found = (await library.scan()).skills.find((skill) => skill.key === key);
    if (!found) throw new SkillError("That routine is no longer there.");
    shell.showItemInFolder(resolve(library.path(found.key), "SKILL.md"));
  },
  listCourses: courses,
  async createCourse(input) {
    const course = await (await operations).createCourse((input ?? {}) as CourseInput);
    return courseView(course, 0);
  },
  async updateCourse(id, patch, revision) {
    checkId(id);
    await (await operations).updateCourse(id, (patch ?? {}) as CourseInput, Number(revision));
    return (await courses()).find((course) => course.id === id);
  },
  async listDocuments(courseId) {
    if (courseId !== undefined && courseId !== null) checkId(courseId);
    const documents = await (
      await library
    ).listDocuments({
      courseId: (courseId as string | null | undefined) ?? undefined,
    });
    return documents.map(documentView);
  },
  importFiles: importPaths,
  async chooseFiles(courseId) {
    checkId(courseId);
    const options: Electron.OpenDialogOptions = {
      title: "Add files to this course",
      buttonLabel: "Add",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "PDF and Markdown", extensions: ["pdf", "md", "markdown"] }],
    };
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return picked.canceled ? [] : importPaths(courseId, picked.filePaths);
  },
  async updateDocument(id, patch, revision) {
    checkId(id);
    const document = await (
      await operations
    ).updateDocument(id, (patch ?? {}) as DocumentPatch, Number(revision));
    return documentView(document);
  },
  async readDocument(id) {
    checkId(id);
    return (await (await library).readOriginal(id)).data;
  },
  async listNotes(courseId) {
    if (courseId !== undefined && courseId !== null) checkId(courseId);
    return (await (await notes).list((courseId as string | null | undefined) ?? undefined)).map(
      noteView,
    );
  },
  async readNote(id) {
    checkId(id);
    const note = await (await notes).read(id);
    return { note: noteView(note), content: note.content };
  },
  async createNote(courseId, title) {
    checkId(courseId);
    const note = await (await notes).create(courseId, typeof title === "string" ? title : "");
    emit({ type: "library" });
    return noteView(note);
  },
  async saveNote(id, content, revision) {
    checkId(id);
    if (typeof content !== "string" || typeof revision !== "string")
      throw new Error("A note and its revision are required.");
    const note = await (await notes).save(id, content, revision);
    emit({ type: "library" });
    return noteView(note);
  },
  async noteHistory(id) {
    checkId(id);
    return (await (await notes).history(id)).map((entry) => ({
      revision: entry.revision,
      at: entry.at,
      author: entry.author.kind,
      title: noteTitle(entry.content),
      characters: entry.content.length,
    }));
  },
  async restoreNote(id, version, revision) {
    checkId(id);
    if (typeof version !== "string" || typeof revision !== "string")
      throw new Error("A version and the note's revision are required.");
    const note = await (await notes).restore(id, version, revision);
    emit({ type: "library" });
    return noteView(note);
  },
  async appendToNote(id, text) {
    checkId(id);
    if (typeof text !== "string" || !text.trim()) throw new Error("Nothing to add.");
    const note = await (await notes).append(id, text);
    emit({ type: "library" });
    return noteView(note);
  },
  async searchNotes(query, courseId) {
    if (typeof query !== "string") throw new Error("A search is required.");
    if (courseId !== undefined && courseId !== null) checkId(courseId);
    const found = await (
      await notes
    ).search(query.slice(0, 200), (courseId as string | null) ?? undefined);
    return found.slice(0, 100).map(({ note, snippet }) => ({ noteId: note.id, snippet }));
  },
  async noteMentions(id) {
    checkId(id);
    return (await (await notes).mentions(id)).map(({ note, linked, unlinked }) => ({
      noteId: note.id,
      title: note.title,
      revision: note.revision,
      linked,
      unlinked,
    }));
  },
  async linkMention(source, target, revision) {
    checkId(source);
    checkId(target);
    if (typeof revision !== "string") throw new Error("The note's revision is required.");
    const note = await (await notes).linkMention(source, target, revision);
    emit({ type: "library" });
    return noteView(note);
  },
  async listProposals() {
    return Promise.all((await (await notes).listProposals()).map(proposal));
  },
  async resolveProposal(id, action) {
    checkId(id);
    if (!["keep", "insert", "discard"].includes(action as string))
      throw new Error("Unknown action.");
    try {
      return await proposal(await (await notes).resolve(id, action as ProposalAction));
    } finally {
      emit({ type: "library" });
    }
  },
  async scanFolder(path) {
    const folder =
      typeof path === "string"
        ? path
        : await choose({
            title: "Choose a course folder",
            buttonLabel: "Scan",
            properties: ["openDirectory"],
          });
    return folder ? scanFolder(folder, (await config).categories) : null;
  },
  async readSyllabus(path) {
    const file =
      typeof path === "string"
        ? path
        : await choose({
            title: "Choose the course syllabus",
            buttonLabel: "Read",
            properties: ["openFile"],
            filters: [{ name: "PDF and Markdown", extensions: ["pdf", "md", "markdown"] }],
          });
    return file ? readSyllabus(file) : null;
  },
  listJobs: async () => (await jobs).runner.list(),
  async startIngest(courseId, documentIds) {
    checkId(courseId);
    if (!Array.isArray(documentIds) || documentIds.some((id) => typeof id !== "string"))
      throw new Error("Choose lectures or recitations to study.");
    const missing = await studyMissing();
    if (missing) throw new Error(`Connect ${missing} in Settings to study documents.`);
    return (await jobs).runner.start(courseId, documentIds as string[]);
  },
  async pauseJob(id) {
    checkId(id);
    return (await jobs).runner.pause(id);
  },
  async resumeJob(id) {
    checkId(id);
    const missing = await studyMissing();
    if (missing) throw new Error(`Connect ${missing} in Settings to resume.`);
    return (await jobs).runner.resume(id);
  },
  async cancelJob(id) {
    checkId(id);
    return (await jobs).runner.cancel(id);
  },
  async dismissJob(id) {
    checkId(id);
    (await jobs).runner.dismiss(id);
  },
  async knowledge(courseId) {
    checkId(courseId);
    return knowledgeView(courseId);
  },
  async studyNotes(courseId) {
    checkId(courseId);
    const store = await knowledgeStore;
    const current = store.current(courseId);
    const knowledge = await store.knowledge(courseId);
    return current && knowledge ? studyNotesView(knowledge, current) : null;
  },
  async rollbackKnowledge(courseId) {
    checkId(courseId);
    (await knowledgeStore).rollback(courseId);
    emit({ type: "library" });
    return (await knowledgeView(courseId))!;
  },
  async trashDocuments(ids) {
    if (!Array.isArray(ids) || !ids.length) throw new Error("Choose files to remove.");
    ids.forEach(checkId);
    const remove = await removal;
    const entries: TrashEntry[] = [];
    try {
      for (const id of ids as string[]) entries.push(await remove.removeDocument(id));
    } finally {
      await trashChanged();
    }
    return entries.map(trashView);
  },
  async listAssignments() {
    return (await (await library).listAssignments()).map(assignmentView);
  },
  async createAssignment(input) {
    const value = (input ?? {}) as Record<string, unknown>;
    checkId(value.courseId);
    const kind = ASSIGNMENT_KINDS.find((candidate) => candidate === value.kind);
    const created = await (
      await library
    ).createAssignment({
      courseId: value.courseId as string,
      title: typeof value.title === "string" ? value.title : "",
      ...(kind ? { kind } : {}),
      dueAt: typeof value.dueAt === "string" ? value.dueAt : null,
      dueHasTime: value.dueHasTime === true,
    });
    emit({ type: "library" });
    return assignmentView(created);
  },
  async updateAssignment(id, patch, revision) {
    checkId(id);
    const updated = await (
      await library
    ).updateAssignment(id, (patch ?? {}) as AssignmentPatch, Number(revision));
    emit({ type: "library" });
    return assignmentView(updated);
  },
  async addAssignmentFiles(id, into, revision, note) {
    checkId(id);
    if (into !== "attempt" && into !== "feedback") throw new Error("Unknown kind of file.");
    const options: Electron.OpenDialogOptions = {
      title: into === "attempt" ? "Add what you handed in" : "Add the feedback you got back",
      buttonLabel: "Add",
      properties: ["openFile", "multiSelections"],
    };
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths.length) return null;
    const updated = await (
      await library
    ).addAssignmentFiles(
      id,
      picked.filePaths,
      into,
      Number(revision),
      typeof note === "string" ? note : "",
    );
    emit({ type: "library" });
    return assignmentView(updated);
  },
  async openAssignmentFile(id, fileId) {
    checkId(id);
    const store = await library;
    const assignment = await store.assignment(id);
    const kept = [
      ...assignment.attempts.flatMap((attempt) => attempt.files),
      ...assignment.feedback.files,
    ];
    if (!kept.some((file) => file.id === fileId)) throw new Error("That file is not kept here.");
    const failure = await shell.openPath(store.assignmentFile(id, fileId as string));
    if (failure) throw new Error(failure);
  },
  async trashAssignment(id) {
    checkId(id);
    const entry = await (await removal).removeAssignment(id as string);
    await trashChanged();
    return trashView(entry);
  },
  async trashNote(id) {
    checkId(id);
    const entry = await (await removal).removeNote(id as string);
    await trashChanged();
    return trashView(entry);
  },
  async trashChat(id) {
    checkId(id);
    const entry = await (await removal).removeChat(id as string);
    await trashChanged();
    return trashView(entry);
  },
  async trashCourse(id) {
    checkId(id);
    const entry = await (await removal).removeCourse(id as string);
    await trashChanged();
    return trashView(entry);
  },
  async listTrash() {
    return (await trash.list()).map(trashView);
  },
  async restoreFromTrash(id) {
    checkId(id);
    await (await removal).restore(id as string);
    await trashChanged();
  },
  async deleteFromTrash(id) {
    checkId(id);
    await trash.discard(id as string);
    emit({ type: "trash" });
  },
  async emptyTrash() {
    for (const entry of await trash.list()) await trash.discard(entry.id);
    emit({ type: "trash" });
  },
  async registerArtifact(input) {
    const { source } = (input ?? {}) as Record<string, unknown>;
    if (typeof source !== "string" || !source.trim()) throw new Error("There is no demo to show.");
    if (source.length > MAX_ARTIFACT) throw new Error("That demo is too large to show.");
    return { url: artifacts.register(source) };
  },
  async saveFile(file) {
    const { name, type, data } = (file ?? {}) as Record<string, unknown>;
    if (type !== "svg" || typeof data !== "string" || !data.startsWith("<svg"))
      throw new Error("Only diagrams can be saved this way.");
    if (data.length > MAX_SAVED_FILE) throw new Error("That file is too large to save.");
    const suggested =
      typeof name === "string" && /^[\w .-]{1,80}\.svg$/.test(name) ? name : "diagram.svg";
    const options = {
      defaultPath: suggested,
      filters: [{ name: "SVG image", extensions: ["svg"] }],
    };
    const chosen = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return false;
    await writeFile(chosen.filePath, data, "utf8");
    return true;
  },
  async loadWorkspace() {
    try {
      return JSON.parse(await readFile(resolve(home, "workspace.json"), "utf8")) as unknown;
    } catch {
      return null;
    }
  },
  async saveWorkspace(state) {
    // Open tabs and reading positions only: restoring them never starts model work.
    const raw = JSON.stringify(state);
    if (raw === undefined || raw.length > MAX_WORKSPACE_BYTES)
      throw new Error("The workspace state is too large.");
    await writeAtomic(resolve(home, "workspace.json"), raw);
  },
};

function trusted(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return trustedSender({
    fromWindow: !!window && event.sender === window.webContents,
    isMainFrame: !!frame && frame.parent === null,
    origin: frame?.origin,
    rendererOrigin,
  });
}

ipcMain.handle(
  CHANNELS.invoke,
  async (event, method: unknown, ...args: unknown[]): Promise<InvokeResult<unknown>> => {
    if (!trusted(event)) return { ok: false, error: "Untrusted request." };
    if (typeof method !== "string" || !Object.hasOwn(handlers, method))
      return { ok: false, error: "Unknown request." };
    try {
      return { ok: true, value: await handlers[method as InvokeMethod](...args) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  },
);

function serveRenderer(): void {
  protocol.handle("folio", (request) => {
    const url = new URL(request.url);
    // Folio's own files go to Folio's page (or to the window opening it), never to a demo.
    const initiator = (request as { initiatorOrigin?: string }).initiatorOrigin;
    if (initiator !== undefined && originOf(initiator) !== rendererOrigin)
      return new Response("Not found", { status: 404 });
    const path = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`);
    if (url.host !== "app" || !path.startsWith(`${rendererRoot}${sep}`))
      return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(path).href);
  });
}

/** What the window may ask for, load and reach; see hardening.ts for the rules. */
function hardenSession(): void {
  const ses = session.defaultSession;
  const decide = (permission: string, isMainFrame: boolean, url: string) => {
    const origin = originOf(url);
    const allowed = permissionDecision({ permission, isMainFrame, origin, rendererOrigin });
    if (permissionMode === "log")
      console.error(`[permission] ${JSON.stringify({ permission, isMainFrame, origin, allowed })}`);
    return permissionMode === "log" || allowed;
  };
  ses.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(decide(permission, details.isMainFrame, details.requestingUrl)),
  );
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    decide(permission, details.isMainFrame, details.requestingUrl ?? requestingOrigin),
  );
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) =>
      callback({
        cancel: !requestDecision({ url: details.url, devOrigin: devUrl ? rendererOrigin : null }),
      }),
  );
  ses.on("will-download", (event) => event.preventDefault());
}

// Every web page Folio creates: no webviews, no new windows, and frames stay where they are.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-frame-navigate", (event) => {
    const parent = event.frame?.parent;
    const allowed = frameNavigationDecision({
      isMainFrame: event.isMainFrame,
      url: event.url,
      parentIsMain: !!parent && parent.parent === null,
      currentUrl: event.frame?.url ?? "",
    });
    if (!allowed) event.preventDefault();
  });
});

function createWindow(): void {
  window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    title: "Folio",
    show: false,
    titleBarStyle: "hiddenInset",
    // On the same line as the tab strip's buttons, as the sidebar button and Folio's name are.
    trafficLightPosition: { x: 18, y: 24 },
    // Light is Folio's default theme; the renderer applies a saved dark preference.
    backgroundColor: "#f3f3f4",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => (window = undefined));
  // Links open in the browser; the window itself never navigates away from Folio.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (originOf(url) !== rendererOrigin || !devUrl) event.preventDefault();
  });
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  void window.loadURL(rendererUrl);
}

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  signIn?.abort();
  // Closing settles running replies as interrupted and releases each chat's lease; the student's
  // servers close after them, so no reply is left calling one.
  void service
    .then((chats) => chats.close())
    .catch(() => undefined)
    .then(() => servers)
    .then((running) => running.close(3_000))
    .catch(() => undefined)
    .finally(() => app.quit());
});
// Opening Folio again brings its window forward, or opens it again if it was closed.
app.on("second-instance", () => {
  if (!window) return createWindow();
  if (window.isMinimized()) window.restore();
  window.focus();
});
app.on("window-all-closed", () => {
  // On a Mac, closing the window keeps Folio running. A quit already under way goes on, though:
  // one that a signal started (the installer replacing Folio, or `kill`) is put off by
  // before-quit while chats settle, and ends up here instead of quitting.
  if (process.platform !== "darwin" || quitting) app.quit();
});
app.on("activate", () => {
  if (!window) createWindow();
});
void app.whenReady().then(() => {
  hardenSession();
  serveRenderer();
  protocol.handle(ARTIFACT_SCHEME, (request) =>
    artifactResponse(
      {
        url: request.url,
        initiatorOrigin: (request as { initiatorOrigin?: string }).initiatorOrigin,
      },
      artifacts,
      rendererOrigin,
    ),
  );
  createWindow();
  // The student's servers start once the window is up, in the background, and the live model
  // list is checked.
  setTimeout(() => void servers.then((running) => running.reconcile()), 1_500);
  setTimeout(() => void liveLoaded.then(refreshLive), 1_500);
});
