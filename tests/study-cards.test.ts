import { describe, expect, it } from "vite-plus/test";
import type { AgentNodeView, JobView } from "../src/desktop/api.ts";
import { PUBLISH_FAILED } from "../src/ingest/pipeline.ts";
import { explain, studyDocuments, studyProgress } from "../app/lib/study.ts";

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
      "Read every slide",
      "pending",
      "Preparing the slides",
    ]);
    const briefed = [
      ...base,
      node("prep", "doc", "prepare", "done"),
      node("brief", "doc", "brief", "done"),
    ];
    expect(stagesOf(job(briefed, 0))[0]).toEqual([
      "Read every slide",
      "pending",
      "Waiting for its turn",
    ]);
    expect(stagesOf(job(briefed, 2))[0]).toEqual([
      "Read every slide",
      "pending",
      "2 of 4 slides · waiting for its turn",
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
    expect(stagesOf(job(reading, 0))[0]).toEqual(["Read every slide", "running", "slides 1–3"]);
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
    expect(document!.stages[0]).toMatchObject({ label: "Read every slide", state: "running" });
    expect(document!.problem).toBeNull();
    expect(document!.activity.map((item) => [item.title, item.status, item.retried])).toEqual([
      ["Plan the topics", "done", true],
      ["Read slides 1–3", "running", false],
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

describe("study progress", () => {
  const study = (view: JobView) => studyDocuments(view, () => "Lecture 1 Graphs")[0]!;

  it("is one line and one bar, with reading the pages filling most of it", () => {
    expect(studyProgress(study(job([], 0)))).toEqual({ phase: "Starting", fraction: 0 });
    const reading = [
      ...base,
      node("prep", "doc", "prepare", "done"),
      node("brief", "doc", "brief", "done"),
      node("reader", "doc", "reader", "running", { pages: [3] }),
    ];
    const halfway = studyProgress(study(job(reading, 2)));
    expect(halfway.phase).toBe("Reading the slides");
    expect(halfway.fraction).toBeCloseTo(0.275);
    const writing = [
      ...base,
      node("prep", "doc", "prepare", "done"),
      node("brief", "doc", "brief", "done"),
      node("reader", "doc", "reader", "done", { pages: [1, 2, 3, 4] }),
      node("author", "doc", "author", "running"),
    ];
    expect(studyProgress(study(job(writing, 4)))).toEqual({
      phase: "Writing the study notes",
      fraction: 0.7,
    });
  });
});

describe("fixing what the check found", () => {
  const study = (view: JobView) => studyDocuments(view, () => "Lecture 1 Graphs")[0]!;
  const read = [
    node("prep", "doc", "prepare", "done"),
    node("brief", "doc", "brief", "done"),
    node("reader", "doc", "reader", "done", { pages: [1, 2, 3, 4] }),
  ];
  const fix = (view: JobView) =>
    study(view).stages.find((stage) => stage.label === "Fix what the check found")!;

  it("keeps a revision out of the writing stage and shows it as fixing", () => {
    const fixing = [
      ...base,
      ...read,
      node("author", "doc", "author", "done", { outcome: { topics: 3, sections: 7 } }),
      node("check", "doc", "reviewer", "done", { outcome: { claims: 12, disagreements: 1 } }),
      node("revision", "doc", "author", "running", { attempt: 2 }),
    ];
    const card = study(job(fixing, 4));
    expect(card.stages.map((stage) => [stage.label, stage.state])).toEqual([
      ["Read every slide", "done"],
      ["Look closer where needed", "done"],
      ["Write the study notes", "done"],
      ["Check against the slides", "done"],
      ["Fix what the check found", "running"],
    ]);
    expect(card.stages[3]!.detail).toBe("12 claims checked · 1 questioned");
    expect(studyProgress(card)).toEqual({ phase: "Fixing what the check found", fraction: 0.92 });
  });

  it("says there was nothing to fix, or how many rounds it took, once the document is done", () => {
    const clean = [
      node("run", null, "run", "running"),
      node("doc", "run", "document", "done", { title: "Lecture 1 Graphs" }),
      ...read,
      node("author", "doc", "author", "done"),
      node("check", "doc", "reviewer", "done"),
    ];
    expect(fix(job(clean, 4))).toMatchObject({ state: "done", detail: "Nothing to fix" });
    const fixed = [
      ...clean,
      node("revision", "doc", "author", "done", { attempt: 2 }),
      node("recheck", "doc", "reviewer", "done"),
    ];
    expect(fix(job(fixed, 4))).toMatchObject({ state: "done", detail: "Fixed in 1 round" });
  });

  it("follows fix rounds and their rechecks, and says how much of what was found it fixed", () => {
    const checked = [
      ...base,
      ...read,
      node("author", "doc", "author", "done"),
      node("check", "doc", "reviewer", "done", { outcome: { claims: 20, disagreements: 2 } }),
    ];
    const fixing = [...checked, node("fix1", "doc", "fix", "running", { pages: [2, 3] })];
    expect(fix(job(fixing, 4))).toMatchObject({
      state: "running",
      detail: "Fixing what the check found",
    });
    const rechecking = [
      ...checked,
      node("fix1", "doc", "fix", "done", { outcome: { discrepancies: 3, fixed: 2 } }),
      node("recheck", "doc", "recheck", "running", { pages: [3] }),
    ];
    const card = study(job(rechecking, 4));
    expect(card.stages[3]).toMatchObject({
      state: "done",
      detail: "20 claims checked · 2 questioned",
    });
    // A check that also looked for every region's facts says so, and how much it sent to fixing.
    const covered = rechecking.map((item) =>
      item.id === "check"
        ? { ...item, outcome: { claims: 20, disagreements: 1, regions: 64, discrepancies: 3 } }
        : item,
    );
    expect(study(job(covered, 4)).stages[3]!.detail).toBe(
      "20 claims · 64 regions checked · 3 to fix",
    );
    expect(card.stages[4]).toMatchObject({ state: "running", detail: "Rechecking slide 3" });
    expect(card.activity.map((item) => item.title)).toContain("Recheck slide 3");
    const done = [
      node("run", null, "run", "running"),
      node("doc", "run", "document", "done", {
        title: "Lecture 1 Graphs",
        outcome: { discrepancies: 3, fixed: 3 },
      }),
      ...rechecking.slice(2).map((item) => ({ ...item, status: "done" as const })),
    ];
    expect(fix(job(done, 4))).toMatchObject({ state: "done", detail: "3 of 3 fixed" });
  });
});

describe("topics written side by side", () => {
  const study = (view: JobView) => studyDocuments(view, () => "Lecture 1 Graphs")[0]!;
  const write = (view: JobView) =>
    study(view).stages.find((stage) => stage.label === "Write the study notes")!;
  const planned = [
    ...base,
    node("prep", "doc", "prepare", "done"),
    node("brief", "doc", "brief", "done", { outcome: { topics: 3 } }),
    node("reader", "doc", "reader", "done", { pages: [1, 2] }),
  ];

  it("counts the topics written while the rest are still being written or read", () => {
    const writing = [
      ...planned,
      node("w1", "doc", "author", "done", {
        title: "Topic · Marking",
        outcome: { topics: 1, sections: 3 },
      }),
      node("w2", "doc", "author", "running", { title: "Topic · Automata" }),
    ];
    expect(write(job(writing, 2))).toMatchObject({
      state: "running",
      detail: "1 of 3 topics written",
    });
    // One writer done and the next still waiting for its pages: not done yet.
    const waiting = [
      ...planned,
      node("w1", "doc", "author", "done", {
        title: "Topic · Marking",
        outcome: { topics: 1, sections: 3 },
      }),
    ];
    expect(write(job(waiting, 2))).toMatchObject({
      state: "pending",
      detail: "1 of 3 topics written",
    });
    const written = [
      ...planned,
      ...["Marking", "Automata", "Diagrams"].map((title, index) =>
        node(`w${index}`, "doc", "author", "done", {
          title: `Topic · ${title}`,
          outcome: { topics: 1, sections: 2 },
        }),
      ),
    ];
    expect(write(job(written, 2))).toMatchObject({
      state: "done",
      detail: "3 topics · 6 sections",
    });
  });
});

describe("the activity list", () => {
  const study = (view: JobView) => studyDocuments(view, () => "Lecture 1 Graphs")[0]!;

  it("times each request by itself, and leaves out a step a restart stopped until it runs again", () => {
    const nodes = [
      ...base,
      node("prep", "doc", "prepare", "done"),
      node("brief", "doc", "brief", "done", { outcome: { topics: 3 } }),
      node("reader", "doc", "reader", "done", {
        pages: [3],
        title: "Page 3",
        inputTokens: 900,
        outputTokens: 100,
        startedAt: "2026-10-28T10:00:00.000Z",
        endedAt: "2026-10-28T10:03:00.000Z",
      }),
      // Its close-up ran much later, after a restart; it is its own line.
      node("closer", "reader", "escalation", "done", {
        pages: [3],
        inputTokens: 400,
        outputTokens: 50,
        startedAt: "2026-10-28T10:11:00.000Z",
        endedAt: "2026-10-28T10:11:20.000Z",
      }),
      node("w1", "doc", "author", "stopped", { title: "Topic · Marking", pages: [3] }),
    ];
    const lines = study(job(nodes, 4)).activity;
    expect(lines.map((line) => line.title)).toEqual([
      "Plan the topics",
      "Read slide 3",
      "Look closer at slide 3",
    ]);
    const read = lines[1]!;
    expect([read.end! - read.start!, read.tokens]).toEqual([180_000, 1000]);
    // When the whole study stopped, its stopped steps show.
    const stopped = nodes.map((item) =>
      item.id === "doc" ? { ...item, status: "stopped" as const } : item,
    );
    expect(study(job(stopped, 4)).activity.map((line) => line.title)).toContain("Write Marking");
  });
});

describe("a study that was continued", () => {
  const study = (view: JobView) => studyDocuments(view, () => "Lecture 1 Graphs")[0]!;

  it("treats what failed before it continued as history, and names each fix part", () => {
    const nodes = [
      node("run", null, "run", "running"),
      node("doc", "run", "document", "running", {
        title: "Lecture 1 Graphs",
        startedAt: "2026-10-28T11:00:00.000Z",
      }),
      node("prep", "doc", "prepare", "done"),
      node("reader", "doc", "reader", "done", { pages: [1, 2, 3, 4] }),
      node("author", "doc", "author", "done"),
      node("check", "doc", "reviewer", "done"),
      node("fix", "doc", "fix", "failed", {
        title: "Fix · round 1",
        pages: [1, 2, 3, 4],
        note: "OpenAI Responses stream ended before a terminal response event",
        startedAt: "2026-10-28T10:30:00.000Z",
        endedAt: "2026-10-28T10:45:00.000Z",
      }),
      node("part1", "doc", "fix", "running", {
        title: "Fix · round 1 · part 1",
        pages: [1, 2],
        startedAt: "2026-10-28T11:00:05.000Z",
        endedAt: null,
      }),
      node("part2", "doc", "fix", "queued", {
        title: "Fix · round 1 · part 2",
        pages: [3, 4],
        startedAt: null,
        endedAt: null,
      }),
    ];
    const card = study(job(nodes, 4));
    expect(card.problem).toBeNull();
    expect(card.stages[4]).toMatchObject({ state: "running" });
    expect(
      card.activity.map((line) => line.title).filter((title) => title.startsWith("Fix")),
    ).toEqual(["Fix what the check found, part 1", "Fix what the check found, part 2"]);
  });
});

describe("a file studied before", () => {
  const study = (view: JobView) => studyDocuments(view, () => "Lecture 1 Graphs")[0]!;

  it("folds the steps it reused into their own kinds of work, marked reused, not finished in 0s", () => {
    const reused = { note: "Reused from an earlier run.", calls: 0 };
    const nodes = [
      ...base,
      node("prep", "doc", "prepare", "done"),
      node("brief", "doc", "brief", "done", { outcome: { topics: 3 } }),
      ...[1, 2, 3, 4].map((page) =>
        node(`r${page}`, "doc", "reader", "done", {
          pages: [page],
          title: `Page ${page}`,
          ...reused,
        }),
      ),
      node("closer", "r3", "escalation", "done", { pages: [3], ...reused }),
      node("w1", "doc", "author", "done", { title: "Topic · Marking", pages: [1, 2] }),
      node("w2", "doc", "author", "running", { title: "Topic · Automata", pages: [3] }),
    ];
    const card = study(job(nodes, 4));
    expect(
      card.activityGroups.map((group) => [group.title, group.detail, group.status, group.reused]),
    ).toEqual([
      ["Plan the topics", "", "done", false],
      ["Read the slides", "4 slides", "done", true],
      ["Look closer", "1 slide", "done", true],
      ["Write the topics", "1 of 3 topics", "running", false],
    ]);
    expect(card.activityGroups[1]!.items.map((item) => item.title)).toEqual([
      "Read slide 1",
      "Read slide 2",
      "Read slide 3",
      "Read slide 4",
    ]);
    expect(card.stages[0]).toMatchObject({
      state: "done",
      detail: "4 of 4 slides · from an earlier study",
    });
  });
});
