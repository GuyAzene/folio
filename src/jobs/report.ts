import type { DatabaseSync } from "node:sqlite";

/**
 * Where a study's time goes, read from the agent tree in jobs.sqlite: per document, each kind of
 * step with its model calls, output tokens and minutes. Read-only; it measures the pipeline
 * rather than changing it, so a change to the pipeline is judged by numbers, not impressions.
 */

/** One kind of step in one document's study. */
export interface StepTiming {
  /**
   * The node's role. An author's attempts after the first are "revision": studies from before
   * patch fixes rewrote the whole draft; newer ones have "fix" and "recheck" steps instead.
   */
  step: string;
  nodes: number;
  calls: number;
  inputTokens: number;
  /** The part of the input the provider served from its prompt cache; null when not recorded. */
  cachedTokens: number | null;
  outputTokens: number;
  /** Each step's own duration, added up: steps that ran side by side all count. */
  busyMinutes: number;
  /** From the first of these steps starting to the last one ending. */
  spanMinutes: number;
}

export interface DocumentTiming {
  jobId: string;
  /** The document's node in the job's agent tree. */
  nodeId: string;
  title: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  /** In the order each kind of step first started. */
  steps: StepTiming[];
  /** Every step together; its span runs from the first step's start to the last one's end. */
  wall: StepTiming;
  /** The document's own clock, which starts again when a paused study resumes. */
  lastRunMinutes: number;
  /** Close-ups by the reasons their task gives, most frequent first; one may give several. */
  closeups: { reason: string; count: number }[];
}

export interface TimingFilter {
  /** A job ID, or the start of one. */
  job?: string;
  /** Only documents whose study started at or after this ISO time. */
  since?: string;
  /** The time a running step is measured up to; now by default. */
  now?: string;
}

const MINUTES = (from: string, to: string) =>
  `(unixepoch(${to}, 'subsec') - unixepoch(${from}, 'subsec')) / 60.0`;

/**
 * Each document node and every node below it. Group nodes (the "Readers", "Reviewers" and
 * "Rechecks" that hold steps of their own role) are left out: their clocks would count their
 * children twice. `cached` is the expression for a node's cached input tokens.
 */
const tree = (cached: string) => `
WITH RECURSIVE
  documents AS (
    SELECT n.id, n.job_id, n.title, n.status, n.started_at, n.ended_at
    FROM nodes n JOIN jobs j ON j.id = n.job_id
    WHERE n.role = 'document'
      AND (:job IS NULL OR substr(n.job_id, 1, length(:job)) = :job)
      AND (:since IS NULL OR COALESCE(n.started_at, j.created_at) >= :since)
  ),
  tree (document, id) AS (
    SELECT id, id FROM documents
    UNION ALL
    SELECT tree.document, n.id FROM nodes n JOIN tree ON n.parent_id = tree.id
  ),
  steps AS (
    SELECT tree.document, n.seq, n.role, n.task, n.calls, n.input_tokens, n.output_tokens,
      ${cached} AS cached_tokens,
      CASE WHEN n.role = 'author' AND n.attempt > 1 THEN 'revision' ELSE n.role END AS step,
      n.started_at AS started,
      COALESCE(n.ended_at, CASE WHEN n.status = 'running' THEN :now END) AS ended
    FROM tree JOIN nodes n ON n.id = tree.id
    WHERE n.id <> tree.document
      AND NOT EXISTS (SELECT 1 FROM nodes child WHERE child.parent_id = n.id AND child.role = n.role)
  )`;

/** Per-document step timings for every study in a jobs database, oldest first. */
export function stepTimings(db: DatabaseSync, filter: TimingFilter = {}): DocumentTiming[] {
  // Stores the app has not opened since cache hits were recorded lack the column, and a
  // read-only report does not add it.
  const recordsCache = (db.prepare("PRAGMA table_info(nodes)").all() as { name: string }[]).some(
    (column) => column.name === "cached_tokens",
  );
  const TREE = tree(recordsCache ? "n.cached_tokens" : "NULL");
  const params = {
    job: filter.job ?? null,
    since: filter.since ?? null,
    now: filter.now ?? new Date().toISOString(),
  };
  const documents = db
    .prepare(
      `${TREE}
      SELECT id, job_id, title, status, started_at, ended_at,
        ${MINUTES("started_at", "COALESCE(ended_at, CASE WHEN status = 'running' THEN :now END)")} AS wall
      FROM documents ORDER BY started_at IS NULL, started_at, id`,
    )
    .all(params) as {
    id: string;
    job_id: string;
    title: string;
    status: string;
    started_at: string | null;
    ended_at: string | null;
    wall: number | null;
  }[];
  const steps = db
    .prepare(
      `${TREE}
      SELECT document, step, COUNT(*) AS nodes, SUM(calls) AS calls,
        SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(COALESCE(${MINUTES("started", "ended")}, 0)) AS busy,
        ${MINUTES("MIN(started)", "MAX(ended)")} AS span,
        MIN(started) AS first, MAX(ended) AS last
      FROM steps GROUP BY document, step
      ORDER BY document, MIN(seq)`,
    )
    .all(params) as {
    document: string;
    step: string;
    nodes: number;
    calls: number;
    input_tokens: number;
    cached_tokens: number | null;
    output_tokens: number;
    busy: number;
    span: number | null;
    first: string | null;
    last: string | null;
  }[];
  const closeups = db
    .prepare(`${TREE} SELECT document, task FROM steps WHERE role = 'escalation'`)
    .all(params) as { document: string; task: string }[];

  return documents.map((document) => {
    const rows = steps.filter((row) => row.document === document.id);
    const own = rows.map((row): StepTiming => ({
      step: row.step,
      nodes: row.nodes,
      calls: row.calls,
      inputTokens: row.input_tokens,
      cachedTokens: row.cached_tokens,
      outputTokens: row.output_tokens,
      busyMinutes: row.busy,
      spanMinutes: row.span ?? 0,
    }));
    const reasons = new Map<string, number>();
    for (const { task } of closeups.filter((row) => row.document === document.id))
      for (const reason of closeupReasons(task))
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    // ISO times in one format sort as text.
    const ended = document.ended_at ?? (document.status === "running" ? params.now : null);
    const known = (time: string | null): time is string => time !== null;
    const first = [document.started_at, ...rows.map((row) => row.first)].filter(known).sort()[0];
    const last = [ended, ...rows.map((row) => row.last)].filter(known).sort().at(-1);
    return {
      jobId: document.job_id,
      nodeId: document.id,
      title: document.title,
      status: document.status,
      startedAt: document.started_at,
      endedAt: document.ended_at,
      steps: own,
      wall: {
        step: "wall",
        nodes: own.reduce((sum, row) => sum + row.nodes, 0),
        calls: own.reduce((sum, row) => sum + row.calls, 0),
        inputTokens: own.reduce((sum, row) => sum + row.inputTokens, 0),
        cachedTokens: recordsCache
          ? own.reduce((sum, row) => sum + (row.cachedTokens ?? 0), 0)
          : null,
        outputTokens: own.reduce((sum, row) => sum + row.outputTokens, 0),
        busyMinutes: own.reduce((sum, row) => sum + row.busyMinutes, 0),
        spanMinutes: first && last ? (Date.parse(last) - Date.parse(first)) / 60_000 : 0,
      },
      lastRunMinutes: document.wall ?? 0,
      closeups: [...reasons]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1)),
    };
  });
}

/**
 * The reasons a close-up's task names ("Re-read 2 hard regions: a; b"), without their details:
 * what is in parentheses goes, and values (numbers, symbols) become "…". So "the reader dropped
 * words (kept 40%)" and "(kept 0%)" are one reason, as are "cited, but 1, 2 is missing from the
 * cited blocks" and "cited, but ∑ is missing from the cited blocks".
 */
export function closeupReasons(task: string): string[] {
  const at = task.indexOf(": ");
  if (at < 0) return [];
  return [
    ...new Set(
      task
        .slice(at + 2)
        .split("; ")
        .map((reason) =>
          reason
            .replace(/\s*\([^)]*\)/g, "")
            .split(/\s+/)
            .map((word) => (/\d|^[^\p{L}]+$/u.test(word) ? "…" : word))
            .join(" ")
            .replace(/…(?: …)+/g, "…")
            .trim(),
        )
        .filter(Boolean),
    ),
  ];
}

const number = (value: number) => value.toLocaleString("en-US");
const minutes = (value: number) => value.toFixed(1);

/**
 * A plain-text table per document, its close-up reasons under it. "cached in" is the share of
 * input tokens the provider served from its prompt cache.
 */
export function timingTable(documents: DocumentTiming[]): string {
  if (!documents.length) return "No studies match.";
  const header = ["step", "nodes", "calls", "out tokens", "cached in", "busy min", "span min"];
  return documents
    .map((document) => {
      const rows = [...document.steps, document.wall].map((row) => [
        row.step,
        number(row.nodes),
        number(row.calls),
        number(row.outputTokens),
        row.cachedTokens === null || !row.inputTokens
          ? "–"
          : `${Math.round((row.cachedTokens / row.inputTokens) * 100)}%`,
        minutes(row.busyMinutes),
        minutes(row.spanMinutes),
      ]);
      const widths = header.map((title, column) =>
        Math.max(title.length, ...rows.map((row) => row[column]!.length)),
      );
      const line = (cells: string[]) =>
        `  ${cells.map((cell, column) => (column ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!))).join("  ")}`;
      const closeups = document.closeups.length
        ? `  close-ups by reason: ${document.closeups.map((item) => `${item.reason} ${item.count}`).join(" · ")}`
        : "  close-ups by reason: none";
      // A resumed study's span includes the pause; its last run says how long the work took.
      const resumed =
        document.wall.spanMinutes - document.lastRunMinutes > 0.05
          ? ` · last run ${minutes(document.lastRunMinutes)} min`
          : "";
      return [
        `${document.title} · ${document.status} · job ${document.jobId.slice(0, 8)} · started ${document.startedAt ?? "never"}${resumed}`,
        line(header),
        ...rows.map(line),
        closeups,
      ].join("\n");
    })
    .join("\n\n");
}
