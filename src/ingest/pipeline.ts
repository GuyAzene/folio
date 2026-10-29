import { createHash } from "node:crypto";
import type {
  AgentNodeView,
  JobOrigin,
  JobView,
  PageCoverageView,
  StepOutcome,
} from "../desktop/api.ts";
import type { JobStore, NodeInput } from "../jobs/store.ts";
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
  ESCALATION_SYSTEM,
  escalationSchema,
  OMIT_REASONS,
  PROMPT_VERSION,
  READER_SYSTEM,
  readerSchema,
  REVIEWER_SYSTEM,
  reviewerSchema,
  type AuthorDraft,
  type Brief,
  type EscalatedRegion,
  type ReadPage,
  type ReadRegion,
  type Verdict,
} from "./prompts.ts";
import { missingNumbers, tokenRecall } from "./reconcile.ts";
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
}

export const DEFAULT_ROLES: RoleModels = {
  provider: "openai",
  brief: "gpt-6-sol",
  reader: "gpt-6-luna",
  escalation: "gpt-6.1-sol",
  author: "gpt-6.1-sol",
  reviewer: "gpt-6-sol",
};

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
  roles?: RoleModels;
  /** Parallel reader and reviewer requests across all jobs. */
  concurrency?: number;
  /** Jobs studied at once; the rest wait their turn. */
  parallelJobs?: number;
  /** Whether ChatGPT is connected. Queued jobs wait for it; without this, it always is. */
  connected?: () => Promise<boolean>;
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
const LEDGER_RECALL_FLOOR = 0.5;
const HARD_FLAGS = new Set([
  "hebrew_in_image",
  "small_text",
  "chart",
  "arrows",
  "handwriting",
  "unreadable",
]);
const QUIET_TYPES = new Set(["decoration", "header_footer"]);

/**
 * Runs ingestion jobs as fixed code, not as an agent deciding its own work: prepare and
 * inventory, brief, readers in parallel, gate, escalate, author, ledger, independent review,
 * one revision, then published to the course. See docs/architecture.md.
 */
/** Starts a run's failure note when the study notes were written but could not be published. */
export const PUBLISH_FAILED = "The study notes were written but couldn't be added to the course:";

export class IngestRunner {
  readonly #options: IngestOptions;
  readonly #roles: RoleModels;
  readonly #running = new Map<string, AbortController>();
  /** Each running job's run, so a caller can wait until it has really stopped. */
  readonly #runs = new Map<string, Promise<void>>();
  readonly #limit: <T>(line: string, task: () => Promise<T>) => Promise<T>;
  #filling: Promise<void> = Promise.resolve();

  constructor(options: IngestOptions) {
    this.#options = options;
    this.#roles = options.roles ?? DEFAULT_ROLES;
    this.#limit = fairLimiter(options.concurrency ?? 3);
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
    try {
      const job = store.job(jobId);
      const course = await library.course(job.courseId);
      const documents = await Promise.all(job.documentIds.map((id) => library.document(id)));
      // Sessions are numbered and paired across the whole course, not only this job's files.
      const studied = (await library.listDocuments({ courseId: course.id }))
        .filter((document) => document.role === "lecture" || document.role === "recitation")
        .sort((a, b) => a.importedAt.localeCompare(b.importedAt) || a.id.localeCompare(b.id));
      // Documents are independent: one that fails does not stop the others, and whatever
      // finished is added to the course. Resume redoes only what did not finish.
      const results = await Promise.allSettled(
        documents.map((document) =>
          this.#document(jobId, root.id, course, document, studied, signal),
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

  async #document(
    jobId: string,
    rootId: string,
    course: CourseRecord,
    document: DocumentRecord,
    courseDocuments: DocumentRecord[],
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
      const brief = await this.#brief(jobId, branch.id, document, source, signal);
      const regions = await this.#read(jobId, branch.id, document, source, brief, signal);
      let draft = await this.#author(
        jobId,
        branch.id,
        course,
        document,
        source,
        brief,
        regions,
        session,
        signal,
        null,
      );
      let ledger = computeLedger(inventory, regions, draft);
      let verdicts = await this.#review(jobId, branch.id, document, source, draft, {}, signal);

      const issues = revisionIssues(ledger, verdicts);
      if (issues.length) {
        draft = await this.#author(
          jobId,
          branch.id,
          course,
          document,
          source,
          brief,
          regions,
          session,
          signal,
          { draft, issues },
        );
        ledger = computeLedger(inventory, regions, draft);
        verdicts = await this.#review(jobId, branch.id, document, source, draft, verdicts, signal);
      }
      // Nothing waits for the student: regions Folio could not place become stated gaps, and
      // claims the checker could not confirm are noted on their sections, where the tutor reads.
      const uncovered = ledger.filter((entry) => entry.state === "unaccounted").length;
      ledger = ledger.map((entry) =>
        entry.state === "unaccounted"
          ? {
              ...entry,
              state: "gap" as const,
              reason: `Folio could not place this region, so nothing was written from it (${entry.reason}).`,
            }
          : entry,
      );
      draft = noteDisputes(draft, verdicts);
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
    const key = hash(["brief", PROMPT_VERSION, model, document.sha256, inventory.version]);
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
        return this.#call<Brief>(
          node,
          { model, system: BRIEF_SYSTEM, content, maxTokens: 6000, reasoning: "low", signal },
          briefSchema,
        );
      },
    );
  }

  async #read(
    jobId: string,
    parentId: string,
    document: DocumentRecord,
    source: PreparedSource,
    brief: Brief,
    signal: AbortSignal,
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
    const briefText = briefContext(brief);
    const regions: DocumentDraft["regions"] = {};

    await together(
      signal,
      batches(inventory.pages).map(
        (pages) => (signal) =>
          this.#limit(`${jobId}:${document.id}`, async () => {
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
              hash(brief),
            ]);
            const read = await this.#step(
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
                const content: ModelRequest["content"] = [text(briefText)];
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
                    maxTokens: 4000 + 3000 * pages.length,
                    reasoning: "low",
                    signal,
                  },
                  readerSchema,
                  (parts) => ({ pages: parts.flatMap((part) => part.pages) }),
                );
                return result.pages;
              },
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
          }),
      ),
    );
    store.setNode(group.id, { status: "done" });
    this.#emit(jobId);
    return regions;
  }

  async #escalate(
    jobId: string,
    readerKey: string,
    document: DocumentRecord,
    source: PreparedSource,
    items: { region: Region; reason: string; first?: ReadRegion }[],
    regions: DocumentDraft["regions"],
    signal: AbortSignal,
  ): Promise<void> {
    const { store } = this.#options;
    // The reader step that found these regions; documents read at the same time share page numbers.
    const parent = store.nodesByKey(jobId, readerKey).at(-1);
    const byPage = Map.groupBy(items, (item) => item.region.page);
    for (const [page, group] of byPage) {
      signal.throwIfAborted();
      const model = this.#roles.escalation;
      const key = hash([
        "escalation",
        PROMPT_VERSION,
        model,
        document.sha256,
        readerKey,
        page,
        group.map((item) => item.region.id),
      ]);
      const result = await this.#step(
        jobId,
        parent?.id ?? null,
        key,
        {
          role: "escalation",
          title: `Page ${page} close-up`,
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
              maxTokens: 6000,
              reasoning: "medium",
              signal,
            },
            escalationSchema,
            (parts) => ({ regions: parts.flatMap((part) => part.regions) }),
          );
        },
      );
      for (const region of result.regions) {
        const edges = region.edges.map(
          (edge) => `${edge.from} -> ${edge.to}${edge.label ? ` (${edge.label})` : ""}`,
        );
        regions[region.id] = {
          id: region.id,
          type: region.type,
          content: edges.length ? `${region.content}\nEdges: ${edges.join("; ")}` : region.content,
          claims: region.claims,
          flags: [],
          escalated: true,
          unreadable: region.unreadable,
        };
      }
    }
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
    signal: AbortSignal,
    revision: { draft: AuthorDraft; issues: string[] } | null,
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
      revision ? hash(revision) : null,
    ]);
    return this.#step(
      jobId,
      parentId,
      key,
      {
        role: "author",
        title: revision ? "Author · revision" : "Author",
        task: revision
          ? `Fix ${revision.issues.length} issue${revision.issues.length === 1 ? "" : "s"} found by the ledger and the reviewer`
          : `Write the wiki for ${document.title}`,
        model,
        attempt: revision ? 2 : 1,
      },
      async (node) => {
        const regionLines = Object.entries(regions)
          .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
          .map(
            ([id, region]) =>
              `- ${id} [${region.type}${region.escalated ? ", re-read" : ""}] ${region.content}${region.claims.length ? `\n  claims: ${region.claims.map((claim) => `${claim.text} (${claim.basis})`).join(" | ")}` : ""}${region.unreadable ? `\n  unreadable: ${region.unreadable}` : ""}`,
          );
        const content: ModelRequest["content"] = [
          text(
            [
              `Course: ${course.name}${course.code ? ` (${course.code})` : ""}. Wiki page slugs are written without the course prefix "${session.prefix}"; Folio adds it.`,
              `Session: ${session.slug}, ${session.type} "${document.title}".`,
              briefContext(brief),
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
        if (revision)
          content.push(
            text(
              `Your previous draft:\n${JSON.stringify(revision.draft)}\n\nFix these issues and return the complete corrected draft:\n${revision.issues.map((issue) => `- ${issue}`).join("\n")}`,
            ),
          );
        const written = await this.#call<AuthorDraft>(
          node,
          { model, system: AUTHOR_SYSTEM, content, maxTokens: 32000, reasoning: "medium", signal },
          authorSchema,
        );
        this.#options.store.setNode(node.id, { outcome: draftOutcome(written) });
        return written;
      },
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
    const group = this.#node(jobId, parentId, `reviewers:${hash(pending)}`, {
      role: "reviewer",
      title: "Reviewers",
      task: `Check ${pending.length} claims against the page images`,
      model: this.#roles.reviewer,
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
          this.#limit(`${jobId}:${document.id}`, async () => {
            signal.throwIfAborted();
            const model = this.#roles.reviewer;
            const batch = pending.filter((claim) => chunk.includes(pageOf(claim.region)));
            const key = hash([
              "reviewer",
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
                role: "reviewer",
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
                    maxTokens: 2000 + 150 * batch.length,
                    reasoning: "medium",
                    signal,
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
      provider: node.model ? this.#roles.provider : null,
    });
    if (cached !== undefined) {
      if (created.status !== "done")
        store.setNode(created.id, { status: "done", note: "Reused from an earlier run." });
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
  const lines = new Map<string, (() => void)[]>();
  const dispatch = () => {
    while (active < size && lines.size) {
      const [line, waiting] = lines.entries().next().value!;
      lines.delete(line);
      const start = waiting.shift()!;
      if (waiting.length) lines.set(line, waiting);
      active++;
      start();
    }
  };
  return async <T>(line: string, task: () => Promise<T>): Promise<T> => {
    await new Promise<void>((resolve) => {
      const waiting = lines.get(line);
      if (waiting) waiting.push(resolve);
      else lines.set(line, [resolve]);
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

/** Three pages per reader; a page with no usable text layer gets a reader to itself. */
export function batches(pages: PageInventory[]): PageInventory[][] {
  const result: PageInventory[][] = [];
  let current: PageInventory[] = [];
  for (const page of pages) {
    if (page.textLayer !== "ok") {
      if (current.length) result.push(current);
      result.push([page]);
      current = [];
      continue;
    }
    current.push(page);
    if (current.length === 3) {
      result.push(current);
      current = [];
    }
  }
  if (current.length) result.push(current);
  return result;
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

/** Why a region must be re-read up close, or null when the reader's account holds up. */
export function gateRegion(
  page: PageInventory,
  region: Region,
  reading: ReadRegion | undefined,
  pageProblem: string | null,
): string | null {
  if (pageProblem) return pageProblem;
  if (!reading) return "the reader skipped this region";
  if (reading.flags.some((flag) => HARD_FLAGS.has(flag)))
    return `flagged as hard: ${reading.flags.join(", ")}`;
  if (QUIET_TYPES.has(reading.type)) return null;
  if (page.textLayer !== "ok") return `no usable text layer on this page`;
  if (region.kind !== "text") return `${region.kind} content is checked up close`;
  const recall = tokenRecall(region.text, reading.content);
  if (recall < RECALL_FLOOR) return `the reader dropped words (kept ${Math.round(recall * 100)}%)`;
  const missing = missingNumbers(region.numbers, reading.content);
  if (missing.length) return `numbers or symbols missing: ${missing.join(", ")}`;
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
    const gap = draft.gaps.find((entry) => entry.region === id);
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
        const recall = tokenRecall(info.region.text, words);
        const missing = missingNumbers(info.region.numbers, words);
        if (recall >= LEDGER_RECALL_FLOOR && !missing.length) {
          state = "represented";
          reason = `reconciled (${Math.round(recall * 100)}% of its words)`;
        } else {
          reason = missing.length
            ? `cited, but ${missing.join(", ")} is missing from the cited blocks`
            : `cited, but only ${Math.round(recall * 100)}% of its words reach the cited blocks`;
        }
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

function revisionIssues(ledger: LedgerEntry[], verdicts: DocumentDraft["verdicts"]): string[] {
  return [
    ...ledger
      .filter((entry) => entry.state === "unaccounted")
      .map(
        (entry) =>
          `Region ${entry.region} (page ${entry.page}) is ${entry.reason}. Cite it, omit it with an allowed reason, or list it as a gap.`,
      ),
    ...Object.values(verdicts)
      .filter((verdict) => verdict.verdict === "contradicted")
      .map(
        (verdict) =>
          `The claim "${verdict.text}" (${verdict.region}) is contradicted by the page: ${verdict.note}`,
      ),
  ];
}

/** Each claim the checker could not confirm, noted on the section that makes it. */
export function noteDisputes(draft: AuthorDraft, verdicts: DocumentDraft["verdicts"]): AuthorDraft {
  const disputed = Object.values(verdicts).filter((verdict) => verdict.verdict !== "supported");
  if (!disputed.length) return draft;
  return {
    ...draft,
    pages: draft.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => {
        const notes = disputed
          .filter((verdict) =>
            block.claims.some(
              (claim) => claim.text === verdict.text && claim.region === verdict.region,
            ),
          )
          .map(
            (verdict) =>
              `Not confirmed against the slides: "${verdict.text}"${verdict.note ? ` (${verdict.note})` : ""}`,
          );
        return notes.length
          ? {
              ...block,
              body: `${block.body.trim()}\n\n${notes.map((note) => `> ${note}`).join("\n>\n")}`,
              gaps: [...block.gaps, ...notes],
            }
          : block;
      }),
    })),
  };
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
