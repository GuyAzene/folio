import {
  REUSED_STEP,
  type AgentNodeView,
  type AgentStatus,
  type JobView,
  type PageCoverageView,
  type StepOutcome,
  type StudyNotesView,
  type StudyTopicView,
} from "../../src/desktop/api.ts";
import { DROPPED } from "../../src/dropped.ts";
import { agentTree, type AgentCard } from "./agent-tree.ts";
import { formatPages, modelLabel, plural } from "./labels.ts";

/**
 * A study job as a student follows it: per document, four plain stages and what each produced,
 * the slides being read right now, and the model doing the current part. Folio's own steps and
 * retried attempts stay out of sight; "Show activity" lists the model work for those who want it.
 */

export type StageState = "pending" | "running" | "done" | "failed";

export interface StudyStage {
  label: string;
  state: StageState;
  /** What the stage produced, or what it is doing now. */
  detail: string;
  /** The model doing the current part, while it runs. */
  model: string | null;
  provider: string | null;
}

/** The kinds of work a study does, in the order a study does them. */
export type ActivityStep = "plan" | "read" | "closer" | "write" | "check" | "fix" | "recheck";

export interface StudyActivity {
  id: string;
  step: ActivityStep;
  title: string;
  model: string;
  provider: string | null;
  status: AgentStatus;
  tokens: number;
  start: number | null;
  end: number | null;
  retried: boolean;
  /** Slides the request covered. */
  slides: number[];
  /** Its saved result from an earlier study of the same file was used, so it made no request. */
  reused: boolean;
}

/** One kind of work, as one line that opens to its requests. */
export interface StudyActivityGroup {
  step: ActivityStep;
  title: string;
  /** How far along it is: "40 of 62 slides", "17 topics". */
  detail: string;
  status: AgentStatus;
  /** Every request in it was reused from an earlier study. */
  reused: boolean;
  model: string;
  provider: string | null;
  tokens: number;
  start: number | null;
  end: number | null;
  items: StudyActivity[];
}

export interface StudyDocument {
  documentId: string;
  /** "Lecture 3" and "Shortest paths", from "Lecture 3 Shortest paths". */
  title: string;
  subtitle: string;
  status: AgentStatus;
  start: number | null;
  end: number | null;
  pages: PageCoverageView[];
  /** Pages a model is reading or looking at right now. */
  activePages: number[];
  pagesRead: number;
  stages: StudyStage[];
  outcome: StepOutcome | null;
  problem: { message: string; detail: string } | null;
  activity: StudyActivity[];
  /** The activity by kind of work, in study order. */
  activityGroups: StudyActivityGroup[];
  tokens: number;
}

/** A course's topics in the order it first teaches them: by session, then by slide. */
export function topicsInOrder(notes: StudyNotesView): StudyTopicView[] {
  const rank = new Map<string, number>();
  notes.sessions.forEach((session, at) =>
    session.topics.forEach((slug, index) => {
      if (!rank.has(slug)) rank.set(slug, at * 1000 + index);
    }),
  );
  return [...notes.topics].sort(
    (a, b) =>
      (rank.get(a.slug) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.slug) ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title),
  );
}

export function splitTitle(title: string): { title: string; subtitle: string } {
  const match = /^((?:lecture|recitation|tutorial|week)\s*\d+)[\s:.\-–·]*(.*)$/i.exec(title);
  return match && match[2] ? { title: match[1]!, subtitle: match[2] } : { title, subtitle: "" };
}

/** A failure note in plain words; the original stays available as detail. */
export function explain(note: string | null): string {
  if (!note) return "Something went wrong.";
  if (/required format|no JSON object|invalid JSON/i.test(note))
    return "The model's answer came back in the wrong shape twice, so Folio didn't use it.";
  if (/cut off/i.test(note))
    return "The model's answer was cut off before it finished, so Folio didn't use it.";
  if (/usage[_ ]limit|rate[_ ]limit|quota|429/i.test(note))
    return "Your ChatGPT plan reached its usage limit. Resume once it resets.";
  // Folio already tried again before saying so (src/ingest/pi-complete.ts).
  if (DROPPED.test(note))
    return "Folio kept losing its connection to ChatGPT. Check your internet connection, then resume.";
  if (/no longer matches/i.test(note)) return "The file changed after it was imported.";
  if (/Interrupted when Folio closed/i.test(note))
    return "Folio was closed while this was running.";
  // The pipeline's PUBLISH_FAILED prefix: every document finished, only adding them failed.
  if (/couldn't be added to the course|UNIQUE constraint failed: blocks/i.test(note))
    return "The study notes were written, but Folio couldn't add them to the course, so nothing in the course changed.";
  return note;
}

const flatten = (cards: AgentCard[]): AgentCard[] =>
  cards.flatMap((card) => [card, ...flatten(card.children)]);

/** "slide 3" or "slides 3–4": a lecture's pages are its slides. */
const pagesOf = (cards: AgentCard[]) =>
  formatPages(cards.flatMap((card) => card.node.pages))
    .toLowerCase()
    .replace(/^page/, "slide");

function stage(
  label: string,
  items: AgentCard[],
  done: boolean,
  idle: string,
  running: (items: AgentCard[]) => string,
  finished: () => string,
): StudyStage {
  const active = items.filter((item) => item.status === "running");
  if (items.some((item) => item.status === "failed"))
    return { label, state: "failed", detail: "Couldn't finish", model: null, provider: null };
  if (active.length)
    return {
      label,
      state: "running",
      detail: running(active),
      model: modelLabel(active[0]!.node.model),
      provider: active[0]!.node.provider,
    };
  if (done) return { label, state: "done", detail: finished(), model: null, provider: null };
  return { label, state: "pending", detail: idle, model: null, provider: null };
}

const ACTIVITY: Partial<Record<AgentNodeView["role"], (card: AgentCard) => string>> = {
  brief: () => "Plan the topics",
  reader: (card) => `Read ${pagesOf([card])}`,
  escalation: (card) => `Look closer at ${pagesOf([card])}`,
  author: (card) =>
    card.node.attempt > 1
      ? "Revise the notes"
      : card.node.title.startsWith("Topic · ")
        ? `Write ${card.node.title.slice("Topic · ".length)}`
        : "Write the study notes",
  reviewer: (card) => `Check ${pagesOf([card])}`,
  fix: (card) => {
    const [, round, part] = /round (\d+)(?: · part (\d+))?/.exec(card.node.title) ?? [];
    return `${round && round !== "1" ? "Fix again" : "Fix what the check found"}${part ? `, part ${part}` : ""}`;
  },
  recheck: (card) => `Recheck ${pagesOf([card])}`,
};

export function studyDocuments(job: JobView, titleOf: (id: string) => string): StudyDocument[] {
  const root = agentTree(job.nodes);
  const branches = root?.children.filter((card) => card.node.role === "document") ?? [];
  return job.documentIds.map((documentId, index) => {
    const name = titleOf(documentId);
    const card = branches.find((branch) => branch.node.title === name) ?? branches[index];
    const pages = job.coverage
      .filter((cell) => cell.documentId === documentId)
      .sort((a, b) => a.page - b.page);
    const pagesRead = pages.filter((cell) => cell.state !== "pending").length;
    const { title, subtitle } = splitTitle(name);
    if (!card)
      return {
        documentId,
        title,
        subtitle,
        status: "queued" as const,
        start: null,
        end: null,
        pages,
        activePages: [],
        pagesRead,
        stages: [],
        outcome: null,
        problem: null,
        activity: [],
        activityGroups: [],
        tokens: 0,
      };

    // What failed or stopped before the study last started again is history, not its state.
    const since = card.node.startedAt;
    const all = flatten(card.children).filter(
      (item) =>
        !(
          (item.status === "failed" || item.status === "stopped") &&
          since !== null &&
          item.node.endedAt !== null &&
          item.node.endedAt < since
        ),
    );
    const of = (role: AgentNodeView["role"]) => all.filter((item) => item.node.role === role);
    const [briefs, readers, closeups, writers, checkers, fixes, rechecked] = (
      ["brief", "reader", "escalation", "author", "reviewer", "fix", "recheck"] as const
    ).map(of) as [
      AgentCard[],
      AgentCard[],
      AgentCard[],
      AgentCard[],
      AgentCard[],
      AgentCard[],
      AgentCard[],
    ];
    const settled = (items: AgentCard[]) =>
      items.length > 0 && items.every((item) => item.status === "done");
    // Outcomes live on the writer and on the checker groups, which the tree folds away.
    const raw = (role: AgentNodeView["role"]) =>
      job.nodes.filter(
        (node) => node.role === role && node.outcome && descends(job.nodes, node, card.node.id),
      );
    // A lecture of several topics has a writer per topic, side by side; what they wrote together
    // is the document's own outcome once it is done.
    const toWrite = raw("brief")[0]?.outcome?.topics ?? 0;
    const topicWriters = toWrite > 2;
    const written = topicWriters
      ? (card.node.outcome ??
        raw("author")
          .filter((node) => node.attempt === 1)
          .reduce<StepOutcome>(
            (sum, node) => ({
              topics: (sum.topics ?? 0) + (node.outcome?.topics ?? 0),
              sections: (sum.sections ?? 0) + (node.outcome?.sections ?? 0),
            }),
            {},
          ))
      : raw("author").at(-1)?.outcome;
    const checked = raw("reviewer")[0]?.outcome;
    // The first write and its check, then what fixing brought: fix rounds and their rechecks.
    // Studies before patches revised by writing the notes again, checked by the same checkers.
    const order = (item: AgentCard) => job.nodes.findIndex((node) => node.id === item.node.id);
    const firstWrites = writers.filter((item) => item.node.attempt === 1);
    const wroteTopics = firstWrites.filter((item) => item.status === "done").length;
    const revisions = writers.filter((item) => item.node.attempt > 1);
    const fixing = [...revisions, ...fixes];
    const fixFrom = fixing.length ? Math.min(...fixing.map(order)) : Infinity;
    const firstChecks = checkers.filter((item) => order(item) < fixFrom);
    const rechecks = [...checkers.filter((item) => order(item) > fixFrom), ...rechecked];
    const fixedText = (): string => {
      const outcome = card.node.outcome?.discrepancies
        ? card.node.outcome
        : (() => {
            // A round may be sent in parts; the first round's parts together are what was found.
            const rounds = raw("fix");
            const first = Math.min(...rounds.map((node) => node.attempt));
            const found = rounds
              .filter((node) => node.attempt === first)
              .reduce((sum, node) => sum + (node.outcome?.discrepancies ?? 0), 0);
            const fixed = rounds.reduce((sum, node) => sum + (node.outcome?.fixed ?? 0), 0);
            return { discrepancies: found, fixed: Math.min(found, fixed) };
          })();
      if (outcome.discrepancies) return `${outcome.fixed ?? 0} of ${outcome.discrepancies} fixed`;
      return revisions.length ? `Fixed in ${plural(revisions.length, "round")}` : "Nothing to fix";
    };
    const allRead = pages.length > 0 && pagesRead === pages.length;
    // Close-ups can start until the last page is read; after that, writing begins.
    const later = card.status === "done" || writers.some((item) => item.status !== "queued");
    const preparing = job.nodes.some(
      (node) =>
        node.role === "prepare" &&
        node.status === "running" &&
        descends(job.nodes, node, card.node.id),
    );
    // Model requests are shared by everything being studied, a few at a time, with documents
    // taking turns: pages that are not being read yet are waiting for their turn.
    const waiting = "Waiting for its turn";

    const stages = [
      stage(
        "Read every slide",
        [...briefs, ...readers],
        allRead && settled(readers),
        card.status !== "running"
          ? ""
          : preparing
            ? "Preparing the slides"
            : pagesRead
              ? `${pagesRead} of ${pages.length} slides · ${waiting.toLowerCase()}`
              : waiting,
        (active) =>
          active.some((item) => item.node.role === "reader")
            ? pagesOf(active.filter((item) => item.node.role === "reader"))
            : "Planning the topics",
        () =>
          readers.length && readers.every((item) => item.node.note === REUSED_STEP)
            ? `${pagesRead} of ${pages.length} slides · from an earlier study`
            : `${pagesRead} of ${pages.length} slides`,
      ),
      stage(
        "Look closer where needed",
        closeups,
        later && (closeups.length === 0 || settled(closeups)),
        "",
        (active) => pagesOf(active),
        () => {
          const looked = new Set(closeups.flatMap((item) => item.node.pages)).size;
          return looked
            ? `${plural(looked, "slide")} re-read up close`
            : "Nothing needed a closer look";
        },
      ),
      stage(
        "Write the study notes",
        firstWrites,
        topicWriters ? toWrite <= wroteTopics || card.status === "done" : settled(firstWrites),
        topicWriters && wroteTopics ? `${wroteTopics} of ${toWrite} topics written` : "",
        () => (topicWriters ? `${wroteTopics} of ${toWrite} topics written` : ""),
        () =>
          written?.topics !== undefined
            ? `${plural(written.topics, "topic")} · ${plural(written.sections ?? 0, "section")}`
            : "",
      ),
      stage(
        "Check against the slides",
        firstChecks,
        settled(firstChecks) && settled(firstWrites),
        "",
        (active) => pagesOf(active),
        () =>
          checked?.regions !== undefined
            ? `${plural(checked.claims ?? 0, "claim")} · ${plural(checked.regions, "region")} checked${checked.discrepancies ? ` · ${checked.discrepancies} to fix` : ""}`
            : checked?.claims !== undefined
              ? `${plural(checked.claims, "claim")} checked${checked.disagreements ? ` · ${checked.disagreements} questioned` : ""}`
              : "",
      ),
      stage(
        "Fix what the check found",
        [...fixing, ...rechecks],
        card.status === "done" ||
          (fixing.length > 0 && settled(fixing) && (!rechecks.length || settled(rechecks))),
        "",
        (active) => {
          const checking = active.filter(
            (item) => item.node.role === "reviewer" || item.node.role === "recheck",
          );
          return checking.length
            ? `Rechecking ${pagesOf(checking)}`
            : "Fixing what the check found";
        },
        fixedText,
      ),
    ];

    // A later stage whose requests are queued behind other documents says so too.
    if (card.status === "running" && !stages.some((item) => item.state === "running")) {
      const next = stages.find((item) => item.state === "pending");
      if (next && !next.detail) next.detail = waiting;
    }

    const failed = all.find((item) => item.status === "failed");
    const problemNote =
      failed?.node.note ??
      (card.status === "failed" || (job.status === "failed" && card.status !== "done")
        ? (root?.node.note ?? null)
        : null);

    // Each line times its own request; a step a restart stopped leaves the list until it runs
    // again, unless the whole study stopped. A reused step made no request and takes no time.
    const activity: StudyActivity[] = all
      .filter(
        (item) =>
          ACTIVITY[item.node.role] && (item.status !== "stopped" || card.status === "stopped"),
      )
      .map((item) => {
        const reused = item.node.note === REUSED_STEP;
        return {
          id: item.node.id,
          step: STEP[item.node.role]!,
          title: ACTIVITY[item.node.role]!(item),
          model: modelLabel(item.node.model),
          provider: item.node.provider,
          status: item.status,
          tokens: item.node.inputTokens + item.node.outputTokens,
          start: reused ? null : item.node.startedAt ? Date.parse(item.node.startedAt) : item.start,
          end: reused ? null : item.node.endedAt ? Date.parse(item.node.endedAt) : null,
          retried: item.retried,
          slides: item.node.pages,
          reused,
        };
      })
      // Reused steps first, as they came first; then by start, with steps not yet started last.
      .sort(
        (a, b) =>
          (a.start ?? (a.reused ? -Infinity : Infinity)) -
          (b.start ?? (b.reused ? -Infinity : Infinity)),
      );

    return {
      documentId,
      title,
      subtitle,
      status: card.status,
      start: card.start,
      end: card.end,
      pages,
      activePages: [
        ...new Set(
          all
            .filter(
              (item) =>
                item.status === "running" &&
                (item.node.role === "reader" || item.node.role === "escalation"),
            )
            .flatMap((item) => item.node.pages),
        ),
      ],
      pagesRead,
      stages,
      outcome: card.node.outcome,
      problem:
        problemNote || card.status === "failed"
          ? { message: explain(problemNote), detail: problemNote ?? "" }
          : null,
      // Each line times its own request, not the close-ups that hang under a reader; a step a
      // restart stopped leaves the list until it runs again, unless the whole study stopped.
      activity,
      activityGroups: activityGroups(activity, { read: pages.length, write: toWrite }),
      tokens: card.tokens,
    };
  });
}

const STEP: Partial<Record<AgentNodeView["role"], ActivityStep>> = {
  brief: "plan",
  reader: "read",
  escalation: "closer",
  author: "write",
  reviewer: "check",
  fix: "fix",
  recheck: "recheck",
};

const STEPS: Record<ActivityStep, { title: string; unit: "slide" | "topic" | "part" }> = {
  plan: { title: "Plan the topics", unit: "part" },
  read: { title: "Read the slides", unit: "slide" },
  closer: { title: "Look closer", unit: "slide" },
  write: { title: "Write the topics", unit: "topic" },
  check: { title: "Check against the slides", unit: "slide" },
  fix: { title: "Fix what the check found", unit: "part" },
  recheck: { title: "Recheck what changed", unit: "slide" },
};

/**
 * The activity as one line per kind of work, in study order: how much of it is done, its time
 * from first request to last, and its tokens. `expected` is how many there will be, where the
 * study knows before every request exists (slides to read, topics to write).
 */
export function activityGroups(
  activity: StudyActivity[],
  expected: Partial<Record<ActivityStep, number>> = {},
): StudyActivityGroup[] {
  return (Object.keys(STEPS) as ActivityStep[]).flatMap((step) => {
    const items = activity.filter((item) => item.step === step);
    if (!items.length) return [];
    const { title, unit } = STEPS[step];
    const finished = items.filter((item) => item.status === "done");
    const running = items.some((item) => item.status === "running");
    const failed = items.some((item) => item.status === "failed");
    const status: AgentStatus = running
      ? "running"
      : failed
        ? "failed"
        : finished.length === items.length
          ? "done"
          : "queued";
    // Slides counted once each; topics and parts by request.
    const count = (list: StudyActivity[]) =>
      unit === "slide" ? new Set(list.flatMap((item) => item.slides)).size : list.length;
    const total = Math.max(count(items), expected[step] ?? 0);
    const done = count(finished);
    const detail =
      step === "plan" || total === 0
        ? ""
        : status === "done"
          ? plural(total, unit)
          : `${done} of ${plural(total, unit)}`;
    const starts = items.flatMap((item) => (item.start === null ? [] : [item.start]));
    const ends = items.flatMap((item) => (item.end === null ? [] : [item.end]));
    return [
      {
        step,
        title,
        detail,
        status,
        reused: items.every((item) => item.reused),
        model: items[0]!.model,
        provider: items[0]!.provider,
        tokens: items.reduce((sum, item) => sum + item.tokens, 0),
        start: starts.length ? Math.min(...starts) : null,
        end: status === "done" && ends.length ? Math.max(...ends) : null,
        items,
      },
    ];
  });
}

/**
 * One document's study as a single line and bar: what Folio is doing now, in plain words, and
 * how far along it is. Reading the pages is most of the work, so it fills most of the bar.
 */
export function studyProgress(study: StudyDocument): { phase: string; fraction: number } {
  if (study.status === "done") return { phase: "Done", fraction: 1 };
  if (study.status === "queued" || !study.stages.length) return { phase: "Starting", fraction: 0 };
  const [read, closer, write, check, fix] = study.stages;
  const pages = study.pages.length;
  const reading = pages ? (0.55 * study.pagesRead) / pages : 0;
  const waiting = (stage: StudyStage | undefined) => stage?.detail === "Waiting for its turn";
  if (read && read.state !== "done")
    return {
      phase:
        read.detail === "Preparing the slides"
          ? "Preparing the slides"
          : waiting(read)
            ? "Waiting for its turn"
            : "Reading the slides",
      fraction: reading,
    };
  if (closer?.state === "running") return { phase: "Looking closer where needed", fraction: 0.6 };
  if (write && write.state !== "done")
    return {
      phase:
        write.state === "running"
          ? write.detail || "Writing the study notes"
          : waiting(write)
            ? "Waiting for its turn"
            : "Writing the study notes",
      fraction: 0.7,
    };
  if (check && check.state !== "done")
    return {
      phase: waiting(check) ? "Waiting for its turn" : "Checking against the slides",
      fraction: 0.85,
    };
  if (fix?.state === "running")
    return { phase: fix.detail || "Fixing what the check found", fraction: 0.92 };
  return { phase: "Adding to the study notes", fraction: 0.97 };
}

function descends(nodes: AgentNodeView[], node: AgentNodeView, ancestor: string): boolean {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  for (let at: AgentNodeView | undefined = node; at; at = byId.get(at.parentId ?? "")) {
    if (at.id === ancestor) return true;
  }
  return false;
}
