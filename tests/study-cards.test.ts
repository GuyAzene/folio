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
});

describe("failure wording", () => {
  it("says in plain words when the notes were written but not added to the course", () => {
    const plain =
      "The study notes were written, but Folio couldn't add them to the course, so nothing in the course changed.";
    expect(explain(`${PUBLISH_FAILED} UNIQUE constraint failed: blocks.handle`)).toBe(plain);
    // A job that failed before this wording existed reads the same.
    expect(explain("UNIQUE constraint failed: blocks.handle")).toBe(plain);
  });
});
