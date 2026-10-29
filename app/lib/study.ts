import type {
  AgentNodeView,
  AgentStatus,
  JobView,
  PageCoverageView,
  StepOutcome,
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

export interface StudyActivity {
  id: string;
  title: string;
  model: string;
  provider: string | null;
  status: AgentStatus;
  tokens: number;
  start: number | null;
  end: number | null;
  retried: boolean;
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
  tokens: number;
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

const pagesOf = (cards: AgentCard[]) =>
  formatPages(cards.flatMap((card) => card.node.pages)).toLowerCase();

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
  brief: () => "Skim the whole document",
  reader: (card) => `Read ${pagesOf([card])}`,
  escalation: (card) => `Look closer at ${pagesOf([card])}`,
  author: (card) => (card.node.attempt > 1 ? "Revise the notes" : "Write the study notes"),
  reviewer: (card) => `Check ${pagesOf([card])} against the slides`,
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
        tokens: 0,
      };

    const all = flatten(card.children);
    const of = (role: AgentNodeView["role"]) => all.filter((item) => item.node.role === role);
    const [briefs, readers, closeups, writers, checkers] = (
      ["brief", "reader", "escalation", "author", "reviewer"] as const
    ).map(of) as [AgentCard[], AgentCard[], AgentCard[], AgentCard[], AgentCard[]];
    const settled = (items: AgentCard[]) =>
      items.length > 0 && items.every((item) => item.status === "done");
    // Outcomes live on the writer and on the checker groups, which the tree folds away.
    const raw = (role: AgentNodeView["role"]) =>
      job.nodes.filter(
        (node) => node.role === role && node.outcome && descends(job.nodes, node, card.node.id),
      );
    const written = raw("author").at(-1)?.outcome;
    const checked = raw("reviewer").at(-1)?.outcome;
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
        "Read every page",
        [...briefs, ...readers],
        allRead && settled(readers),
        card.status !== "running"
          ? ""
          : preparing
            ? "Preparing the pages"
            : pagesRead
              ? `${pagesRead} of ${pages.length} pages · ${waiting.toLowerCase()}`
              : waiting,
        (active) =>
          active.some((item) => item.node.role === "reader")
            ? pagesOf(active.filter((item) => item.node.role === "reader"))
            : "Skimming the whole document first",
        () => `${pagesRead} of ${pages.length} pages`,
      ),
      stage(
        "Look closer at figures",
        closeups,
        later && (closeups.length === 0 || settled(closeups)),
        "",
        (active) => pagesOf(active),
        () => {
          const looked = new Set(closeups.flatMap((item) => item.node.pages)).size;
          return looked
            ? `${plural(looked, "page")} re-read up close`
            : "Nothing needed a closer look";
        },
      ),
      stage(
        "Write study notes",
        writers,
        settled(writers),
        "",
        (active) =>
          active.some((item) => item.node.attempt > 1) ? "Revising after the check" : "",
        () =>
          written?.topics !== undefined
            ? `${plural(written.topics, "topic")} · ${plural(written.sections ?? 0, "section")}`
            : "",
      ),
      stage(
        "Check against the slides",
        checkers,
        settled(checkers) && settled(writers),
        "",
        (active) => pagesOf(active),
        () =>
          checked?.claims !== undefined
            ? `${plural(checked.claims, "claim")} checked${checked.disagreements ? ` · ${checked.disagreements} questioned` : ""}`
            : "",
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
      activity: all
        .filter((item) => ACTIVITY[item.node.role])
        .map((item) => ({
          id: item.node.id,
          title: ACTIVITY[item.node.role]!(item),
          model: modelLabel(item.node.model),
          provider: item.node.provider,
          status: item.status,
          tokens: item.tokens,
          start: item.start,
          end: item.end,
          retried: item.retried,
        }))
        .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity)),
      tokens: card.tokens,
    };
  });
}

function descends(nodes: AgentNodeView[], node: AgentNodeView, ancestor: string): boolean {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  for (let at: AgentNodeView | undefined = node; at; at = byId.get(at.parentId ?? "")) {
    if (at.id === ancestor) return true;
  }
  return false;
}
