// The line's two waits, for whichever agent ships a change to Folio. The ship and land skills in
// .agents/skills say when to run them:
//
//   vp node scripts/line.ts ship [pr]   until CI and the review gate have both spoken on the pull
//                                       request's newest commit; when nothing holds it back,
//                                       has GitHub merge it. The review's notes hold it back
//                                       too, until they're fixed or, with --notes-answered
//                                       <commit>, answered on the pull request
//   vp node scripts/line.ts land [pr]   until the pull request has merged and main's CI on the
//                                       merge has finished, every job of it
//
// Both print a line whenever something changes, so a wait is never silent, and end with one line
// saying what to do next. The exit code says the same: 0 done, 1 something to fix, 2 it's the
// owner's now, 3 it took too long (--minutes, 60 by default), 4 GitHub didn't answer.
// The pull request is the current branch's unless one is named. GitHub is asked through the gh
// CLI, as whoever is signed in to it; nothing here merges past a rule, turns auto-merge off, or
// skips a check.
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ACTIONS_APP,
  GATE_CHECK,
  REVIEW_APP,
  ROUNDS,
  VERDICT_CHECK,
  parseGateNote,
  parseVerdict,
  short,
  type GateNote,
  type Verdict,
} from "./review-gate.ts";

/** The one check a pull request needs to merge: every CI job passed or had nothing to check. */
const CI_CHECK = "CI";

export const EXIT = { done: 0, fix: 1, owner: 2, timeout: 3, github: 4 } as const;
export type Outcome = keyof typeof EXIT;

export type Check = {
  name: string;
  status: string;
  conclusion: string | null;
  app: number;
  title?: string | null;
  text?: string | null;
};
export type Pull = {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  head: string;
  autoMerge: boolean;
  mergeCommit: string | null;
};
export type Step =
  | { done: false; waitingFor: string }
  | { done: true; outcome: Outcome; lines: string[] };

const BAD = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
/**
 * A check counts only from the app that makes it: CI from GitHub Actions, the review's verdict
 * and gate from Folio's review app. Any other check of the same name, such as one a pull
 * request's own workflow posts, is ignored.
 */
const ours = (checks: Check[], name: string) =>
  checks.find(
    (check) => check.name === name && check.app === (name === CI_CHECK ? ACTIONS_APP : REVIEW_APP),
  );
const place = (item: { file?: string; line?: number }) =>
  item.file ? ` (${item.file}${typeof item.line === "number" ? `:${item.line}` : ""})` : "";

/** The checks that failed on a commit, the summary checks themselves left out. */
export const failedChecks = (checks: Check[]) =>
  checks
    .filter((check) => check.status === "completed" && BAD.has(check.conclusion ?? ""))
    .filter((check) => check.name !== CI_CHECK && check.name !== GATE_CHECK)
    .map((check) => `${check.name}: ${check.conclusion}`);

/**
 * What a ship wait knows now: still waiting, or done with an outcome and what to do next.
 * `answered` is the commit whose review's notes the agent answered on the pull request.
 */
export const readShip = (
  pr: Pull,
  checks: Check[],
  verdict: Verdict | null,
  note: GateNote | null,
  answered = "",
): Step => {
  if (pr.state === "MERGED")
    return {
      done: true,
      outcome: "done",
      lines: [`#${pr.number} has merged. Next: land.`],
    };
  if (pr.state === "CLOSED")
    return {
      done: true,
      outcome: "owner",
      lines: [`#${pr.number} was closed without merging. Ask the owner before reopening it.`],
    };
  if (pr.draft)
    return {
      done: true,
      outcome: "fix",
      lines: [
        `#${pr.number} is a draft, which isn't reviewed. Mark it ready (gh pr ready ${pr.number}) and ship again.`,
      ],
    };
  const ci = ours(checks, CI_CHECK);
  const gate = ours(checks, GATE_CHECK);
  if (!ci || ci.status !== "completed") return { done: false, waitingFor: "CI" };
  if (!gate || !note) return { done: false, waitingFor: `the review gate on ${short(pr.head)}` };
  if (note.lane === "wait")
    return { done: false, waitingFor: `the review of ${short(note.reviewed)}` };

  const failed = failedChecks(checks);
  const findings = note.lane === "fix" ? (verdict?.open ?? []) : [];
  if (ci.conclusion !== "success" || findings.length || note.lane === "fix") {
    const lines = [`#${pr.number} at ${short(pr.head)} has something to fix:`];
    if (ci.conclusion !== "success")
      lines.push(
        `- CI ${ci.conclusion}${failed.length ? `: ${failed.join(", ")}` : ""}. Read the failed jobs' logs and fix the cause; never re-run a check to get past it.`,
      );
    for (const item of findings)
      lines.push(`- ${item.id}${place(item)}: ${item.title}. ${item.why}`);
    if (note.lane === "fix" && !findings.length)
      lines.push(`- ${gate.title ?? "the review gate failed"}`);
    lines.push(
      "Fix them in this branch, run the checks, push, and ship again. If a finding is wrong, reply on the pull request with why and add the \"needs owner\" label: then it's the owner's.",
    );
    return { done: true, outcome: "fix", lines };
  }
  // Notes don't fail the gate, but the line fixes or answers them before anything merges, so a
  // review stops only when nothing worth doing is left. After the last round, they stay open. A
  // pass merges only once its verdict is read, so no note goes by unseen; the owner's lane may
  // have no verdict at all, since Claude doesn't review some pull requests.
  const reviewed = short(note.reviewed);
  if (note.lane === "merge" && verdict?.sha !== note.reviewed)
    return { done: false, waitingFor: `the review's verdict on ${reviewed}` };
  const notes = verdict?.sha === note.reviewed ? verdict.notes : [];
  const lastRound = (verdict?.round ?? 0) >= ROUNDS;
  if (notes.length && !lastRound && !(answered.length >= 7 && note.reviewed.startsWith(answered)))
    return {
      done: true,
      outcome: "fix",
      lines: [
        `#${pr.number} at ${short(pr.head)} passed, but the review of ${reviewed} left notes:`,
        ...notes.map((item) => `- ${item.title}${place(item)}. ${item.why}`),
        "Fix the ones that are right and within this pull request's scope, run the checks, push, and ship again. Don't change correct code just to satisfy the review.",
        `For each note you leave, reply on the pull request with why, then ship again with --notes-answered ${reviewed}.`,
      ],
    };
  const leftOpen = notes.length
    ? [
        `Notes ${lastRound ? `left open after ${verdict!.round} rounds` : "answered on the pull request"}: ${notes.map((item) => item.title).join("; ")}.`,
      ]
    : [];
  if (note.lane === "owner")
    return {
      done: true,
      outcome: "owner",
      lines: [
        `#${pr.number} passed CI, and the owner merges it with GitHub's merge button: ${gate.title ?? "the review gate"}.`,
        ...leftOpen,
        "Tell the owner in one line, then stop. Don't merge it, and don't turn auto-merge on. If the owner says to merge it, merge it normally, never with --admin.",
      ],
    };
  return {
    done: true,
    outcome: "done",
    lines: [
      pr.autoMerge
        ? `#${pr.number} passed CI and the review gate, and auto-merge is on: GitHub merges it. Next: land.`
        : `#${pr.number} passed CI and the review gate. Next: land.`,
      ...leftOpen,
    ],
  };
};

export type Run = { id: number; head: string; status: string; conclusion: string | null };

/** What a land wait knows now. */
export const readLand = (pr: Pull, run: Run | null, failedJobs: string[]): Step => {
  if (pr.state === "CLOSED")
    return {
      done: true,
      outcome: "owner",
      lines: [`#${pr.number} was closed without merging, so nothing landed.`],
    };
  if (pr.state === "OPEN") return { done: false, waitingFor: `#${pr.number} to merge` };
  if (!run || run.status !== "completed")
    return { done: false, waitingFor: `main's CI on ${short(run?.head ?? pr.mergeCommit ?? "")}` };
  if (run.conclusion === "success")
    return {
      done: true,
      outcome: "done",
      lines: [
        `#${pr.number} landed: main is green at ${short(run.head)}. Remove this task's worktree and branch, and tell the owner in one line.`,
      ],
    };
  return {
    done: true,
    outcome: "fix",
    lines: [
      `main isn't green at ${short(run.head)}: its CI ended in ${run.conclusion}${failedJobs.length ? ` (${failedJobs.join(", ")})` : ""}.`,
      "Fixing main comes before anything else: find the cause in the failed jobs' logs, then fix it in a new pull request from main.",
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
    const said = check.name === GATE_CHECK && check.title ? `: ${check.title}` : "";
    lines.push(`${mark} ${check.name}${said || (mark === "✓" ? "" : `: ${check.conclusion}`)}`);
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

type PullView = {
  number: number;
  state: Pull["state"];
  isDraft: boolean;
  headRefOid: string;
  autoMergeRequest: unknown;
  mergeCommit: { oid: string } | null;
};
const pull = async (number?: string): Promise<Pull> => {
  const view = JSON.parse(
    await gh([
      "pr",
      "view",
      ...(number ? [number] : []),
      "--json",
      "number,state,isDraft,headRefOid,autoMergeRequest,mergeCommit",
    ]),
  ) as PullView;
  return {
    number: view.number,
    state: view.state,
    draft: view.isDraft,
    head: view.headRefOid,
    autoMerge: !!view.autoMergeRequest,
    mergeCommit: view.mergeCommit?.oid ?? null,
  };
};

type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  app: { id: number } | null;
  output: { title: string | null; text: string | null };
};
const checksOn = async (sha: string): Promise<Check[]> => {
  const { check_runs: runs } = await api<{ check_runs: CheckRun[] }>(
    `commits/${sha}/check-runs?filter=latest&per_page=100`,
  );
  return runs.map((run) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    app: run.app?.id ?? 0,
    title: run.output.title,
    text: run.output.text,
  }));
};

const verdictOn = async (sha: string) => {
  const checks = await checksOn(sha);
  return parseVerdict(ours(checks, VERDICT_CHECK)?.text);
};

type WorkflowRun = { id: number; head_sha: string; status: string; conclusion: string | null };
const toRun = (run: WorkflowRun | undefined): Run | null =>
  run ? { id: run.id, head: run.head_sha, status: run.status, conclusion: run.conclusion } : null;
const mainRun = async (sha?: string) => {
  const { workflow_runs: runs } = await api<{ workflow_runs: WorkflowRun[] }>(
    `actions/workflows/ci.yml/runs?branch=main&event=push&per_page=1${sha ? `&head_sha=${sha}` : ""}`,
  );
  return toRun(runs[0]);
};
const failedJobs = async (run: Run) => {
  const { jobs } = await api<{ jobs: { name: string; conclusion: string | null }[] }>(
    `actions/runs/${run.id}/jobs?per_page=100`,
  );
  return jobs
    .filter((job) => BAD.has(job.conclusion ?? "") && job.name !== CI_CHECK)
    .map((job) => `${job.name}: ${job.conclusion}`);
};

/** The jobs of CI's newest run on a commit, with their steps. */
const jobsOn = async (sha: string) => {
  const { workflow_runs: runs } = await api<{ workflow_runs: WorkflowRun[] }>(
    `actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=1`,
  );
  if (!runs[0]) return [];
  const { jobs } = await api<{ jobs: Job[] }>(`actions/runs/${runs[0].id}/jobs?per_page=100`);
  return jobs;
};

/** The commit checked out here, if any, so the wait doesn't ask you to pull your own push. */
const localHead = async () => {
  try {
    return (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  } catch {
    return "";
  }
};

const commitLine = async (sha: string) => {
  const commit = await api<{ commit: { message: string }; author: { login: string } | null }>(
    `commits/${sha}`,
  );
  return `${commit.commit.message.split("\n")[0]} (${commit.author?.login ?? "unknown"})`;
};

// The waiting itself.

const POLL = 30_000;
const QUIET = 5 * 60_000;
const ATTEMPTS = 10;
const clock = () => new Date().toTimeString().slice(0, 5);
const say = (line: string) => console.log(`${clock()} ${line}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks again until a step is done, saying what changed and, when nothing does, what it awaits. */
const wait = async (minutes: number, look: () => Promise<Step>): Promise<Outcome> => {
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
        say(`GitHub didn't answer ${ATTEMPTS} times in a row (${why}). Try again later.`);
        return "github";
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
        `Still waiting for ${step.waitingFor} after ${minutes} minute${minutes === 1 ? "" : "s"}. Say so, with this line.`,
      );
      return "timeout";
    }
    await sleep(POLL);
  }
};

const ship = async (number: string | undefined, minutes: number, answered = "") => {
  let head = "";
  let seen = new Map<string, string>();
  let failed = new Set<string>();
  // A commit's verdict is written once, so it's read once.
  let verdict: Verdict | null = null;
  return wait(minutes, async () => {
    const pr = await pull(number);
    number ??= String(pr.number);
    if (pr.head !== head) {
      if (head) {
        say(`A new commit is on the branch: ${short(pr.head)} ${await commitLine(pr.head)}.`);
        say(
          pr.head === (await localHead())
            ? "Waiting on it now."
            : "Pull it before pushing again. Waiting on it now.",
        );
      } else say(`Shipping #${pr.number} at ${short(pr.head)}.`);
      head = pr.head;
      seen = new Map();
      failed = new Set();
    }
    const checks = pr.state === "OPEN" ? await checksOn(pr.head) : [];
    for (const line of progress(seen, checks)) say(line);
    if (pr.state === "OPEN")
      for (const line of failedSteps(failed, await jobsOn(pr.head))) say(line);
    const note = parseGateNote(ours(checks, GATE_CHECK)?.text);
    if (note && note.lane !== "wait" && verdict?.sha !== note.reviewed)
      verdict = await verdictOn(note.reviewed);
    const step = readShip(pr, checks, verdict, note, answered);
    if (!step.done || step.outcome !== "done" || pr.state !== "OPEN" || pr.autoMerge) return step;
    // The one place anything merges: CI and the gate passed on this very commit. GitHub still
    // merges only once its own rules allow it, and nothing here turns auto-merge off.
    say("Nothing holds it back: having GitHub merge it (squash).");
    try {
      say(
        (await arm(pr.number, pr.head)) === "merged"
          ? "GitHub's rules already allowed it, so it merged at once."
          : "Auto-merge is on.",
      );
    } catch (error) {
      return {
        done: true,
        outcome: "owner",
        lines: [
          `GitHub refused to merge #${pr.number}: ${(error as Error).message.split("\n")[0]}`,
          "Tell the owner in one line, then stop.",
        ],
      };
    }
    return readShip(await pull(number), checks, verdict, note, answered);
  });
};

/**
 * Has GitHub merge a pull request, squashed: auto-merge, which waits for GitHub's rules. GitHub
 * won't queue one its rules already let merge (it answers that it's in "clean status"); that one
 * is merged at once, as auto-merge would have. Never `--admin`, so never past a rule. Both are
 * pinned to the commit that passed, so a push in between makes GitHub refuse rather than merge a
 * commit nobody checked.
 */
export const arm = async (
  number: number,
  head: string,
  run: (args: string[]) => Promise<unknown> = gh,
) => {
  const merge = ["pr", "merge", String(number), "--squash", "--match-head-commit", head];
  try {
    await run([...merge, "--auto"]);
    return "queued" as const;
  } catch (error) {
    if (!/clean status/i.test((error as Error).message)) throw error;
    await run(merge);
    return "merged" as const;
  }
};

const land = async (number: string | undefined, minutes: number) => {
  let following: string | null = null;
  const seen = new Map<string, string>();
  return wait(minutes, async () => {
    const pr = await pull(number);
    number ??= String(pr.number);
    if (pr.state !== "MERGED" || !pr.mergeCommit) return readLand(pr, null, []);
    let run = await mainRun(following ?? pr.mergeCommit);
    if (run?.status === "completed" && run.conclusion === "cancelled") {
      // A newer push to main cancels the older run; the newer one carries this change too.
      const newest = await mainRun();
      if (newest && newest.head !== run.head) {
        say(`main moved on to ${short(newest.head)}, whose CI includes this change: following it.`);
        following = newest.head;
        run = newest;
      }
    }
    if (run) for (const line of progress(seen, await checksOn(run.head))) say(line);
    return readLand(pr, run, run?.status === "completed" ? await failedJobs(run) : []);
  });
};

export type Args = { name: "ship" | "land"; pr?: string; minutes: number; answered?: string };

/** What the command line asks for, or null when it asks for something the waits can't do. */
export const parseArgs = ([name, ...rest]: string[]): Args | null => {
  const option = (flag: string) => {
    const at = rest.indexOf(flag);
    return at >= 0 ? (rest.splice(at, 2)[1] ?? "") : undefined;
  };
  const minutes = Number(option("--minutes") ?? 60);
  const answered = option("--notes-answered");
  if ((name !== "ship" && name !== "land") || !(minutes > 0) || rest.length > 1) return null;
  // A commit named in at least seven characters, and only for ship, which reads the notes.
  if (answered !== undefined && (name !== "ship" || answered.length < 7)) return null;
  return { name, ...(rest[0] ? { pr: rest[0] } : {}), minutes, ...(answered ? { answered } : {}) };
};

const commands = { ship, land };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      "Usage: vp node scripts/line.ts ship|land [pull request] [--minutes 60] [--notes-answered <commit>]",
    );
    process.exit(EXIT.fix);
  }
  // Found once up front, so a wrong number or a branch without a pull request fails at once
  // instead of being asked about again and again.
  let number: string;
  try {
    number = String((await pull(args.pr)).number);
  } catch (error) {
    say(`No such pull request: ${(error as Error).message.split("\n")[0]}`);
    process.exit(EXIT.fix);
  }
  process.exit(EXIT[await commands[args.name](number, args.minutes, args.answered)]);
}
