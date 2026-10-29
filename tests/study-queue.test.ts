import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DocumentRecord } from "../src/library/store.ts";
import { IngestRunner, sessionInfo, type PreparedSource } from "../src/ingest/pipeline.ts";
import { mergeDraft, emptyKnowledge } from "../src/kb/knowledge.ts";
import { JobStore } from "../src/jobs/store.ts";
import { LibraryStore } from "../src/library/store.ts";
import { bundle } from "./fixtures/draft-bundle.ts";
import { syntheticPdf } from "./fixtures/synthetic-pdf.ts";

// Synthetic lectures only. Preparing a document waits on a gate the test opens, so a test sees
// which studies started and in what order, then fails them quickly once let through.

const homes: string[] = [];
const stores: JobStore[] = [];
/** Lets every study through and waits for it to stop, before its store closes. */
const settles: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const settle of settles.splice(0)) await settle();
  stores.splice(0).forEach((store) => store.close());
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function setup(options: { connected?: boolean } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), "folio-queue-test-"));
  homes.push(home);
  const library = await LibraryStore.open({ home });
  const store = await JobStore.open(home);
  stores.push(store);
  const course = await library.createCourse({ name: "Algorithms" });
  const lectures: DocumentRecord[] = [];
  for (const name of ["Lecture 1", "Lecture 2", "Lecture 3"]) {
    const path = resolve(home, `${name}.pdf`);
    await writeFile(path, syntheticPdf([[name]]));
    lectures.push((await library.importFile(course.id, path)).document);
  }
  const prepared: string[] = [];
  let open!: () => void;
  let gate = new Promise<void>((done) => (open = done));
  const state = { connected: options.connected ?? true };
  const removed: string[] = [];
  const runner = new IngestRunner({
    store,
    library,
    complete: async () => {
      throw new Error("No model in these tests.");
    },
    prepare: async (_data, sha256) => {
      prepared.push(sha256);
      await gate;
      return {
        inventory: { version: 1, sha256, pages: [] },
        render: async () => new Uint8Array(),
        crop: async () => new Uint8Array(),
        close: async () => undefined,
      } satisfies PreparedSource;
    },
    emit: () => undefined,
    publish: async () => 1,
    removed: (id) => removed.push(id),
    connected: async () => state.connected,
    parallelJobs: 2,
  });
  settles.push(async () => {
    gate = Promise.resolve();
    open();
    await runner.withdraw(() => true);
  });
  const started = () =>
    lectures.filter((lecture) => prepared.includes(lecture.sha256)).map((lecture) => lecture.id);
  return {
    store,
    runner,
    library,
    course,
    lectures,
    started,
    removed,
    state,
    release: () => {
      open();
      gate = new Promise<void>((done) => (open = done));
    },
  };
}

describe("studying on its own", () => {
  it("studies two at a time: what the student asked for, then new files, then the rest", async () => {
    const { runner, course, lectures, started, state, store, release } = await setup({
      connected: false,
    });
    const [first, second, third] = lectures as [DocumentRecord, DocumentRecord, DocumentRecord];
    await runner.queue(course.id, [first.id], "backlog");
    await runner.queue(course.id, [second.id], "upload");
    await runner.start(course.id, [third.id]);
    await vi.waitFor(() =>
      expect(store.jobs().every((job) => job.waitingFor === "connection")).toBe(true),
    );
    expect(started()).toEqual([]);

    state.connected = true;
    runner.connectionChanged();
    await vi.waitFor(() => expect(started().sort()).toEqual([second.id, third.id].sort()));
    const waiting = store.jobs().find((job) => job.documentIds[0] === first.id)!;
    expect(waiting.status).toBe("queued");
    expect(waiting.waitingFor).toBeNull();

    release();
    await vi.waitFor(() => expect(started()).toContain(first.id));
  });

  it("never queues a document twice, or again after the student cancelled it", async () => {
    const { runner, course, lectures, store } = await setup({ connected: false });
    const lecture = lectures[0]!;
    expect(await runner.queue(course.id, [lecture.id, lecture.id], "upload")).toHaveLength(1);
    expect(await runner.queue(course.id, [lecture.id], "backlog")).toHaveLength(0);
    const job = store.jobs()[0]!;
    runner.cancel(job.id);
    runner.dismiss(job.id);
    expect(await runner.queue(course.id, [lecture.id], "backlog")).toHaveLength(0);
    // Asking again is the student's own choice, and it counts.
    await runner.start(course.id, [lecture.id]);
    expect(store.declined().has(lecture.id)).toBe(false);
  });

  it("leaves alone what is not a PDF lecture or recitation", async () => {
    const { runner, course, lectures, library } = await setup();
    const lecture = lectures[0]!;
    await library.updateDocument(lecture.id, { role: "assignment" }, lecture.revision);
    expect(await runner.queue(course.id, [lecture.id], "upload")).toHaveLength(0);
  });

  it("withdraws a study and resolves only once it has stopped", async () => {
    const { runner, course, lectures, started, store, removed, release } = await setup();
    const job = await runner.start(course.id, [lectures[0]!.id]);
    await vi.waitFor(() => expect(started()).toHaveLength(1));
    let done = false;
    const withdrawing = runner
      .withdraw((candidate) => candidate.documentIds.includes(lectures[0]!.id))
      .then(() => (done = true));
    await new Promise((settle) => setTimeout(settle, 20));
    expect(done).toBe(false);
    release();
    await withdrawing;
    expect(store.jobs()).toHaveLength(0);
    expect(removed).toEqual([job.id]);
  });

  it("picks up interrupted studies after a restart, and leaves paused ones paused", async () => {
    const { runner, course, lectures, store, started } = await setup({ connected: false });
    await runner.queue(course.id, [lectures[0]!.id], "upload");
    const paused = await runner.start(course.id, [lectures[1]!.id]);
    runner.pause(paused.id);
    const interrupted = store.jobs().find((job) => job.documentIds[0] === lectures[0]!.id)!;
    store.updateJob(interrupted.id, { status: "running" });

    const restarted = new IngestRunner({
      store,
      library: (await setup()).library,
      complete: async () => {
        throw new Error("No model.");
      },
      prepare: () => new Promise(() => undefined),
      emit: () => undefined,
      publish: async () => 1,
      connected: async () => false,
    });
    restarted.recover();
    await vi.waitFor(() => expect(store.job(interrupted.id).status).toBe("queued"));
    expect(store.job(paused.id).status).toBe("stopped");
    expect(started()).toEqual([]);
    void course;
  });
});

describe("sessions across a course", () => {
  const course = { name: "Algorithms" } as Parameters<typeof sessionInfo>[0];
  const document = (id: string, title: string, role: DocumentRecord["role"] = "lecture") =>
    ({ id, title, role }) as DocumentRecord;

  it("number by title or place, never share a slug, and pair by number", () => {
    const all = [
      document("a", "Graph traversal"),
      document("b", "Shortest paths"),
      document("c", "Lecture 1"),
      document("d", "Lecture 1 (updated)"),
      document("e", "Recitation 1", "recitation"),
    ];
    const slugs = all.map((item) => sessionInfo(course, item, all).slug);
    expect(slugs).toEqual(["alg-L01", "alg-L02", "alg-L01-2", "alg-L01-3", "alg-R01"]);
    expect(sessionInfo(course, all[4]!, all).pairedWith).toEqual([
      "alg-L01",
      "alg-L01-2",
      "alg-L01-3",
    ]);
  });

  it("replace a document's own session under a new slug, and never another's", () => {
    const empty = emptyKnowledge("course", "alg");
    const first = mergeDraft(empty, bundle("course", "doc-a", "alg-L01"));
    const renamed = mergeDraft(first, bundle("course", "doc-a", "alg-L05"));
    expect(renamed.sessions.map((session) => [session.slug, session.documentId])).toEqual([
      ["alg-L05", "doc-a"],
    ]);
    const other = mergeDraft(renamed, bundle("course", "doc-b", "alg-L05"));
    expect(other.sessions.map((session) => [session.slug, session.documentId])).toEqual([
      ["alg-L05", "doc-a"],
      ["alg-L05-2", "doc-b"],
    ]);
    expect(other.pages.flatMap((page) => page.blocks.map((block) => block.session)).sort()).toEqual(
      ["alg-L05", "alg-L05", "alg-L05-2", "alg-L05-2"],
    );
  });
});
