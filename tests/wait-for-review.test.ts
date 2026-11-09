import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ROUNDS, buildVerdict, type Review } from "../scripts/review.ts";
import {
  EXIT,
  failedChecks,
  failedSteps,
  findNumber,
  noSuchPull,
  parseArgs,
  progress,
  readRound,
  type Check,
  type Pull,
} from "../scripts/wait-for-review.ts";

const HEAD = "a".repeat(40);
const EARLIER = "b".repeat(40);

const pull = (overrides: Partial<Pull> = {}): Pull => ({
  number: 7,
  state: "OPEN",
  draft: false,
  head: HEAD,
  ...overrides,
});
const check = (name: string, conclusion: string | null): Check => ({
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
});
const passed = [
  check("What changed", "success"),
  check("Linux", "success"),
  check("CI", "success"),
];
const bug = {
  title: "Cancel leaves the job running",
  file: "src/jobs/run.ts",
  line: 12,
  serious: true,
  why: "It never stops.",
};
const naming = {
  title: "Rename run to start",
  file: "src/jobs/run.ts",
  line: 3,
  serious: false,
  why: "It reads better.",
};
const verdict = (findings: Review["findings"] = [], sha = HEAD) =>
  buildVerdict(null, { summary: "", earlier: [], findings }, sha, null);
const said = (step: ReturnType<typeof readRound>) => (step.done ? step.lines.join("\n") : "");

describe("a round", () => {
  it("waits for the checks to start, then for each to finish, then for the review", () => {
    expect(readRound(pull(), [], HEAD, null)).toEqual({
      done: false,
      waitingFor: "the checks on aaaaaaa",
    });
    expect(readRound(pull(), [check("Linux", null), check("CI", null)], HEAD, verdict())).toEqual({
      done: false,
      waitingFor: "2 checks, Linux among them",
    });
    expect(
      readRound(pull(), [...passed, check("macOS: packaged app", null)], HEAD, verdict()),
    ).toEqual({
      done: false,
      waitingFor: "macOS: packaged app",
    });
    expect(readRound(pull(), passed, HEAD, null)).toEqual({
      done: false,
      waitingFor: "Claude's review of aaaaaaa",
    });
  });

  it("is done when every check passed and nothing serious is open, and says to hand over the link", () => {
    const step = readRound(pull(), passed, HEAD, verdict());
    expect(step).toMatchObject({ done: true, outcome: "done" });
    expect(said(step)).toContain(
      "passed every check, and the review (round 1 of 3) left nothing serious open",
    );
    expect(said(step)).toContain("Hand the owner the pull request's link.");
  });

  it("lists the notes to fix or answer, without holding the round", () => {
    const step = readRound(pull(), passed, HEAD, verdict([naming]));
    expect(step).toMatchObject({ done: true, outcome: "done" });
    expect(said(step)).toContain("- Rename run to start (src/jobs/run.ts:3). It reads better.");
    expect(said(step)).toContain("answer the rest on the pull request");
    expect(said(step)).toContain("If you push a fix, wait again.");
  });

  it("sends serious findings back to be fixed, with where they are", () => {
    const step = readRound(pull(), passed, HEAD, verdict([bug]));
    expect(step).toMatchObject({ done: true, outcome: "fix" });
    expect(said(step)).toContain(
      "- F1 (src/jobs/run.ts:12): Cancel leaves the job running. It never stops.",
    );
    expect(said(step)).toContain("push, and wait again");
  });

  it("sends failed checks back to be fixed, naming them, even when the review is clean", () => {
    const checks = [
      check("Linux", "success"),
      check("macOS: packaged app", "failure"),
      check("CI", "failure"),
    ];
    const step = readRound(pull(), checks, HEAD, verdict());
    expect(step).toMatchObject({ done: true, outcome: "fix" });
    expect(said(step)).toContain("- macOS: packaged app: failure.");
    expect(said(step)).toContain("never re-run a check");
  });

  it("says so on the last round", () => {
    let last = verdict([bug]);
    for (let round = 1; round < ROUNDS; round++)
      last = buildVerdict(last, { summary: "", earlier: [], findings: [] }, HEAD, null);
    expect(said(readRound(pull(), passed, HEAD, last))).toContain(
      "That was the last round: report what's left, and stop.",
    );
  });

  it("is stuck when the review couldn't run, and says how to start it once more", () => {
    const step = readRound(pull(), passed, HEAD, {
      version: 1,
      sha: HEAD,
      failed: "was stopped before it finished",
    });
    expect(step).toMatchObject({ done: true, outcome: "stuck" });
    expect(said(step)).toContain("gh workflow run review.yml -f pr=7");
  });

  it("counts the review of the commit before CI's pictures, on the pictures' checks", () => {
    const step = readRound(pull({ head: HEAD }), passed, EARLIER, verdict([], EARLIER));
    expect(step).toMatchObject({ done: true, outcome: "done" });
  });

  it("says what to do with a draft, a merged and a closed pull request", () => {
    expect(readRound(pull({ draft: true }), [], HEAD, null)).toMatchObject({ outcome: "fix" });
    const merged = readRound(pull({ state: "MERGED" }), [], HEAD, null);
    expect(merged).toMatchObject({ outcome: "done" });
    expect(said(merged)).toContain("Remove its worktree and branch");
    expect(readRound(pull({ state: "CLOSED" }), [], HEAD, null)).toMatchObject({
      outcome: "stuck",
    });
  });
});

describe("what the wait prints", () => {
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

  it("names the jobs that failed rather than CI's summary, unless the summary is all there is", () => {
    expect(
      failedChecks([
        check("CI", "failure"),
        check("Windows: packaged app", "timed_out"),
        check("Linux", "success"),
      ]),
    ).toEqual(["Windows: packaged app: timed_out"]);
    expect(failedChecks([check("CI", "failure")])).toEqual(["CI: failure"]);
  });
});

describe("the wait's command line", () => {
  it("takes a pull request and --minutes", () => {
    expect(parseArgs([])).toEqual({ minutes: 30 });
    expect(parseArgs(["38", "--minutes", "5"])).toEqual({ pr: "38", minutes: 5 });
  });

  it("refuses what it can't use, so the usage is printed", () => {
    for (const args of [
      ["1", "2"],
      ["--minutes", "0"],
      ["--minutes"],
      ["--notes-answered", "77d2814"],
    ])
      expect(parseArgs(args), args.join(" ")).toBeNull();
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
    expect(await findNumber(down, pause)).toMatchObject({ outcome: "stuck" });
    expect(pauses).toHaveLength(9);
    log.mockRestore();
  });

  it("gives each outcome its own exit code", () => {
    expect(new Set(Object.values(EXIT)).size).toBe(Object.keys(EXIT).length);
  });

  // Agents don't merge unless the owner says so, and the wait only reads.
  it("only reads from GitHub: it never merges, comments or starts a run", () => {
    const source = readFileSync("scripts/wait-for-review.ts", "utf8");
    for (const write of ['"merge"', '"comment"', '"workflow", "run"', "--method", '"-X"', '"POST"'])
      expect(source, write).not.toContain(write);
  });
});
