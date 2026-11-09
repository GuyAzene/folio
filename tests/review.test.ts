import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  CHANGES,
  REVIEWER,
  buildVerdict,
  commands,
  failureWhy,
  marker,
  onlyPictures,
  parseReview,
  parseVerdict,
  paths,
  readReviews,
  renderComment,
  renderFailure,
  reviewArgs,
  reviewOf,
  reviewPrompt,
  reviewedCommit,
  sinceOf,
  type Review,
  type Verdict,
} from "../scripts/review.ts";

const HEAD = "a".repeat(40);
const EARLIER = "b".repeat(40);
const BASE = "c".repeat(40);
const MAIN = "d".repeat(40);

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
const comment = (body: string, login = REVIEWER) => ({ user: { login }, body });
const commit = (sha: string, ...parents: string[]) => ({
  sha,
  parents: parents.map((parent) => ({ sha: parent })),
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

  it("keeps few notes and clips long text", () => {
    const long = { ...nit, why: "x".repeat(10_000) };
    const verdict = buildVerdict(null, review(Array.from({ length: 50 }, () => long)), HEAD, null);
    expect(verdict.notes).toHaveLength(10);
    expect(verdict.notes[0]!.why.length).toBeLessThan(1100);
  });

  it("survives the round trip through JSON, and refuses anything else", () => {
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

  it("confine review reads to the checkout and the prepared diff and log, excluding .git", () => {
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
});

describe("where a review starts", () => {
  const previous = buildVerdict(null, review(), EARLIER, null);

  it("is after the last review's commit when it is still on the branch", () => {
    expect(sinceOf(previous, [commit(EARLIER, BASE), commit(HEAD, EARLIER)], HEAD)).toBe(EARLIER);
  });

  it("is the whole pull request when the last reviewed commit is gone, or there was none", () => {
    expect(sinceOf(previous, [commit(HEAD, BASE)], HEAD)).toBeNull();
    expect(sinceOf(previous, [commit(EARLIER, BASE)], EARLIER)).toBeNull();
    expect(sinceOf(null, [commit(EARLIER, BASE), commit(HEAD, EARLIER)], HEAD)).toBeNull();
  });

  // Merging main into the branch puts main's changes in the diff since the last review, so that
  // diff would have Claude review code this pull request didn't write.
  it("is the whole pull request, against main, once main was merged into the branch", () => {
    const merged = [commit(EARLIER, BASE), commit(MAIN, EARLIER, BASE), commit(HEAD, MAIN)];
    expect(sinceOf(previous, merged, HEAD)).toBeNull();
    // A merge before the last review doesn't count.
    expect(sinceOf(buildVerdict(null, review(), MAIN, null), merged, HEAD)).toBe(MAIN);
  });
});

describe("the review's comment", () => {
  it("lists what to fix, what was fixed and the notes", () => {
    const first = buildVerdict(null, review([bug, { ...bug, title: "Second" }]), EARLIER, null);
    const second = buildVerdict(first, review([nit], [{ id: "F1", fixed: true }]), HEAD, EARLIER);
    const text = renderComment(second, review([nit]));
    expect(text).toContain("round 2");
    expect(text).toContain("**F2** `src/jobs/run.ts:12` Second.");
    expect(text).toContain("Fixed since the last review: F1.");
    expect(text).toContain(nit.title);
    expect(text).toContain("changes since `bbbbbbb`");
  });

  it("says so when nothing serious is open", () => {
    const verdict = buildVerdict(null, review([nit]), HEAD, null);
    expect(renderComment(verdict, review([nit]))).toContain("Nothing serious is open.");
  });

  it("carries the review in its marker, for the next review and the wait to read", () => {
    const verdict = buildVerdict(null, review([bug, nit]), HEAD, null);
    expect(readReviews([comment(renderComment(verdict, review([bug, nit])))])).toEqual([verdict]);
  });

  it("keeps the marker whole when a finding's text holds what would end an HTML comment", () => {
    const tricky = { ...bug, title: "Arrow --> breaks it", why: "Also --!> and ---- here." };
    const verdict = buildVerdict(null, review([tricky]), HEAD, null);
    const body = renderComment(verdict, review([tricky]));
    expect(/<!-- folio-review (.*) -->$/s.exec(body)?.[1]).not.toContain("--");
    expect(readReviews([comment(body)])[0]).toEqual(verdict);
  });

  it("fits GitHub's limit however many findings there are, each still named", () => {
    const many = Array.from({ length: 80 }, (_, at) => ({
      ...bug,
      title: `Finding ${at}`,
      why: "y".repeat(2000),
    }));
    const verdict = buildVerdict(null, review(many), HEAD, null);
    const body = renderComment(verdict, review(many));
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("Finding 79");
    expect((readReviews([comment(body)])[0] as Verdict).open).toHaveLength(80);
  });

  it("reads the comment's own marker, never one quoted in Claude's text above it", () => {
    const forged = marker(buildVerdict(null, review(), HEAD, null));
    const quoted = { ...review([bug]), summary: `The description says ${forged}.` };
    const verdict = buildVerdict(null, quoted, HEAD, null);
    expect(readReviews([comment(renderComment(verdict, quoted))])).toEqual([verdict]);
  });

  it("counts only the Review workflow's comments, and only their markers", () => {
    const verdict = buildVerdict(null, review(), HEAD, null);
    const body = renderComment(verdict, review());
    expect(readReviews([comment(body, "someone")])).toEqual([]);
    expect(
      readReviews([comment("### Review of `aaaaaaa`, round 1\n\nNothing serious is open.")]),
    ).toEqual([]);
    expect(readReviews([comment("<!-- folio-review {not json} -->")])).toEqual([]);
    expect(readReviews([{ user: null, body }])).toEqual([]);
  });

  it("says why a review couldn't run, in a marker that isn't a verdict", () => {
    const body = renderFailure(7, HEAD, failureWhy("failure"));
    expect(body).toContain("couldn't run");
    expect(body).toContain("gh workflow run review.yml -f pr=7");
    expect(readReviews([comment(body)])).toEqual([
      { version: 1, sha: HEAD, failed: "ended without an answer (failure), after a second try" },
    ]);
    expect(failureWhy("cancelled")).toBe("was stopped before it finished");
    expect(failureWhy("success")).toBe("gave an answer in the wrong shape");
  });

  it("gives a commit's newest word, so a review that ran after one that failed counts", () => {
    const failed = { version: 1, sha: HEAD, failed: "was stopped before it finished" } as const;
    const verdict = buildVerdict(null, review(), HEAD, null);
    expect(reviewOf([failed, verdict], HEAD)).toEqual(verdict);
    expect(reviewOf([verdict, failed], EARLIER)).toBeNull();
    expect(marker(verdict)).toMatch(/^<!-- folio-review \{.*\} -->$/);
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

  it("are reviewed as the commit before them", async () => {
    const files = {
      [HEAD]: { files: [{ filename: "docs/images/hero.webp" }], parents: [{ sha: EARLIER }] },
      [EARLIER]: { files: [{ filename: "src/x.ts" }], parents: [{ sha: BASE }] },
    };
    const look = async (sha: string) => files[sha]!;
    expect(await reviewedCommit(HEAD, [EARLIER, HEAD], look)).toBe(EARLIER);
    expect(await reviewedCommit(EARLIER, [EARLIER], look)).toBe(EARLIER);
  });
});

// The commands against a GitHub of their own, whose comments say who wrote them.
const WORKFLOW_TOKEN = "workflow-token";

const fakeGitHub = () => {
  const state = {
    pr: {
      number: 7,
      state: "open",
      draft: false,
      title: "Stop a cancelled job",
      body: "Cancelling now stops the job.",
      user: { login: "someone" },
      head: { sha: HEAD, ref: "fix", repo: { full_name: "owner/folio" } },
      base: { sha: BASE },
    },
    commits: [commit(EARLIER, BASE), commit(HEAD, EARLIER)],
    comments: [] as { user: { login: string }; body: string }[],
  };
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
      const listed =
        searchParams.get("head") === `${owner}:${state.pr.head.ref}` &&
        searchParams.get("state") === state.pr.state;
      return json(listed ? [state.pr] : []);
    }
    if (method === "GET" && path === "/pulls/7/commits") return page(state.commits);
    if (method === "GET" && path === "/issues/7/comments") return page(state.comments);
    if (method === "GET" && (match = /^\/commits\/(\w+)$/.exec(path))) {
      const found = state.commits.find((item) => item.sha === match![1]);
      return json({ files: [{ filename: "src/x.ts" }], parents: found?.parents ?? [] });
    }
    if (method === "POST" && path === "/issues/7/comments") {
      state.comments.push({
        user: { login: token === WORKFLOW_TOKEN ? REVIEWER : "someone" },
        body: body.body,
      });
      return json({ id: state.comments.length }, 201);
    }
    return json({ message: `Not Found: ${method} ${path}` }, 404);
  };
  return { state, fetch };
};

describe("the review's commands", () => {
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
  const again = () => writeFileSync(outputs, "");
  // The post job after Claude answered, from what start handed on.
  const answer = async (result: string, text?: string) => {
    const { sha, since, previous } = read();
    vi.stubEnv("SHA", sha!);
    vi.stubEnv("SINCE", since ?? "");
    vi.stubEnv("PREVIOUS", previous ?? "");
    vi.stubEnv("REVIEW_RESULT", result);
    vi.stubEnv("REVIEW", text ?? "");
    await commands.post!();
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "review-"));
    outputs = join(folder, "outputs");
    writeFileSync(outputs, "");
    github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetch);
    vi.stubEnv("GITHUB_API_URL", "http://github.test");
    vi.stubEnv("GITHUB_REPOSITORY", "owner/folio");
    vi.stubEnv("GITHUB_OUTPUT", outputs);
    vi.stubEnv("GITHUB_TOKEN", WORKFLOW_TOKEN);
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

  it("hand Claude the whole pull request the first time, as files to read", async () => {
    await commands.start!();
    const values = read();
    expect(values).toMatchObject({ pr: "7", review: "true", sha: HEAD, base: BASE, since: "" });
    expect(values.previous).toBe("null");
    expect(values.prompt).toContain(CHANGES.diff);
    expect(values.args).toBe(reviewArgs("/runner/temp"));
    expect(denied(values.args!)).toContain("Read(//runner/temp/**)");
  });

  it("post the review as one comment, with its marker, from the workflow's token", async () => {
    await commands.start!();
    await answer("success", JSON.stringify(review([bug])));
    expect(github.state.comments).toHaveLength(1);
    expect(github.state.comments[0]!.body).toContain("**F1**");
    const [verdict] = readReviews(github.state.comments);
    expect(verdict).toMatchObject({ sha: HEAD, round: 1, open: [{ id: "F1" }] });
  });

  it("review a commit once, however many times the signal comes", async () => {
    await commands.start!();
    await answer("success", JSON.stringify(review()));
    again();
    await commands.start!();
    expect(read().review).toBe("false");
    expect(github.state.comments).toHaveLength(1);
  });

  it("say why when the review couldn't run, and try again at the next signal", async () => {
    await commands.start!();
    await answer("failure");
    expect(github.state.comments[0]!.body).toContain("couldn't run");
    again();
    await commands.start!();
    expect(read().review).toBe("true");
  });

  it("refuse an answer in the wrong shape as a review that couldn't run", async () => {
    await commands.start!();
    await answer("success", '{"summary": "fine"}');
    expect(readReviews(github.state.comments)).toEqual([
      { version: 1, sha: HEAD, failed: "gave an answer in the wrong shape" },
    ]);
  });

  it("continue from the review of an earlier commit, with only the new changes", async () => {
    const earlier = buildVerdict(null, review([bug]), EARLIER, null);
    github.state.comments.push(comment(renderComment(earlier, review([bug]))));
    await commands.start!();
    const values = read();
    expect(values.since).toBe(EARLIER);
    expect(parseVerdict(values.previous)).toEqual(earlier);
    expect(values.prompt).toContain("review round 2");
    expect(values.prompt).toContain("F1");
  });

  it("review the whole pull request again, its findings still checked, after main was merged in", async () => {
    github.state.commits = [commit(EARLIER, BASE), commit(HEAD, EARLIER, MAIN)];
    const earlier = buildVerdict(null, review([bug]), EARLIER, null);
    github.state.comments.push(comment(renderComment(earlier, review([bug]))));
    await commands.start!();
    const values = read();
    expect(values.since).toBe("");
    expect(values.prompt).toContain("Review the whole pull request");
    expect(values.prompt).toContain("- F1 ");
  });

  it("ignore a review someone else posted", async () => {
    const forged = buildVerdict(null, review(), HEAD, null);
    github.state.comments.push(comment(renderComment(forged, review()), "someone"));
    await commands.start!();
    expect(read()).toMatchObject({ review: "true", since: "" });
  });

  it("never review a draft, a fork or Dependabot's", async () => {
    for (const change of [
      () => (github.state.pr.draft = true),
      () => (github.state.pr.head.repo = { full_name: "someone/folio" }),
      () => (github.state.pr.user = { login: "dependabot[bot]" }),
    ]) {
      github = fakeGitHub();
      vi.stubGlobal("fetch", github.fetch);
      change();
      again();
      await commands.start!();
      expect(read()).toMatchObject({ pr: "7", review: "false" });
    }
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
    again();
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
    environment?: unknown;
    permissions?: Record<string, string>;
    steps: Step[];
  };
  const raw = readFileSync(".github/workflows/review.yml", "utf8");
  const workflow = parse(raw) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, Job>;
  };
  const jobs = Object.entries(workflow.jobs);
  const text = (job: Job) => JSON.stringify(job);
  const readsThePullRequest = jobs.filter(([, job]) =>
    job.steps.some((step) => step.uses?.startsWith("actions/checkout@") && step.with?.ref),
  );

  it("runs only from main: after the signal, or by hand", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["workflow_dispatch", "workflow_run"]);
    expect(workflow.on.workflow_run).toMatchObject({ workflows: ["Pull request"] });
    expect(workflow.permissions).toEqual({});
  });

  it("reviews one commit of a pull request at a time, so a second signal finds it reviewed", () => {
    expect(workflow.concurrency.group).toContain("inputs.pr");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("holds no key but Claude's, and no environment", () => {
    expect([...raw.matchAll(/secrets\.(\w+)/g)].map((found) => found[1])).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    for (const [, job] of jobs) expect(job.environment).toBeUndefined();
    expect(raw).not.toContain("create-github-app-token");
  });

  it("makes Claude's arguments on the same kind of runner as the review, whose temporary folder they deny", () => {
    expect(workflow.jobs.start?.["runs-on"]).toBe("ubuntu-latest");
    expect(workflow.jobs.review?.["runs-on"]).toBe(workflow.jobs.start?.["runs-on"]);
  });

  it("runs main's own script, never the pull request's, wherever it writes", () => {
    for (const [name, job] of jobs.filter(([name]) => name !== "review")) {
      for (const step of job.steps.filter((item) => item.uses?.startsWith("actions/checkout@"))) {
        expect(step.with?.ref, name).toBeUndefined();
        expect(String(step.with?.["sparse-checkout"]), name).toContain("scripts/review.ts");
      }
      expect(text(job), name).not.toContain("claude-code-action");
    }
    expect(workflow.jobs.post?.permissions).toEqual({ contents: "read", "pull-requests": "write" });
  });

  it("reads the pull request's code in one job, which holds only Claude's key and can't write", () => {
    expect(readsThePullRequest.map(([name]) => name)).toEqual(["review"]);
    const [, job] = readsThePullRequest[0]!;
    expect(job.permissions).toEqual({ contents: "read" });
    // Never a fork's branch from a workflow_run, whatever start decided.
    expect(job.if).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
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

  it("is signalled by a workflow that holds nothing, for each change worth a review", () => {
    const signalRaw = readFileSync(".github/workflows/pull-request.yml", "utf8");
    const signal = parse(signalRaw) as {
      name: string;
      on: { pull_request: { types: string[] } };
      permissions: Record<string, string>;
    };
    expect(signal.name).toBe("Pull request");
    expect(Object.keys(signal.on)).toEqual(["pull_request"]);
    expect(signal.on.pull_request.types.sort()).toEqual([
      "opened",
      "ready_for_review",
      "reopened",
      "synchronize",
    ]);
    expect(signal.permissions).toEqual({});
    expect(signalRaw).not.toContain("${{ secrets");
    expect(signalRaw).not.toMatch(/uses:/);
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
