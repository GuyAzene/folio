import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentNodeView,
  AgentRole,
  AgentStatus,
  JobView,
  PageCoverageView,
  StepOutcome,
} from "../desktop/api.ts";
import { privateDirectory } from "../files.ts";
import type { RejectedReply } from "../ingest/models.ts";

export class JobError extends Error {}

/** The job's own record; nodes and coverage live in their own tables. */
export interface JobRecord {
  id: string;
  kind: "ingest";
  courseId: string;
  documentIds: string[];
  title: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  pages: number;
  pagesRead: number;
  regions: number;
  regionsAccounted: number;
  /** Cancelled by the student: never resumed. */
  cancelled: boolean;
}

export type NodeInput = Pick<AgentNodeView, "role" | "title" | "task"> &
  Partial<Pick<AgentNodeView, "provider" | "model" | "pages" | "status" | "note" | "attempt">> & {
    parentId: string | null;
    /** The step this node performs; a resumed job finds its earlier nodes by it. */
    key?: string;
  };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  course_id TEXT NOT NULL,
  document_ids TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0,
  pages_read INTEGER NOT NULL DEFAULT 0,
  regions INTEGER NOT NULL DEFAULT 0,
  regions_accounted INTEGER NOT NULL DEFAULT 0,
  draft_path TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  parent_id TEXT,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  task TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL,
  note TEXT,
  pages TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  step_key TEXT,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS nodes_by_job ON nodes(job_id, seq);
CREATE TABLE IF NOT EXISTS coverage (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  document_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (job_id, document_id, page)
);
CREATE TABLE IF NOT EXISTS steps (
  key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  output TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rejections (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  problem TEXT NOT NULL,
  reply TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

/**
 * Durable state of background jobs in FOLIO_HOME/jobs.sqlite: each job, its agent-tree nodes,
 * page coverage, and finished step outputs keyed by the hash of their inputs, so resuming a job
 * never pays twice for work already done.
 */
export class JobStore {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static async open(home: string): Promise<JobStore> {
    await privateDirectory(home, "data", JobError);
    const file = resolve(home, "jobs.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
    db.exec(SCHEMA);
    // Stores from before step outcomes were recorded gain the column; old rows stay null.
    const columns = db.prepare("PRAGMA table_info(nodes)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "outcome"))
      db.exec("ALTER TABLE nodes ADD COLUMN outcome TEXT");
    await chmod(file, 0o600);
    return new JobStore(db);
  }

  close(): void {
    this.#db.close();
  }

  createJob(input: Pick<JobRecord, "courseId" | "documentIds" | "title">): JobRecord {
    const job: JobRecord = {
      id: randomUUID(),
      kind: "ingest",
      courseId: input.courseId,
      documentIds: input.documentIds,
      title: input.title,
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
      pages: 0,
      pagesRead: 0,
      regions: 0,
      regionsAccounted: 0,
      cancelled: false,
    };
    this.#db
      .prepare(
        "INSERT INTO jobs (id, kind, course_id, document_ids, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        job.id,
        job.kind,
        job.courseId,
        JSON.stringify(job.documentIds),
        job.title,
        job.status,
        job.createdAt,
        job.updatedAt,
      );
    return job;
  }

  job(id: string): JobRecord {
    const row = this.#db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new JobError("Unknown job.");
    return jobRecord(row);
  }

  jobs(): JobRecord[] {
    return (
      this.#db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as Record<
        string,
        unknown
      >[]
    ).map(jobRecord);
  }

  updateJob(
    id: string,
    patch: Partial<
      Pick<
        JobRecord,
        "status" | "pages" | "pagesRead" | "regions" | "regionsAccounted" | "title" | "cancelled"
      >
    >,
  ): JobRecord {
    const columns: Record<string, string> = {
      status: "status",
      pages: "pages",
      pagesRead: "pages_read",
      regions: "regions",
      regionsAccounted: "regions_accounted",
      title: "title",
      cancelled: "cancelled",
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${columns[key]} = ?`);
      values.push(typeof value === "boolean" ? Number(value) : (value as string | number | null));
    }
    sets.push("updated_at = ?");
    values.push(now(), id);
    this.#db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.job(id);
  }

  addNode(jobId: string, input: NodeInput): AgentNodeView {
    const id = randomUUID();
    const seq =
      (
        this.#db
          .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM nodes WHERE job_id = ?")
          .get(jobId) as { seq: number }
      ).seq + 1;
    this.#db
      .prepare(
        "INSERT INTO nodes (id, job_id, parent_id, seq, role, title, task, provider, model, status, note, pages, attempt, step_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        jobId,
        input.parentId,
        seq,
        input.role,
        input.title,
        input.task,
        input.provider ?? null,
        input.model ?? null,
        input.status ?? "queued",
        input.note ?? null,
        JSON.stringify(input.pages ?? []),
        input.attempt ?? 1,
        input.key ?? null,
      );
    return this.node(id);
  }

  node(id: string): AgentNodeView {
    const row = this.#db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new JobError("Unknown job step.");
    return nodeView(row);
  }

  nodes(jobId: string): AgentNodeView[] {
    return (
      this.#db.prepare("SELECT * FROM nodes WHERE job_id = ? ORDER BY seq").all(jobId) as Record<
        string,
        unknown
      >[]
    ).map(nodeView);
  }

  nodesByKey(jobId: string, key: string): AgentNodeView[] {
    return (
      this.#db
        .prepare("SELECT * FROM nodes WHERE job_id = ? AND step_key = ? ORDER BY seq")
        .all(jobId, key) as Record<string, unknown>[]
    ).map(nodeView);
  }

  /** Forgets a job, its nodes and its coverage. Finished step outputs stay, keyed by content. */
  deleteJob(id: string): void {
    this.#db.exec("BEGIN");
    try {
      for (const table of ["coverage", "rejections", "nodes"])
        this.#db.prepare(`DELETE FROM ${table} WHERE job_id = ?`).run(id);
      this.#db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Moves a node to a new status, stamping its start and end times. */
  setNode(
    id: string,
    patch: Partial<
      Pick<AgentNodeView, "status" | "note" | "task" | "model" | "provider" | "outcome">
    >,
  ): AgentNodeView {
    const current = this.node(id);
    const status = patch.status ?? current.status;
    // Running again after it ended (a resumed job): a fresh clock and no stale note.
    const restarted =
      status === "running" && (isEnded(current.status) || current.status === "waiting");
    const startedAt = restarted
      ? now()
      : (current.startedAt ?? (status === "running" || isEnded(status) ? now() : null));
    const endedAt = isEnded(status) ? (current.endedAt ?? now()) : null;
    const note = patch.note !== undefined ? patch.note : restarted ? null : current.note;
    this.#db
      .prepare(
        "UPDATE nodes SET status = ?, note = ?, task = ?, model = ?, provider = ?, started_at = ?, ended_at = ?, outcome = ? WHERE id = ?",
      )
      .run(
        status,
        note,
        patch.task ?? current.task,
        patch.model !== undefined ? patch.model : current.model,
        patch.provider !== undefined ? patch.provider : current.provider,
        startedAt,
        endedAt,
        JSON.stringify(patch.outcome !== undefined ? patch.outcome : current.outcome),
        id,
      );
    return this.node(id);
  }

  /** Adds one model request's usage to a node. */
  recordCall(id: string, usage: { input: number; output: number }): void {
    this.#db
      .prepare(
        "UPDATE nodes SET calls = calls + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?",
      )
      .run(usage.input, usage.output, id);
  }

  /** Keeps a model reply that was not used, so the failure can be inspected later. */
  recordRejection(nodeId: string, rejected: RejectedReply): void {
    this.#db
      .prepare(
        "INSERT INTO rejections (job_id, node_id, attempt, problem, reply, created_at) SELECT job_id, id, ?, ?, ?, ? FROM nodes WHERE id = ?",
      )
      .run(rejected.attempt, rejected.problem, rejected.reply, now(), nodeId);
  }

  rejections(jobId: string): (RejectedReply & { nodeId: string; createdAt: string })[] {
    return (
      this.#db
        .prepare(
          "SELECT node_id, attempt, problem, reply, created_at FROM rejections WHERE job_id = ? ORDER BY id",
        )
        .all(jobId) as Record<string, unknown>[]
    ).map((row) => ({
      nodeId: row.node_id as string,
      attempt: row.attempt as number,
      problem: row.problem as string,
      reply: row.reply as string,
      createdAt: row.created_at as string,
    }));
  }

  /** Marks every unfinished node of a job, for example after a crash or a pause. */
  settleNodes(jobId: string, status: "stopped" | "queued", note: string | null): void {
    this.#db
      .prepare(
        "UPDATE nodes SET status = ?, note = ?, ended_at = CASE WHEN ? = 'stopped' THEN ? ELSE NULL END WHERE job_id = ? AND status IN ('running', 'queued', 'waiting')",
      )
      .run(status, note, status, now(), jobId);
  }

  setCoverage(jobId: string, documentId: string, page: number, state: PageCoverageView["state"]) {
    this.#db
      .prepare(
        "INSERT INTO coverage (job_id, document_id, page, state) VALUES (?, ?, ?, ?) ON CONFLICT (job_id, document_id, page) DO UPDATE SET state = excluded.state",
      )
      .run(jobId, documentId, page, state);
  }

  coverage(jobId: string): PageCoverageView[] {
    return (
      this.#db
        .prepare(
          "SELECT document_id, page, state FROM coverage WHERE job_id = ? ORDER BY document_id, page",
        )
        .all(jobId) as { document_id: string; page: number; state: PageCoverageView["state"] }[]
    ).map((row) => ({ documentId: row.document_id, page: row.page, state: row.state }));
  }

  /** A finished step's output, by the hash of everything that determined it. */
  step<T>(key: string): T | undefined {
    const row = this.#db.prepare("SELECT output FROM steps WHERE key = ?").get(key) as
      | { output: string }
      | undefined;
    return row ? (JSON.parse(row.output) as T) : undefined;
  }

  saveStep(key: string, jobId: string, kind: string, output: unknown): void {
    this.#db
      .prepare(
        "INSERT INTO steps (key, job_id, kind, output, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING",
      )
      .run(key, jobId, kind, JSON.stringify(output), now());
  }

  view(id: string): JobView {
    const job = this.job(id);
    return {
      id: job.id,
      kind: job.kind,
      courseId: job.courseId,
      documentIds: job.documentIds,
      title: job.title,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      pages: job.pages,
      pagesRead: job.pagesRead,
      regions: job.regions,
      regionsAccounted: job.regionsAccounted,
      coverage: this.coverage(id),
      nodes: this.nodes(id),
      resumable:
        !job.cancelled &&
        (job.status === "stopped" || job.status === "failed" || job.status === "waiting"),
    };
  }
}

function isEnded(status: AgentStatus): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}

function jobRecord(row: Record<string, unknown>): JobRecord {
  return {
    id: row.id as string,
    kind: "ingest",
    courseId: row.course_id as string,
    documentIds: JSON.parse(row.document_ids as string) as string[],
    title: row.title as string,
    status: row.status as AgentStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    pages: row.pages as number,
    pagesRead: row.pages_read as number,
    regions: row.regions as number,
    regionsAccounted: row.regions_accounted as number,
    cancelled: row.cancelled === 1,
  };
}

function nodeView(row: Record<string, unknown>): AgentNodeView {
  return {
    id: row.id as string,
    parentId: (row.parent_id as string | null) ?? null,
    role: row.role as AgentRole,
    title: row.title as string,
    task: row.task as string,
    provider: (row.provider as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    status: row.status as AgentStatus,
    note: (row.note as string | null) ?? null,
    pages: JSON.parse(row.pages as string) as number[],
    calls: row.calls as number,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    startedAt: (row.started_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
    attempt: row.attempt as number,
    outcome: row.outcome ? (JSON.parse(row.outcome as string) as StepOutcome | null) : null,
  };
}
