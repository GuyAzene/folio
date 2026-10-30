import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type AuthInteraction } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
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
import { createFolioModels, readConnectionStatus } from "../auth.ts";
import { writeAtomic } from "../files.ts";
import { IngestRunner } from "../ingest/pipeline.ts";
import { piComplete } from "../ingest/pi-complete.ts";
import { prepareSource } from "../ingest/source.ts";
import { JobStore } from "../jobs/store.ts";
import { withoutDocuments } from "../kb/knowledge.ts";
import { KnowledgeStore } from "../kb/store.ts";
import { TOPIC_POLICY, topicModel } from "../kb/topics.ts";
import { createAttach } from "../library/attachments.ts";
import { createRuntimes } from "../library/course-tools.ts";
import { hostedSearch } from "../library/web-search.ts";
import {
  ASSIGNMENT_KINDS,
  type AssignmentPatch,
  type AssignmentRecord,
} from "../library/assignments.ts";
import { CourseNotes, noteTitle, type ProposalRecord } from "../library/notes.ts";
import { scanFolder } from "../library/scan.ts";
import { parseCourseDetails, SYLLABUS_PROMPT, syllabusText } from "../library/syllabus.ts";
import { checkId, DOCUMENT_ROLES, LibraryStore, type DocumentRole } from "../library/store.ts";
import { folioModel } from "../model-catalog.ts";
import { OFFERED_MODELS, SUBSCRIPTIONS } from "../model-choices.ts";
import { DEFAULT_MODEL } from "../agents.ts";
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
  type ConnectionView,
  type CourseInput,
  type DesktopBootstrap,
  type DesktopEvent,
  type DocumentPatch,
  type ImportResult,
  type InvokeMethod,
  type InvokeResult,
  type JobOrigin,
  type KnowledgeView,
  type TrashEntryView,
  type ProposalAction,
  type SyllabusDraft,
} from "./api.ts";
import { ChatService, errorMessage } from "./chat-service.ts";
import { PageReader } from "../library/page-reader.ts";
import { Removal } from "../library/removal.ts";
import { Trash, TRASH_DAYS, type TrashEntry } from "../library/trash.ts";
import { studyNotesView } from "./study-notes.ts";
import { courseView, documentView, noteView, proposalView } from "./view.ts";
import { folioHome, prepareHome } from "../home.ts";

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

const catalog = createModels();
catalog.setProvider(openaiProvider());
const resolveModel = (id: string) => {
  const model = folioModel(catalog, id);
  if (!model) throw new Error(`Model '${id}' is not in Pi's catalog.`);
  return model;
};
const connection = createFolioModels({ home: connectionHome });
const streamFn: StreamFn = async (model, context, options) =>
  (await connection).models.streamSimple(model, context, options);

let signIn: AbortController | undefined;
async function connectionView(): Promise<ConnectionView> {
  const { store } = await connection;
  return { connected: (await readConnectionStatus(store)).connected, signingIn: !!signIn };
}

const library = LibraryStore.open({ home });
const notes = library.then((store) => new CourseNotes(store));
// One reader of course PDFs for the tutor: page text, and pages as images.
const pageReader = library.then((store) => new PageReader(store));
// Topics are compared and given overviews by GPT-6.1 Terra at low effort.
const knowledgeStore = library.then((store) =>
  KnowledgeStore.open(store, {
    topics: topicModel(piComplete(async () => (await connection).models, resolveModel)),
  }),
);
const jobs = Promise.all([JobStore.open(home), library]).then(([store, courses]) => {
  const runner = new IngestRunner({
    store,
    library: courses,
    complete: piComplete(async () => (await connection).models, resolveModel),
    prepare: prepareSource,
    emit: (job) => emit({ type: "job", job }),
    async publish(bundle) {
      const published = await (await knowledgeStore).publish(bundle);
      emit({ type: "library" });
      return published.generation;
    },
    removed: (id) => emit({ type: "jobRemoved", id }),
    connected: async () => (await connectionView()).connected,
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
});

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

const teaching = (document: { role: string; kind: string }) =>
  (document.role === "lecture" || document.role === "recitation") && document.kind === "pdf";

/** Every lecture and recitation in the library that was never studied, queued once at start. */
setTimeout(() => {
  void Promise.all([library, knowledgeStore])
    .then(async ([courses, knowledge]) => {
      const documents = (await courses.listDocuments()).filter(teaching);
      const byCourse = new Map<string, string[]>();
      for (const document of documents) {
        const studied = (await knowledge.knowledge(document.courseId))?.sessions.some(
          (session) => session.documentId === document.id,
        );
        if (!studied)
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
const sessionStore = createSessionStore({ home });
const service = Promise.all([sessionStore, library, notes, knowledgeStore, pageReader]).then(
  ([store, courses, courseNotes, knowledge, pages]) => {
    const runtimes = createRuntimes(courses, {
      notes: courseNotes,
      changed: () => emit({ type: "library" }),
      knowledge,
      pages,
      visuals: true,
      // Each search is its own request on GPT-6.1 Terra, carrying the query and nothing else.
      search: hostedSearch(streamFn, resolveModel("gpt-6.1-terra")),
    });
    return new ChatService({
      store,
      streamFn,
      resolveModel,
      modelId: DEFAULT_MODEL,
      models: OFFERED_MODELS,
      connected: async () => (await connectionView()).connected,
      emit,
      courseRuntime: runtimes.course,
      libraryRuntime: runtimes.library,
      // Pages, images, lectures and courses the student adds, checked against the chat.
      attach: createAttach(courses, pages, { studied: (id) => !!knowledge.current(id) }),
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
  emit({ type: "connection", connection: await connectionView() });
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
    emit({ type: "connection", connection: await connectionView() });
    (await jobs).runner.connectionChanged();
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
  if (!(await connectionView()).connected)
    return { ...draft, note: "Connect ChatGPT and Folio can fill these in from the syllabus." };
  const reply = await (
    await connection
  ).models.completeSimple(
    resolveModel(DEFAULT_MODEL),
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

async function importPaths(
  courseId: unknown,
  paths: unknown,
  role?: unknown,
): Promise<ImportResult[]> {
  checkId(courseId);
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string"))
    throw new Error("Choose files to import.");
  if (role !== undefined && role !== null && !DOCUMENT_ROLES.includes(role as DocumentRole))
    throw new Error("Unknown role.");
  const store = await library;
  const results: ImportResult[] = [];
  const added: string[] = [];
  for (const path of paths as string[]) {
    try {
      const { document, duplicate } = await store.importFile(courseId, path, {
        role: (role as DocumentRole | null | undefined) ?? undefined,
      });
      results.push({ name: basename(path), document: documentView(document), duplicate });
      if (!duplicate && teaching(document)) added.push(document.id);
    } catch (error) {
      results.push({ name: basename(path), error: errorMessage(error) });
    }
  }
  emit({ type: "library" });
  studySoon(courseId, added, "upload");
  syncAssignments();
  return results;
}

const handlers: Record<InvokeMethod, (...args: unknown[]) => Promise<unknown>> = {
  async bootstrap(): Promise<DesktopBootstrap> {
    const { chats, unavailable } = await (await service).chats();
    const model = resolveModel(DEFAULT_MODEL);
    const connection = await connectionView();
    return {
      connection,
      model: { id: model.id, name: model.name },
      subscriptions: SUBSCRIPTIONS.map((subscription) => ({
        provider: subscription.provider,
        name: subscription.name,
        available: subscription.available,
        // Only ChatGPT can be signed in to so far.
        connected: subscription.provider === "openai" && connection.connected,
        models: [
          ...subscription.models.map((id) => ({ id, name: resolveModel(id).name })),
          ...subscription.older.map((id) => ({ id, name: resolveModel(id).name, older: true })),
        ],
      })),
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
    emit({ type: "connection", connection: await connectionView() });
    (await jobs).runner.connectionChanged();
  },
  listCourses: courses,
  async createCourse(input) {
    const course = await (await library).createCourse((input ?? {}) as CourseInput);
    emit({ type: "library" });
    return courseView(course, 0);
  },
  async updateCourse(id, patch, revision) {
    checkId(id);
    await (await library).updateCourse(id, (patch ?? {}) as CourseInput, Number(revision));
    emit({ type: "library" });
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
    const store = await library;
    const before = await store.document(id);
    const change = (patch ?? {}) as DocumentPatch;
    const moved = change.courseId !== undefined && change.courseId !== before.courseId;
    const after = { ...before, ...change };
    // A lecture that stops being one, or leaves its course, stops being studied first, so
    // nothing reads it or publishes notes from it while it changes.
    const leaving = teaching(before) && (!teaching(after) || moved);
    if (leaving)
      await (await jobs).runner.withdraw((job) => job.documentIds.includes(id as string));
    const document = await store.updateDocument(id, change, Number(revision));
    if (leaving) {
      const knowledge = await knowledgeStore;
      const studied = (await knowledge.knowledge(before.courseId))?.sessions.some(
        (session) => session.documentId === id,
      );
      if (studied)
        await knowledge.revise(
          before.courseId,
          (current) => withoutDocuments(current, [id as string]),
          `${before.title} is no longer studied`,
        );
    }
    if (teaching(document) && (!teaching(before) || moved))
      studySoon(document.courseId, [document.id], "upload");
    if (document.role === "assignment" && before.role !== "assignment") syncAssignments();
    emit({ type: "library" });
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
    return folder ? scanFolder(folder) : null;
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
    if (!(await connectionView()).connected)
      throw new Error("Connect your ChatGPT account in Settings to study documents.");
    return (await jobs).runner.start(courseId, documentIds as string[]);
  },
  async pauseJob(id) {
    checkId(id);
    return (await jobs).runner.pause(id);
  },
  async resumeJob(id) {
    checkId(id);
    if (!(await connectionView()).connected)
      throw new Error("Connect your ChatGPT account in Settings to resume.");
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
  // Closing settles running replies as interrupted and releases each chat's lease.
  void service
    .then((chats) => chats.close())
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
});
