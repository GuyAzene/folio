import { describe, expect, it } from "vite-plus/test";
import type { AgentNodeView, JobView } from "../src/desktop/api.ts";
import { PUBLISH_FAILED } from "../src/ingest/pipeline.ts";
import { explain, studyDocuments } from "../app/lib/study.ts";

const node = (
  id: string,
  parentId: string | null,
  role: AgentNodeView["role"],
  status: AgentNodeView["status"],
  extra: Partial<AgentNodeView> = {},
): AgentNodeView => ({
  id,
  parentId,
  role,
  title: role,
  task: "",
  provider: null,
  model: null,
  status,
  note: null,
  pages: [],
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  startedAt: "2026-10-28T10:00:00.000Z",
  endedAt: status === "done" ? "2026-10-28T10:00:10.000Z" : null,
  attempt: 1,
  outcome: null,
  ...extra,
});

function job(nodes: AgentNodeView[], read: number): JobView {
  return {
    id: "job",
    kind: "ingest",
    origin: "upload",
    waitingFor: null,
    courseId: "course",
    documentIds: ["doc"],
    title: "Study",
    status: "running",
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:00:20.000Z",
    pages: 4,
    pagesRead: read,
    regions: 0,
    regionsAccounted: 0,
    coverage: [1, 2, 3, 4].map((page) => ({
      documentId: "doc",
      page,
      state: page <= read ? "read" : "pending",
    })),
    nodes,
    resumable: false,
  };
}

const base = [
  node("run", null, "run", "running"),
  node("doc", "run", "document", "running", { title: "Lecture 1 Graphs" }),
];
const stagesOf = (view: JobView) =>
  studyDocuments(view, () => "Lecture 1 Graphs")[0]!.stages.map((stage) => [
    stage.label,
    stage.state,
    stage.detail,
  ]);

describe("study cards", () => {
  it("says a document is preparing its pages, then waiting for its turn, not idle", () => {
    expect(stagesOf(job([...base, node("prep", "doc", "prepare", "running")], 0))[0]).toEqual([
      "Read every page",
      "pending",
      "Preparing the pages",
    ]);
    const briefed = [
      ...base,
      node("prep", "doc", "prepare", "done"),
      node("brief", "doc", "brief", "done"),
    ];
    expect(stagesOf(job(briefed, 0))[0]).toEqual([
      "Read every page",
      "pending",
      "Waiting for its turn",
    ]);
    expect(stagesOf(job(briefed, 2))[0]).toEqual([
      "Read every page",
      "pending",
      "2 of 4 pages · waiting for its turn",
    ]);
  });

  it("names the running stage's work instead while one of its requests runs", () => {
    const reading = [
      ...base,
      node("prep", "doc", "prepare", "done"),
      node("brief", "doc", "brief", "done"),
      node("reader", "doc", "reader", "running", {
        pages: [1, 2, 3],
        provider: "openai",
        model: "gpt-6-luna",
      }),
    ];
    expect(stagesOf(job(reading, 0))[0]).toEqual(["Read every page", "running", "pages 1–3"]);
  });

  it("drops a failed step once resuming retried it, even under the next attempt number", () => {
    const resumed = [
      ...base,
      node("prep", "doc", "prepare", "done"),
      node("brief-1", "doc", "brief", "failed", {
        note: "Connection error.",
        provider: "openai",
        model: "gpt-6-sol",
      }),
      node("brief-2", "doc", "brief", "done", {
        attempt: 2,
        provider: "openai",
        model: "gpt-6-sol",
        inputTokens: 14_000,
        outputTokens: 1_300,
      }),
      node("reader", "doc", "reader", "running", { pages: [1, 2, 3] }),
    ];
    const [document] = studyDocuments(job(resumed, 0), () => "Lecture 1 Graphs");
    expect(document!.stages[0]).toMatchObject({ label: "Read every page", state: "running" });
    expect(document!.problem).toBeNull();
    expect(document!.activity.map((item) => [item.title, item.status, item.retried])).toEqual([
      ["Skim the whole document", "done", true],
      ["Read pages 1–3", "running", false],
    ]);
    // A step that failed and was not retried yet still shows, in plain words.
    const failed = studyDocuments(job(resumed.slice(0, 4), 0), () => "Lecture 1 Graphs")[0]!;
    expect(failed.stages[0]!.state).toBe("failed");
    expect(failed.problem?.message).toMatch(/losing its connection to ChatGPT/);
  });

  it("keeps a revision of the notes apart from a retry", () => {
    const revised = [
      ...base,
      node("author-1", "doc", "author", "done"),
      node("author-2", "doc", "author", "failed", { attempt: 2, note: "Connection error." }),
    ];
    const [document] = studyDocuments(job(revised, 4), () => "Lecture 1 Graphs");
    expect(document!.activity.map((item) => item.title)).toEqual([
      "Write the study notes",
      "Revise the notes",
    ]);
  });
});

describe("failure wording", () => {
  it("says a lost connection in plain words, keeping the provider's for detail", () => {
    for (const note of [
      "Connection error.",
      "fetch failed",
      "Request timed out.",
      "read ECONNRESET",
    ])
      expect(explain(note), note).toBe(
        "Folio kept losing its connection to ChatGPT. Check your internet connection, then resume.",
      );
    expect(explain("usage_limit_reached")).toMatch(/usage limit/);
  });

  it("says in plain words when the notes were written but not added to the course", () => {
    const plain =
      "The study notes were written, but Folio couldn't add them to the course, so nothing in the course changed.";
    expect(explain(`${PUBLISH_FAILED} UNIQUE constraint failed: blocks.handle`)).toBe(plain);
    // A job that failed before this wording existed reads the same.
    expect(explain("UNIQUE constraint failed: blocks.handle")).toBe(plain);
  });
});
