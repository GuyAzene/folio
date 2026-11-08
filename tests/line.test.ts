import { describe, expect, it } from "vitest";
import {
  EXIT,
  arm,
  failedChecks,
  progress,
  readLand,
  readShip,
  type Check,
  type Pull,
  type Run,
} from "../scripts/line.ts";
import {
  ACTIONS_APP,
  GATE_CHECK,
  buildVerdict,
  type GateNote,
  type Lane,
} from "../scripts/review-gate.ts";

const HEAD = "a".repeat(40);
const MERGED = "c".repeat(40);

const pull = (overrides: Partial<Pull> = {}): Pull => ({
  number: 7,
  state: "OPEN",
  draft: false,
  head: HEAD,
  autoMerge: false,
  mergeCommit: null,
  ...overrides,
});
const check = (name: string, conclusion: string | null, overrides: Partial<Check> = {}): Check => ({
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  app: ACTIONS_APP,
  ...overrides,
});
const note = (lane: Lane, reviewed = HEAD): GateNote => ({ version: 1, lane, reviewed });
const gate = (lane: Lane, title = "the gate's title") =>
  check(GATE_CHECK, lane === "wait" ? null : lane === "merge" ? "success" : "failure", { title });
const bug = {
  title: "Cancel leaves the job running",
  file: "src/jobs/run.ts",
  line: 12,
  serious: true,
  why: "It never stops.",
};

describe("ship", () => {
  it("waits for CI, then for the review, on the newest commit", () => {
    expect(readShip(pull(), [check("CI", null), gate("merge")], null, note("merge"))).toEqual({
      done: false,
      waitingFor: "CI",
    });
    expect(readShip(pull(), [check("CI", "success"), gate("wait")], null, note("wait"))).toEqual({
      done: false,
      waitingFor: "the review of aaaaaaa",
    });
    expect(readShip(pull(), [check("CI", "success")], null, null)).toEqual({
      done: false,
      waitingFor: "the review gate on aaaaaaa",
    });
  });

  it("doesn't count a check another app made under the same name", () => {
    const forged = check("CI", "success", { app: 1 });
    expect(readShip(pull(), [forged, gate("merge")], null, note("merge"))).toMatchObject({
      done: false,
      waitingFor: "CI",
    });
  });

  it("passes once CI and the gate both passed", () => {
    expect(
      readShip(
        pull({ autoMerge: true }),
        [check("CI", "success"), gate("merge")],
        null,
        note("merge"),
      ),
    ).toMatchObject({ done: true, outcome: "done" });
  });

  it("lists the serious findings to fix, with where they are", () => {
    const verdict = buildVerdict(null, { summary: "", earlier: [], findings: [bug] }, HEAD, null);
    const step = readShip(pull(), [check("CI", "success"), gate("fix")], verdict, note("fix"));
    expect(step).toMatchObject({ done: true, outcome: "fix" });
    expect(step.done && step.lines.join("\n")).toContain(
      "F1 (src/jobs/run.ts:12): Cancel leaves the job running. It never stops.",
    );
  });

  it("sends a failed CI back to be fixed, naming the jobs, even when the review passed", () => {
    const checks = [
      check("CI", "failure"),
      check("macOS: packaged app", "failure"),
      check("Linux: checks, tests and build", "success"),
      gate("merge"),
    ];
    const step = readShip(pull(), checks, null, note("merge"));
    expect(step).toMatchObject({ done: true, outcome: "fix" });
    expect(step.done && step.lines[1]).toContain("CI failure: macOS: packaged app: failure");
    expect(step.done && step.lines.join("\n")).toContain("never re-run a check");
  });

  it("leaves to the owner what the gate leaves to the owner", () => {
    const step = readShip(
      pull(),
      [check("CI", "success"), gate("owner", "Reviewed, nothing serious: waits for the owner")],
      null,
      note("owner"),
    );
    expect(step).toMatchObject({ done: true, outcome: "owner" });
    expect(step.done && step.lines.join("\n")).toContain("don't turn auto-merge on");
  });

  it("says what to do with a draft, a merged and a closed pull request", () => {
    expect(readShip(pull({ draft: true }), [], null, null)).toMatchObject({ outcome: "fix" });
    expect(readShip(pull({ state: "MERGED" }), [], null, null)).toMatchObject({ outcome: "done" });
    expect(readShip(pull({ state: "CLOSED" }), [], null, null)).toMatchObject({ outcome: "owner" });
  });
});

describe("land", () => {
  const run = (overrides: Partial<Run> = {}): Run => ({
    id: 1,
    head: MERGED,
    status: "completed",
    conclusion: "success",
    ...overrides,
  });
  const merged = pull({ state: "MERGED", mergeCommit: MERGED });

  it("waits for the merge, then for every job of main's CI", () => {
    expect(readLand(pull(), null, [])).toMatchObject({ done: false, waitingFor: "#7 to merge" });
    expect(readLand(merged, null, [])).toMatchObject({ done: false });
    expect(readLand(merged, run({ status: "in_progress", conclusion: null }), [])).toMatchObject({
      done: false,
      waitingFor: "main's CI on ccccccc",
    });
  });

  it("is done when main is green, and stops the line when it isn't", () => {
    expect(readLand(merged, run(), [])).toMatchObject({ done: true, outcome: "done" });
    const red = readLand(merged, run({ conclusion: "failure" }), ["Nightly build: failure"]);
    expect(red).toMatchObject({ done: true, outcome: "fix" });
    expect(red.done && red.lines.join("\n")).toContain("Fixing main comes before anything else");
  });

  it("says nothing landed when the pull request was closed", () => {
    expect(readLand(pull({ state: "CLOSED" }), null, [])).toMatchObject({ outcome: "owner" });
  });
});

describe("what the waits print", () => {
  it("prints each check once, when it finishes", () => {
    const seen = new Map<string, string>();
    expect(progress(seen, [check("CI", null), check("What changed", "success")])).toEqual([
      "✓ What changed",
    ]);
    expect(progress(seen, [check("CI", "failure"), check("What changed", "success")])).toEqual([
      "✗ CI: failure",
    ]);
    expect(progress(seen, [check("CI", "failure")])).toEqual([]);
  });

  it("prints what the review gate says", () => {
    expect(progress(new Map(), [gate("fix", "1 serious finding open")])).toEqual([
      "✗ Review gate: 1 serious finding open",
    ]);
  });

  it("leaves the summary checks out of the failed jobs", () => {
    expect(
      failedChecks([
        check("CI", "failure"),
        check("Windows: packaged app", "timed_out"),
        gate("fix"),
      ]),
    ).toEqual(["Windows: packaged app: timed_out"]);
  });

  it("has GitHub merge through auto-merge, or at once only when its rules already allow it", async () => {
    const calls: string[][] = [];
    const queues = async (args: string[]) => void calls.push(args);
    expect(await arm(7, queues)).toBe("queued");
    expect(calls).toEqual([["pr", "merge", "7", "--auto", "--squash"]]);

    calls.length = 0;
    const clean = async (args: string[]) => {
      calls.push(args);
      if (args.includes("--auto")) throw new Error("Pull request is in clean status");
    };
    expect(await arm(7, clean)).toBe("merged");
    expect(calls.at(-1)).toEqual(["pr", "merge", "7", "--squash"]);
    expect(calls.flat()).not.toContain("--admin");

    calls.length = 0;
    const refuses = async (args: string[]) => {
      calls.push(args);
      throw new Error("Auto merge is not allowed for this repository");
    };
    await expect(arm(7, refuses)).rejects.toThrow("not allowed");
    expect(calls).toHaveLength(1);
  });

  it("gives each outcome its own exit code", () => {
    expect(new Set(Object.values(EXIT)).size).toBe(Object.keys(EXIT).length);
  });
});
