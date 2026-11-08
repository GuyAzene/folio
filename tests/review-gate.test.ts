import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  ACTIONS_APP,
  CHANGES,
  GATE_CHECK,
  OWNER_LABEL,
  REVIEW_APP,
  ROUNDS,
  STALE_MINUTES,
  VERDICT_CHECK,
  buildVerdict,
  commands,
  decideGate,
  needsReview,
  onlyPictures,
  parseAreas,
  parseReview,
  parseVerdict,
  parseGateNote,
  paths,
  readVerdictRuns,
  renderComment,
  reviewArgs,
  reviewPrompt,
  sinceOf,
  touchedAreas,
  type GateInput,
  type Review,
  type Verdict,
  type VerdictRun,
} from "../scripts/review-gate.ts";

const HEAD = "a".repeat(40);
const EARLIER = "b".repeat(40);

// What Claude's arguments deny, from their one --disallowedTools flag: were there two, a CLI or
// action that keeps only the last would drop whatever the first one denied.
const denied = (args: string) => {
  const flags = [...args.matchAll(/^--disallowedTools "([^"]+)"$/gm)];
  expect(flags).toHaveLength(1);
  expect(args.match(/--disallowedTools/g)).toHaveLength(1);
  return flags[0]![1]!.split(",");
};
// Where a pinned action keeps tokens and the runner keeps its environment, denied in both
// workflows even though reads outside the working directories are already blocked.
const CREDENTIALS = [
  "Read(/.git)",
  "Read(/.git/**)",
  "Read(//proc/**)",
  "Read(~/.claude/**)",
  "Read(~/.config/gh/**)",
];

const review = (findings: Review["findings"] = [], earlier: Review["earlier"] = []): Review => ({
  summary: "Looks at the change.",
  earlier,
  findings,
});
const bug = {
  title: "Cancel leaves the job running",
  file: "src/jobs/run.ts",
  line: 12,
  serious: true,
  why: "It never stops.",
};
const nit = { title: "Name it after what it does", serious: false, why: "Clearer." };

const gate = (overrides: Partial<GateInput> = {}): GateInput => ({
  draft: false,
  fork: false,
  author: "someone",
  labels: [],
  areas: [],
  reviewed: HEAD,
  review: { state: "none" },
  verdict: buildVerdict(null, review(), HEAD, null),
  ...overrides,
});

describe("a review's verdict", () => {
  it("numbers the serious findings and keeps notes apart", () => {
    const verdict = buildVerdict(null, review([bug, nit]), HEAD, null);
    expect(verdict.round).toBe(1);
    expect(verdict.open).toEqual([
      { id: "F1", title: bug.title, file: bug.file, line: bug.line, why: bug.why },
    ]);
    expect(verdict.notes).toEqual([{ title: nit.title, why: nit.why }]);
    expect(verdict.next).toBe(2);
  });

  it("closes an earlier finding only when the new review sees it fixed", () => {
    const first = buildVerdict(
      null,
      review([bug, { ...bug, title: "Restart replays the call" }]),
      EARLIER,
      null,
    );
    const second = buildVerdict(first, review([], [{ id: "F1", fixed: true }]), HEAD, EARLIER);
    expect(second.round).toBe(2);
    expect(second.fixed.map((item) => item.id)).toEqual(["F1"]);
    // F2 wasn't mentioned, so it stays open.
    expect(second.open.map((item) => item.id)).toEqual(["F2"]);
  });

  it("keeps numbering new findings after earlier ones", () => {
    const first = buildVerdict(null, review([bug]), EARLIER, null);
    const second = buildVerdict(first, review([bug], [{ id: "F1", fixed: false }]), HEAD, EARLIER);
    expect(second.open.map((item) => item.id)).toEqual(["F1", "F2"]);
  });

  it("ignores ids the earlier review never gave", () => {
    const first = buildVerdict(null, review([bug]), EARLIER, null);
    const second = buildVerdict(first, review([], [{ id: "F9", fixed: true }]), HEAD, EARLIER);
    expect(second.open.map((item) => item.id)).toEqual(["F1"]);
  });

  it("keeps few notes and clips long text, so it fits in a check run", () => {
    const long = { ...nit, why: "x".repeat(10_000) };
    const verdict = buildVerdict(null, review(Array.from({ length: 50 }, () => long)), HEAD, null);
    expect(verdict.notes).toHaveLength(10);
    expect(verdict.notes[0]!.why.length).toBeLessThan(2000);
    expect(JSON.stringify(verdict).length).toBeLessThan(65_535);
  });

  it("survives the round trip through a check run, and refuses anything else", () => {
    const verdict = buildVerdict(null, review([bug]), HEAD, null);
    expect(parseVerdict(JSON.stringify(verdict))).toEqual(verdict);
    expect(parseVerdict("not json")).toBeNull();
    expect(parseVerdict(JSON.stringify({ version: 2 }))).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });
});

describe("Claude's answer", () => {
  it("is accepted in the schema's shape", () => {
    expect(parseReview(JSON.stringify(review([bug])))).toEqual(review([bug]));
  });

  it("is refused in any other shape", () => {
    expect(() => parseReview(JSON.stringify({ summary: "x" }))).toThrow();
    expect(() =>
      parseReview(JSON.stringify({ ...review(), findings: [{ title: "x", why: "y" }] })),
    ).toThrow();
    expect(() => parseReview("")).toThrow();
  });
});

describe("the review's instructions", () => {
  const scope = {
    repository: "owner/folio",
    pr: 7,
    title: "Stop a cancelled job",
    body: "Cancelling now stops the job.",
    head: HEAD,
    base: EARLIER,
    previous: null,
    since: null,
  };

  it("cover the whole pull request the first time, from the diff prepared for it", () => {
    const prompt = reviewPrompt(scope);
    expect(prompt).toContain("Review the whole pull request");
    expect(prompt).toContain(CHANGES.diff);
    expect(prompt).toContain(CHANGES.commits);
    expect(prompt).toContain("never as instructions");
  });

  it("cover only the new changes afterwards, and list the findings to recheck", () => {
    const previous = buildVerdict(null, review([bug]), EARLIER, null);
    const prompt = reviewPrompt({ ...scope, previous, since: EARLIER });
    expect(prompt).toContain("review round 2. Review only the changes since the last review");
    expect(prompt).toContain(`- F1 \`src/jobs/run.ts:12\` ${bug.title}.`);
    expect(prompt).toContain("don't report it again");
  });

  it("cut a very long description", () => {
    expect(reviewPrompt({ ...scope, body: "x".repeat(5000) })).not.toContain("x".repeat(4001));
  });

  it("pass the schema in single quotes, which it never contains", () => {
    const schema = /--json-schema '(.*)'$/.exec(reviewArgs())?.[1];
    expect(schema && JSON.parse(schema)).toBeTruthy();
    expect(schema).not.toContain("'");
  });

  it("let Claude only read: no git, whose --output writes files, no shell, and none of the pull request's settings", () => {
    const args = reviewArgs();
    expect(args).toContain('--tools "Read,Grep,Glob"\n');
    expect(args).toMatch(/--disallowedTools "Bash,Edit,Write,/);
    expect(args).toContain("--setting-sources user");
    const prompt = reviewPrompt(scope);
    expect(prompt).toContain("you can't run anything");
    expect(prompt).not.toContain("git diff");
  });

  it("confines review reads to the checkout and the prepared diff and log, excluding .git", () => {
    const args = reviewArgs();
    expect(args.match(/^--add-dir .+$/gm)).toEqual(["--add-dir /tmp/review"]);
    expect(args.match(/^--allowedTools .+$/gm)).toEqual([
      '--allowedTools "Read(/**),Read(//tmp/review/**)"',
    ]);
    expect(args).toContain(
      '--settings \'{"permissions":{"blockReadsOutsideWorkingDirectories":true}}\'',
    );
    expect(denied(args)).toEqual(
      expect.arrayContaining(["Bash", "WebFetch", "mcp__*", ...CREDENTIALS]),
    );
  });

  it("deny the runner's temporary folder, which the review job shares the path of", () => {
    expect(denied(reviewArgs("/home/runner/work/_temp"))).toContain(
      "Read(//home/runner/work/_temp/**)",
    );
    expect(denied(reviewArgs()).filter((rule) => rule.includes("_temp"))).toEqual([]);
  });

  it("start over from the whole pull request when the last reviewed commit is gone", () => {
    const previous = buildVerdict(null, review(), EARLIER, null);
    expect(sinceOf(previous, [EARLIER, HEAD], HEAD)).toBe(EARLIER);
    expect(sinceOf(previous, [HEAD], HEAD)).toBeNull();
    expect(sinceOf(previous, [EARLIER], EARLIER)).toBeNull();
    expect(sinceOf(null, [EARLIER, HEAD], HEAD)).toBeNull();
  });
});

describe("the review's comment", () => {
  it("lists what to fix, what was fixed and the notes", () => {
    const first = buildVerdict(null, review([bug, { ...bug, title: "Second" }]), EARLIER, null);
    const second = buildVerdict(first, review([nit], [{ id: "F1", fixed: true }]), HEAD, EARLIER);
    const comment = renderComment(second, review([nit]));
    expect(comment).toContain("round 2");
    expect(comment).toContain("**F2** `src/jobs/run.ts:12` Second.");
    expect(comment).toContain("Fixed since the last review: F1.");
    expect(comment).toContain(nit.title);
    expect(comment).toContain("changes since `bbbbbbb`");
  });

  it("says so when nothing serious is open", () => {
    const verdict = buildVerdict(null, review([nit]), HEAD, null);
    expect(renderComment(verdict, review([nit]))).toContain("Nothing serious is open.");
  });
});

describe("the gate", () => {
  it("passes when the newest review left nothing serious open", () => {
    expect(decideGate(gate())).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("fails while a serious finding is open", () => {
    const verdict = buildVerdict(null, review([bug]), HEAD, null);
    expect(decideGate(gate({ verdict }))).toMatchObject({
      conclusion: "failure",
      title: "1 serious finding open",
    });
  });

  it("hands the pull request to the owner after the last round", () => {
    let verdict: Verdict | null = null;
    for (let round = 0; round < ROUNDS; round++)
      verdict = buildVerdict(verdict, review([bug]), HEAD, null);
    expect(decideGate(gate({ verdict }))).toMatchObject({
      status: "in_progress",
      lane: "owner",
      title: `${ROUNDS} serious findings after ${ROUNDS} rounds: waits for the owner`,
    });
  });

  it("waits while the review hasn't started or is running", () => {
    expect(decideGate(gate({ verdict: null, review: { state: "none" } }))).toMatchObject({
      status: "in_progress",
    });
    expect(decideGate(gate({ verdict: null, review: { state: "reviewing" } }))).toMatchObject({
      status: "in_progress",
      title: "Reviewing aaaaaaa",
    });
  });

  it("never passes a commit whose review couldn't run", () => {
    expect(
      decideGate(
        gate({ verdict: null, review: { state: "failed", why: "ended without a verdict" } }),
      ),
    ).toMatchObject({
      status: "in_progress",
      lane: "owner",
      title: "The review couldn't run: waits for the owner",
    });
  });

  it("doesn't count a verdict on another commit", () => {
    const verdict = buildVerdict(null, review(), EARLIER, null);
    expect(decideGate(gate({ verdict, review: { state: "none" } }))).toMatchObject({
      status: "in_progress",
    });
  });

  it("leaves to the owner what touches an owner area or carries the label", () => {
    expect(decideGate(gate({ areas: ["the checks and the review gate"] }))).toMatchObject({
      status: "in_progress",
      lane: "owner",
      summary: expect.stringContaining("it touches the checks and the review gate"),
    });
    expect(decideGate(gate({ labels: [OWNER_LABEL] }))).toMatchObject({
      status: "in_progress",
      lane: "owner",
      title: "Reviewed, nothing serious: waits for the owner",
    });
  });

  it("leaves dependency updates to the owner, and waits on drafts", () => {
    expect(decideGate(gate({ author: "dependabot[bot]" }))).toMatchObject({
      status: "in_progress",
      lane: "owner",
    });
    expect(decideGate(gate({ draft: true }))).toMatchObject({ status: "in_progress" });
  });

  it("fails only when there is something to fix, never to say it waits for the owner", () => {
    const open = buildVerdict(null, review([bug]), HEAD, null);
    let stuck: Verdict | null = null;
    for (let round = 0; round < ROUNDS; round++)
      stuck = buildVerdict(stuck, review([bug]), HEAD, null);
    const owners = [
      gate({ author: "dependabot[bot]" }),
      gate({ fork: true }),
      gate({ verdict: null, review: { state: "failed", why: "ended without a verdict" } }),
      gate({ verdict: stuck }),
      gate({ labels: [OWNER_LABEL] }),
      gate({ areas: ["the checks and the review gate"] }),
    ].map(decideGate);
    for (const result of owners) {
      expect(result).toMatchObject({ status: "in_progress", lane: "owner" });
      expect(result).not.toHaveProperty("conclusion");
      expect(result.summary).toContain("Nothing failed");
    }
    expect(decideGate(gate({ verdict: open }))).toMatchObject({
      status: "completed",
      conclusion: "failure",
      lane: "fix",
    });
  });

  it("says which lane it leaves the pull request in, for the line's waiter", () => {
    const open = buildVerdict(null, review([bug]), HEAD, null);
    expect(decideGate(gate()).lane).toBe("merge");
    expect(decideGate(gate({ verdict: open })).lane).toBe("fix");
    expect(decideGate(gate({ labels: [OWNER_LABEL] })).lane).toBe("owner");
    expect(decideGate(gate({ verdict: null, review: { state: "none" } })).lane).toBe("wait");
    const note = { version: 1, lane: "fix", reviewed: HEAD };
    expect(parseGateNote(JSON.stringify(note))).toEqual(note);
    expect(parseGateNote(JSON.stringify({ ...note, lane: "merge please" }))).toBeNull();
    expect(parseGateNote("not json")).toBeNull();
  });

  it("leaves a pull request from another repository to the owner, unreviewed", () => {
    expect(
      decideGate(gate({ fork: true, verdict: null, review: { state: "none" } })),
    ).toMatchObject({
      status: "in_progress",
      lane: "owner",
      title: "From another repository: waits for the owner",
    });
  });
});

describe("owner areas", () => {
  const areas = parseAreas(readFileSync(".github/owner-areas.txt", "utf8"));

  it("read every area with its paths", () => {
    expect(areas.length).toBeGreaterThan(3);
    expect(areas.every((area) => area.globs.length > 0)).toBe(true);
  });

  it("catch the gate itself, the agents' rules, dependencies and saved data, and nothing else", () => {
    expect(touchedAreas([".github/workflows/ci.yml"], areas)).toEqual([
      "the checks and the review gate",
    ]);
    expect(touchedAreas(["scripts/review-gate.ts"], areas)).toEqual([
      "the checks and the review gate",
    ]);
    expect(touchedAreas(["AGENTS.md", ".agents/skills/ship/SKILL.md"], areas)).toEqual([
      "how agents work and ship",
    ]);
    expect(touchedAreas(["CLAUDE.md"], areas)).toEqual(["how agents work and ship"]);
    expect(touchedAreas(["package-lock.json", "src/library/store.ts"], areas)).toEqual([
      "dependencies and the toolchain",
      "how Folio saves the student's data",
    ]);
    expect(touchedAreas(["README.md", "app/App.svelte", "src/notes.ts"], areas)).toEqual([]);
  });

  it("catch a file renamed out of an area", () => {
    const renamed = paths([{ filename: "src/sign-in.ts", previous_filename: "src/auth.ts" }]);
    expect(touchedAreas(renamed, areas)).toEqual(["sign-in, keys and the app's hardening"]);
  });
});

describe("picture commits", () => {
  it("are those that change only the README's pictures", () => {
    expect(onlyPictures(["docs/images/hero-light.webp", "docs/images/hero-dark.webp"])).toBe(true);
    expect(onlyPictures(["docs/images/hero-light.webp", "README.md"])).toBe(false);
    expect(onlyPictures([])).toBe(false);
  });

  it("don't include a file moved in among the pictures", () => {
    const moved = paths([{ filename: "docs/images/x.webp", previous_filename: "src/auth.ts" }]);
    expect(onlyPictures(moved)).toBe(false);
  });
});

const APP = REVIEW_APP;
const NOW = Date.parse("2026-11-08T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const run = (overrides: Partial<VerdictRun> & { text?: string | null } = {}): VerdictRun => {
  const { text = null, ...rest } = overrides;
  return {
    id: 1,
    status: "completed",
    started_at: minutesAgo(5),
    app: { id: APP },
    output: { text },
    ...rest,
  };
};

describe("the signed verdict", () => {
  const clean = JSON.stringify(buildVerdict(null, review(), HEAD, null));
  const open = JSON.stringify(buildVerdict(null, review([bug]), HEAD, null));

  it("is the app's newest verdict on the commit", () => {
    const read = readVerdictRuns(
      [run({ id: 1, text: clean }), run({ id: 2, text: open })],
      APP,
      NOW,
    );
    expect(read.verdict?.open.map((item) => item.id)).toEqual(["F1"]);
  });

  it("ignores a verdict any other app wrote, a pull request's own workflow included", () => {
    const forged = run({ id: 9, app: { id: ACTIONS_APP }, text: clean });
    expect(readVerdictRuns([forged], APP, NOW)).toEqual({
      verdict: null,
      review: { state: "none" },
    });
    expect(
      readVerdictRuns([run({ id: 1, text: open }), forged], APP, NOW).verdict?.open,
    ).toHaveLength(1);
  });

  it("says a review is under way while the app's mark is fresh", () => {
    const marked = run({ status: "in_progress", started_at: minutesAgo(STALE_MINUTES - 1) });
    expect(readVerdictRuns([marked], APP, NOW).review).toEqual({ state: "reviewing" });
  });

  it("calls a review stopped once its mark has gone stale, as when its job was lost", () => {
    const lost = run({ status: "in_progress", started_at: minutesAgo(STALE_MINUTES + 1) });
    expect(readVerdictRuns([lost], APP, NOW).review).toMatchObject({ state: "failed" });
    expect(
      readVerdictRuns([run({ status: "in_progress", started_at: null })], APP, NOW).review,
    ).toMatchObject({ state: "failed" });
  });

  it("calls a review failed when it ended, or was cancelled, without a verdict", () => {
    expect(readVerdictRuns([run({ text: null })], APP, NOW).review).toEqual({
      state: "failed",
      why: "ended without a verdict",
    });
  });

  it("prefers a verdict, then a review under way, over one that stopped", () => {
    const stopped = run({ id: 3, text: null });
    const marked = run({ id: 2, status: "in_progress" });
    expect(readVerdictRuns([stopped, marked], APP, NOW).review).toEqual({ state: "reviewing" });
    expect(
      readVerdictRuns([stopped, run({ id: 1, text: clean })], APP, NOW).verdict,
    ).not.toBeNull();
  });
});

describe("starting a signed review", () => {
  const pr = { draft: false, fork: false, author: "someone" };
  const none = { verdict: null, review: { state: "none" } as const };

  it("starts on a commit with no verdict and no review under way", () => {
    expect(needsReview(pr, none)).toBe(true);
  });

  it("doesn't start a second review of a commit, as when a signal comes twice", () => {
    expect(needsReview(pr, { verdict: null, review: { state: "reviewing" } })).toBe(false);
    expect(needsReview(pr, { ...none, verdict: buildVerdict(null, review(), HEAD, null) })).toBe(
      false,
    );
  });

  it("tries again after a review that ended without a verdict", () => {
    expect(needsReview(pr, { verdict: null, review: { state: "failed", why: "x" } })).toBe(true);
  });

  it("never reviews a draft, a fork or Dependabot", () => {
    expect(needsReview({ ...pr, draft: true }, none)).toBe(false);
    expect(needsReview({ ...pr, fork: true }, none)).toBe(false);
    expect(needsReview({ ...pr, author: "dependabot[bot]" }, none)).toBe(false);
  });
});

// The signed commands against a GitHub of their own: the tokens they write with say which app a
// check run belongs to, as on GitHub, and only the app that made a check run can change it.
type FakeRun = VerdictRun & {
  name: string;
  head_sha: string;
  conclusion: string | null;
  output: { title?: string; summary?: string; text: string | null };
};
const APP_TOKEN = "app-token";
const WORKFLOW_TOKEN = "workflow-token";
const BASE = "c".repeat(40);

const fakeGitHub = () => {
  const state = {
    pr: {
      number: 7,
      state: "open",
      draft: false,
      title: "Stop a cancelled job",
      body: "Cancelling now stops the job.",
      user: { login: "someone" },
      labels: [] as { name: string }[],
      head: { sha: HEAD, ref: "fix", repo: { full_name: "owner/folio" } },
      base: { sha: BASE },
    },
    commits: [EARLIER, HEAD],
    files: [{ filename: "src/jobs/run.ts" }],
    runs: [] as FakeRun[],
    comments: [] as { body: string; token: string }[],
  };
  let id = 100;
  const appOf = (token: string) => (token === APP_TOKEN ? APP : ACTIONS_APP);
  const fetch = async (url: string, init: RequestInit = {}) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace("/repos/owner/folio", "");
    const method = init.method ?? "GET";
    const token = String((init.headers as Record<string, string>).authorization ?? "").replace(
      "Bearer ",
      "",
    );
    // The script always sends its bodies as JSON text.
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    const page = (items: unknown[]) => json(searchParams.get("page") === "1" ? items : []);
    let match: RegExpExecArray | null;
    if (method === "GET" && path === "/pulls/7") return json(state.pr);
    if (method === "GET" && path === "/pulls") {
      const owner = state.pr.head.repo.full_name.split("/")[0];
      return json(searchParams.get("head") === `${owner}:${state.pr.head.ref}` ? [state.pr] : []);
    }
    if (method === "GET" && path === "/pulls/7/commits")
      return page(state.commits.map((sha) => ({ sha })));
    if (method === "GET" && path === "/pulls/7/files") return page(state.files);
    if (method === "GET" && (match = /^\/commits\/(\w+)\/check-runs$/.exec(path)))
      return json({
        check_runs: state.runs.filter(
          (item) =>
            item.head_sha === match![1] &&
            item.name === searchParams.get("check_name") &&
            item.app?.id === Number(searchParams.get("app_id")),
        ),
      });
    if (method === "GET" && (match = /^\/commits\/(\w+)$/.exec(path)))
      return json({ files: [{ filename: "src/x.ts" }], parents: [{ sha: EARLIER }] });
    if (method === "POST" && path === "/check-runs") {
      const made: FakeRun = {
        id: ++id,
        name: body.name,
        head_sha: body.head_sha,
        status: body.status,
        conclusion: body.conclusion ?? null,
        started_at: body.started_at ?? null,
        app: { id: appOf(token) },
        output: { text: null, ...body.output },
      };
      state.runs.push(made);
      return json({ id: made.id }, 201);
    }
    if (method === "PATCH" && (match = /^\/check-runs\/(\d+)$/.exec(path))) {
      const found = state.runs.find((item) => item.id === Number(match![1]));
      if (!found || found.app?.id !== appOf(token)) return json({ message: "Forbidden" }, 403);
      Object.assign(found, {
        status: body.status,
        conclusion: body.conclusion,
        output: { text: null, ...body.output },
      });
      return json({ id: found.id });
    }
    if (method === "POST" && path === "/issues/7/comments") {
      state.comments.push({ body: body.body, token });
      return json({ id: 1 }, 201);
    }
    return json({ message: `Not Found: ${method} ${path}` }, 404);
  };
  return { state, fetch };
};

describe("the signed commands", () => {
  let folder: string;
  let outputs: string;
  let github: ReturnType<typeof fakeGitHub>;
  const read = () => {
    const values: Record<string, string> = {};
    const text = readFileSync(outputs, "utf8");
    for (const [, name, end] of text.matchAll(/^(\w+)<<(END_[\w-]+)$/gm)) {
      const from = text.indexOf(`${name}<<${end}\n`) + `${name}<<${end}\n`.length;
      values[name!] = text.slice(from, text.indexOf(`\n${end}\n`, from));
    }
    return values;
  };
  const verdictRuns = () => github.state.runs.filter((item) => item.name === VERDICT_CHECK);
  const gateRuns = () => github.state.runs.filter((item) => item.name === GATE_CHECK);

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "review-gate-"));
    outputs = join(folder, "outputs");
    writeFileSync(outputs, "");
    github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetch);
    vi.stubEnv("GITHUB_API_URL", "http://github.test");
    vi.stubEnv("GITHUB_REPOSITORY", "owner/folio");
    vi.stubEnv("GITHUB_OUTPUT", outputs);
    vi.stubEnv("GITHUB_TOKEN", WORKFLOW_TOKEN);
    vi.stubEnv("APP_TOKEN", APP_TOKEN);
    vi.stubEnv("PR", "7");
    // As on a runner, so the tests don't depend on where they run.
    vi.stubEnv("RUNNER_TEMP", "/runner/temp");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(folder, { recursive: true, force: true });
  });

  it("mark the commit as being reviewed, as the app, and hand Claude only files to read", async () => {
    await commands.start!();
    const values = read();
    expect(values).toMatchObject({ pr: "7", review: "true", sha: HEAD, base: BASE, since: "" });
    expect(verdictRuns()).toEqual([
      expect.objectContaining({ status: "in_progress", head_sha: HEAD, app: { id: APP } }),
    ]);
    expect(values.check).toBe(String(verdictRuns()[0]!.id));
    expect(values.prompt).toContain(CHANGES.diff);
    expect(values.args).toBe(reviewArgs("/runner/temp"));
    expect(denied(values.args!)).toContain("Read(//runner/temp/**)");
  });

  it("start one review of a commit however many times the signal comes", async () => {
    await commands.start!();
    writeFileSync(outputs, "");
    await commands.start!();
    expect(read().review).toBe("false");
    expect(verdictRuns()).toHaveLength(1);
  });

  it("post the verdict as the app before the comment, and the gate reads it", async () => {
    await commands.start!();
    const { check, previous } = read();
    vi.stubEnv("CHECK", check!);
    vi.stubEnv("SHA", HEAD);
    vi.stubEnv("PREVIOUS", previous!);
    vi.stubEnv("REVIEW_RESULT", "success");
    vi.stubEnv("REVIEW", JSON.stringify(review([bug])));
    await commands.verdict!();
    expect(parseVerdict(verdictRuns()[0]!.output.text)?.open).toHaveLength(1);
    expect(github.state.comments).toEqual([
      { body: expect.stringContaining("**F1**"), token: WORKFLOW_TOKEN },
    ]);
    await commands.judge!();
    expect(gateRuns()).toEqual([
      expect.objectContaining({
        head_sha: HEAD,
        conclusion: "failure",
        app: { id: APP },
        output: expect.objectContaining({ title: "1 serious finding open" }),
      }),
    ]);
    expect(parseGateNote(gateRuns()[0]!.output.text)).toEqual({
      version: 1,
      lane: "fix",
      reviewed: HEAD,
    });
  });

  it("close the mark without a verdict when the review was cancelled, and try again next time", async () => {
    await commands.start!();
    vi.stubEnv("CHECK", read().check!);
    vi.stubEnv("SHA", HEAD);
    vi.stubEnv("REVIEW_RESULT", "cancelled");
    await commands.verdict!();
    expect(verdictRuns()[0]).toMatchObject({
      status: "completed",
      output: expect.objectContaining({ title: "The review was stopped", text: null }),
    });
    expect(github.state.comments).toEqual([]);
    await commands.judge!();
    expect(gateRuns()[0]!.output.title).toBe("The review couldn't run: waits for the owner");
    writeFileSync(outputs, "");
    await commands.start!();
    expect(read().review).toBe("true");
  });

  it("refuse an answer in the wrong shape as a review that couldn't run", async () => {
    await commands.start!();
    vi.stubEnv("CHECK", read().check!);
    vi.stubEnv("SHA", HEAD);
    vi.stubEnv("REVIEW_RESULT", "success");
    vi.stubEnv("REVIEW", '{"summary": "fine"}');
    await commands.verdict!();
    expect(verdictRuns()[0]!.output).toMatchObject({
      title: "The review couldn't run",
      text: null,
    });
  });

  it("don't count a clean verdict or a passing gate that GitHub Actions' token wrote", async () => {
    const clean = JSON.stringify(buildVerdict(null, review(), HEAD, null));
    github.state.runs.push(
      {
        id: 1,
        name: VERDICT_CHECK,
        head_sha: HEAD,
        status: "completed",
        conclusion: "neutral",
        started_at: null,
        app: { id: ACTIONS_APP },
        output: { text: clean },
      },
      {
        id: 2,
        name: GATE_CHECK,
        head_sha: HEAD,
        status: "completed",
        conclusion: "success",
        started_at: null,
        app: { id: ACTIONS_APP },
        output: { text: null },
      },
    );
    await commands.judge!();
    const signed = gateRuns().filter((item) => item.app?.id === APP);
    expect(signed).toEqual([
      expect.objectContaining({
        status: "in_progress",
        output: expect.objectContaining({ title: "Waiting for the review of aaaaaaa" }),
      }),
    ]);
    await commands.start!();
    expect(read().review).toBe("true");
  });

  it("continue from the app's verdict on an earlier commit, with only the new changes", async () => {
    const earlier = buildVerdict(null, review([bug]), EARLIER, null);
    github.state.runs.push({
      id: 1,
      name: VERDICT_CHECK,
      head_sha: EARLIER,
      status: "completed",
      conclusion: "neutral",
      started_at: null,
      app: { id: APP },
      output: { text: JSON.stringify(earlier) },
    });
    await commands.start!();
    const values = read();
    expect(values.since).toBe(EARLIER);
    expect(parseVerdict(values.previous)).toEqual(earlier);
    expect(values.prompt).toContain("review round 2");
  });

  it("leave a pull request from another repository to the owner, unreviewed", async () => {
    github.state.pr.head.repo = { full_name: "someone/folio" };
    await commands.start!();
    expect(read().review).toBe("false");
    await commands.judge!();
    expect(gateRuns()[0]!.output.title).toBe("From another repository: waits for the owner");
  });

  it("find a fork's pull request, which comes without its number, by its branch under its owner", async () => {
    github.state.pr.head.repo = { full_name: "someone/folio" };
    vi.stubEnv("PR", "");
    vi.stubEnv("BRANCH", "fix");
    vi.stubEnv("GITHUB_REPOSITORY_OWNER", "owner");
    vi.stubEnv("HEAD_OWNER", "someone");
    await commands.start!();
    expect(read()).toMatchObject({ pr: "7", review: "false" });
    // A branch of that name here isn't the fork's.
    vi.stubEnv("HEAD_OWNER", "");
    writeFileSync(outputs, "");
    await commands.start!();
    expect(read()).toMatchObject({ pr: "", review: "false" });
  });
});

describe("the Review workflow", () => {
  type Step = {
    uses?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
    run?: string;
  };
  type Job = {
    if?: string;
    "runs-on"?: string;
    environment?: { name: string; deployment: boolean };
    permissions?: Record<string, string>;
    steps: Step[];
  };
  const workflow = parse(readFileSync(".github/workflows/review.yml", "utf8")) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, Job>;
  };
  const jobs = Object.entries(workflow.jobs);
  const text = (job: Job) => JSON.stringify(job);
  const withKey = jobs.filter(([, job]) => text(job).includes("secrets.REVIEW_APP_KEY"));
  const readsThePullRequest = jobs.filter(([, job]) =>
    job.steps.some((step) => step.uses?.startsWith("actions/checkout@") && step.with?.ref),
  );

  it("runs only from main: after the signal, or by hand", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["workflow_dispatch", "workflow_run"]);
    expect(workflow.on.workflow_run).toMatchObject({ workflows: ["Pull request"] });
    expect(workflow.permissions).toEqual({});
  });

  it("makes Claude's arguments on the same kind of runner as the review, whose temporary folder they deny", () => {
    expect(workflow.jobs.start?.["runs-on"]).toBe("ubuntu-latest");
    expect(workflow.jobs.review?.["runs-on"]).toBe(workflow.jobs.start?.["runs-on"]);
  });

  it("gives the app's key only to jobs in the main-only environment", () => {
    expect(withKey.map(([name]) => name).sort()).toEqual(["gate", "start", "verdict"]);
    for (const [, job] of withKey)
      expect(job.environment).toEqual({ name: "review-gate", deployment: false });
  });

  it("never checks out the pull request where the key is, nor runs Claude there", () => {
    for (const [, job] of withKey) {
      for (const step of job.steps.filter((item) => item.uses?.startsWith("actions/checkout@"))) {
        expect(step.with?.ref).toBeUndefined();
        expect(String(step.with?.["sparse-checkout"])).toContain("scripts/review-gate.ts");
      }
      expect(text(job)).not.toContain("claude-code-action");
    }
  });

  it("reads the pull request's code in one job, which holds only Claude's key and can't write", () => {
    expect(readsThePullRequest.map(([name]) => name)).toEqual(["review"]);
    const [, job] = readsThePullRequest[0]!;
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    // Never a fork's branch from a workflow_run, whatever start decided.
    expect(job.if).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect([...text(job).matchAll(/secrets\.(\w+)/g)].map((found) => found[1])).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    const leaveOut = job.steps.find((step) => step.run?.startsWith("rm -rf .claude"));
    for (const path of [".claude", ".mcp.json", "CLAUDE.md"]) expect(leaveOut?.run).toContain(path);
    const claude = job.steps.filter((item) =>
      item.uses?.startsWith("anthropics/claude-code-action@"),
    );
    expect(claude).toHaveLength(2);
    for (const step of claude)
      expect(step.with?.claude_args).toBe("${{ needs.start.outputs.args }}");
  });

  it("writes the changes where the instructions say they are", () => {
    const [, job] = readsThePullRequest[0]!;
    const changes = job.steps.find((step) => step.run?.includes("git diff"));
    expect(changes?.run).toContain(CHANGES.diff);
    expect(changes?.run).toContain(CHANGES.commits);
    expect(changes?.run).toContain("--no-ext-diff --no-textconv");
  });

  it("is signalled by a workflow that holds nothing", () => {
    const signal = parse(readFileSync(".github/workflows/pull-request.yml", "utf8")) as {
      name: string;
      on: Record<string, unknown>;
      permissions: Record<string, string>;
    };
    const raw = readFileSync(".github/workflows/pull-request.yml", "utf8");
    expect(signal.name).toBe("Pull request");
    expect(Object.keys(signal.on)).toEqual(["pull_request"]);
    expect(signal.permissions).toEqual({});
    expect(raw).not.toContain("${{ secrets");
    expect(raw).not.toMatch(/uses:/);
  });
});

describe("the @claude workflow", () => {
  it("confines file tools to the checkout and downloaded images and denies shell access", () => {
    const workflow = parse(readFileSync(".github/workflows/claude.yml", "utf8")) as {
      jobs: { answer: { steps: { uses?: string; with?: { claude_args?: string } }[] } };
    };
    const claude = workflow.jobs.answer.steps.filter((step) =>
      step.uses?.startsWith("anthropics/claude-code-action@"),
    );
    expect(claude).toHaveLength(1);
    const args = claude[0]?.with?.claude_args ?? "";
    expect(args).toContain('--tools "Read,Grep,Glob"');
    expect(args).toContain("--setting-sources user");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain(
      '--settings \'{"permissions":{"blockReadsOutsideWorkingDirectories":true}}\'',
    );
    expect(args.match(/^--add-dir .+$/gm)).toEqual(["--add-dir /tmp/github-images"]);
    expect(args).not.toContain("--allowedTools");
    expect(denied(args)).toEqual(
      expect.arrayContaining(["Bash", "Read(/${{ runner.temp }}/**)", ...CREDENTIALS]),
    );
  });
});
