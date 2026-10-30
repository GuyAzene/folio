import type { AgentNodeView, AgentStatus } from "../../src/desktop/api.ts";
import { formatPages, modelLabel, plural } from "./labels.ts";

/**
 * A job's nodes as the student sees them: one card per agent, in plain words. Folio's own
 * bookkeeping (page preparation, reader and checker groups, attempts a retry replaced) is folded
 * away; the usage of a replaced attempt still counts toward the card that replaced it.
 */
export interface AgentCard {
  node: AgentNodeView;
  /** "Reader", "Writer"; a document's title. */
  name: string;
  /** A quieter suffix to the name, such as "pages 1–3". */
  detail: string;
  /** The model doing the work, or "Folio" for Folio's own code. */
  by: string;
  task: string;
  status: AgentStatus;
  children: AgentCard[];
  /** Requests and tokens of this card, everything under it, and attempts it replaced. */
  calls: number;
  tokens: number;
  start: number | null;
  end: number | null;
  /** Something in this branch is running. */
  live: boolean;
  /** An earlier attempt failed and this card is its retry. */
  retried: boolean;
}

const GROUPS = new Set(["Readers", "Reviewers", "Rechecks"]);

export function agentTree(nodes: AgentNodeView[]): AgentCard | null {
  const ids = new Set(nodes.map((node) => node.id));
  const byParent = new Map<string | null, AgentNodeView[]>();
  for (const node of nodes) {
    const parent = node.parentId !== null && ids.has(node.parentId) ? node.parentId : null;
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(node);
    else byParent.set(parent, [node]);
  }

  // Groups hand their children up; page preparation shows on the document card instead.
  const shown = (node: AgentNodeView): AgentNodeView[] => {
    if (node.role === "prepare") return [];
    if (
      (node.role === "reader" || node.role === "reviewer" || node.role === "recheck") &&
      GROUPS.has(node.title)
    )
      return (byParent.get(node.id) ?? []).flatMap(shown);
    return [node];
  };

  const grow = (node: AgentNodeView): AgentCard => {
    const raw = (byParent.get(node.id) ?? []).flatMap(shown);
    const replaced = new Map<string, AgentNodeView[]>();
    const kept: AgentNodeView[] = [];
    // The same step again: same kind, same pages, at the same attempt or later. A retry after
    // resuming gets the next attempt; a revision follows a finished attempt, so it never
    // replaces one here.
    const step = (node: AgentNodeView) => `${node.role}|${node.pages.join(",")}`;
    raw.forEach((child, index) => {
      const retry = raw
        .slice(index + 1)
        .find((other) => step(other) === step(child) && other.attempt >= child.attempt);
      if (retry && (child.status === "failed" || child.status === "stopped")) {
        replaced.set(retry.id, [...(replaced.get(retry.id) ?? []), child]);
      } else kept.push(child);
    });

    const children = kept.map((child) => {
      const card = grow(child);
      const earlier = (replaced.get(child.id) ?? []).map(grow);
      if (!earlier.length) return card;
      return {
        ...card,
        calls: card.calls + earlier.reduce((sum, item) => sum + item.calls, 0),
        tokens: card.tokens + earlier.reduce((sum, item) => sum + item.tokens, 0),
        retried: true,
      };
    });
    const live = node.status === "running" || children.some((child) => child.live);
    const starts = [
      ...(node.startedAt ? [Date.parse(node.startedAt)] : []),
      ...children.flatMap((child) => (child.start === null ? [] : [child.start])),
    ];
    const ends = [
      ...(node.endedAt ? [Date.parse(node.endedAt)] : []),
      ...children.flatMap((child) => (child.end === null ? [] : [child.end])),
    ];
    return {
      node,
      ...describe(node),
      status: node.status,
      children,
      calls: node.calls + children.reduce((sum, child) => sum + child.calls, 0),
      tokens:
        node.inputTokens +
        node.outputTokens +
        children.reduce((sum, child) => sum + child.tokens, 0),
      start: starts.length ? Math.min(...starts) : null,
      end: live || !ends.length ? null : Math.max(...ends),
      live,
      retried: false,
    };
  };

  const root = (byParent.get(null) ?? []).find((node) => node.role === "run");
  if (!root) return null;
  const tree = grow(root);
  const documents = tree.children.filter((card) => card.node.role === "document").length;
  return {
    ...tree,
    task: `Study ${plural(documents, "document")} into the course's notes`,
  };
}

function describe(node: AgentNodeView): Pick<AgentCard, "name" | "detail" | "by" | "task"> {
  const by = node.provider ? modelLabel(node.model) : "Folio";
  const pages = formatPages(node.pages).toLowerCase();
  switch (node.role) {
    case "run":
      return { name: "Coordinator", detail: "", by: "Folio", task: node.task };
    case "document":
      return { name: node.title, detail: "", by: node.task, task: "" };
    case "brief":
      return {
        name: "Planner",
        detail: "",
        by,
        task: "Plan the topics, the notation and the Hebrew–English terms",
      };
    case "reader":
      return { name: "Reader", detail: pages, by, task: `Read ${pages}, region by region` };
    case "escalation":
      return {
        name: "Close-up",
        detail: pages,
        by,
        task: node.task.replace(/^Re-read (\d)/, "Look again at $1"),
      };
    case "author":
      return node.attempt > 1
        ? { name: "Writer", detail: "revision", by, task: "Fix what the checks found" }
        : node.title.startsWith("Topic · ")
          ? {
              name: "Writer",
              detail: node.title.slice("Topic · ".length),
              by,
              task: `Write this topic from ${pages}, citing every region`,
            }
          : { name: "Writer", detail: "", by, task: "Write the wiki pages, citing every region" };
    case "reviewer":
      return {
        name: "Checker",
        detail: pages,
        by,
        task: "Check every claim against the page images",
      };
    case "fix":
      return { name: "Fixer", detail: pages, by, task: "Correct only what the check found" };
    case "recheck":
      return {
        name: "Checker",
        detail: pages,
        by,
        task: "Check the corrected claims against the page images",
      };
    case "ledger":
      return { name: "Coverage", detail: "", by: "Folio", task: node.task };
    case "publish":
      return { name: "Publish", detail: "", by: "Folio", task: node.task };
    case "prepare":
      return { name: "Pages", detail: "", by: "Folio", task: node.task };
  }
}
