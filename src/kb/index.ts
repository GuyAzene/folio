import { DatabaseSync } from "node:sqlite";
import { linkedPrerequisites, type Knowledge, type KnowledgeBlock } from "./knowledge.ts";
import { matchQuery, normalizeText, NORMALIZE_VERSION, strippedForms, words } from "./normalize.ts";

/**
 * One generation's search index: SQLite FTS5 over evidence blocks with weighted columns, a
 * prefix-stripped Hebrew column, and the raw page text kept apart as unreviewed. Built once per
 * generation and then only read (see the local knowledge base research).
 */

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE blocks (
  id INTEGER PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  page_slug TEXT NOT NULL,
  page_title TEXT NOT NULL,
  block_title TEXT NOT NULL,
  session TEXT NOT NULL,
  document_id TEXT NOT NULL,
  pages TEXT NOT NULL,
  locators TEXT NOT NULL,
  body TEXT NOT NULL,
  prerequisites TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE VIRTUAL TABLE blocks_fts USING fts5(
  context, title, keywords_en, keywords_he, aliases, questions, body, stripped,
  tokenize = "unicode61 remove_diacritics 2"
);
CREATE TABLE source_pages (id INTEGER PRIMARY KEY, session TEXT NOT NULL, document_id TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL);
CREATE VIRTUAL TABLE pages_fts USING fts5(text, stripped, tokenize = "unicode61 remove_diacritics 2");
`;

/** Column weights for bm25(), in schema order: titles and keywords outrank prose. */
const WEIGHTS = [2, 8, 6, 6, 5, 3, 1, 1.5];

export interface SearchHit {
  handle: string;
  title: string;
  session: string;
  pages: number[];
  snippet: string;
}

export interface BlockText {
  handle: string;
  title: string;
  session: string;
  documentId: string;
  locators: KnowledgeBlock["locators"];
  body: string;
}

export function buildIndex(file: string, knowledge: Knowledge, generation: number): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA);
    const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    meta.run("normalize_version", String(NORMALIZE_VERSION));
    meta.run("generation", String(generation));
    meta.run("course", knowledge.courseId);
    const block = db.prepare(
      "INSERT INTO blocks (id, handle, page_slug, page_title, block_title, session, document_id, pages, locators, body, prerequisites, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const blockText = db.prepare(
      "INSERT INTO blocks_fts (rowid, context, title, keywords_en, keywords_he, aliases, questions, body, stripped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const sessions = new Map(knowledge.sessions.map((session) => [session.slug, session]));
    db.exec("BEGIN");
    let id = 0;
    for (const page of knowledge.pages)
      for (const item of page.blocks) {
        id++;
        const session = sessions.get(item.session);
        const pages = [...new Set(item.locators.map((locator) => locator.page))].sort(
          (a, b) => a - b,
        );
        block.run(
          id,
          item.handle,
          page.slug,
          page.title,
          item.title,
          item.session,
          item.documentId,
          JSON.stringify(pages),
          JSON.stringify(item.locators),
          item.body,
          JSON.stringify(linkedPrerequisites(knowledge, page)),
          id,
        );
        const all = [
          item.title,
          item.body,
          ...item.keywords_he,
          ...item.aliases,
          ...item.questions,
        ].join(" ");
        blockText.run(
          id,
          normalizeText(`${session?.title ?? item.session} ${page.title}`),
          normalizeText(`${page.title} ${item.title}`),
          normalizeText(item.keywords_en.join(" ")),
          normalizeText(item.keywords_he.join(" ")),
          normalizeText(item.aliases.join(" ")),
          normalizeText(item.questions.join(" ")),
          normalizeText(item.body),
          strippedForms(all).join(" "),
        );
      }
    const page = db.prepare(
      "INSERT INTO source_pages (id, session, document_id, page, text) VALUES (?, ?, ?, ?, ?)",
    );
    const pageText = db.prepare("INSERT INTO pages_fts (rowid, text, stripped) VALUES (?, ?, ?)");
    let pageId = 0;
    for (const session of knowledge.sessions)
      for (const source of session.sourcePages) {
        pageId++;
        page.run(pageId, session.slug, session.documentId, source.page, source.text);
        pageText.run(pageId, normalizeText(source.text), strippedForms(source.text).join(" "));
      }
    db.exec("COMMIT");
    db.exec("PRAGMA optimize");
  } finally {
    db.close();
  }
}

/** Read-only queries over one generation's index, always filtered to the allowed sessions. */
export class KnowledgeIndex {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    this.#db = new DatabaseSync(file, { readOnly: true });
    const version = (
      this.#db.prepare("SELECT value FROM meta WHERE key = 'normalize_version'").get() as
        | { value: string }
        | undefined
    )?.value;
    if (version !== String(NORMALIZE_VERSION)) {
      this.#db.close();
      throw new Error("This course's index was built by another version of Folio. Rebuild it.");
    }
  }

  close(): void {
    this.#db.close();
  }

  /** Ranked evidence blocks for a question, with short snippets of the original wording. */
  search(question: string, sessions: string[], limit = 8): SearchHit[] {
    const match = matchQuery(question);
    if (!match || !sessions.length) return [];
    const rows = this.#db
      .prepare(
        `SELECT b.handle, b.page_title, b.block_title, b.session, b.pages, b.body
         FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid
         WHERE blocks_fts MATCH ? AND b.session IN (${sessions.map(() => "?").join(", ")})
         ORDER BY bm25(blocks_fts, ${WEIGHTS.join(", ")}) LIMIT ?`,
      )
      .all(match, ...sessions, limit) as Record<string, string>[];
    return rows.map((row) => ({
      handle: row.handle!,
      title: `${row.page_title} › ${row.block_title}`,
      session: row.session!,
      pages: JSON.parse(row.pages!) as number[],
      snippet: snippet(row.body!, question),
    }));
  }

  /** Whole blocks by handle, only from the allowed sessions; unknown handles are skipped. */
  read(handles: string[], sessions: string[]): BlockText[] {
    if (!handles.length || !sessions.length) return [];
    const rows = this.#db
      .prepare(
        `SELECT handle, page_title, block_title, session, document_id, locators, body FROM blocks
         WHERE handle IN (${handles.map(() => "?").join(", ")}) AND session IN (${sessions.map(() => "?").join(", ")})`,
      )
      .all(...handles, ...sessions) as Record<string, string>[];
    return handles.flatMap((handle) => {
      const row = rows.find((candidate) => candidate.handle === handle);
      return row
        ? [
            {
              handle,
              title: `${row.page_title} › ${row.block_title}`,
              session: row.session!,
              documentId: row.document_id!,
              locators: JSON.parse(row.locators!) as KnowledgeBlock["locators"],
              body: row.body!,
            },
          ]
        : [];
    });
  }

  /** Handles related to one block: the same page, its prerequisites' pages, and pages using it. */
  related(
    handle: string,
    sessions: string[],
  ): { relation: string; handle: string; title: string }[] {
    const seed = this.#db
      .prepare("SELECT page_slug, prerequisites FROM blocks WHERE handle = ?")
      .get(handle) as { page_slug: string; prerequisites: string } | undefined;
    if (!seed || !sessions.length) return [];
    const inScope = `session IN (${sessions.map(() => "?").join(", ")})`;
    const prerequisites = JSON.parse(seed.prerequisites) as string[];
    const rows = (sql: string, ...values: string[]) =>
      this.#db.prepare(sql).all(...values, ...sessions) as {
        handle: string;
        page_title: string;
        block_title: string;
      }[];
    const label =
      (relation: string) => (row: { handle: string; page_title: string; block_title: string }) => ({
        relation,
        handle: row.handle,
        title: `${row.page_title} › ${row.block_title}`,
      });
    return [
      ...rows(
        `SELECT handle, page_title, block_title FROM blocks WHERE page_slug = ? AND handle != ? AND ${inScope} ORDER BY seq`,
        seed.page_slug,
        handle,
      ).map(label("same page")),
      ...(prerequisites.length
        ? rows(
            `SELECT handle, page_title, block_title FROM blocks WHERE page_slug IN (${prerequisites.map(() => "?").join(", ")}) AND ${inScope} ORDER BY seq`,
            ...prerequisites,
          ).map(label("prerequisite"))
        : []),
      ...rows(
        `SELECT handle, page_title, block_title FROM blocks WHERE prerequisites LIKE ? AND ${inScope} ORDER BY seq`,
        `%"${seed.page_slug}"%`,
      ).map(label("used by")),
    ].slice(0, 12);
  }

  /** Unreviewed page text matching a question: for finding where wording appears, not for teaching. */
  searchPages(
    question: string,
    sessions: string[],
    limit = 5,
  ): { session: string; documentId: string; page: number; snippet: string }[] {
    const match = matchQuery(question);
    if (!match || !sessions.length) return [];
    const rows = this.#db
      .prepare(
        `SELECT p.session, p.document_id, p.page, p.text FROM pages_fts JOIN source_pages p ON p.id = pages_fts.rowid
         WHERE pages_fts MATCH ? AND p.session IN (${sessions.map(() => "?").join(", ")})
         ORDER BY bm25(pages_fts, 1, 0.5) LIMIT ?`,
      )
      .all(match, ...sessions, limit) as Record<string, string | number>[];
    return rows.map((row) => ({
      session: row.session as string,
      documentId: row.document_id as string,
      page: row.page as number,
      snippet: snippet(row.text as string, question),
    }));
  }
}

/** About 30 words of the original text around the first word of the question it contains. */
export function snippet(text: string, question: string): string {
  const wanted = new Set(words(question).filter((word) => word.length > 2));
  const tokens = text.split(/(\s+)/);
  let at = tokens.findIndex((token) => words(token).some((word) => wanted.has(word)));
  if (at < 0) at = 0;
  const start = Math.max(0, at - 24);
  const piece = tokens
    .slice(start, start + 60)
    .join("")
    .trim();
  return `${start > 0 ? "… " : ""}${piece}${start + 60 < tokens.length ? " …" : ""}`;
}
