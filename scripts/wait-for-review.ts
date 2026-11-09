// The ship skill's wait, in the spirit of rstack's review helper. It waits until every check on a
// pull request's newest commit has finished and Claude has reviewed it, then says what failed, the
// serious findings still open and the notes:
//
//   vp node scripts/wait-for-review.ts [pull request] [--minutes 30]
//
// It prints a line whenever something changes, so a wait is never silent, and ends with what to do
// next. The exit code says the same: 0 nothing left to fix, 1 something to fix, 2 stuck (it took too
// long, GitHub didn't answer, or the review couldn't run). The pull request is the current branch's
// unless one is named. It asks GitHub through the gh CLI, as whoever is signed in, and changes
// nothing: it never merges.
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ROUNDS,
  readReviews,
  reviewOf,
  reviewedCommit,
  short,
  type Failure,
  type Verdict,
} from "./review.ts";

export const EXIT = { done: 0, fix: 1, stuck: 2 } as const;
export type Outcome = keyof typeof EXIT;

export type Check = { name: string; status: string; conclusion: string | null };
export type Pull = {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  head: string;
};
export type Step =
  | { done: false; waitingFor: string }
  | { done: true; outcome: Outcome; lines: string[] };

const BAD = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
/** CI's own summary check, which only says whether its jobs passed. */
const CI_CHECK = "CI";
const place = (item: { file?: string; line?: number }) =>
  item.file ? ` (${item.file}${typeof item.line === "number" ? `:${item.line}` : ""})` : "";

/** The checks that failed on a commit, CI's summary left out since its jobs say more. */
export const failedChecks = (checks: Check[]) =>
  checks
    .filter((check) => check.status === "completed" && BAD.has(check.conclusion ?? ""))
    .filter((check, _, all) => check.name !== CI_CHECK || all.length === 1)
    .map((check) => `${check.name}: ${check.conclusion}`);

/** Where a round stands: still waiting, or done with an outcome and what to do next. */
export const readRound = (
  pr: Pull,
  checks: Check[],
  reviewed: string,
  review: Verdict | Failure | null,
): Step => {
  if (pr.state === "MERGED")
    return {
      done: true,
      outcome: "done",
      lines: [`#${pr.number} has merged. Remove its worktree and branch, as isolate says.`],
    };
  if (pr.state === "CLOSED")
    return {
      done: true,
      outcome: "stuck",
      lines: [`#${pr.number} was closed without merging. Tell the owner, and stop.`],
    };
  if (pr.draft)
    return {
      done: true,
      outcome: "fix",
      lines: [
        `#${pr.number} is a draft, which isn't reviewed. Mark it ready (gh pr ready ${pr.number}) and wait again.`,
      ],
    };
  const running = checks.filter((check) => check.status !== "completed");
  if (!checks.length) return { done: false, waitingFor: `the checks on ${short(pr.head)}` };
  if (running.length)
    return {
      done: false,
      waitingFor:
        running.length === 1
          ? running[0]!.name
          : `${running.length} checks, ${running[0]!.name} among them`,
    };
  if (!review) return { done: false, waitingFor: `Claude's review of ${short(reviewed)}` };
  if (!("open" in review))
    return {
      done: true,
      outcome: "stuck",
      lines: [
        `Claude's review of ${short(reviewed)} ${review.failed}.`,
        `Start it again once (gh workflow run review.yml -f pr=${pr.number}) and wait again. If it fails again, say so, and stop.`,
      ],
    };

  const failed = failedChecks(checks);
  const round = `round ${review.round} of ${ROUNDS}`;
  const notes = review.notes.map((item) => `- ${item.title}${place(item)}. ${item.why}`);
  const noteLines = notes.length
    ? [
        "Notes:",
        ...notes,
        "Fix the ones that are right and within this task, and answer the rest on the pull request. Don't change correct code just to satisfy the review.",
      ]
    : [];
  if (!failed.length && !review.open.length)
    return {
      done: true,
      outcome: "done",
      lines: [
        `#${pr.number} at ${short(pr.head)} passed every check, and the review (${round}) left nothing serious open.`,
        ...noteLines,
        notes.length
          ? "If you push a fix, wait again. Otherwise hand the owner the pull request's link."
          : "Hand the owner the pull request's link.",
      ],
    };
  return {
    done: true,
    outcome: "fix",
    lines: [
      `#${pr.number} at ${short(pr.head)} has something to fix (${round}):`,
      ...failed.map(
        (check) =>
          `- ${check}. Read its log and fix the cause; never re-run a check to get past it.`,
      ),
      ...review.open.map((item) => `- ${item.id}${place(item)}: ${item.title}. ${item.why}`),
      ...noteLines,
      review.round >= ROUNDS
        ? "That was the last round: report what's left, and stop."
        : "Fix it in this branch, run the checks, push, and wait again. If a finding is wrong, reply on the pull request with why.",
    ],
  };
};

/** One line for each check that finished since the last look. */
export const progress = (before: Map<string, string>, checks: Check[]) => {
  const lines: string[] = [];
  for (const check of checks) {
    const state = check.status === "completed" ? (check.conclusion ?? "completed") : check.status;
    if (before.get(check.name) === state) continue;
    before.set(check.name, state);
    if (check.status !== "completed") continue;
    const mark = check.conclusion === "success" ? "✓" : BAD.has(check.conclusion ?? "") ? "✗" : "·";
    lines.push(`${mark} ${check.name}${mark === "✓" ? "" : `: ${check.conclusion}`}`);
  }
  return lines;
};

export type Job = {
  name: string;
  status: string;
  steps?: { name: string; conclusion: string | null }[];
};

/**
 * One line for each step that failed inside a job that hasn't finished. A job can go on to its
 * later steps after one fails, so its check still says it's running while the commit is already
 * as good as failed.
 */
export const failedSteps = (before: Set<string>, jobs: Job[]) =>
  jobs.flatMap((job) =>
    job.status === "completed"
      ? []
      : (job.steps ?? [])
          .filter((step) => BAD.has(step.conclusion ?? ""))
          .filter((step) => !before.has(`${job.name}\n${step.name}`))
          .map((step) => {
            before.add(`${job.name}\n${step.name}`);
            return `✗ ${job.name}: its "${step.name}" step failed, though the job is still running`;
          }),
  );

// GitHub, through the gh CLI.

const exec = promisify(execFile);
/** gh's output; a failure carries what gh said, not just that it failed. */
const gh = async (args: string[]) => {
  try {
    return (await exec("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    const said = String((error as { stderr?: string }).stderr ?? "").trim();
    throw new Error(said || (error as Error).message);
  }
};
const api = async <T>(path: string): Promise<T> =>
  JSON.parse(await gh(["api", `repos/{owner}/{repo}/${path}`])) as T;
/** Every item of a paged list, one JSON object a line. */
const everyItem = async <T>(path: string, jq = ".[]") =>
  (await gh(["api", "--paginate", `repos/{owner}/{repo}/${path}`, "--jq", jq]))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);

const pull = async (number?: string): Promise<Pull> => {
  const view = JSON.parse(
    await gh([
      "pr",
      "view",
      ...(number ? [number] : []),
      "--json",
      "number,state,isDraft,headRefOid",
    ]),
  ) as { number: number; state: Pull["state"]; isDraft: boolean; headRefOid: string };
  return { number: view.number, state: view.state, draft: view.isDraft, head: view.headRefOid };
};

const checksOn = async (sha: string): Promise<Check[]> =>
  (
    await api<{ check_runs: Check[] }>(`commits/${sha}/check-runs?filter=latest&per_page=100`)
  ).check_runs.map(({ name, status, conclusion }) => ({ name, status, conclusion }));

/** The jobs of CI's newest run on a commit, with their steps. */
const jobsOn = async (sha: string) => {
  const { workflow_runs: runs } = await api<{ workflow_runs: { id: number }[] }>(
    `actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=1`,
  );
  if (!runs[0]) return [];
  return (await api<{ jobs: Job[] }>(`actions/runs/${runs[0].id}/jobs?per_page=100`)).jobs;
};

const reviewedOn = async (number: number, head: string) =>
  reviewedCommit(
    head,
    (await everyItem<{ sha: string }>(`pulls/${number}/commits`, ".[] | {sha}")).map(
      (commit) => commit.sha,
    ),
    (sha) => api(`commits/${sha}`),
  );

const reviewsOn = async (number: number) =>
  readReviews(
    await everyItem(`issues/${number}/comments`, ".[] | {user: {login: .user.login}, body}"),
  );

/** The commit checked out here, if any, so the wait doesn't ask you to pull your own push. */
const localHead = async () => {
  try {
    return (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  } catch {
    return "";
  }
};

// The waiting itself.

const POLL = 30_000;
const QUIET = 5 * 60_000;
const ATTEMPTS = 10;
const clock = () => new Date().toTimeString().slice(0, 5);
const say = (line: string) => console.log(`${clock()} ${line}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks again until a step is done, saying what changed and, when nothing does, what it awaits. */
const loop = async (minutes: number, look: () => Promise<Step>): Promise<Outcome> => {
  const end = Date.now() + minutes * 60_000;
  let misses = 0;
  let waitingFor = "";
  let quietSince = Date.now();
  for (;;) {
    let step: Step;
    try {
      step = await look();
      misses = 0;
    } catch (error) {
      misses++;
      const why = (error as Error).message.split("\n")[0];
      if (misses >= ATTEMPTS) {
        say(`GitHub didn't answer ${ATTEMPTS} times in a row (${why}). Say so, and stop.`);
        return "stuck";
      }
      say(`GitHub didn't answer (${why}); asking again in ${POLL / 1000} s.`);
      await sleep(POLL);
      continue;
    }
    if (step.done) {
      for (const line of step.lines) say(line);
      return step.outcome;
    }
    if (step.waitingFor !== waitingFor || Date.now() - quietSince >= QUIET) {
      say(`Waiting for ${step.waitingFor}.`);
      waitingFor = step.waitingFor;
      quietSince = Date.now();
    }
    if (Date.now() >= end) {
      say(
        `Still waiting for ${step.waitingFor} after ${minutes} minute${minutes === 1 ? "" : "s"}. If it never started, start it once by hand, as ship says; otherwise say so, and stop.`,
      );
      return "stuck";
    }
    await sleep(POLL);
  }
};

const waitForReview = async (number: string, minutes: number) => {
  let head = "";
  let reviewed = "";
  let seen = new Map<string, string>();
  let failed = new Set<string>();
  return loop(minutes, async () => {
    const pr = await pull(number);
    if (pr.state !== "OPEN") return readRound(pr, [], pr.head, null);
    if (pr.head !== head) {
      if (head) {
        say(`A new commit is on the branch: ${short(pr.head)}.`);
        if (pr.head !== (await localHead())) say("Pull it before pushing again.");
      } else say(`Waiting on #${pr.number} at ${short(pr.head)}.`);
      reviewed = await reviewedOn(pr.number, pr.head);
      head = pr.head;
      seen = new Map();
      failed = new Set();
    }
    const checks = await checksOn(pr.head);
    for (const line of progress(seen, checks)) say(line);
    for (const line of failedSteps(failed, await jobsOn(pr.head))) say(line);
    return readRound(pr, checks, reviewed, reviewOf(await reviewsOn(pr.number), reviewed));
  });
};

export type Args = { pr?: string; minutes: number };

/** What the command line asks for, or null when it asks for something the wait can't do. */
export const parseArgs = (args: string[]): Args | null => {
  const rest = [...args];
  const at = rest.indexOf("--minutes");
  const minutes = Number(at >= 0 ? (rest.splice(at, 2)[1] ?? "") : 30);
  if (!(minutes > 0) || rest.length > 1 || rest.some((arg) => arg.startsWith("-"))) return null;
  return { ...(rest[0] ? { pr: rest[0] } : {}), minutes };
};

/** Whether gh's answer means there is no such pull request, rather than GitHub not answering. */
export const noSuchPull = (message: string) =>
  /no pull requests? found|could not resolve to a pullrequest/i.test(message);

/**
 * The pull request's number, found once up front so a wrong number or a branch without a pull
 * request fails at once. GitHub not answering is asked again, as the wait does.
 */
export const findNumber = async (
  look: () => Promise<{ number: number }>,
  pause: (ms: number) => Promise<unknown> = sleep,
): Promise<{ number: string } | { outcome: Outcome; line: string }> => {
  for (let tried = 1; ; tried++) {
    try {
      return { number: String((await look()).number) };
    } catch (error) {
      const why = (error as Error).message.split("\n")[0] ?? "";
      if (noSuchPull(why)) return { outcome: "fix", line: `No such pull request: ${why}` };
      if (tried >= ATTEMPTS)
        return {
          outcome: "stuck",
          line: `GitHub didn't answer ${ATTEMPTS} times in a row (${why}). Say so, and stop.`,
        };
      say(`GitHub didn't answer (${why}); asking again in ${POLL / 1000} s.`);
      await pause(POLL);
    }
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Usage: vp node scripts/wait-for-review.ts [pull request] [--minutes 30]");
    process.exit(EXIT.fix);
  }
  const found = await findNumber(() => pull(args.pr));
  if (!("number" in found)) {
    say(found.line);
    process.exit(EXIT[found.outcome]);
  }
  process.exit(EXIT[await waitForReview(found.number, args.minutes)]);
}
