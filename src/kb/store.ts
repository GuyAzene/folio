import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DraftBundle } from "../ingest/pipeline.ts";
import { coursePrefix } from "../ingest/pipeline.ts";
import { privateDirectory } from "../files.ts";
import { checkId, LibraryError, type LibraryStore } from "../library/store.ts";
import { buildIndex, KnowledgeIndex } from "./index.ts";
import {
  emptyKnowledge,
  mergeDraft,
  renderKnowledge,
  type Acknowledgement,
  type Knowledge,
} from "./knowledge.ts";

export interface GenerationInfo {
  courseId: string;
  generation: number;
  publishedAt: string;
  jobId: string | null;
  summary: string;
}

/**
 * Published course knowledge as immutable generations under
 * `courses/<id>/kb/generations/<n>/` (knowledge.json, the wiki's Markdown, index.sqlite). The
 * current generation is a row in `library/kb.sqlite`: publishing builds the new generation in a
 * staging folder, renames it into place, then switches with one SQLite commit.
 */
export class KnowledgeStore {
  readonly #library: LibraryStore;
  readonly #db: DatabaseSync;
  /** Each course's last queued change; the next one waits for it. */
  readonly #publishing = new Map<string, Promise<unknown>>();
  readonly #indexes = new Map<string, { generation: number; index: KnowledgeIndex }>();
  readonly #knowledge = new Map<string, { generation: number; knowledge: Knowledge }>();

  private constructor(library: LibraryStore, db: DatabaseSync) {
    this.#library = library;
    this.#db = db;
  }

  static async open(library: LibraryStore): Promise<KnowledgeStore> {
    const db = new DatabaseSync(resolve(library.root, "kb.sqlite"));
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS generations (
        course_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, job_id TEXT, summary TEXT NOT NULL,
        PRIMARY KEY (course_id, generation));
      CREATE TABLE IF NOT EXISTS current (course_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);`);
    const store = new KnowledgeStore(library, db);
    await store.#recover();
    return store;
  }

  close(): void {
    for (const { index } of this.#indexes.values()) index.close();
    this.#db.close();
  }

  current(courseId: string): GenerationInfo | null {
    const row = this.#db
      .prepare(
        "SELECT g.* FROM current c JOIN generations g ON g.course_id = c.course_id AND g.generation = c.generation WHERE c.course_id = ?",
      )
      .get(courseId) as Record<string, string | number | null> | undefined;
    return row ? generationInfo(row) : null;
  }

  history(courseId: string): GenerationInfo[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM generations WHERE course_id = ? AND status = 'published' ORDER BY generation DESC",
        )
        .all(courseId) as Record<string, string | number | null>[]
    ).map(generationInfo);
  }

  /** The course's published knowledge, or null before its first publication. */
  async knowledge(courseId: string): Promise<Knowledge | null> {
    const current = this.current(courseId);
    if (!current) return null;
    const cached = this.#knowledge.get(courseId);
    if (cached?.generation === current.generation) return cached.knowledge;
    const knowledge = JSON.parse(
      await readFile(
        resolve(this.#generationDir(courseId, current.generation), "knowledge.json"),
        "utf8",
      ),
    ) as Knowledge;
    this.#knowledge.set(courseId, { generation: current.generation, knowledge });
    return knowledge;
  }

  /** The current generation's search index, opened read-only and reused. */
  index(courseId: string): KnowledgeIndex | null {
    const current = this.current(courseId);
    if (!current) return null;
    const cached = this.#indexes.get(courseId);
    if (cached?.generation === current.generation) return cached.index;
    cached?.index.close();
    const index = new KnowledgeIndex(
      resolve(this.#generationDir(courseId, current.generation), "index.sqlite"),
    );
    this.#indexes.set(courseId, { generation: current.generation, index });
    return index;
  }

  /** Merges a reviewed draft into a new generation and switches to it in one commit. */
  /**
   * Publishes one course's new version. Publishes for the same course run one at a time, so
   * two studies finishing together both land, each on top of the other.
   */
  publish(bundle: DraftBundle, acknowledgements: Acknowledgement[] = []): Promise<GenerationInfo> {
    const previous = this.#publishing.get(bundle.courseId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.#publish(bundle, acknowledgements));
    this.#publishing.set(bundle.courseId, next);
    return next;
  }

  async #publish(
    bundle: DraftBundle,
    acknowledgements: Acknowledgement[],
  ): Promise<GenerationInfo> {
    const courseId = bundle.courseId;
    checkId(courseId);
    const course = await this.#library.course(courseId);
    const previous =
      (await this.knowledge(courseId)) ?? emptyKnowledge(courseId, coursePrefix(course.name));
    const knowledge = mergeDraft(previous, bundle, acknowledgements);
    const summary = `${bundle.documents.map((document) => document.session.slug).join(", ")}: ${knowledge.pages.length} pages, ${knowledge.pages.reduce((sum, page) => sum + page.blocks.length, 0)} blocks`;
    return this.#write(courseId, knowledge, bundle.jobId, summary);
  }

  /**
   * Publishes the course's knowledge changed by `change`, such as without a removed lecture's
   * notes. It queues behind publishes for the same course; null when nothing was published yet.
   */
  revise(
    courseId: string,
    change: (current: Knowledge) => Knowledge | Promise<Knowledge>,
    summary: string,
  ): Promise<GenerationInfo | null> {
    checkId(courseId);
    const previous = this.#publishing.get(courseId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = await this.knowledge(courseId);
        return current ? this.#write(courseId, await change(current), null, summary) : null;
      });
    this.#publishing.set(courseId, next);
    return next;
  }

  /** An earlier published generation's knowledge, or null if it is not there. */
  async knowledgeAt(courseId: string, generation: number): Promise<Knowledge | null> {
    checkId(courseId);
    try {
      return JSON.parse(
        await readFile(
          resolve(this.#generationDir(courseId, generation), "knowledge.json"),
          "utf8",
        ),
      ) as Knowledge;
    } catch {
      return null;
    }
  }

  /** Closes the course's open index and drops cached knowledge, before its folder moves. */
  release(courseId: string): void {
    this.#indexes.get(courseId)?.index.close();
    this.#indexes.delete(courseId);
    this.#knowledge.delete(courseId);
  }

  async #write(
    courseId: string,
    knowledge: Knowledge,
    jobId: string | null,
    summary: string,
  ): Promise<GenerationInfo> {
    const generation =
      ((
        this.#db
          .prepare("SELECT MAX(generation) AS max FROM generations WHERE course_id = ?")
          .get(courseId) as {
          max: number | null;
        }
      ).max ?? 0) + 1;
    const createdAt = new Date().toISOString();
    this.#db
      .prepare(
        "INSERT INTO generations (course_id, generation, status, created_at, job_id, summary) VALUES (?, ?, 'publishing', ?, ?, ?)",
      )
      .run(courseId, generation, createdAt, jobId, summary);

    const kb = await this.#kbDir(courseId);
    const staging = resolve(kb, `staging-${randomUUID()}`);
    try {
      await mkdir(resolve(staging, "wiki"), { recursive: true, mode: 0o700 });
      await writeFile(
        resolve(staging, "knowledge.json"),
        `${JSON.stringify(knowledge, null, 2)}\n`,
        { mode: 0o600 },
      );
      for (const file of renderKnowledge(knowledge, createdAt.slice(0, 10))) {
        const target = resolve(staging, "wiki", file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.content, { mode: 0o600 });
      }
      buildIndex(resolve(staging, "index.sqlite"), knowledge, generation);
      await syncTree(staging);
      await mkdir(resolve(kb, "generations"), { recursive: true, mode: 0o700 });
      await rename(staging, this.#generationDir(courseId, generation));
      await syncDirectory(resolve(kb, "generations"));
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      this.#db
        .prepare("DELETE FROM generations WHERE course_id = ? AND generation = ?")
        .run(courseId, generation);
      throw error;
    }
    this.#switch(courseId, generation, true);
    return this.current(courseId)!;
  }

  /** Points the course back at its previous published generation. */
  rollback(courseId: string): GenerationInfo {
    const current = this.current(courseId);
    const previous = this.history(courseId).find(
      (item) => current && item.generation < current.generation,
    );
    if (!current || !previous) throw new LibraryError("There is no earlier version to go back to.");
    this.#switch(courseId, previous.generation, false);
    return this.current(courseId)!;
  }

  #switch(courseId: string, generation: number, publishing: boolean): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (publishing)
        this.#db
          .prepare(
            "UPDATE generations SET status = 'published' WHERE course_id = ? AND generation = ?",
          )
          .run(courseId, generation);
      this.#db
        .prepare(
          "INSERT INTO current (course_id, generation) VALUES (?, ?) ON CONFLICT (course_id) DO UPDATE SET generation = excluded.generation",
        )
        .run(courseId, generation);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Removes what an interrupted publish left behind; published generations are untouched. */
  async #recover(): Promise<void> {
    const pending = this.#db
      .prepare("SELECT course_id, generation FROM generations WHERE status = 'publishing'")
      .all() as {
      course_id: string;
      generation: number;
    }[];
    for (const row of pending) {
      await rm(this.#generationDir(row.course_id, row.generation), {
        recursive: true,
        force: true,
      });
      this.#db
        .prepare("DELETE FROM generations WHERE course_id = ? AND generation = ?")
        .run(row.course_id, row.generation);
    }
    for (const course of await this.#library.listCourses()) {
      const kb = resolve(this.#library.courseDirectory(course.id), "kb");
      const entries = await readdir(kb).catch(() => [] as string[]);
      for (const entry of entries)
        if (entry.startsWith("staging-"))
          await rm(resolve(kb, entry), { recursive: true, force: true });
    }
  }

  #generationDir(courseId: string, generation: number): string {
    return resolve(
      this.#library.courseDirectory(courseId),
      "kb",
      "generations",
      String(generation),
    );
  }

  async #kbDir(courseId: string): Promise<string> {
    const directory = resolve(this.#library.courseDirectory(courseId), "kb");
    await privateDirectory(directory, "library", LibraryError);
    return directory;
  }
}

function generationInfo(row: Record<string, string | number | null>): GenerationInfo {
  return {
    courseId: row.course_id as string,
    generation: row.generation as number,
    publishedAt: row.created_at as string,
    jobId: (row.job_id as string | null) ?? null,
    summary: row.summary as string,
  };
}

async function syncTree(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await syncTree(child);
    else {
      const handle = await open(child, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  await syncDirectory(path);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
