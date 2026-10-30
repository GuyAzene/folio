import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { JobStore } from "../src/jobs/store.ts";
import { closeupReasons, stepTimings, timingTable } from "../src/jobs/report.ts";

const homes: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  databases.splice(0).forEach((db) => db.close());
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** Minutes after 10:00 on a fixed day, as the store writes times. */
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 29, 10, 0, minutes * 60)).toISOString();

interface Row {
  id: string;
  parent: string | null;
  role: string;
  task?: string;
  attempt?: number;
  calls?: number;
  input?: number;
  cached?: number;
  output?: number;
  start?: number | null;
  end?: number | null;
  status?: string;
}

/** A synthetic jobs.sqlite with the store's own schema, filled with rows at chosen times. */
async function database(jobs: { id: string; created: number; nodes: Row[] }[]) {
  const home = await mkdtemp(resolve(tmpdir(), "folio-report-test-"));
  homes.push(home);
  (await JobStore.open(home)).close();
  const db = new DatabaseSync(resolve(home, "jobs.sqlite"));
  databases.push(db);
  for (const job of jobs) {
    db.prepare(
      "INSERT INTO jobs (id, kind, course_id, document_ids, title, status, created_at, updated_at) VALUES (?, 'ingest', 'c1', '[]', 'Study', 'done', ?, ?)",
    ).run(job.id, at(job.created), at(job.created));
    job.nodes.forEach((node, seq) =>
      db
        .prepare(
          "INSERT INTO nodes (id, job_id, parent_id, seq, role, title, task, status, pages, calls, input_tokens, cached_tokens, output_tokens, started_at, ended_at, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          node.id,
          job.id,
          node.parent,
          seq + 1,
          node.role,
          node.role === "document" ? `Lecture ${node.id}` : node.role,
          node.task ?? "",
          node.status ?? "done",
          node.calls ?? 0,
          node.input ?? 0,
          node.cached ?? 0,
          node.output ?? 0,
          node.start === null || node.start === undefined ? null : at(node.start),
          node.end === null || node.end === undefined ? null : at(node.end),
          node.attempt ?? 1,
        ),
    );
  }
  return db;
}

/** One lecture: read, two close-ups while reading, a draft, a check, then one revision. */
const LECTURE: Row[] = [
  { id: "run", parent: null, role: "run", start: 0, end: 32 },
  { id: "d1", parent: "run", role: "document", start: 0, end: 31 },
  { id: "prep", parent: "d1", role: "prepare", start: 0, end: 1 },
  { id: "brief", parent: "d1", role: "brief", calls: 1, output: 2000, start: 1, end: 3 },
  { id: "readers", parent: "d1", role: "reader", start: 3, end: 10 },
  { id: "r1", parent: "readers", role: "reader", calls: 1, output: 3000, start: 3, end: 6 },
  { id: "r2", parent: "readers", role: "reader", calls: 2, output: 3500, start: 4, end: 8 },
  {
    id: "e1",
    parent: "r1",
    role: "escalation",
    task: "Re-read 2 hard regions: image content is checked up close; the reader dropped words (kept 40%)",
    calls: 1,
    output: 900,
    start: 6,
    end: 9,
  },
  {
    id: "e2",
    parent: "r2",
    role: "escalation",
    task: "Re-read 1 hard region: the reader dropped words (kept 0%)",
    calls: 1,
    output: 400,
    start: 5,
    end: 7,
  },
  { id: "a1", parent: "d1", role: "author", calls: 1, output: 20000, start: 10, end: 20 },
  { id: "reviewers", parent: "d1", role: "reviewer", start: 20, end: 22 },
  { id: "v1", parent: "reviewers", role: "reviewer", calls: 1, output: 800, start: 20, end: 22 },
  {
    id: "e3",
    parent: "d1",
    role: "escalation",
    task: "Re-read 1 hard region: flagged as hard",
    calls: 1,
    output: 300,
    start: 21,
    end: 22,
  },
  {
    id: "a2",
    parent: "d1",
    role: "author",
    attempt: 2,
    calls: 1,
    input: 30000,
    cached: 24000,
    output: 18000,
    start: 22,
    end: 30,
  },
  { id: "ledger", parent: "d1", role: "ledger", start: 30, end: 30 },
  { id: "publish", parent: "run", role: "publish", start: 31, end: 32 },
];

describe("study timings", () => {
  it("gives each step's nodes, calls, tokens and minutes, with revisions apart", async () => {
    const db = await database([{ id: "job-aaaa", created: 0, nodes: LECTURE }]);
    const [document, ...rest] = stepTimings(db);
    expect(rest).toEqual([]);
    expect(document).toMatchObject({
      jobId: "job-aaaa",
      nodeId: "d1",
      title: "Lecture d1",
      status: "done",
      startedAt: at(0),
      endedAt: at(31),
    });
    const rows = document!.steps.map((row) => [
      row.step,
      row.nodes,
      row.calls,
      row.outputTokens,
      Math.round(row.busyMinutes * 100) / 100,
      Math.round(row.spanMinutes * 100) / 100,
    ]);
    // The "Readers" and "Reviewers" groups are not counted next to their own steps.
    expect(rows).toEqual([
      ["prepare", 1, 0, 0, 1, 1],
      ["brief", 1, 1, 2000, 2, 2],
      ["reader", 2, 3, 6500, 7, 5],
      ["escalation", 3, 3, 1600, 6, 17],
      ["author", 1, 1, 20000, 10, 10],
      ["reviewer", 1, 1, 800, 2, 2],
      ["revision", 1, 1, 18000, 8, 8],
      ["ledger", 1, 0, 0, 0, 0],
    ]);
    expect(document!.wall).toMatchObject({
      step: "wall",
      nodes: 11,
      calls: 10,
      outputTokens: 48900,
    });
    expect(document!.wall.busyMinutes).toBeCloseTo(36);
    expect(document!.wall.spanMinutes).toBeCloseTo(31);
    expect(document!.closeups).toEqual([
      { reason: "the reader dropped words", count: 2 },
      { reason: "flagged as hard", count: 1 },
      { reason: "image content is checked up close", count: 1 },
    ]);
  });

  it("keeps two documents of one job apart and measures a running step up to now", async () => {
    const db = await database([
      {
        id: "job-bbbb",
        created: 0,
        nodes: [
          { id: "run", parent: null, role: "run", start: 0, status: "running" },
          { id: "d1", parent: "run", role: "document", start: 0, end: 20 },
          { id: "a1", parent: "d1", role: "author", calls: 1, output: 100, start: 2, end: 12 },
          { id: "d2", parent: "run", role: "document", start: 1, status: "running" },
          // Queued again after a pause: started once, with no end, and not running now.
          { id: "b2", parent: "d2", role: "brief", start: 1, status: "queued" },
          {
            id: "a2",
            parent: "d2",
            role: "author",
            calls: 1,
            output: 0,
            start: 5,
            status: "running",
          },
        ],
      },
    ]);
    const [first, second] = stepTimings(db, { now: at(15) });
    expect(first!.steps.map((row) => [row.step, row.nodes, row.calls])).toEqual([["author", 1, 1]]);
    expect(second!.steps.map((row) => [row.step, row.nodes, row.busyMinutes])).toEqual([
      ["brief", 1, 0],
      ["author", 1, 10],
    ]);
    expect(second!.wall.spanMinutes).toBeCloseTo(14);
    expect(second!.endedAt).toBeNull();
  });

  it("spans a resumed study from its first step, and keeps its last run's own clock", async () => {
    const db = await database([
      {
        id: "job-cccc",
        created: 0,
        nodes: [
          // Paused at 12 and resumed at 40: the document's clock started again then.
          { id: "d1", parent: null, role: "document", start: 40, end: 55 },
          { id: "b1", parent: "d1", role: "brief", calls: 1, start: 0, end: 2 },
          {
            id: "a1",
            parent: "d1",
            role: "author",
            calls: 1,
            start: 2,
            end: 12,
            status: "stopped",
          },
          { id: "a2", parent: "d1", role: "author", calls: 1, start: 40, end: 52 },
        ],
      },
    ]);
    const [document] = stepTimings(db);
    expect(document!.wall.spanMinutes).toBeCloseTo(55);
    expect(document!.lastRunMinutes).toBeCloseTo(15);
    expect(document!.steps.find((row) => row.step === "author")).toMatchObject({
      nodes: 2,
      busyMinutes: 22,
      spanMinutes: 50,
    });
    expect(timingTable([document!]).split("\n")[0]).toBe(
      `Lecture d1 · done · job job-cccc · started ${at(40)} · last run 15.0 min`,
    );
  });

  it("filters by the start of a job ID and by when the study started", async () => {
    const db = await database([
      {
        id: "1111-early",
        created: 0,
        nodes: [{ id: "d1", parent: null, role: "document", start: 0, end: 5 }],
      },
      {
        id: "2222-late",
        created: 60,
        nodes: [{ id: "d2", parent: null, role: "document", start: 70, end: 80 }],
      },
      // Queued but never started: its job's creation time stands in.
      {
        id: "3333-queued",
        created: 90,
        nodes: [{ id: "d3", parent: null, role: "document", start: null }],
      },
    ]);
    expect(stepTimings(db).map((document) => document.nodeId)).toEqual(["d1", "d2", "d3"]);
    expect(stepTimings(db, { job: "2222" }).map((document) => document.nodeId)).toEqual(["d2"]);
    expect(stepTimings(db, { job: "2222-late-x" })).toEqual([]);
    expect(stepTimings(db, { since: at(60) }).map((document) => document.nodeId)).toEqual([
      "d2",
      "d3",
    ]);
  });

  it("shows patch fixes and rechecks as their own steps, rechecks without their group", async () => {
    const db = await database([
      {
        id: "job-dddd",
        created: 0,
        nodes: [
          { id: "d1", parent: null, role: "document", start: 0, end: 30 },
          { id: "a1", parent: "d1", role: "author", calls: 1, start: 0, end: 10 },
          { id: "reviewers", parent: "d1", role: "reviewer", start: 10, end: 14 },
          { id: "v1", parent: "reviewers", role: "reviewer", calls: 1, start: 10, end: 14 },
          { id: "f1", parent: "d1", role: "fix", calls: 1, output: 3000, start: 14, end: 17 },
          { id: "rechecks", parent: "d1", role: "recheck", start: 17, end: 18 },
          { id: "k1", parent: "rechecks", role: "recheck", calls: 1, start: 17, end: 18 },
          { id: "f2", parent: "d1", role: "fix", attempt: 2, calls: 1, start: 18, end: 20 },
        ],
      },
    ]);
    const [document] = stepTimings(db);
    expect(document!.steps.map((row) => [row.step, row.nodes, row.calls, row.busyMinutes])).toEqual(
      [
        ["author", 1, 1, 10],
        ["reviewer", 1, 1, 4],
        ["fix", 2, 2, 5],
        ["recheck", 1, 1, 1],
      ],
    );
  });

  it("reads a store from before cache hits were recorded, without changing it", async () => {
    const db = await database([{ id: "job-aaaa", created: 0, nodes: LECTURE }]);
    db.exec("ALTER TABLE nodes DROP COLUMN cached_tokens");
    const [document] = stepTimings(db);
    expect(document!.wall.cachedTokens).toBeNull();
    expect(document!.steps.every((row) => row.cachedTokens === null)).toBe(true);
    expect(timingTable([document!]).split("\n")).toContainEqual(
      expect.stringMatching(/^ {2}revision +1 +1 +18,000 +– +8\.0 +8\.0$/),
    );
  });

  it("reads close-up reasons from a task, details and repeats aside", () => {
    expect(
      closeupReasons(
        "Re-read 3 hard regions: no usable text layer on this page; the reader dropped words (kept 12%); the reader dropped words (kept 70%)",
      ),
    ).toEqual(["no usable text layer on this page", "the reader dropped words"]);
    // Values in a reason vary from region to region; the reason does not.
    expect(
      closeupReasons(
        "Re-read 4 hard regions: cited, but 1, 2 is missing from the cited blocks; cited, but ∑ is missing from the cited blocks; cited, but only 33% of its words reach the cited blocks; flagged as hard",
      ),
    ).toEqual([
      "cited, but … is missing from the cited blocks",
      "cited, but only … of its words reach the cited blocks",
      "flagged as hard",
    ]);
    expect(closeupReasons("Re-read hard regions")).toEqual([]);
  });

  it("prints a table per document with a wall row and the close-up reasons", async () => {
    const db = await database([{ id: "job-aaaa", created: 0, nodes: LECTURE }]);
    const table = timingTable(stepTimings(db));
    const lines = table.split("\n");
    expect(lines[0]).toBe(`Lecture d1 · done · job job-aaaa · started ${at(0)}`);
    expect(lines[1]).toMatch(/^ {2}step +nodes +calls +out tokens +cached in +busy min +span min$/);
    // The share of input served from the prompt cache; no input, no share.
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {2}revision +1 +1 +18,000 +80% +8\.0 +8\.0$/),
    );
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}ledger +1 +0 +0 +– +0\.0 +0\.0$/));
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {2}wall +11 +10 +48,900 +80% +36\.0 +31\.0$/),
    );
    expect(lines.at(-1)).toBe(
      "  close-ups by reason: the reader dropped words 2 · flagged as hard 1 · image content is checked up close 1",
    );
    expect(timingTable([])).toBe("No studies match.");
  });
});
