import { describe, expect, it, vi } from "vitest";
import {
  EXIT,
  afterRefusal,
  merge,
  failedChecks,
  findNumber,
  noSuchPull,
  failedSteps,
  parseArgs,
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
  REVIEW_APP,
  ROUNDS,
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
// Only something to fix fails; the owner's lane is neutral; only waiting for the review is pending.
const CONCLUSION = { fix: "failure", merge: "success", owner: "neutral", wait: null } as const;
const gate = (lane: Lane, title = "the gate's title") =>
  check(GATE_CHECK, CONCLUSION[lane], { title, app: REVIEW_APP });
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

  it("doesn't count a gate GitHub Actions' token wrote, as a pull request's own workflow could", () => {
    const forged = check(GATE_CHECK, "success", { title: "Reviewed, nothing serious open" });
    expect(readShip(pull(), [check("CI", "success"), forged], null, note("merge"))).toEqual({
      done: false,
      waitingFor: "the review gate on aaaaaaa",
    });
  });

  const clean = buildVerdict(null, { summary: "", earlier: [], findings: [] }, HEAD, null);

  it("passes once CI and the gate both passed", () => {
    expect(
      readShip(pull(), [check("CI", "success"), gate("merge")], clean, note("merge")),
    ).toMatchObject({ done: true, outcome: "done" });
  });

  it("waits to read the verdict of a pass, rather than merging past notes it couldn't see", () => {
    const passed = [check("CI", "success"), gate("merge")];
    const waiting = { done: false, waitingFor: "the review's verdict on aaaaaaa" };
    expect(readShip(pull(), passed, null, note("merge"))).toEqual(waiting);
    const older = buildVerdict(
      null,
      { summary: "", earlier: [], findings: [] },
      "d".repeat(40),
      null,
    );
    expect(readShip(pull(), passed, older, note("merge"))).toEqual(waiting);
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
      [
        check("CI", "success"),
        gate("owner", "Reviewed, nothing serious: the owner merges this one"),
      ],
      null,
      note("owner"),
    );
    expect(step).toMatchObject({ done: true, outcome: "owner" });
    const said = step.done ? step.lines.join("\n") : "";
    expect(said).toContain("the owner merges it with GitHub's merge button");
    expect(said).toContain("don't turn auto-merge on");
  });

  describe("the review's notes", () => {
    const naming = {
      title: "Rename run to start",
      file: "src/jobs/run.ts",
      line: 3,
      serious: false,
      why: "It reads better.",
    };
    const withNotes = buildVerdict(
      null,
      { summary: "", earlier: [], findings: [naming] },
      HEAD,
      null,
    );
    const passed = [check("CI", "success"), gate("merge")];

    it("hold a pass until they're fixed or answered, without merging", () => {
      const step = readShip(pull(), passed, withNotes, note("merge"));
      expect(step).toMatchObject({ done: true, outcome: "fix" });
      const text = step.done ? step.lines.join("\n") : "";
      expect(text).toContain("Rename run to start (src/jobs/run.ts:3). It reads better.");
      expect(text).toContain("--notes-answered aaaaaaa");
      expect(text).toContain("Don't change correct code");
    });

    it("let it go once answered, for the review of that commit only", () => {
      expect(readShip(pull(), passed, withNotes, note("merge"), "aaaaaaa")).toMatchObject({
        done: true,
        outcome: "done",
      });
      expect(readShip(pull(), passed, withNotes, note("merge"), "bbbbbbb")).toMatchObject({
        outcome: "fix",
      });
      // Too short to name one commit.
      expect(readShip(pull(), passed, withNotes, note("merge"), "aaa")).toMatchObject({
        outcome: "fix",
      });
    });

    it("come before the owner's merge too", () => {
      expect(
        readShip(pull(), [check("CI", "success"), gate("owner")], withNotes, note("owner")),
      ).toMatchObject({
        outcome: "fix",
      });
    });

    it("stop holding it after the last round, and are listed as left open", () => {
      const last = { ...withNotes, round: ROUNDS };
      const step = readShip(pull(), passed, last, note("merge"));
      expect(step).toMatchObject({ done: true, outcome: "done" });
      expect(step.done && step.lines.join("\n")).toContain("left open after 3 rounds");
      const owners = readShip(pull(), [check("CI", "success"), gate("owner")], last, note("owner"));
      expect(owners).toMatchObject({ done: true, outcome: "owner" });
      expect(owners.done && owners.lines.join("\n")).toContain("left open after 3 rounds");
    });
  });

  describe("its arguments", () => {
    it("take a pull request, --minutes and --notes-answered", () => {
      expect(parseArgs(["ship"])).toEqual({ name: "ship", minutes: 60 });
      expect(parseArgs(["ship", "38", "--minutes", "5", "--notes-answered", "77d2814"])).toEqual({
        name: "ship",
        pr: "38",
        minutes: 5,
        answered: "77d2814",
      });
      expect(parseArgs(["land", "38"])).toEqual({ name: "land", pr: "38", minutes: 60 });
    });

    it("refuse what they can't use, so the usage is printed", () => {
      for (const args of [
        [],
        ["deploy"],
        ["ship", "1", "2"],
        ["ship", "--minutes", "0"],
        ["ship", "--notes-answered"],
        ["ship", "--notes-answered", "77d"],
        ["land", "38", "--notes-answered", "77d2814"],
      ])
        expect(parseArgs(args), args.join(" ")).toBeNull();
    });
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

  it("prints a step that failed while its job is still running, once", () => {
    const seen = new Set<string>();
    const windows = {
      name: "Windows: tests and Folio in a real window",
      status: "in_progress",
      steps: [
        { name: "Electron", conclusion: "success" },
        { name: "Tests", conclusion: "failure" },
        { name: "Folio in a real window", conclusion: null },
      ],
    };
    expect(failedSteps(seen, [windows])).toEqual([
      '✗ Windows: tests and Folio in a real window: its "Tests" step failed, though the job is still running',
    ]);
    expect(failedSteps(seen, [windows])).toEqual([]);
    // Once the job ends, its own check says it failed.
    expect(failedSteps(new Set(), [{ ...windows, status: "completed" }])).toEqual([]);
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

  // Auto-merge would merge later, on whatever the gate says by then: a pull request that moves to
  // the owner's lane afterwards passes as neutral, and nothing would hold it for the owner.
  it("merges at once, pinned to the commit that passed, and never through auto-merge", async () => {
    const calls: string[][] = [];
    await merge(7, HEAD, async (args) => void calls.push(args));
    // Pinned, so a push in between is refused instead of merged.
    expect(calls).toEqual([["pr", "merge", "7", "--squash", "--match-head-commit", HEAD]]);
    expect(calls.flat()).not.toContain("--auto");
    expect(calls.flat()).not.toContain("--admin");
    const refuses = async () => {
      throw new Error("Pull request is not mergeable");
    };
    await expect(merge(7, HEAD, refuses)).rejects.toThrow("not mergeable");
  });

  it("tries a refused merge again twice, then tells the owner why", () => {
    const waiting = { done: false, waitingFor: "GitHub to let it merge" };
    expect(afterRefusal(7, 1, "Required status check is expected")).toEqual(waiting);
    expect(afterRefusal(7, 2, "Required status check is expected")).toEqual(waiting);
    expect(afterRefusal(7, 3, "Pull request is not mergeable")).toEqual({
      done: true,
      outcome: "owner",
      lines: [
        "GitHub refused to merge #7: Pull request is not mergeable",
        "Tell the owner in one line, then stop.",
      ],
    });
  });

  it("fails at once on a pull request that doesn't exist, and asks again while GitHub doesn't answer", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const pauses: number[] = [];
    const pause = async (ms: number) => void pauses.push(ms);
    let asked = 0;
    const flaky = async () => {
      if (++asked < 3) throw new Error("error connecting to api.github.com");
      return { number: 45 };
    };
    expect(await findNumber(flaky, pause)).toEqual({ number: "45" });
    expect(pauses).toHaveLength(2);

    const missing = async () => {
      throw new Error("GraphQL: Could not resolve to a PullRequest with the number of 999.");
    };
    expect(await findNumber(missing, pause)).toMatchObject({ outcome: "fix" });
    expect(noSuchPull('no pull requests found for branch "fix"')).toBe(true);
    expect(noSuchPull("HTTP 502: Bad Gateway")).toBe(false);

    pauses.length = 0;
    const down = async () => {
      throw new Error("error connecting to api.github.com");
    };
    expect(await findNumber(down, pause)).toMatchObject({ outcome: "github" });
    expect(pauses).toHaveLength(9);
    log.mockRestore();
  });

  it("gives each outcome its own exit code", () => {
    expect(new Set(Object.values(EXIT)).size).toBe(Object.keys(EXIT).length);
  });
});
