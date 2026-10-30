import { createHash } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
  REUSED_STEP,
  type AgentNodeView,
  type JobOrigin,
  type JobView,
  type PageCoverageView,
  type StepOutcome,
} from "../desktop/api.ts";
import type { JobStore, NodeInput } from "../jobs/store.ts";
import type { Knowledge } from "../kb/knowledge.ts";
import { topicInventory } from "../kb/topics.ts";
import type { CourseRecord, DocumentRecord, LibraryStore } from "../library/store.ts";
import type { SessionInfo } from "./draft.ts";
import {
  jsonCall,
  ModelStepError,
  png,
  text,
  type CompleteFn,
  type ModelRequest,
} from "./models.ts";
import {
  AUTHOR_SYSTEM,
  authorSchema,
  BRIEF_SYSTEM,
  briefSchema,
  CHECK_SYSTEM,
  checkSchema,
  ESCALATION_SYSTEM,
  escalationSchema,
  FIX_SYSTEM,
  OMIT_REASONS,
  patchSchema,
  PROMPT_VERSION,
  READER_SYSTEM,
  TOPIC_SYSTEM,
  readerSchema,
  REVIEWER_SYSTEM,
  reviewerSchema,
  type AuthorDraft,
  type Brief,
  type DraftPage,
  type EscalatedRegion,
  type Patch,
  type ReadPage,
  type ReadRegion,
  type RegionCoverage,
  type Verdict,
} from "./prompts.ts";
import {
  answered,
  applyPatches,
  discrepancies,
  missingFacts,
  withRestated,
  type Coverage,
  type Discrepancy,
} from "./patch.ts";
import { missingNumbers, tokenRecall } from "./reconcile.ts";
import { parseRef } from "../model-refs.ts";
import type { Box, PageInventory, Region, SourceInventory } from "./types.ts";

/** One opened source: its inventory and page renders. Implemented with pdf.js in the app. */
export interface PreparedSource {
  inventory: SourceInventory;
  render(page: number, maxEdge: number): Promise<Uint8Array>;
  crop(page: number, box: Box, maxEdge: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export type PrepareFn = (data: Uint8Array, sha256: string) => Promise<PreparedSource>;

/** Which model plays each role; the reader is the cheap tier. */
export interface RoleModels {
  provider: string;
  brief: string;
  reader: string;
  escalation: string;
  author: string;
  reviewer: string;
  /** Rechecks the few claims a fix changed; studies before 2026-10-30 used the reviewer. */
  recheck?: string;
  /**
   * How hard each step thinks. The few fixes think hardest; what is read, planned and written
   * one level less, as Codex's Ultra runs its workers; the check, many pages side by side, at
   * high. Studies before 2026-10-30 recorded none.
   */
  effort?: Record<StudyEffortRole, ThinkingLevel>;
}

export type StudyEffortRole =
  | "brief"
  | "reader"
  | "escalation"
  | "author"
  | "reviewer"
  | "fix"
  | "recheck";

export const DEFAULT_ROLES: RoleModels = {
  provider: "openai",
  brief: "gpt-6.1-sol",
  reader: "gpt-6.1-sol",
  escalation: "gpt-6.1-sol",
  author: "gpt-6.1-sol",
  reviewer: "gpt-6.1-sol",
  // Measured on a real lecture: caught every altered claim and kept every true one, as 6.1 Sol
  // did, in less time and at half the cost. Terra and Luna each kept only about 72% of what
  // 6.1 Sol read on a page, so reading stays on Sol.
  recheck: "gpt-6.1-terra",
  effort: {
    brief: "high",
    reader: "medium",
    escalation: "high",
    author: "high",
    reviewer: "high",
    fix: "high",
    recheck: "medium",
  },
};

const LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * These roles with any step's model or effort changed for a trial: FOLIO_STUDY_PLANNER, _READER,
 * _WRITER, _CHECKER and _RECHECKER name a model; FOLIO_STUDY_EFFORT_<ROLE> an effort.
 */
export function trialRoles(
  env: Record<string, string | undefined>,
  roles: RoleModels = DEFAULT_ROLES,
): RoleModels {
  const effort = { ...(roles.effort ?? DEFAULT_ROLES.effort!) };
  for (const role of Object.keys(effort) as StudyEffortRole[]) {
    const value = env[`FOLIO_STUDY_EFFORT_${role.toUpperCase()}`] as ThinkingLevel | undefined;
    if (value && LEVELS.includes(value)) effort[role] = value;
  }
  return {
    ...roles,
    brief: env.FOLIO_STUDY_PLANNER || roles.brief,
    reader: env.FOLIO_STUDY_READER || roles.reader,
    author: env.FOLIO_STUDY_WRITER || roles.author,
    reviewer: env.FOLIO_STUDY_CHECKER || roles.reviewer,
    recheck: env.FOLIO_STUDY_RECHECKER || roles.recheck,
    effort,
  };
}

export interface IngestOptions {
  store: JobStore;
  library: LibraryStore;
  complete: CompleteFn;
  prepare: PrepareFn;
  emit: (job: JobView) => void;
  /**
   * Adds a finished study to its course's knowledge and returns the new version. Nothing waits
   * for the student: what Folio could not place is published as stated gaps.
   */
  publish: (bundle: DraftBundle) => Promise<number>;
  /** A job left the list: dismissed, or replaced by a later run over the same documents. */
  removed?: (jobId: string) => void;
  /** Read again at each step, so a change in Settings applies from the next step on. */
  roles?: RoleModels | (() => RoleModels);
  /** Model requests in flight across all jobs: every step takes a turn through one limiter. */
  concurrency?: number;
  /** Jobs studied at once; the rest wait their turn. */
  parallelJobs?: number;
  /** Whether ChatGPT is connected. Queued jobs wait for it; without this, it always is. */
  connected?: () => Promise<boolean>;
  /** The course's published knowledge, so the author writes into the topics it already has. */
  knowledge?: (courseId: string) => Promise<Knowledge | null>;
  /** Regroups a course's published notes into shared topics; says how many topics merged. */
  regroup?: (courseId: string) => Promise<{ merged: { from: string; into: string }[] } | null>;
}

/** The order queued jobs start in: what the student asked for, new files, the rest, redos. */
const PRIORITY: Record<JobOrigin, number> = { student: 0, upload: 1, backlog: 2, restudy: 3 };

/** What code decided about one region after the author wrote. */
export type RegionState = "represented" | "described" | "omitted" | "gap" | "unaccounted";

export interface LedgerEntry {
  region: string;
  page: number;
  kind: Region["kind"] | "missed";
  state: RegionState;
  blocks: string[];
  reason: string;
}

/** What the student must look at before publishing. */
export interface ReviewException {
  kind: "unaccounted" | "contradicted" | "unreadable" | "judgement_omission" | "visual_only";
  region: string;
  page: number;
  detail: string;
}

/** One document's finished study, as it is published. */
export interface DocumentDraft {
  documentId: string;
  sha256: string;
  session: SessionInfo;
  brief: Brief;
  inventory: SourceInventory;
  regions: Record<string, ReadRegion & { escalated: boolean; unreadable: string }>;
  draft: AuthorDraft;
  ledger: LedgerEntry[];
  verdicts: Record<string, Verdict & { region: string; text: string }>;
  /** What the checker found each region teaches and where; studies before 2026-10-30 have none. */
  coverage?: Coverage;
  exceptions: ReviewException[];
  models: RoleModels;
  promptVersion: number;
}

export interface DraftBundle {
  version: 1;
  jobId: string;
  courseId: string;
  createdAt: string;
  documents: DocumentDraft[];
}

const READ_EDGE = 1568;
const AUTHOR_EDGE = 1024;
const RECALL_FLOOR = 0.8;
/** Rounds of fixing at most: returns fall fast, and a third round rarely finds anything new. */
const FIX_ROUNDS = 2;
/** Hard to read: a doubtful reading of a region flagged so is re-read up close. */
const HARD_FLAGS = new Set(["hebrew_in_image", "small_text", "chart", "arrows"]);
const QUIET_TYPES = new Set(["decoration", "header_footer"]);

/**
 * Runs ingestion jobs as fixed code, not as an agent deciding its own work: prepare and
 * inventory, brief, readers in parallel, gate, escalate, author, ledger, independent review,
 * revision only on grounded issues, then published to the course. See docs/architecture.md.
 */
/** Starts a run's failure note when the study notes were written but could not be published. */
export const PUBLISH_FAILED = "The study notes were written but couldn't be added to the course:";

export class IngestRunner {
  readonly #options: IngestOptions;
  readonly #roleOption: RoleModels | (() => RoleModels);
  readonly #running = new Map<string, AbortController>();
  /** Each running job's run, so a caller can wait until it has really stopped. */
  readonly #runs = new Map<string, Promise<void>>();
  readonly #limit: <T>(line: string, task: () => Promise<T>, priority?: number) => Promise<T>;
  #filling: Promise<void> = Promise.resolve();

  /**
   * Which model plays each role. A ChatGPT model is named by its bare ID, as studies always
   * have; any other by its `connection/model` reference.
   */
  get #roles(): RoleModels {
    const roles = this.#roleOption;
    return typeof roles === "function" ? roles() : roles;
  }

  constructor(options: IngestOptions) {
    this.#options = options;
    this.#roleOption = options.roles ?? DEFAULT_ROLES;
    this.#limit = fairLimiter(options.concurrency ?? 16);
  }

  /**
   * Picks up jobs interrupted by a quit or crash: they go back in the queue and continue from
   * their checkpoints. Paused and cancelled jobs stay as the student left them.
   */
  recover(): void {
    const { store } = this.#options;
    for (const job of store.jobs())
      if (job.status === "running" || job.status === "queued") {
        store.settleNodes(job.id, "stopped", "Interrupted when Folio closed.");
        store.updateJob(job.id, { status: job.cancelled ? "stopped" : "queued" });
      }
    this.#fill();
  }

  /** ChatGPT was connected or disconnected: jobs waiting for it start, or wait. */
  connectionChanged(): void {
    this.#fill();
  }

  list(): JobView[] {
    const { store } = this.#options;
    return store.jobs().map((job) => store.view(job.id));
  }

  /** Studies these documents because the student asked, ahead of anything Folio queued itself. */
  async start(courseId: string, documentIds: string[]): Promise<JobView> {
    const { library, store } = this.#options;
    const course = await library.course(courseId);
    if (!documentIds.length) throw new Error("Choose lectures or recitations to study.");
    const documents: DocumentRecord[] = [];
    for (const id of new Set(documentIds)) {
      const document = await library.document(id);
      if (document.courseId !== course.id)
        throw new Error("Those documents are not in this course.");
      if (document.role !== "lecture" && document.role !== "recitation")
        throw new Error(
          `“${document.title}” is ${document.role === "solution" ? "an official solution" : `an ${document.role}`}. Only lectures and recitations are studied; homework, exams, solutions and syllabi never become course knowledge.`,
        );
      if (document.kind !== "pdf") throw new Error("Folio can study PDF lectures for now.");
      documents.push(document);
    }
    const busy = documents.find((document) => this.#active(document.id));
    if (busy) throw new Error(`Folio is already studying “${busy.title}”.`);
    store.setDeclined(
      documents.map((document) => document.id),
      false,
    );
    const job = store.createJob({
      courseId: course.id,
      documentIds: documents.map((document) => document.id),
      title: `Study ${documents.map((document) => document.title).join(", ")}`,
    });
    this.#emit(job.id);
    this.#fill();
    return store.view(job.id);
  }

  /**
   * Queues a study of each document on Folio's own initiative, one job per document. Documents
   * that are not PDF lectures or recitations, that already have a job, or whose study the student
   * cancelled are left alone; so is a re-study of a document that was never studied.
   */
  async queue(courseId: string, documentIds: string[], origin: JobOrigin): Promise<JobView[]> {
    const { library, store } = this.#options;
    const declined = store.declined();
    const queued: JobView[] = [];
    for (const id of new Set(documentIds)) {
      const document = await library.document(id).catch(() => null);
      if (
        !document ||
        document.courseId !== courseId ||
        (document.role !== "lecture" && document.role !== "recitation") ||
        document.kind !== "pdf" ||
        declined.has(id) ||
        store.jobs().some((job) => job.documentIds.includes(id) && job.status !== "done")
      )
        continue;
      const job = store.createJob({
        courseId,
        documentIds: [id],
        title: `Study ${document.title}`,
        origin,
      });
      queued.push(this.#emit(job.id));
    }
    if (queued.length) this.#fill();
    return queued;
  }

  /**
   * Regroups a course's existing study notes into shared topics, once, then queues each studied
   * document to be studied again with the stronger pipeline, behind everything else.
   */
  async regroup(courseId: string): Promise<JobView> {
    const { library, store } = this.#options;
    const course = await library.course(courseId);
    const job = store.createJob({
      courseId: course.id,
      documentIds: [],
      title: `Group ${course.name}'s study notes by topic`,
      origin: "backlog",
      kind: "regroup",
    });
    this.#emit(job.id);
    this.#fill();
    return store.view(job.id);
  }

  /**
   * Stops and forgets every unfinished job that matches, and resolves once each has really
   * stopped: a document that is moving to the Trash or stops being a lecture is no longer read
   * or published while its files change.
   */
  async withdraw(matches: (job: { courseId: string; documentIds: string[] }) => boolean) {
    const { store } = this.#options;
    const jobs = store.jobs().filter((job) => job.status !== "done" && matches(job));
    for (const job of jobs) this.#running.get(job.id)?.abort();
    await Promise.allSettled(jobs.flatMap((job) => this.#runs.get(job.id) ?? []));
    for (const job of jobs) {
      store.deleteJob(job.id);
      this.#options.removed?.(job.id);
    }
  }

  pause(id: string): JobView {
    const { store } = this.#options;
    this.#running.get(id)?.abort();
    store.settleNodes(id, "stopped", "Paused.");
    store.updateJob(id, { status: "stopped" });
    return this.#emit(id);
  }

  /** Stops a job for good; Folio will not study its documents again unless the student asks. */
  cancel(id: string): JobView {
    const { store } = this.#options;
    this.#running.get(id)?.abort();
    store.settleNodes(id, "stopped", "Cancelled.");
    store.updateJob(id, { status: "stopped", cancelled: true, waitingFor: null });
    store.setDeclined(store.job(id).documentIds, true);
    return this.#emit(id);
  }

  /** Removes a job that is not running from the list; what it published stays published. */
  dismiss(id: string): void {
    if (this.#running.has(id)) throw new Error("Pause or cancel this job before dismissing it.");
    this.#options.store.deleteJob(id);
    this.#options.removed?.(id);
  }

  /** Continues from the job's checkpoints: finished steps are reused, not paid for again. */
  resume(id: string): JobView {
    const { store } = this.#options;
    const job = store.job(id);
    if (this.#running.has(id)) return store.view(id);
    if (job.status === "done") throw new Error("This job already finished.");
    if (job.cancelled)
      throw new Error("This job was cancelled. Study the documents again to start over.");
    store.updateJob(id, { status: "queued" });
    this.#fill();
    return this.#emit(id);
  }

  /** True while a document has a job that is queued, running or waiting on the plan. */
  #active(documentId: string): boolean {
    return this.#options.store
      .jobs()
      .some(
        (job) =>
          job.documentIds.includes(documentId) &&
          (job.status === "queued" || job.status === "running" || job.status === "waiting"),
      );
  }

  /** Starts queued jobs, in order, while there is room and ChatGPT is connected. */
  #fill(): void {
    this.#filling = this.#filling.then(async () => {
      const { store } = this.#options;
      const queued = store
        .jobs()
        .filter((job) => job.status === "queued" && !this.#running.has(job.id))
        .sort(
          (a, b) =>
            PRIORITY[a.origin] - PRIORITY[b.origin] || a.createdAt.localeCompare(b.createdAt),
        );
      if (!queued.length) return;
      const connected = (await this.#options.connected?.().catch(() => false)) ?? true;
      for (const job of queued) {
        const waitingFor = connected ? null : "connection";
        if (job.waitingFor !== waitingFor) {
          store.updateJob(job.id, { waitingFor });
          this.#emit(job.id);
        }
        if (connected && this.#running.size < (this.#options.parallelJobs ?? 2))
          this.#launch(job.id);
      }
    });
    // One failed pass must not stop the next: the queue is filled again on every change.
    this.#filling = this.#filling.catch((error: unknown) =>
      console.error("Folio could not start a queued study:", error),
    );
  }

  #launch(id: string): void {
    const controller = new AbortController();
    this.#running.set(id, controller);
    const run = this.#run(id, controller.signal).finally(() => {
      this.#running.delete(id);
      this.#runs.delete(id);
      this.#fill();
    });
    this.#runs.set(id, run);
  }

  #emit(id: string): JobView {
    const view = this.#options.store.view(id);
    this.#options.emit(view);
    return view;
  }

  async #run(jobId: string, signal: AbortSignal): Promise<void> {
    const { store, library } = this.#options;
    // Counters are rebuilt by every run; finished steps replay from their checkpoints.
    store.updateJob(jobId, {
      status: "running",
      waitingFor: null,
      pages: 0,
      regions: 0,
      pagesRead: 0,
      regionsAccounted: 0,
    });
    const root = this.#node(jobId, null, "run", {
      role: "run",
      title: "Ingestion",
      task: store.job(jobId).title,
    });
    store.setNode(root.id, { status: "running" });
    this.#emit(jobId);
    if (store.job(jobId).kind === "regroup") return this.#regroup(jobId, root.id, signal);
    try {
      const job = store.job(jobId);
      const course = await library.course(job.courseId);
      const documents = await Promise.all(job.documentIds.map((id) => library.document(id)));
      // The topics the course has as this job starts: every document of the job sees the same.
      const known = (await this.#options.knowledge?.(course.id).catch(() => null)) ?? null;
      // Sessions are numbered and paired across the whole course, not only this job's files.
      const studied = (await library.listDocuments({ courseId: course.id }))
        .filter((document) => document.role === "lecture" || document.role === "recitation")
        .sort((a, b) => a.importedAt.localeCompare(b.importedAt) || a.id.localeCompare(b.id));
      // Documents are independent: one that fails does not stop the others, and whatever
      // finished is added to the course. Resume redoes only what did not finish.
      const results = await Promise.allSettled(
        documents.map((document) =>
          this.#document(jobId, root.id, course, document, studied, known, signal),
        ),
      );
      signal.throwIfAborted();
      const drafts: DocumentDraft[] = [];
      let failure: unknown;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") return void drafts.push(result.value);
        failure ??= result.reason;
        const branch = store.nodesByKey(jobId, `document:${documents[index]!.id}`).at(-1);
        if (branch)
          store.setNode(branch.id, {
            status: "failed",
            note: (result.reason as Error).message,
          });
      });
      if (drafts.length) {
        // Its own node, so a failure here is recorded where it happened, not only on the run.
        const publishing = this.#node(jobId, root.id, "publish", {
          role: "publish",
          title: "Publish",
          task: `Adding the study notes to ${course.name}`,
        });
        store.setNode(publishing.id, { status: "running", note: null });
        let generation: number;
        try {
          generation = await this.#options.publish({
            version: 1,
            jobId,
            courseId: course.id,
            createdAt: new Date().toISOString(),
            documents: drafts,
          });
        } catch (error) {
          store.setNode(publishing.id, { status: "failed", note: (error as Error).message });
          throw new Error(`${PUBLISH_FAILED} ${(error as Error).message}`, { cause: error });
        }
        store.setNode(publishing.id, {
          status: "done",
          task: `Added to ${course.name} as version ${generation}`,
        });
      }
      if (failure) throw failure;
      store.setNode(root.id, { status: "done", note: null });
      store.updateJob(jobId, { status: "done" });
      this.#retire(store.job(jobId));
    } catch (error) {
      if (signal.aborted) return;
      const limit = error instanceof ModelStepError && error.kind === "limit";
      store.settleNodes(jobId, "stopped", limit ? "Waiting for the plan's usage limit." : null);
      store.setNode(root.id, {
        status: limit ? "waiting" : "failed",
        note: limit
          ? "Your plan's usage limit was reached. Resume when it resets; finished steps are kept."
          : (error as Error).message,
      });
      store.updateJob(jobId, { status: limit ? "waiting" : "failed" });
    } finally {
      this.#emit(jobId);
    }
  }

  /** A regroup: compare and merge the course's topics, then queue its documents for re-study. */
  async #regroup(jobId: string, rootId: string, signal: AbortSignal): Promise<void> {
    const { store } = this.#options;
    const job = store.job(jobId);
    try {
      const node = this.#node(jobId, rootId, "regroup", {
        role: "publish",
        title: "Group by topic",
        task: "Compare the course's topics and merge the ones that are the same",
        model: "gpt-6.1-terra",
      });
      store.setNode(node.id, { status: "running" });
      this.#emit(jobId);
      const result = await this.#options.regroup?.(job.courseId);
      signal.throwIfAborted();
      const merged = result?.merged ?? [];
      store.setNode(node.id, {
        status: "done",
        task: merged.length
          ? `Merged “${merged[0]!.from}” into “${merged[0]!.into}”${merged.length > 1 ? `, and ${merged.length - 1} more` : ""}`
          : "No topic was a duplicate",
      });
      const studied = (await this.#options.knowledge?.(job.courseId))?.sessions ?? [];
      await this.queue(
        job.courseId,
        studied.map((session) => session.documentId),
        "restudy",
      );
      store.setNode(rootId, { status: "done", note: null });
      store.updateJob(jobId, { status: "done" });
    } catch (error) {
      if (signal.aborted) return;
      store.settleNodes(jobId, "stopped", null);
      store.setNode(rootId, { status: "failed", note: (error as Error).message });
      store.updateJob(jobId, { status: "failed" });
    } finally {
      this.#emit(jobId);
    }
  }

  async #document(
    jobId: string,
    rootId: string,
    course: CourseRecord,
    document: DocumentRecord,
    courseDocuments: DocumentRecord[],
    known: Knowledge | null,
    signal: AbortSignal,
  ): Promise<DocumentDraft> {
    const { store, library, prepare } = this.#options;
    const branch = this.#node(jobId, rootId, `document:${document.id}`, {
      role: "document",
      title: document.title,
      task: `${document.role === "lecture" ? "Lecture" : "Recitation"} · ${document.pages ?? 1} pages`,
    });
    store.setNode(branch.id, { status: "running" });

    // 1. Prepare: verified original, page renders, region inventory (code).
    const prep = this.#node(jobId, branch.id, `prepare:${document.sha256}`, {
      role: "prepare",
      title: "Prepare pages",
      task: "Render every page, read its text layer and list its regions",
    });
    store.setNode(prep.id, { status: "running" });
    this.#emit(jobId);
    const { data } = await library.readOriginal(document.id);
    const source = await prepare(data, document.sha256);
    try {
      const inventory = source.inventory;
      const regionCount = inventory.pages.reduce((sum, page) => sum + page.regions.length, 0);
      const job = store.job(jobId);
      store.updateJob(jobId, {
        pages: job.pages + inventory.pages.length,
        regions: job.regions + regionCount,
      });
      for (const page of inventory.pages)
        store.setCoverage(jobId, document.id, page.page, "pending");
      store.setNode(prep.id, {
        status: "done",
        task: `${inventory.pages.length} pages, ${regionCount} regions`,
      });
      this.#emit(jobId);
      signal.throwIfAborted();

      const session = sessionInfo(course, document, courseDocuments);
      const regions: DocumentDraft["regions"] = {};
      const done = new Map(
        inventory.pages.map((page) => [page.page, Promise.withResolvers<void>()]),
      );
      const readPages = (pages: number[], signal: AbortSignal) =>
        untilAll(
          pages.map((page) => done.get(page)!.promise),
          signal,
        );
      // Planning and reading start together: a reader needs only its own page. Each writer
      // starts once the plan is made and its own pages are read, while later pages are still
      // being read; a lecture of one topic has a single writer once every page is read.
      let brief: Brief | undefined;
      // Each slide is checked as soon as every topic covering it is written, while the other
      // topics are still being written; whatever is left is checked once all are written.
      const checked = { verdicts: {} as DocumentDraft["verdicts"], coverage: {} as Coverage };
      const checkedPages = new Set<number>();
      const [, parts] = await together<AuthorDraft[] | null>(signal, [
        async (signal) => {
          await this.#read(jobId, branch.id, document, source, regions, signal, (pages) =>
            pages.forEach((page) => done.get(page)?.resolve()),
          );
          return null;
        },
        async (signal) => {
          brief = await this.#brief(jobId, branch.id, document, source, signal);
          const planned = brief;
          const topics = topicInventory(known, [
            ...planned.outline.map((item) => item.title),
            ...planned.terms.flatMap((term) => [term.english, term.hebrew]),
          ]);
          const plan = topicPlan(planned, inventory);
          // How many topics the writers take on, for the Studying page, also when reused.
          for (const node of store.nodes(jobId))
            if (node.role === "brief" && node.parentId === branch.id)
              store.setNode(node.id, { outcome: { topics: plan.length } });
          if (plan.length === 1) {
            await readPages(
              inventory.pages.map((page) => page.page),
              signal,
            );
            return [
              await this.#author(
                jobId,
                branch.id,
                course,
                document,
                source,
                planned,
                regions,
                session,
                topics,
                signal,
              ),
            ];
          }
          const written: (AuthorDraft | undefined)[] = plan.map(() => undefined);
          return together(
            signal,
            plan.map((topic, index) => async (signal: AbortSignal) => {
              await readPages(topic.pages, signal);
              const part = await this.#writeTopic(
                jobId,
                branch.id,
                course,
                document,
                source,
                planned,
                regions,
                session,
                topics,
                plan,
                index,
                signal,
              );
              written[index] = part;
              const ready = topic.pages.filter(
                (page) =>
                  !checkedPages.has(page) &&
                  plan.every((other, at) => !other.pages.includes(page) || written[at]),
              );
              if (ready.length) {
                for (const page of ready) checkedPages.add(page);
                const sofar = mergeTopics(
                  planned,
                  written.filter((item): item is AuthorDraft => item !== undefined),
                );
                await this.#check(
                  jobId,
                  branch.id,
                  document,
                  source,
                  sofar,
                  regions,
                  computeLedger(inventory, regions, sofar),
                  signal,
                  { pages: ready },
                  checked,
                );
              }
              return part;
            }),
          );
        },
      ]);
      if (!brief || !parts) throw new Error("Planning finished without a plan.");
      const planned: Brief = brief;
      let draft = parts.length === 1 ? parts[0]! : mergeTopics(brief, parts);
      let ledger = computeLedger(inventory, regions, draft);
      // What is left: every slide a single writer wrote, a slide no topic covered, and claims
      // that cite a slide outside their own topic, which its check could not see yet.
      const check = await this.#check(
        jobId,
        branch.id,
        document,
        source,
        draft,
        regions,
        ledger,
        signal,
        { regionsDone: checkedPages },
        checked,
      );
      let verdicts = check.verdicts;
      let coverage = check.coverage;
      // A region the checker could not make out is read again up close, once, so the fixer
      // works from a better reading.
      const unclear = Object.values(coverage).flatMap((entry) => {
        const region = inventory.pages
          .flatMap((page) => page.regions)
          .find((candidate) => candidate.id === entry.region);
        const reading = regions[entry.region];
        return !entry.legible && region && !reading?.escalated
          ? [{ region, reason: `the checker could not read it: ${entry.note}`, first: reading }]
          : [];
      });
      if (unclear.length)
        await this.#escalate(jobId, branch.id, document, source, unclear, regions, signal, 1);
      // A region nothing cites whose facts the checker found in blocks is cited by them.
      draft = withRestated(draft, ledger, coverage);
      ledger = computeLedger(inventory, regions, draft);

      // Fixed only for what a check can stand behind: regions nothing cites, facts of a slide
      // no block carries, and claims the checker doubted against the page. A cited region whose
      // words differ from the slide's (English notes on a Hebrew slide, a formula written
      // another way) is never sent back for that alone. The fixer patches only the blocks
      // concerned, and only its new claims are checked again. At most two rounds, and none once
      // a round stops reducing what is wrong or changes nothing.
      const regionIds = new Set(ledger.map((entry) => entry.region));
      let found = discrepancies(ledger, verdicts, draft, coverage);
      const firstFound = found.length;
      if (check.group) {
        const group = store.node(check.group);
        store.setNode(group.id, { outcome: { ...group.outcome, discrepancies: firstFound } });
      }
      let previous = Infinity;
      for (let round = 1; round <= FIX_ROUNDS; round++) {
        if (!found.length || found.length >= previous) break;
        previous = found.length;
        // A close-up helps a region nothing cites that was never read up close; one already
        // read up close needs the fixer, not the same look again.
        const closer = ledger.flatMap((entry) => {
          const region = inventory.pages
            .find((page) => page.page === entry.page)
            ?.regions.find((candidate) => candidate.id === entry.region);
          const reading = regions[entry.region];
          return entry.state === "unaccounted" &&
            !entry.blocks.length &&
            region &&
            !reading?.escalated
            ? [{ region, reason: entry.reason, first: reading }]
            : [];
        });
        if (closer.length)
          await this.#escalate(jobId, branch.id, document, source, closer, regions, signal, round);
        // A few discrepancies per request, side by side: one long request for everything is
        // slow and fragile. Those that touch the same block stay in one part.
        const parts = fixParts(found);
        const answers = await together(
          signal,
          parts.map((part, index) => async (signal: AbortSignal) => {
            const key = hash([
              "fix",
              PROMPT_VERSION,
              hash(FIX_SYSTEM),
              this.#roles.author,
              document.sha256,
              draft,
              part,
              regions,
            ]);
            const patches = await this.#fix(
              jobId,
              branch.id,
              key,
              document,
              source,
              planned,
              regions,
              draft,
              part,
              round,
              parts.length > 1 ? index + 1 : 0,
              signal,
            );
            return { key, part, patches };
          }),
        );
        const result = applyPatches(
          draft,
          answers.flatMap((answer) => answer.patches),
          found,
          regionIds,
        );
        const fixes = new Set(result.applied.flatMap((patch) => patch.fixes));
        for (const { key, part } of answers)
          for (const node of store
            .nodesByKey(jobId, key)
            .filter((item) => item.status === "done")) {
            store.setNode(node.id, {
              outcome: {
                discrepancies: part.length,
                fixed: part.filter((item) => fixes.has(item.id)).length,
              },
            });
            // A correction refused by the rules is kept with the reason, to be looked at later.
            const own = new Set(part.map((item) => item.id));
            for (const { patch, problem } of result.rejected)
              if (patch.fixes.some((id) => own.has(id)))
                store.recordRejection(node.id, {
                  attempt: round,
                  problem: `Correction refused: ${problem}`,
                  reply: JSON.stringify(patch),
                });
          }
        if (!result.applied.length) break;
        coverage = answered(coverage, result.applied, found, draft);
        draft = result.draft;
        ledger = computeLedger(inventory, regions, draft);
        verdicts = await this.#review(
          jobId,
          branch.id,
          document,
          source,
          draft,
          verdicts,
          signal,
          "recheck",
        );
        found = discrepancies(ledger, verdicts, draft, coverage);
      }
      // Whatever every round still missed is written up from the slide itself, and claims the
      // checker still doubts are settled for the tutor, never shown to the student as warnings.
      // Facts of a region the notes omit as page furniture are not missing.
      const omitted = new Set(draft.omitted.map((entry) => entry.region));
      const missing = new Set(
        [...missingFacts(coverage, draft).keys()].filter((region) => !omitted.has(region)),
      );
      const uncovered = ledger.filter(
        (entry) => entry.state === "unaccounted" || missing.has(entry.region),
      ).length;
      draft = withFallbacks(draft, ledger, inventory, regions, document.title, missing);
      ledger = computeLedger(inventory, regions, draft);
      draft = settleDisputes(draft, verdicts);
      for (const page of inventory.pages)
        store.setCoverage(jobId, document.id, page.page, pageState(ledger, page.page));
      store.updateJob(jobId, {
        regionsAccounted: store.job(jobId).regionsAccounted + ledger.length,
      });
      const ledgerNode = this.#node(jobId, branch.id, `ledger:${hash(ledger)}`, {
        role: "ledger",
        title: "Coverage ledger",
        task: "Checked every part of every slide",
      });
      store.setNode(ledgerNode.id, { status: "done" });
      const exceptions = exceptionsFor(ledger, verdicts, draft, inventory);
      store.setNode(branch.id, {
        status: "done",
        outcome: {
          pages: inventory.pages.length,
          figures: Object.values(regions).filter((region) => region.escalated).length,
          ...draftOutcome(draft),
          ...verdictOutcome(verdicts),
          uncovered,
          discrepancies: firstFound,
          fixed: Math.max(0, firstFound - found.length),
        },
      });
      this.#emit(jobId);
      return {
        documentId: document.id,
        sha256: document.sha256,
        session,
        brief,
        inventory,
        regions,
        draft,
        ledger,
        verdicts,
        coverage,
        exceptions,
        models: this.#roles,
        promptVersion: PROMPT_VERSION,
      };
    } finally {
      await source.close();
    }
  }

  async #brief(
    jobId: string,
    parentId: string,
    document: DocumentRecord,
    source: PreparedSource,
    signal: AbortSignal,
  ): Promise<Brief> {
    const { inventory } = source;
    const model = this.#roles.brief;
    const key = hash([
      "brief",
      PROMPT_VERSION,
      hash(BRIEF_SYSTEM),
      model,
      document.sha256,
      inventory.version,
    ]);
    return this.#step(
      jobId,
      parentId,
      key,
      {
        role: "brief",
        title: document.role === "recitation" ? "Recitation brief" : "Lecture brief",
        task: "Outline, notation and Hebrew–English terms before the readers start",
        model,
      },
      async (node) => {
        // The whole lecture's text, plus small images of the pages whose text says least.
        const sparse = [...inventory.pages]
          .sort((a, b) => a.characters - b.characters)
          .slice(0, 16);
        const content: ModelRequest["content"] = [
          text(
            `Lecture: ${document.title}\n\n${inventory.pages
              .map(
                (page) =>
                  `## Page ${page.page}\n${page.regions
                    .map((region) => region.text)
                    .filter(Boolean)
                    .join("\n")}`,
              )
              .join("\n\n")}`,
          ),
        ];
        for (const page of sparse.sort((a, b) => a.page - b.page)) {
          content.push(text(`Image of page ${page.page}:`));
          content.push(png(await source.render(page.page, 768)));
        }
        // Every request a document makes shares the job's slots, so two studies take turns.
        const brief = await this.#request("write", jobId, document.id, () =>
          this.#call<Brief>(
            node,
            {
              model,
              system: BRIEF_SYSTEM,
              content,
              maxTokens: 32000,
              reasoning: this.#effort("brief"),
              signal,
              cacheKey: cacheKey(document),
            },
            briefSchema,
          ),
        );
        return brief;
      },
    );
  }

  /**
   * Reads every page, one careful reader per page, side by side. Readings land in `regions` as
   * they come; `onRead` hears of each page once it and its close-ups are done, so a writer can
   * start on its topic while later pages are still being read.
   */
  async #read(
    jobId: string,
    parentId: string,
    document: DocumentRecord,
    source: PreparedSource,
    regions: DocumentDraft["regions"],
    signal: AbortSignal,
    onRead?: (pages: number[]) => void,
  ): Promise<DocumentDraft["regions"]> {
    const { store } = this.#options;
    const { inventory } = source;
    const group = this.#node(jobId, parentId, `readers:${document.sha256}`, {
      role: "reader",
      title: "Readers",
      task: `Read every page and account for each region`,
      model: this.#roles.reader,
    });
    store.setNode(group.id, { status: "running" });
    this.#emit(jobId);

    await together(
      signal,
      batches(inventory.pages).map((pages) => async (signal) => {
        signal.throwIfAborted();
        const model = this.#roles.reader;
        const label = pageLabel(pages.map((page) => page.page));
        const key = hash([
          "reader",
          PROMPT_VERSION,
          model,
          document.sha256,
          inventory.version,
          pages.map((page) => page.page),
        ]);
        // Only the reader's own request holds a slot; its close-ups queue for their own.
        const read = await this.#request("read", jobId, document.id, () =>
          this.#step(
            jobId,
            group.id,
            key,
            {
              role: "reader",
              title: label,
              task: `Read ${label.toLowerCase()} of ${document.title}`,
              model,
              pages: pages.map((page) => page.page),
            },
            async (node) => {
              const content: ModelRequest["content"] = [];
              for (const page of pages) {
                content.push(text(regionList(page)));
                content.push(png(await source.render(page.page, READ_EDGE)));
              }
              const result = await this.#call<{ pages: ReadPage[] }>(
                node,
                {
                  model,
                  system: READER_SYSTEM,
                  content,
                  maxTokens: 24000 * pages.length,
                  reasoning: this.#effort("reader"),
                  signal,
                  cacheKey: cacheKey(document),
                },
                readerSchema,
                (parts) => ({ pages: parts.flatMap((part) => part.pages) }),
              );
              return result.pages;
            },
          ),
        );

        // Gate (code): every region present and reconciled, or it is re-read up close.
        const escalate: { region: Region; reason: string; first?: ReadRegion }[] = [];
        for (const page of pages) {
          const found = read.find((candidate) => candidate.page === page.page);
          for (const region of page.regions) {
            const reading = found?.regions.find((candidate) => candidate.id === region.id);
            const reason = gateRegion(
              page,
              region,
              reading,
              found ? null : "the reader skipped this page",
            );
            if (reading) regions[region.id] = { ...reading, escalated: false, unreadable: "" };
            if (reason) escalate.push({ region, reason, first: reading });
          }
          for (const [index, missed] of (found?.missed ?? []).entries()) {
            const region: Region = {
              id: `p${page.page}.x${index + 1}`,
              page: page.page,
              kind: "image",
              box: [0, 0, page.width, page.height],
              text: "",
              direction: null,
              numbers: [],
            };
            // The reader describes what the inventory missed; a thin description gets a look.
            if (missed.description.split(/\s+/).filter(Boolean).length >= 8)
              regions[region.id] = {
                id: region.id,
                type: "other",
                content: `${missed.description} (${missed.where})`,
                claims: [],
                flags: [],
                escalated: false,
                unreadable: "",
              };
            else
              escalate.push({
                region,
                reason: `the reader saw something the inventory missed: ${missed.description} (${missed.where})`,
              });
          }
          store.setCoverage(jobId, document.id, page.page, "read");
        }
        const job = store.job(jobId);
        store.updateJob(jobId, { pagesRead: job.pagesRead + pages.length });
        this.#emit(jobId);
        if (escalate.length)
          await this.#escalate(jobId, key, document, source, escalate, regions, signal);
        onRead?.(pages.map((page) => page.page));
      }),
    );
    store.setNode(group.id, { status: "done" });
    this.#emit(jobId);
    return regions;
  }

  /**
   * Re-reads hard regions up close, page by page. During reading, `from` is the reader step
   * that found them; during a revision round, it is the document's node.
   */
  async #escalate(
    jobId: string,
    from: string,
    document: DocumentRecord,
    source: PreparedSource,
    items: { region: Region; reason: string; first?: ReadRegion }[],
    regions: DocumentDraft["regions"],
    signal: AbortSignal,
    round = 0,
  ): Promise<void> {
    const { store } = this.#options;
    // The reader step that found these regions; documents read at the same time share page numbers.
    const parent = round ? { id: from } : store.nodesByKey(jobId, from).at(-1);
    const readerKey = from;
    const byPage = Map.groupBy(items, (item) => item.region.page);
    // One request per page, each queued for a slot of its own, so pages are re-read side by side.
    await together(
      signal,
      [...byPage].map(([page, group]) => async (signal) => {
        signal.throwIfAborted();
        const model = this.#roles.escalation;
        // A revision round's close-up is keyed by what it re-reads, not by the run or round, so a
        // re-study or a resumed run reuses it.
        const key = hash([
          "escalation",
          PROMPT_VERSION,
          model,
          document.sha256,
          round ? hash(group.map((item) => item.first ?? null)) : readerKey,
          page,
          group.map((item) => item.region.id),
        ]);
        const result = await this.#request("read", jobId, document.id, () =>
          this.#step(
            jobId,
            parent?.id ?? null,
            key,
            {
              role: "escalation",
              title: round ? `Page ${page} close-up · round ${round}` : `Page ${page} close-up`,
              task: `Re-read ${group.length} hard region${group.length === 1 ? "" : "s"}: ${[...new Set(group.map((item) => item.reason.split(":")[0]))].join("; ")}`,
              model,
              pages: [page],
            },
            async (node) => {
              store.setCoverage(jobId, document.id, page, "escalated");
              this.#emit(jobId);
              const content: ModelRequest["content"] = [
                text(`Page ${page}, whole:`),
                png(await source.render(page, READ_EDGE)),
              ];
              for (const item of group) {
                content.push(
                  text(
                    `Region ${item.region.id} [${item.region.kind}] — why: ${item.reason}.${item.region.text ? ` Text layer: "${item.region.text}"` : ""}${item.first ? ` First reader said: "${item.first.content}"` : ""}`,
                  ),
                );
                if (!item.region.id.includes(".x"))
                  content.push(png(await source.crop(page, item.region.box, READ_EDGE)));
              }
              return this.#call<{ regions: EscalatedRegion[] }>(
                node,
                {
                  model,
                  system: ESCALATION_SYSTEM,
                  content,
                  maxTokens: 24000,
                  reasoning: this.#effort("escalation"),
                  signal,
                  cacheKey: cacheKey(document),
                },
                escalationSchema,
                (parts) => ({ regions: parts.flatMap((part) => part.regions) }),
              );
            },
          ),
        );
        for (const region of result.regions) {
          const edges = region.edges.map(
            (edge) => `${edge.from} -> ${edge.to}${edge.label ? ` (${edge.label})` : ""}`,
          );
          regions[region.id] = {
            id: region.id,
            type: region.type,
            content: edges.length
              ? `${region.content}\nEdges: ${edges.join("; ")}`
              : region.content,
            claims: region.claims,
            flags: [],
            escalated: true,
            unreadable: region.unreadable,
          };
        }
      }),
    );
  }

  async #author(
    jobId: string,
    parentId: string,
    course: CourseRecord,
    document: DocumentRecord,
    source: PreparedSource,
    brief: Brief,
    regions: DocumentDraft["regions"],
    session: SessionInfo,
    topics: string,
    signal: AbortSignal,
  ): Promise<AuthorDraft> {
    const model = this.#roles.author;
    const { inventory } = source;
    const key = hash([
      "author",
      PROMPT_VERSION,
      model,
      document.sha256,
      hash(regions),
      hash(brief),
      null,
      topics ? hash(topics) : null,
    ]);
    return this.#step(
      jobId,
      parentId,
      key,
      {
        role: "author",
        title: "Author",
        task: `Write the wiki for ${document.title}`,
        model,
        attempt: 1,
      },
      async (node) => {
        const regionLines = readingLines(regions);
        const content: ModelRequest["content"] = [
          text(
            [
              `Course: ${course.name}${course.code ? ` (${course.code})` : ""}. Wiki page slugs are written without the course prefix "${session.prefix}"; Folio adds it.`,
              `Session: ${session.slug}, ${session.type} "${document.title}".`,
              briefContext(brief),
              ...(topics
                ? [
                    `Topics this course already has (slug · title · Hebrew · aliases · meaning · where it is taught). When this lecture teaches one of them, write its page under that slug:\n${topics}`,
                  ]
                : []),
              `Regions found on every page (account for each one):\n${regionLines.join("\n")}`,
              `Allowed omission reasons: ${OMIT_REASONS.join(", ")}.`,
            ].join("\n\n"),
          ),
        ];
        if (inventory.pages.length <= 60)
          for (const page of inventory.pages) {
            content.push(text(`Page ${page.page}:`));
            content.push(png(await source.render(page.page, AUTHOR_EDGE)));
          }
        const written = await this.#request("write", jobId, document.id, () =>
          this.#call<AuthorDraft>(
            node,
            {
              model,
              system: AUTHOR_SYSTEM,
              content,
              maxTokens: 64000,
              reasoning: this.#effort("author"),
              signal,
              cacheKey: cacheKey(document),
            },
            authorSchema,
          ),
        );
        this.#options.store.setNode(node.id, { outcome: draftOutcome(written) });
        return written;
      },
    );
  }

  /**
   * Writes one topic of the lecture from its own pages, beside the writers of the other topics.
   * Its answer is a draft like the author's, merged with the others by code.
   */
  async #writeTopic(
    jobId: string,
    parentId: string,
    course: CourseRecord,
    document: DocumentRecord,
    source: PreparedSource,
    brief: Brief,
    regions: DocumentDraft["regions"],
    session: SessionInfo,
    topics: string,
    plan: Topic[],
    index: number,
    signal: AbortSignal,
  ): Promise<AuthorDraft> {
    const model = this.#roles.author;
    const topic = plan[index]!;
    const own = new Set(topic.pages);
    const readings = Object.fromEntries(
      Object.entries(regions).filter(([id]) => own.has(pageNumber(id))),
    );
    const label = pageLabel(topic.pages);
    const key = hash([
      "topic",
      PROMPT_VERSION,
      hash(TOPIC_SYSTEM),
      model,
      document.sha256,
      plan,
      index,
      hash(readings),
      hash(brief),
      topics ? hash(topics) : null,
    ]);
    // The slot comes first, so a writer shows as working only while its request is in flight.
    return this.#request("write", jobId, document.id, () =>
      this.#step(
        jobId,
        parentId,
        key,
        {
          role: "author",
          title: `Topic · ${topic.title}`,
          task: `Write ${topic.title} from ${label.toLowerCase()}`,
          model,
          attempt: 1,
          pages: topic.pages,
        },
        async (node) => {
          const others = plan
            .filter((_, at) => at !== index)
            .map((item) => `- ${item.title} (${pageLabel(item.pages).toLowerCase()})`);
          const content: ModelRequest["content"] = [
            text(
              [
                `Course: ${course.name}${course.code ? ` (${course.code})` : ""}. Wiki page slugs are written without the course prefix "${session.prefix}"; Folio adds it.`,
                `Session: ${session.slug}, ${session.type} "${document.title}".`,
                briefContext(brief),
                ...(topics
                  ? [
                      `Topics this course already has (slug · title · Hebrew · aliases · meaning · where it is taught). When this topic is one of them, write its page under that slug:\n${topics}`,
                    ]
                  : []),
                `Your topic: "${topic.title}", on ${label.toLowerCase()}. The other writers cover:\n${others.join("\n")}`,
                `Regions found on your pages (cite each one that belongs to your topic):\n${readingLines(readings).join("\n")}`,
                `Allowed omission reasons: ${OMIT_REASONS.join(", ")}.`,
              ].join("\n\n"),
            ),
          ];
          for (const page of topic.pages) {
            content.push(text(`Page ${page}:`));
            content.push(png(await source.render(page, AUTHOR_EDGE)));
          }
          const written = await this.#call<AuthorDraft>(
            node,
            {
              model,
              system: TOPIC_SYSTEM,
              content,
              maxTokens: 64000,
              reasoning: this.#effort("author"),
              signal,
              cacheKey: cacheKey(document),
            },
            authorSchema,
          );
          this.#options.store.setNode(node.id, { outcome: draftOutcome(written) });
          return written;
        },
      ),
    );
  }

  /**
   * The independent check: every page that teaches something, one per request, against the whole
   * notes. For each region the checker lists the facts it teaches and names the block that
   * carries each one; for each claim, whether the page supports it. The notes come first in
   * every request, so the provider can serve them from its cache after the first.
   */
  async #check(
    jobId: string,
    parentId: string,
    document: DocumentRecord,
    source: PreparedSource,
    draft: AuthorDraft,
    regions: DocumentDraft["regions"],
    ledger: LedgerEntry[],
    signal: AbortSignal,
    scope: { pages?: number[]; regionsDone?: Set<number> } = {},
    into: { verdicts: DocumentDraft["verdicts"]; coverage: Coverage } = {
      verdicts: {},
      coverage: {},
    },
  ): Promise<{ verdicts: DocumentDraft["verdicts"]; coverage: Coverage; group: string | null }> {
    const { store } = this.#options;
    const { inventory } = source;
    const { verdicts, coverage } = into;
    const pageOf = (region: string) => Number(/^p(\d+)\./.exec(region)?.[1] ?? 0);
    const inScope = (page: number) => !scope.pages || scope.pages.includes(page);
    // Only what has not been checked yet: claims without a verdict, regions without coverage.
    const claims = draft.pages
      .flatMap((page) => page.blocks.flatMap((block) => block.claims))
      .map((claim) => ({ ...claim, id: `c${hash([claim.text, claim.region]).slice(0, 10)}` }))
      .filter((claim) => pageOf(claim.region) > 0 && inScope(pageOf(claim.region)))
      .filter((claim) => !verdicts[claim.id]);
    // Page furniture and decoration teach nothing, so the checker is not asked about them.
    const entries = new Map(ledger.map((entry) => [entry.region, entry]));
    const listed = (page: PageInventory) =>
      scope.regionsDone?.has(page.page)
        ? []
        : page.regions.filter(
            (region) =>
              !coverage[region.id] &&
              entries.get(region.id)?.state !== "omitted" &&
              !QUIET_TYPES.has(regions[region.id]?.type ?? ""),
          );
    const pages = inventory.pages
      .filter((page) => inScope(page.page))
      .filter(
        (page) => listed(page).length || claims.some((claim) => pageOf(claim.region) === page.page),
      )
      .map((page) => page.page);
    const existing = store.nodesByKey(jobId, `reviewers:${document.sha256}`)[0];
    if (!pages.length) return { verdicts, coverage, group: existing?.id ?? null };
    const regionCount = pages.reduce(
      (sum, number) => sum + listed(inventory.pages.find((page) => page.page === number)!).length,
      0,
    );
    const notes = `The notes, every block by topic:\n${draft.pages
      .map(
        (page) =>
          `## ${page.slug} "${page.title}"\n${page.blocks.map((block) => `[${block.id}] ${block.title}: ${block.body}`).join("\n")}`,
      )
      .join("\n\n")}`;
    // One group for the document's whole check, however many calls it takes.
    const group = this.#node(jobId, parentId, `reviewers:${document.sha256}`, {
      role: "reviewer",
      title: "Reviewers",
      task: `Check ${claims.length} claims and ${regionCount} regions against the page images`,
      model: this.#roles.reviewer,
    });
    store.setNode(group.id, { status: "running" });
    this.#emit(jobId);
    const chunks: number[][] = [];
    // One slide per request: each finishes sooner, and many run side by side.
    for (const page of pages) chunks.push([page]);
    await together(
      signal,
      chunks.map(
        (chunk) => (signal) =>
          this.#request("check", jobId, document.id, async () => {
            signal.throwIfAborted();
            const model = this.#roles.reviewer;
            const batch = claims.filter((claim) => chunk.includes(pageOf(claim.region)));
            const chunkPages = chunk.map((number) =>
              inventory.pages.find((candidate) => candidate.page === number)!,
            );
            const asked = chunkPages.flatMap(listed).map((region) => region.id);
            const hints = chunkPages.map((page) => {
              const lines = listed(page).map((region) => {
                const entry = entries.get(region.id);
                const reading = regions[region.id]?.content.replace(/\s+/g, " ").trim() ?? "";
                return `- ${region.id} [${region.kind}]${region.text ? ` "${region.text}"` : ""} · ${entry?.blocks.length ? `cited by ${entry.blocks.join(", ")}` : "not cited"}${reading ? ` · read: "${reading.length > 400 ? `${reading.slice(0, 397)}…` : reading}"` : ""}`;
              });
              const layer =
                page.textLayer === "ok"
                  ? ""
                  : ` (text layer ${page.textLayer}: read everything from the image)`;
              return `Page ${page.page}${layer}. Regions:\n${lines.join("\n") || "(none to list)"}`;
            });
            const key = hash([
              "check",
              PROMPT_VERSION,
              hash(CHECK_SYSTEM),
              model,
              document.sha256,
              hash(notes),
              chunk,
              hints,
              batch.map((claim) => claim.id),
            ]);
            const label = pageLabel(chunk);
            const result = await this.#step(
              jobId,
              group.id,
              key,
              {
                role: "reviewer",
                title: label,
                task: `Check ${batch.length} claim${batch.length === 1 ? "" : "s"} and every region on ${label.toLowerCase()}`,
                model,
                pages: chunk,
              },
              async (node) => {
                const content: ModelRequest["content"] = [text(notes)];
                for (const [index, number] of chunk.entries()) {
                  content.push(text(hints[index]!));
                  content.push(png(await source.render(number, READ_EDGE)));
                }
                content.push(
                  text(
                    batch.length
                      ? `Claims to check (answer with the claim ID in "claim"):\n${batch.map((claim) => `[${claim.id}] (${claim.region}) ${claim.text}`).join("\n")}`
                      : "No claims to check on these pages.",
                  ),
                );
                return this.#call<{ coverage: RegionCoverage[]; verdicts: Verdict[] }>(
                  node,
                  {
                    model,
                    system: CHECK_SYSTEM,
                    content,
                    maxTokens: Math.min(64000, 12000 + 150 * batch.length + 400 * asked.length),
                    reasoning: this.#effort("reviewer"),
                    signal,
                    cacheKey: cacheKey(document),
                  },
                  checkSchema,
                  (parts) => ({
                    coverage: parts.flatMap((part) => part.coverage),
                    verdicts: parts.flatMap((part) => part.verdicts),
                  }),
                );
              },
            );
            for (const claim of batch) {
              const verdict = result.verdicts.find((candidate) => candidate.claim === claim.id);
              verdicts[claim.id] = verdict
                ? { ...verdict, region: claim.region, text: claim.text }
                : {
                    claim: claim.id,
                    verdict: "unreadable",
                    note: "The reviewer gave no verdict.",
                    region: claim.region,
                    text: claim.text,
                  };
            }
            for (const entry of result.coverage)
              if (asked.includes(entry.region)) coverage[entry.region] = entry;
          }),
      ),
    );
    store.setNode(group.id, {
      status: "done",
      task: `Check ${Object.keys(verdicts).length} claims and ${Object.keys(coverage).length} regions against the page images`,
      outcome: { ...verdictOutcome(verdicts), regions: Object.keys(coverage).length },
    });
    this.#emit(jobId);
    return { verdicts, coverage, group: group.id };
  }

  /**
   * Asks for patches that fix what the check found, and nothing else. The fixer sees the
   * discrepancies, the blocks they concern, the readings of the regions involved and those pages,
   * not the whole draft; code applies what it returns.
   */
  async #fix(
    jobId: string,
    parentId: string,
    key: string,
    document: DocumentRecord,
    source: PreparedSource,
    brief: Brief,
    regions: DocumentDraft["regions"],
    draft: AuthorDraft,
    found: Discrepancy[],
    round: number,
    part: number,
    signal: AbortSignal,
  ): Promise<Patch[]> {
    const model = this.#roles.author;
    const pages = [...new Set(found.map((item) => item.page).filter((page) => page > 0))].sort(
      (a, b) => a - b,
    );
    // The slot comes first, so a part shows as working only while its request is in flight.
    return this.#request("write", jobId, document.id, () =>
      this.#step(
        jobId,
        parentId,
        key,
        {
          role: "fix",
          title: part ? `Fix · round ${round} · part ${part}` : `Fix · round ${round}`,
          task: `Fix ${found.length} thing${found.length === 1 ? "" : "s"} the check found`,
          model,
          attempt: round,
          pages,
        },
        async (node) => {
          const concerned = new Set(found.flatMap((item) => item.blocks));
          const affected = draft.pages.flatMap((page) =>
            page.blocks
              .filter((block) => concerned.has(block.id))
              .map((block) => ({ topic: page.slug, block })),
          );
          const involved = new Set([
            ...found.map((item) => item.region),
            ...affected.flatMap(({ block }) => block.locators.map((locator) => locator.region)),
          ]);
          const readings = [...involved]
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .flatMap((id) => {
              const region = regions[id];
              return region
                ? [
                    `- ${id} [${region.type}${region.escalated ? ", re-read" : ""}] ${region.content}${region.unreadable ? `\n  unreadable: ${region.unreadable}` : ""}`,
                  ]
                : [];
            });
          const content: ModelRequest["content"] = [
            text(
              [
                briefContext(brief),
                `Topics in the notes (slug: block ids):\n${draft.pages.map((page) => `- ${page.slug} "${page.title}": ${page.blocks.map((block) => block.id).join(", ")}`).join("\n")}`,
                `Discrepancies:\n${found.map((item) => `[${item.id}] ${item.kind} · ${item.region} (page ${item.page})${item.blocks.length ? ` · blocks ${item.blocks.join(", ")}` : ""}: ${item.detail}`).join("\n")}`,
                ...(affected.length ? [`Blocks they concern:\n${JSON.stringify(affected)}`] : []),
                `What readers found in these regions:\n${readings.join("\n")}`,
                `Allowed omission reasons: ${OMIT_REASONS.join(", ")}.`,
              ].join("\n\n"),
            ),
          ];
          for (const page of pages) {
            content.push(text(`Page ${page}:`));
            content.push(png(await source.render(page, AUTHOR_EDGE)));
          }
          try {
            const result = await this.#call<{ patches: Patch[] }>(
              node,
              {
                model,
                system: FIX_SYSTEM,
                content,
                maxTokens: Math.min(64000, 16000 + 1000 * found.length),
                reasoning: this.#effort("fix"),
                signal,
                cacheKey: cacheKey(document),
              },
              patchSchema,
              (parts) => ({ patches: parts.flatMap((part) => part.patches) }),
            );
            return result.patches;
          } catch (error) {
            // A fix that cannot be had leaves what it would have fixed to the slides' own words,
            // written up below; only a plan limit or a stop ends the study here.
            if (stopped(error) || (error instanceof ModelStepError && error.kind === "limit"))
              throw error;
            this.#options.store.setNode(node.id, {
              note: `Not fixed; written up from the slides instead: ${(error as Error).message}`,
            });
            return [];
          }
        },
      ),
    );
  }

  async #review(
    jobId: string,
    parentId: string,
    document: DocumentRecord,
    source: PreparedSource,
    draft: AuthorDraft,
    previous: DocumentDraft["verdicts"],
    signal: AbortSignal,
    role: "reviewer" | "recheck" = "reviewer",
  ): Promise<DocumentDraft["verdicts"]> {
    const { store } = this.#options;
    const pageOf = (region: string) => Number(/^p(\d+)\./.exec(region)?.[1] ?? 0);
    const claims = draft.pages
      .flatMap((page) => page.blocks.flatMap((block) => block.claims))
      .map((claim) => ({ ...claim, id: `c${hash([claim.text, claim.region]).slice(0, 10)}` }))
      .filter((claim) => pageOf(claim.region) > 0);
    const verdicts: DocumentDraft["verdicts"] = {};
    const pending = claims.filter((claim) => {
      if (previous[claim.id]) verdicts[claim.id] = previous[claim.id]!;
      return !previous[claim.id];
    });
    if (!pending.length) return verdicts;
    const group = this.#node(jobId, parentId, `${role}s:${hash(pending)}`, {
      role,
      title: role === "recheck" ? "Rechecks" : "Reviewers",
      task:
        role === "recheck"
          ? `Check ${pending.length} corrected claim${pending.length === 1 ? "" : "s"} against the page images`
          : `Check ${pending.length} claims against the page images`,
      model: this.#checkModel(role),
    });
    store.setNode(group.id, { status: "running" });
    this.#emit(jobId);
    const pages = [...new Set(pending.map((claim) => pageOf(claim.region)))].sort((a, b) => a - b);
    const chunks: number[][] = [];
    for (let at = 0; at < pages.length; at += 5) chunks.push(pages.slice(at, at + 5));
    await together(
      signal,
      chunks.map(
        (chunk) => (signal) =>
          this.#request("check", jobId, document.id, async () => {
            signal.throwIfAborted();
            const model = this.#checkModel(role);
            const batch = pending.filter((claim) => chunk.includes(pageOf(claim.region)));
            const key = hash([
              role,
              PROMPT_VERSION,
              model,
              document.sha256,
              batch.map((claim) => claim.id),
            ]);
            const label = pageLabel(chunk);
            const result = await this.#step(
              jobId,
              group.id,
              key,
              {
                role,
                title: label,
                task: `Check ${batch.length} claim${batch.length === 1 ? "" : "s"} on ${label.toLowerCase()}`,
                model,
                pages: chunk,
              },
              async (node) => {
                const content: ModelRequest["content"] = [];
                for (const page of chunk) {
                  const inventoryPage = source.inventory.pages.find(
                    (candidate) => candidate.page === page,
                  );
                  content.push(text(inventoryPage ? regionList(inventoryPage) : `Page ${page}`));
                  content.push(png(await source.render(page, READ_EDGE)));
                }
                content.push(
                  text(
                    `Claims to check (answer with the claim ID in "claim"):\n${batch.map((claim) => `[${claim.id}] (${claim.region}) ${claim.text}`).join("\n")}`,
                  ),
                );
                return this.#call<{ verdicts: Verdict[] }>(
                  node,
                  {
                    model,
                    system: REVIEWER_SYSTEM,
                    content,
                    maxTokens: 8000 + 150 * batch.length,
                    reasoning: this.#effort("recheck"),
                    signal,
                    cacheKey: cacheKey(document),
                  },
                  reviewerSchema,
                  (parts) => ({ verdicts: parts.flatMap((part) => part.verdicts) }),
                );
              },
            );
            for (const claim of batch) {
              const verdict = result.verdicts.find((candidate) => candidate.claim === claim.id);
              verdicts[claim.id] = verdict
                ? { ...verdict, region: claim.region, text: claim.text }
                : {
                    claim: claim.id,
                    verdict: "unreadable",
                    note: "The reviewer gave no verdict.",
                    region: claim.region,
                    text: claim.text,
                  };
            }
          }),
      ),
    );
    store.setNode(group.id, { status: "done", outcome: verdictOutcome(verdicts) });
    this.#emit(jobId);
    return verdicts;
  }

  /** A keyed step: reuses a finished output, or runs it in its own agent-tree node. */
  async #step<T>(
    jobId: string,
    parentId: string | null,
    key: string,
    node: Omit<NodeInput, "parentId">,
    run: (node: AgentNodeView) => Promise<T>,
  ): Promise<T> {
    const { store } = this.#options;
    const cached = store.step<T>(key);
    const created = this.#node(jobId, parentId, key, {
      ...node,
      provider: node.model ? (parseRef(node.model)?.connection.provider ?? "openai") : null,
    });
    if (cached !== undefined) {
      if (created.status !== "done")
        store.setNode(created.id, { status: "done", note: REUSED_STEP });
      this.#emit(jobId);
      return cached;
    }
    store.setNode(created.id, { status: "running", note: null });
    this.#emit(jobId);
    try {
      const output = await run(created);
      store.saveStep(key, jobId, node.role, output);
      store.setNode(created.id, { status: "done" });
      return output;
    } catch (error) {
      store.setNode(
        created.id,
        stopped(error)
          ? { status: "stopped", note: null }
          : { status: "failed", note: (error as Error).message },
      );
      throw error;
    } finally {
      this.#emit(jobId);
    }
  }

  /** Finds the job's node for a step, or adds one (a retry gets a new node and a higher attempt). */
  #node(
    jobId: string,
    parentId: string | null,
    key: string,
    input: Omit<NodeInput, "parentId">,
  ): AgentNodeView {
    const { store } = this.#options;
    const existing = store.nodesByKey(jobId, key);
    const kept = existing.find(
      (node) =>
        node.status === "done" ||
        node.status === "running" ||
        node.role === "run" ||
        node.role === "document",
    );
    if (kept) return kept;
    return store.addNode(jobId, {
      ...input,
      parentId,
      key,
      attempt: input.attempt ?? existing.length + 1,
    });
  }

  /** Queues a model request for a document, ahead of less urgent kinds of work. */
  #request<T>(
    kind: keyof typeof URGENCY,
    jobId: string,
    documentId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.#limit(`${jobId}:${documentId}`, task, URGENCY[kind]);
  }

  /** The model that checks claims: the reviewer, or for a recheck the recheck model. */
  #checkModel(role: "reviewer" | "recheck"): string {
    return role === "recheck"
      ? (this.#roles.recheck ?? this.#roles.reviewer)
      : this.#roles.reviewer;
  }

  #effort(role: StudyEffortRole): ThinkingLevel {
    return (this.#roles.effort ?? DEFAULT_ROLES.effort!)[role];
  }

  async #call<T>(
    node: AgentNodeView,
    request: Parameters<CompleteFn>[0],
    schema: Parameters<typeof jsonCall>[2],
    merge?: (parts: T[]) => T,
  ): Promise<T> {
    return jsonCall<T>(
      this.#options.complete,
      request,
      schema,
      (usage) => this.#options.store.recordCall(node.id, usage),
      merge,
      (rejected) => this.#options.store.recordRejection(node.id, rejected),
    );
  }

  /** Earlier failed or paused runs over the same documents are replaced by this one. */
  #retire(finished: { id: string; createdAt: string; documentIds: string[] }): void {
    const { store } = this.#options;
    for (const job of store.jobs())
      if (
        job.id !== finished.id &&
        !this.#running.has(job.id) &&
        (job.status === "failed" || job.status === "stopped") &&
        job.createdAt <= finished.createdAt &&
        job.documentIds.every((id) => finished.documentIds.includes(id))
      ) {
        store.deleteJob(job.id);
        this.#options.removed?.(job.id);
      }
  }
}

/**
 * Discrepancies in parts of a few each, in page order, for fix requests sent side by side.
 * Those that concern the same block stay in one part, so no two parts patch one block.
 */
export function fixParts(found: Discrepancy[], size = 6): Discrepancy[][] {
  const parts: { items: Discrepancy[]; blocks: Set<string> }[] = [];
  for (const item of [...found].sort((a, b) => a.page - b.page)) {
    const last = parts.at(-1);
    const target =
      parts.find((part) => item.blocks.some((block) => part.blocks.has(block))) ??
      (last && last.items.length < size ? last : undefined);
    if (target) {
      target.items.push(item);
      for (const block of item.blocks) target.blocks.add(block);
    } else parts.push({ items: [item], blocks: new Set(item.blocks) });
  }
  return parts.map((part) => part.items);
}

/** One part of the lecture a writer takes on, from the brief's outline. */
export interface Topic {
  title: string;
  pages: number[];
}

/**
 * The brief's outline as writers' topics: every page belongs to at least one, a page the outline
 * left out going to the topic of the nearest page (an earlier one on a tie).
 */
export function topicPlan(brief: Brief, inventory: SourceInventory): Topic[] {
  const real = new Set(inventory.pages.map((page) => page.page));
  const plan = brief.outline
    .map((item) => ({
      title: item.title,
      pages: [...new Set(item.pages.filter((page) => real.has(page)))].sort((a, b) => a - b),
    }))
    .filter((item) => item.pages.length);
  if (!plan.length) return [{ title: brief.title, pages: [...real].sort((a, b) => a - b) }];
  // Distances are to the outline's own pages, not to pages given out here.
  const outlined = plan.map((item) => item.pages);
  for (const page of [...real].sort((a, b) => a - b)) {
    if (outlined.some((pages) => pages.includes(page))) continue;
    const distance = (at: number) =>
      Math.min(...outlined[at]!.map((other) => Math.abs(other - page)));
    const nearest = plan.reduce((best, _, at) => (distance(at) < distance(best) ? at : best), 0);
    plan[nearest]!.pages = [...plan[nearest]!.pages, page].sort((a, b) => a - b);
  }
  return plan;
}

/**
 * The topic writers' drafts as one: topic pages in the outline's order, pages two writers gave
 * the same slug joined, block IDs made unique, and the session's lists gathered.
 */
export function mergeTopics(brief: Brief, parts: AuthorDraft[]): AuthorDraft {
  const pages: DraftPage[] = [];
  const ids = new Set<string>();
  const unique = <T>(items: T[], keyOf: (item: T) => string) =>
    items.filter((item, at) => items.findIndex((other) => keyOf(other) === keyOf(item)) === at);
  for (const part of parts)
    for (const page of part.pages) {
      const blocks = page.blocks.map((block) => {
        let id = block.id;
        for (let copy = 2; ids.has(id); copy++) id = `${block.id}-${copy}`;
        ids.add(id);
        return id === block.id ? block : { ...block, id };
      });
      const same = pages.find((existing) => existing.slug === page.slug);
      if (same) {
        same.blocks = [...same.blocks, ...blocks];
        same.prerequisites = unique([...same.prerequisites, ...page.prerequisites], String);
        same.similar_to = unique([...(same.similar_to ?? []), ...(page.similar_to ?? [])], String);
      } else pages.push({ ...page, blocks });
    }
  return {
    session: {
      title: brief.title,
      covers:
        brief.covers ||
        parts
          .map((part) => part.session.covers)
          .filter(Boolean)
          .join(" ") ||
        brief.outline.map((item) => item.title).join(", "),
      worked_examples: unique(
        parts.flatMap((part) => part.session.worked_examples),
        (item) => `${item.title}|${item.page}`,
      ),
      worth_remembering: unique(
        parts.flatMap((part) => part.session.worth_remembering),
        String,
      ),
      open_threads: unique(
        parts.flatMap((part) => part.session.open_threads),
        String,
      ),
    },
    pages,
    omitted: unique(
      parts.flatMap((part) => part.omitted),
      (entry) => entry.region,
    ),
  };
}

/** What the readers found, one line per region, as the writers see it. */
function readingLines(regions: DocumentDraft["regions"]): string[] {
  return Object.entries(regions)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(
      ([id, region]) =>
        `- ${id} [${region.type}${region.escalated ? ", re-read" : ""}] ${region.content}${region.claims.length ? `\n  claims: ${region.claims.map((claim) => `${claim.text} (${claim.basis})`).join(" | ")}` : ""}${region.unreadable ? `\n  unreadable: ${region.unreadable}` : ""}`,
    );
}

function pageNumber(region: string): number {
  return Number(/^p(\d+)\./.exec(region)?.[1] ?? 0);
}

/** Waits for all of these, or stops waiting as soon as the work is called off. */
function untilAll(promises: Promise<void>[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((done, fail) => {
    const stop = () => fail(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    Promise.all(promises).then(
      () => {
        signal.removeEventListener("abort", stop);
        done();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        fail(error);
      },
    );
  });
}

/**
 * One prompt-cache key per document: its requests share instructions and page images, and the
 * provider routes requests with the same key to where that prefix is likely already cached.
 */
export function cacheKey(document: { sha256: string }): string {
  return `folio-${document.sha256.slice(0, 32)}`;
}

/** A content hash that ignores object key order: readers finish in any order on every run. */
export function hash(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/**
 * Runs a document's requests side by side. When one fails, the others are called off, and the
 * failure is reported only after every one has stopped, so none uses a page source that its
 * document has already closed.
 */
async function together<T>(
  signal: AbortSignal,
  tasks: ((signal: AbortSignal) => Promise<T>)[],
): Promise<T[]> {
  const local = new AbortController();
  const stop = () => local.abort();
  signal.addEventListener("abort", stop, { once: true });
  let failure: { error: unknown } | null = null;
  try {
    const results = await Promise.allSettled(
      tasks.map((task) =>
        task(local.signal).catch((error: unknown) => {
          if (!failure && !stopped(error)) failure = { error };
          local.abort();
          throw error;
        }),
      ),
    );
    if (failure) throw (failure as { error: unknown }).error;
    signal.throwIfAborted();
    const called = results.find((result) => result.status === "rejected");
    if (called) throw called.reason;
    return results.map((result) => (result as PromiseFulfilledResult<T>).value);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/** A request that was called off rather than one that went wrong. */
function stopped(error: unknown): boolean {
  return (
    (error instanceof ModelStepError && error.kind === "stopped") ||
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

/**
 * Model requests across all jobs, a few at a time. Each document waits in its own line and the
 * lines take turns, so lectures studied together both move instead of one queueing behind every
 * page of the other.
 */
export function fairLimiter(size: number) {
  let active = 0;
  // Lines in turn order: a line that just started a request goes to the back.
  const lines = new Map<string, { start: () => void; priority: number }[]>();
  const dispatch = () => {
    while (active < size && lines.size) {
      // The most urgent kind of work goes first; within it, lines take turns.
      let top = -Infinity;
      for (const waiting of lines.values())
        for (const item of waiting) top = Math.max(top, item.priority);
      const [line, waiting] = [...lines].find(([, items]) =>
        items.some((item) => item.priority === top),
      )!;
      lines.delete(line);
      const next = waiting.splice(
        waiting.findIndex((item) => item.priority === top),
        1,
      )[0]!;
      if (waiting.length) lines.set(line, waiting);
      active++;
      next.start();
    }
  };
  return async <T>(line: string, task: () => Promise<T>, priority = 0): Promise<T> => {
    await new Promise<void>((resolve) => {
      const waiting = lines.get(line);
      const item = { start: resolve, priority };
      if (waiting) waiting.push(item);
      else lines.set(line, [item]);
      dispatch();
    });
    try {
      return await task();
    } finally {
      active--;
      dispatch();
    }
  };
}

/**
 * How urgent each kind of request is when slots are scarce: finishing what is written comes
 * before reading more pages, so writers and checkers do not wait behind the rest of the reading.
 */
const URGENCY = { read: 0, check: 1, write: 2 } as const;

/**
 * One page per reader: a careful look at one page, with many pages read side by side, catches
 * what three pages skimmed together miss, and finishes sooner.
 */
export function batches(pages: PageInventory[]): PageInventory[][] {
  return pages.map((page) => [page]);
}

function pageLabel(pages: number[]): string {
  return pages.length === 1 ? `Page ${pages[0]}` : `Pages ${pages[0]}–${pages.at(-1)}`;
}

function briefContext(brief: Brief): string {
  return [
    `Lecture brief: ${brief.title}`,
    brief.notation.length
      ? `Notation:\n${brief.notation.map((item) => `- ${item.symbol}: ${item.meaning}`).join("\n")}`
      : "",
    brief.terms.length
      ? `Terms:\n${brief.terms.map((item) => `- ${item.english} / ${item.hebrew}: ${item.meaning}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function regionList(page: PageInventory): string {
  const layer =
    page.textLayer === "ok"
      ? ""
      : ` (text layer ${page.textLayer}: read everything from the image)`;
  return `Page ${page.page}${layer}. Regions:\n${page.regions.map((region) => `- ${region.id} [${region.kind}]${region.text ? ` "${region.text}"` : ""}`).join("\n")}`;
}

/**
 * Whether a region is re-read up close, and why. Text is checked against the text layer; a
 * drawing, chart or picture is re-read only when its first reading is doubtful: the reader was
 * unsure, its own labels are missing from the reading, or it is hard to read (arrows, a chart,
 * small print, Hebrew in an image) and the reading is too thin to have caught it. A good first
 * reading at full resolution is not read twice.
 */
export function gateRegion(
  page: PageInventory,
  region: Region,
  reading: ReadRegion | undefined,
  pageProblem: string | null,
): string | null {
  if (pageProblem) return pageProblem;
  if (!reading) return "the reader skipped this region";
  const unreadable = reading.flags.filter(
    (flag) => flag === "unreadable" || flag === "handwriting",
  );
  if (unreadable.length) return `flagged as hard: ${unreadable.join(", ")}`;
  if (QUIET_TYPES.has(reading.type)) return null;
  if (reading.confidence === "unsure") return "the reader was unsure";
  // A careful reader looked at the whole page; a picture is looked at again only when the
  // reader found almost nothing to say about it, or said it guessed.
  if (region.kind !== "text" && !region.text.trim())
    return reading.content.split(/\s+/).filter(Boolean).length < 8
      ? `${region.kind} read in only a few words`
      : null;
  if (page.textLayer !== "ok") return null;
  const recall = tokenRecall(region.text, reading.content);
  if (recall < RECALL_FLOOR)
    return region.kind === "text"
      ? `the reader dropped words (kept ${Math.round(recall * 100)}%)`
      : `labels missing from the reading (kept ${Math.round(recall * 100)}%)`;
  const missing = missingNumbers(region.numbers, reading.content);
  if (missing.length) return `numbers or symbols missing: ${missing.join(", ")}`;
  if (region.kind === "text") return null;
  const hard = reading.flags.filter((flag) => HARD_FLAGS.has(flag));
  const thin = thinReading(reading, hard);
  return hard.length && thin ? `flagged as hard (${hard.join(", ")}): ${thin}` : null;
}

/** What makes a reading of a hard drawing or chart too thin to trust, if anything. */
function thinReading(reading: ReadRegion, hard: string[]): string | null {
  if (hard.includes("arrows") && !/->|→|⟶|⇒|=>/.test(reading.content))
    return "no arrow written out";
  if (hard.includes("chart") && !/\d/.test(reading.content)) return "no values read";
  // Plain words, not content words: an automaton read as "q0 -> q1 on a" is symbols, not prose.
  if (reading.content.split(/\s+/).filter(Boolean).length < 8) return "the reading is short";
  return null;
}

/** Code decides each region's state from the author's citations, omissions and gaps. */
export function computeLedger(
  inventory: SourceInventory,
  regions: DocumentDraft["regions"],
  draft: AuthorDraft,
): LedgerEntry[] {
  const blocks = draft.pages.flatMap((page) => page.blocks);
  const entries: LedgerEntry[] = [];
  const known = new Map<string, { page: number; kind: LedgerEntry["kind"]; region?: Region }>();
  for (const page of inventory.pages)
    for (const region of page.regions)
      known.set(region.id, { page: page.page, kind: region.kind, region });
  for (const id of Object.keys(regions))
    if (!known.has(id))
      known.set(id, { page: Number(/^p(\d+)\./.exec(id)?.[1] ?? 0), kind: "missed" });

  for (const [id, info] of known) {
    const citing = blocks.filter((block) =>
      block.locators.some((locator) => locator.region === id),
    );
    const omitted = draft.omitted.find((entry) => entry.region === id);
    const gap = draft.gaps?.find((entry) => entry.region === id);
    let state: RegionState = "unaccounted";
    let reason = "not cited, omitted or listed as a gap";
    if (citing.length) {
      const reading = regions[id];
      const words = citing
        .map(
          (block) =>
            `${block.title}\n${block.body}\n${block.keywords_en.join(" ")} ${block.keywords_he.join(" ")} ${block.aliases.join(" ")}`,
        )
        .join("\n");
      if (info.region?.kind === "text" && info.region.text.trim()) {
        // Bookkeeping only: the checker decides whether the slide's facts are in the notes.
        // Overlap is kept for diagnosis; English notes on a Hebrew slide share few words.
        const recall = tokenRecall(info.region.text, words);
        const missing = missingNumbers(info.region.numbers, words);
        state = "represented";
        reason = `cited (${Math.round(recall * 100)}% of its words reach the cited blocks${missing.length ? `; ${missing.join(", ")} not among them` : ""})`;
      } else {
        state = "described";
        reason = reading?.escalated
          ? "visual content, re-read up close; described, not verified"
          : "visual content; described, not verified";
      }
    } else if (omitted && OMIT_REASONS.includes(omitted.reason)) {
      state = "omitted";
      reason = `${omitted.reason.replace("_", " ")}${omitted.note ? `: ${omitted.note}` : ""}`;
    } else if (gap) {
      state = "gap";
      reason = gap.explanation;
    }
    entries.push({
      region: id,
      page: info.page,
      kind: info.kind,
      state,
      blocks: citing.map((block) => block.id),
      reason,
    });
  }
  return entries.sort((a, b) => a.region.localeCompare(b.region, undefined, { numeric: true }));
}

/**
 * Settles the claims the checker still could not confirm after the last revision. A sentence the
 * page contradicts leaves the section; every unconfirmed claim is kept on its block for the
 * tutor, never shown to the student as a warning.
 */
export function settleDisputes(
  draft: AuthorDraft,
  verdicts: DocumentDraft["verdicts"],
): AuthorDraft {
  const disputed = Object.values(verdicts).filter((verdict) => verdict.verdict !== "supported");
  if (!disputed.length) return draft;
  return {
    ...draft,
    pages: draft.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => {
        const own = disputed.filter((verdict) =>
          block.claims.some(
            (claim) => claim.text === verdict.text && claim.region === verdict.region,
          ),
        );
        if (!own.length) return block;
        let body = block.body;
        for (const verdict of own.filter((item) => item.verdict === "contradicted"))
          body = withoutClaim(body, verdict.text);
        return {
          ...block,
          body,
          claims: block.claims.filter(
            (claim) =>
              !own.some(
                (verdict) =>
                  verdict.verdict === "contradicted" &&
                  verdict.text === claim.text &&
                  verdict.region === claim.region,
              ),
          ),
          disputed: own.map((verdict) => ({
            text: verdict.text,
            note: `${verdict.verdict === "contradicted" ? "The slide says otherwise" : "Could not be checked against the slide"}${verdict.note ? `: ${verdict.note}` : ""}`,
          })),
        };
      }),
    })),
  };
}

/** The body without the sentence that makes this claim, when the claim's words are in it. */
function withoutClaim(body: string, claim: string): string {
  const needle = claim.trim().replace(/\s+/g, " ");
  if (!needle) return body;
  const sentences = body.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => !sentence.replace(/\s+/g, " ").includes(needle));
  return kept.length < sentences.length ? kept.join(" ") : body;
}

/**
 * Writes up, straight from the slide, every region still unplaced after the last fix, and every
 * region with facts the checker found in no block: a cited block on the topic its page is mostly
 * about, so no part of a slide is dropped. Text keeps the slide's own words (the text layer, or
 * what the reader read); a figure keeps the reader's description. These blocks are marked as not
 * reviewed.
 */
export function withFallbacks(
  draft: AuthorDraft,
  ledger: LedgerEntry[],
  inventory: SourceInventory,
  regions: DocumentDraft["regions"],
  sessionTitle: string,
  missing: Set<string> = new Set(),
): AuthorDraft {
  const left = ledger.filter((entry) => entry.state === "unaccounted" || missing.has(entry.region));
  if (!left.length) return draft;
  const pages: DraftPage[] = structuredClone(draft.pages);
  const cites = (page: DraftPage, number: number) =>
    page.blocks.reduce(
      (sum, block) => sum + block.locators.filter((locator) => locator.page === number).length,
      0,
    );
  /** The topic most cited on this page, else on the nearest earlier page, else the first. */
  const topicFor = (number: number): DraftPage => {
    for (let at = number; at >= 1; at--) {
      const best = pages
        .map((page) => ({ page, count: cites(page, at) }))
        .filter((candidate) => candidate.count > 0)
        .sort((a, b) => b.count - a.count)[0];
      if (best) return best.page;
    }
    if (!pages.length)
      pages.push({
        slug: "from-the-slides",
        title: sessionTitle,
        type: "concept",
        prerequisites: [],
        intuition: "",
        blocks: [],
      });
    return pages[0]!;
  };
  const found = new Map(inventory.pages.flatMap((page) => page.regions.map((r) => [r.id, r])));
  for (const entry of left) {
    const region = found.get(entry.region);
    const reading = regions[entry.region];
    const words = region?.kind === "text" && region.text.trim() ? region.text.trim() : "";
    const content = words || reading?.content.trim() || "";
    if (!content) continue;
    topicFor(entry.page).blocks.push({
      id: `slide-${entry.region.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      title: `Also on page ${entry.page}`,
      body: words ? `Also on this slide: ${content}` : content,
      locators: [{ page: entry.page, region: entry.region, location: "as on the slide" }],
      keywords_en: [],
      keywords_he: [],
      aliases: [],
      questions: [],
      claims: [],
      interpretations: [],
      unreviewed: true,
    });
  }
  return { ...draft, pages };
}

function draftOutcome(draft: AuthorDraft): StepOutcome {
  return {
    topics: draft.pages.length,
    sections: draft.pages.reduce((sum, page) => sum + page.blocks.length, 0),
  };
}

function verdictOutcome(verdicts: DocumentDraft["verdicts"]): StepOutcome {
  const all = Object.values(verdicts);
  return {
    claims: all.length,
    disagreements: all.filter((verdict) => verdict.verdict !== "supported").length,
  };
}

function exceptionsFor(
  ledger: LedgerEntry[],
  verdicts: DocumentDraft["verdicts"],
  draft: AuthorDraft,
  inventory: SourceInventory,
): ReviewException[] {
  const judgement = new Set(["decorative", "administrative", "duplicate"]);
  const regions = new Map(
    inventory.pages.flatMap((page) => page.regions).map((region) => [region.id, region]),
  );
  // What the student sees when deciding: the region's own text, or what kind of thing it is.
  const describe = (id: string) => {
    const region = regions.get(id);
    if (!region) return "";
    const text = region.text.replace(/\s+/g, " ").trim();
    if (text) return `“${text.length > 160 ? `${text.slice(0, 157)}…` : text}”`;
    return region.kind === "image" ? "A picture with no text" : "A drawing with no text";
  };
  return [
    ...ledger
      .filter((entry) => entry.state === "unaccounted")
      .map((entry) => ({
        kind: "unaccounted" as const,
        region: entry.region,
        page: entry.page,
        detail: describe(entry.region) || entry.reason,
      })),
    ...Object.values(verdicts)
      .filter((verdict) => verdict.verdict !== "supported")
      .map((verdict) => ({
        kind:
          verdict.verdict === "contradicted" ? ("contradicted" as const) : ("unreadable" as const),
        region: verdict.region,
        page: Number(/^p(\d+)\./.exec(verdict.region)?.[1] ?? 0),
        detail: `${verdict.text}${verdict.note ? ` — ${verdict.note}` : ""}`,
      })),
    ...draft.omitted
      .filter((entry) => judgement.has(entry.reason))
      .map((entry) => ({
        kind: "judgement_omission" as const,
        region: entry.region,
        page: Number(/^p(\d+)\./.exec(entry.region)?.[1] ?? 0),
        detail: `${entry.reason}: ${entry.note}`,
      })),
    ...ledger
      .filter((entry) => entry.state === "described")
      .map((entry) => ({
        kind: "visual_only" as const,
        region: entry.region,
        page: entry.page,
        detail: entry.reason,
      })),
  ];
}

function pageState(ledger: LedgerEntry[], page: number): PageCoverageView["state"] {
  const entries = ledger.filter((entry) => entry.page === page);
  if (entries.some((entry) => entry.state === "unaccounted")) return "unaccounted";
  if (entries.some((entry) => entry.state === "gap")) return "gap";
  return "represented";
}

/**
 * Course prefix and session slug, such as "alg" and "alg-L01". A document is numbered by the
 * number in its title, or else by its place among the course's lectures (or recitations) in the
 * order they were added; no two documents of a course share a slug, and a lecture and a
 * recitation with the same number are paired.
 */
export function sessionInfo(
  course: CourseRecord,
  document: DocumentRecord,
  courseDocuments: DocumentRecord[],
): SessionInfo {
  const prefix = coursePrefix(course.name);
  const type = document.role === "recitation" ? "recitation" : "lecture";
  const letter = (other: DocumentRecord) => (other.role === "recitation" ? "R" : "L");
  const all = courseDocuments.some((other) => other.id === document.id)
    ? courseDocuments
    : [...courseDocuments, document];
  const numbers = new Map<string, string>();
  const slugs = new Map<string, string>();
  const taken = new Set<string>();
  for (const kind of ["L", "R"])
    all
      .filter((other) => letter(other) === kind)
      .forEach((other, index) => {
        const number = (/(\d+)/.exec(other.title)?.[1] ?? String(index + 1)).padStart(2, "0");
        let slug = `${prefix}-${kind}${number}`;
        for (let copy = 2; taken.has(slug); copy++) slug = `${prefix}-${kind}${number}-${copy}`;
        taken.add(slug);
        numbers.set(other.id, number);
        slugs.set(other.id, slug);
      });
  const slug = slugs.get(document.id)!;
  const paired = all
    .filter(
      (other) =>
        other.id !== document.id &&
        letter(other) !== letter(document) &&
        numbers.get(other.id) === numbers.get(document.id),
    )
    .map((other) => slugs.get(other.id)!);
  return {
    prefix,
    slug,
    type,
    sourceId: slug,
    sourcePath: `documents/${document.id}/original.pdf`,
    date: new Date().toISOString().slice(0, 10),
    pairedWith: paired,
  };
}

export function coursePrefix(name: string): string {
  const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? ["course"];
  return words.length === 1
    ? words[0]!.slice(0, 3)
    : words
        .map((word) => word[0])
        .join("")
        .slice(0, 5);
}
