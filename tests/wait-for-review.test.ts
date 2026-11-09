import { describe, expect, it, vi } from "vitest";
import {
  ROUNDS,
  buildVerdict,
  renderComment,
  renderFailure,
  REVIEWER,
  type Review,
} from "../scripts/review.ts";
import {
  EXIT,
  failedChecks,
  failedSteps,
  findNumber,
  noSuchPull,
  parseArgs,
  progress,
  fromView,
  isDependabot,
  readOnly,
  readRound,
  watcher,
  type Check,
  type GitHub,
  type Pull,
} from "../scripts/wait-for-review.ts";

const HEAD = "a".repeat(40);
const EARLIER = "b".repeat(40);
const PICTURES = "c".repeat(40);

const pull = (overrides: Partial<Pull> = {}): Pull => ({
  number: 7,
  state: "OPEN",
  draft: false,
  head: HEAD,
  reviewable: true,
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
const review = (findings: Review["findings"] = []): Review => ({
  summary: "",
  earlier: [],
  findings,
});
const verdict = (findings: Review["findings"] = [], sha = HEAD) =>
  buildVerdict(null, review(findings), sha, null);
const failure = { version: 1, sha: HEAD, failed: "was stopped before it finished" } as const;
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
    ).toEqual({ done: false, waitingFor: "macOS: packaged app" });
    expect(readRound(pull(), passed, HEAD, null)).toEqual({
      done: false,
      waitingFor: "Claude's review of aaaaaaa",
    });
  });

  // A job that waits on others may have no check yet while every visible check has finished.
  it("waits for CI's own check, which main requires, even when every other check finished", () => {
    expect(readRound(pull(), [check("Linux", "success")], HEAD, verdict())).toEqual({
      done: false,
      waitingFor: "CI",
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
    for (let round = 1; round < ROUNDS; round++) last = buildVerdict(last, review(), HEAD, null);
    expect(said(readRound(pull(), passed, HEAD, last))).toContain(
      "That was the last round: report what's left, and stop.",
    );
  });

  it("is stuck when the review couldn't run, and says how to start it once more", () => {
    const step = readRound(pull(), passed, HEAD, failure);
    expect(step).toMatchObject({ done: true, outcome: "stuck" });
    expect(said(step)).toContain("gh workflow run review.yml -f pr=7");
  });

  // The failure stays on the pull request until the retry posts, so a wait started right after
  // the retry would otherwise stop on the old one.
  it("waits out a review that couldn't run while a Review run is under way, as the retry may be", () => {
    expect(readRound(pull(), passed, HEAD, failure, true)).toEqual({
      done: false,
      waitingFor: "the Review run under way",
    });
  });

  it("finishes on the checks alone for a pull request Claude doesn't review", () => {
    const step = readRound(pull({ reviewable: false }), passed, HEAD, null);
    expect(step).toMatchObject({ done: true, outcome: "done" });
    expect(said(step)).toContain("Claude doesn't review a fork's or Dependabot's pull request");
    const failing = [check("Linux", "failure"), check("CI", "failure")];
    expect(readRound(pull({ reviewable: false }), failing, HEAD, null)).toMatchObject({
      outcome: "fix",
    });
  });

  it("counts the review of the commit before CI's pictures, on the pictures' checks", () => {
    const step = readRound(pull({ head: PICTURES }), passed, EARLIER, verdict([], EARLIER));
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

// The wait's looks against a GitHub of their own, as it repeats them.
const fakeGitHub = () => {
  const state = {
    pr: pull(),
    commits: [EARLIER, HEAD],
    files: {
      [EARLIER]: { files: [{ filename: "src/x.ts" }], parents: [{ sha: "d".repeat(40) }] },
      [HEAD]: { files: [{ filename: "src/y.ts" }], parents: [{ sha: EARLIER }] },
      [PICTURES]: { files: [{ filename: "docs/images/hero.webp" }], parents: [{ sha: HEAD }] },
    } as Record<string, Awaited<ReturnType<GitHub["commit"]>>>,
    checks: passed,
    comments: [] as { user: { login: string }; body: string }[],
    reviewing: false,
    local: HEAD,
  };
  const github: GitHub = {
    pull: async () => state.pr,
    checks: async () => state.checks,
    jobs: async () => [],
    commits: async () => state.commits,
    commit: async (sha) => state.files[sha]!,
    comments: async () => state.comments,
    reviewing: async () => state.reviewing,
    localHead: async () => state.local,
  };
  const reviewed = (findings: Review["findings"], sha = HEAD) =>
    state.comments.push({
      user: { login: REVIEWER },
      body: renderComment(verdict(findings, sha), review(findings)),
    });
  return { state, github, reviewed };
};

describe("the wait's looks", () => {
  it("say which pull request and commit they wait on, then each check as it finishes", async () => {
    const { state, github } = fakeGitHub();
    state.checks = [check("Linux", null), check("CI", null)];
    const lines: string[] = [];
    const look = watcher(github, "7", (line) => lines.push(line));
    expect(await look()).toMatchObject({ done: false });
    state.checks = [check("Linux", "success"), check("CI", null)];
    await look();
    expect(lines).toEqual(["Waiting on #7 at aaaaaaa.", "✓ Linux"]);
  });

  it("follow a new commit, and count the review of the commit before CI's pictures", async () => {
    const { state, github, reviewed } = fakeGitHub();
    reviewed([]);
    const lines: string[] = [];
    const look = watcher(github, "7", (line) => lines.push(line));
    expect(await look()).toMatchObject({ outcome: "done" });
    state.pr = pull({ head: PICTURES });
    state.commits = [EARLIER, HEAD, PICTURES];
    expect(await look()).toMatchObject({ done: true, outcome: "done" });
    expect(lines).toContain("A new commit is on the branch: ccccccc.");
    expect(lines).toContain("Pull it before pushing again.");
  });

  it("don't count the review of an older commit once a new one with changes is pushed", async () => {
    const { state, github, reviewed } = fakeGitHub();
    reviewed([], EARLIER);
    state.local = HEAD;
    const lines: string[] = [];
    const step = await watcher(github, "7", (line) => lines.push(line))();
    expect(step).toEqual({ done: false, waitingFor: "Claude's review of aaaaaaa" });
    expect(lines).not.toContain("Pull it before pushing again.");
  });

  it("wait out a review that couldn't run while the retry runs, then take the retry's review", async () => {
    const { state, github, reviewed } = fakeGitHub();
    state.comments.push({ user: { login: REVIEWER }, body: renderFailure(7, HEAD, "x") });
    state.reviewing = true;
    const look = watcher(github, "7", () => {});
    expect(await look()).toEqual({ done: false, waitingFor: "the Review run under way" });
    reviewed([bug]);
    expect(await look()).toMatchObject({ done: true, outcome: "fix" });
  });

  // A retry started a moment ago may not be listed yet, so the first look gives it time.
  it("stop on a review that couldn't run once a second look still finds no Review run", async () => {
    const { state, github } = fakeGitHub();
    state.comments.push({ user: { login: REVIEWER }, body: renderFailure(7, HEAD, "x") });
    const look = watcher(github, "7", () => {});
    expect(await look()).toEqual({
      done: false,
      waitingFor: "a moment, in case the review was just started again",
    });
    expect(await look()).toMatchObject({ outcome: "stuck" });
  });

  it("ask GitHub about this pull request's own Review runs", async () => {
    const { state, github } = fakeGitHub();
    state.comments.push({ user: { login: REVIEWER }, body: renderFailure(7, HEAD, "x") });
    const asked: number[] = [];
    github.reviewing = async (number) => {
      asked.push(number);
      return false;
    };
    await watcher(github, "7", () => {})();
    expect(asked).toEqual([7]);
  });

  it("work out the commit to review again when a look failed half way", async () => {
    const { state, github, reviewed } = fakeGitHub();
    reviewed([]);
    let fail = true;
    const commits = github.commits;
    github.commits = async (number) => {
      if (fail) throw new Error("HTTP 502");
      return commits(number);
    };
    const look = watcher(github, "7", () => {});
    await expect(look()).rejects.toThrow("HTTP 502");
    fail = false;
    state.checks = passed;
    expect(await look()).toMatchObject({ outcome: "done" });
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
  it("takes a pull request and --minutes, an hour by default", () => {
    expect(parseArgs([])).toEqual({ minutes: 60 });
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
});

// Agents don't merge unless the owner says so. The wait's gh refuses every command but these.
describe("what gh says about a pull request", () => {
  const view = {
    number: 7,
    state: "OPEN" as const,
    isDraft: false,
    headRefOid: HEAD,
    isCrossRepository: false,
    author: { login: "someone" },
  };

  it("is read as the pull request the wait follows", () => {
    expect(fromView(view)).toEqual(pull());
    expect(fromView({ ...view, isDraft: true, state: "MERGED" })).toMatchObject({
      draft: true,
      state: "MERGED",
    });
  });

  // gh names an app's pull request "app/dependabot"; GitHub's REST API, as review.ts reads it,
  // "dependabot[bot]". Either way, Claude doesn't review it, so the wait mustn't wait for that.
  it("marks Dependabot's and a fork's pull requests as ones Claude doesn't review", () => {
    for (const login of ["app/dependabot", "dependabot[bot]", "dependabot"]) {
      expect(isDependabot(login), login).toBe(true);
      expect(fromView({ ...view, author: { login } }).reviewable, login).toBe(false);
    }
    expect(isDependabot("dependabot-fan")).toBe(false);
    expect(fromView({ ...view, isCrossRepository: true }).reviewable).toBe(false);
  });
});

describe("the wait's gh", () => {
  it("runs what only reads: pr view, and api with no method or fields", () => {
    for (const args of [
      ["pr", "view", "7", "--json", "number,state"],
      ["api", "repos/{owner}/{repo}/commits/abc/check-runs?filter=latest"],
      ["api", "--paginate", "repos/{owner}/{repo}/issues/7/comments", "--jq", ".[]"],
    ])
      expect(readOnly(args), args.join(" ")).toBe(true);
  });

  it("refuses anything that would change something on GitHub", () => {
    for (const args of [
      ["pr", "merge", "7", "--squash"],
      ["pr", "comment", "7", "--body", "x"],
      ["pr", "ready", "7"],
      ["workflow", "run", "review.yml"],
      ["api", "-X", "POST", "repos/{owner}/{repo}/issues/7/comments"],
      ["api", "--method=PUT", "repos/{owner}/{repo}/pulls/7/merge"],
      ["api", "repos/{owner}/{repo}/issues/7/comments", "-f", "body=x"],
      ["api", "repos/{owner}/{repo}/issues/7/comments", "--raw-field", "body=x"],
      ["api", "graphql", "--input", "query.json"],
    ])
      expect(readOnly(args), args.join(" ")).toBe(false);
  });
});
