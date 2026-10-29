import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { privateDirectory, writeAtomic } from "../files.ts";
import { pdfPageCount } from "./pdf.ts";
import { folioHome } from "../home.ts";

export const LIBRARY_VERSION = 1;
export const DOCUMENT_ROLES = ["lecture", "recitation", "assignment", "solution", "asset"] as const;
export type DocumentRole = (typeof DOCUMENT_ROLES)[number];
export const PENCILS = [
  "graphite",
  "blue",
  "red",
  "green",
  "violet",
  "orange",
  "teal",
  "pink",
] as const;
export type Pencil = (typeof PENCILS)[number];
export type DocumentKind = "pdf" | "markdown";

export interface CourseRecord {
  version: 1;
  id: string;
  name: string;
  code: string;
  term: string;
  color: Pencil;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface DocumentRecord {
  version: 1;
  id: string;
  courseId: string;
  title: string;
  role: DocumentRole;
  kind: DocumentKind;
  originalName: string;
  sha256: string;
  size: number;
  /** Null for Markdown. */
  pages: number | null;
  /** Assignments only: an ISO date the student set. */
  dueAt: string | null;
  importedAt: string;
  updatedAt: string;
  revision: number;
}

export type CourseInput = Partial<Pick<CourseRecord, "name" | "code" | "term" | "color">>;
export type DocumentPatch = Partial<Pick<DocumentRecord, "title" | "role" | "courseId" | "dueAt">>;

export class LibraryError extends Error {}
export class LibraryConflictError extends Error {}
export class LibraryIntegrityError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMPORT_BYTES = 300 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isoDate(value: unknown): value is string {
  return typeof value === "string" && new Date(value).toISOString() === value;
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && value === value.trim();
}
export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}
export function checkId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !UUID.test(id)) throw new LibraryError("Unknown library item.");
}

function validCourse(value: unknown): value is CourseRecord {
  return (
    record(value) &&
    value.version === LIBRARY_VERSION &&
    typeof value.id === "string" &&
    UUID.test(value.id) &&
    text(value.name, 80) &&
    !!value.name &&
    text(value.code, 24) &&
    text(value.term, 40) &&
    PENCILS.includes(value.color as Pencil) &&
    isoDate(value.createdAt) &&
    isoDate(value.updatedAt) &&
    Number.isInteger(value.revision) &&
    Number(value.revision) >= 1
  );
}

function validDocument(value: unknown): value is DocumentRecord {
  return (
    record(value) &&
    value.version === LIBRARY_VERSION &&
    typeof value.id === "string" &&
    UUID.test(value.id) &&
    typeof value.courseId === "string" &&
    UUID.test(value.courseId) &&
    text(value.title, 160) &&
    !!value.title &&
    DOCUMENT_ROLES.includes(value.role as DocumentRole) &&
    (value.kind === "pdf" || value.kind === "markdown") &&
    typeof value.originalName === "string" &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isInteger(value.size) &&
    (value.kind === "pdf"
      ? Number.isInteger(value.pages) && Number(value.pages) >= 1
      : value.pages === null) &&
    (value.dueAt === null || isoDate(value.dueAt)) &&
    isoDate(value.importedAt) &&
    isoDate(value.updatedAt) &&
    Number.isInteger(value.revision) &&
    Number(value.revision) >= 1
  );
}

/** A readable title from a file name: "lec05_graph-traversal.pdf" → "lec05 graph traversal". */
export function titleFromName(name: string): string {
  const title = basename(name, extname(name))
    .replace(/[_]+/g, " ")
    .replace(/\s*-\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return title || "Untitled";
}

/** A first guess from the file name; the student can always change the role. */
export function guessRole(name: string, kind: DocumentKind): DocumentRole {
  const n = name.toLowerCase().replace(/[_.-]+/g, " ");
  if (/\b(syllabus|syllabi|course outline)\b|סילבוס/.test(n)) return "asset";
  if (/\b(solutions?|sol)\b|_sol\b|pitron|פתרון/.test(n)) return "solution";
  if (/\b(hw|homework|assignments?|problem ?set|ps)\s*\d*\b|\bex\d|מטלה/.test(n))
    return "assignment";
  if (/\b(recitation|rec|tirgul|tutorial)\s*\d*\b|\brec\d|תרגול/.test(n)) return "recitation";
  if (/\b(lecture|lec)\s*\d*\b|\blec\d|הרצאה/.test(n)) return "lecture";
  return kind === "pdf" ? "lecture" : "asset";
}

/**
 * The student's course library. Originals are copied in once, made read-only and verified by
 * hash on every read; Folio never rewrites them. Metadata edits are revision-checked.
 */
export class LibraryStore {
  readonly root: string;
  readonly #courses: string;
  readonly #documents: string;
  /** What this store last read or wrote for each metadata file, to detect outside edits. */
  readonly #seen = new Map<string, { revision: number; hash: string }>();

  private constructor(root: string) {
    this.root = root;
    this.#courses = resolve(root, "courses");
    this.#documents = resolve(root, "documents");
  }

  static async open(options: { home?: string } = {}): Promise<LibraryStore> {
    const home = resolve(options.home ?? folioHome());
    await privateDirectory(home, "data", LibraryError);
    const store = new LibraryStore(resolve(home, "library"));
    for (const directory of [store.root, store.#courses, store.#documents])
      await privateDirectory(directory, "library", LibraryError);
    return store;
  }

  courseDirectory(id: string): string {
    checkId(id);
    return resolve(this.#courses, id);
  }

  /** A document's folder: its read-only original and document.json. */
  documentDirectory(id: string): string {
    checkId(id);
    return resolve(this.#documents, id);
  }

  async listCourses(): Promise<CourseRecord[]> {
    const courses = await this.#list(this.#courses, "course.json", validCourse);
    return courses.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async course(id: string): Promise<CourseRecord> {
    return (await this.#read(resolve(this.courseDirectory(id), "course.json"), validCourse)).value;
  }

  async createCourse(input: CourseInput): Promise<CourseRecord> {
    const now = new Date().toISOString();
    const course = cleanCourse({
      version: 1,
      id: randomUUID(),
      name: input.name ?? "",
      code: input.code ?? "",
      term: input.term ?? "",
      color: input.color ?? PENCILS[(await this.listCourses()).length % PENCILS.length]!,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    });
    const directory = this.courseDirectory(course.id);
    await privateDirectory(directory, "library", LibraryError);
    await writeAtomic(resolve(directory, "course.json"), json(course));
    return course;
  }

  async updateCourse(
    id: string,
    patch: CourseInput,
    expectedRevision: number,
  ): Promise<CourseRecord> {
    const file = resolve(this.courseDirectory(id), "course.json");
    return this.#update(file, validCourse, expectedRevision, (current) =>
      cleanCourse({ ...current, ...pick(patch, ["name", "code", "term", "color"]) }),
    );
  }

  async listDocuments(filter: { courseId?: string } = {}): Promise<DocumentRecord[]> {
    const documents = await this.#list(this.#documents, "document.json", validDocument);
    return documents
      .filter((document) => !filter.courseId || document.courseId === filter.courseId)
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }

  async document(id: string): Promise<DocumentRecord> {
    checkId(id);
    return (await this.#read(resolve(this.#documents, id, "document.json"), validDocument)).value;
  }

  /** Copies a PDF or Markdown file into the course. An identical file already there is reused. */
  async importFile(
    courseId: string,
    source: string,
    options: { role?: DocumentRole } = {},
  ): Promise<{ document: DocumentRecord; duplicate: boolean }> {
    await this.course(courseId);
    const info = await lstat(source).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink())
      throw new LibraryError(`${basename(source)} is not a regular file.`);
    if (info.size > MAX_IMPORT_BYTES) throw new LibraryError(`${basename(source)} is too large.`);
    const extension = extname(source).toLowerCase();
    const kind: DocumentKind | undefined =
      extension === ".pdf"
        ? "pdf"
        : [".md", ".markdown"].includes(extension)
          ? "markdown"
          : undefined;
    if (!kind) throw new LibraryError("Folio can import PDF and Markdown files for now.");
    const data = new Uint8Array(await readFile(source));
    let pages: number | null = null;
    if (kind === "pdf") {
      if (new TextDecoder().decode(data.subarray(0, 5)) !== "%PDF-")
        throw new LibraryError(`${basename(source)} is not a PDF.`);
      try {
        pages = await pdfPageCount(data);
      } catch {
        throw new LibraryError(`${basename(source)} could not be read as a PDF.`);
      }
    } else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new LibraryError(`${basename(source)} is not UTF-8 text.`);
      }
    }
    const hash = sha256(data);
    const existing = (await this.listDocuments({ courseId })).find((d) => d.sha256 === hash);
    if (existing) return { document: existing, duplicate: true };

    const now = new Date().toISOString();
    const document: DocumentRecord = {
      version: 1,
      id: randomUUID(),
      courseId,
      title: titleFromName(source),
      role: options.role ?? guessRole(basename(source), kind),
      kind,
      originalName: basename(source),
      sha256: hash,
      size: data.byteLength,
      pages,
      dueAt: null,
      importedAt: now,
      updatedAt: now,
      revision: 1,
    };
    const directory = resolve(this.#documents, document.id);
    await mkdir(directory, { mode: 0o700 });
    try {
      const original = this.#originalPath(document);
      const handle = await open(original, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(original, 0o400);
      await writeAtomic(resolve(directory, "document.json"), json(document));
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return { document, duplicate: false };
  }

  async updateDocument(
    id: string,
    patch: DocumentPatch,
    expectedRevision: number,
  ): Promise<DocumentRecord> {
    checkId(id);
    if (patch.courseId !== undefined) await this.course(patch.courseId);
    const file = resolve(this.#documents, id, "document.json");
    return this.#update(file, validDocument, expectedRevision, (current) => {
      const next = { ...current, ...pick(patch, ["title", "role", "courseId", "dueAt"]) };
      if (typeof next.title === "string") next.title = next.title.trim();
      if (!validDocument({ ...next, updatedAt: current.updatedAt }))
        throw new LibraryError("That change is not valid for this document.");
      return next;
    });
  }

  /** The original bytes, verified against the hash recorded at import. */
  async readOriginal(id: string): Promise<{ document: DocumentRecord; data: Uint8Array }> {
    const document = await this.document(id);
    const data = new Uint8Array(await readFile(this.#originalPath(document)));
    if (sha256(data) !== document.sha256)
      throw new LibraryIntegrityError(
        `“${document.title}” no longer matches the file that was imported. Folio did not open it.`,
      );
    return { document, data };
  }

  #originalPath(document: Pick<DocumentRecord, "id" | "kind">): string {
    checkId(document.id);
    return resolve(
      this.#documents,
      document.id,
      document.kind === "pdf" ? "original.pdf" : "original.md",
    );
  }

  async #list<T>(
    directory: string,
    file: string,
    valid: (value: unknown) => value is T,
  ): Promise<T[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const results: T[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try {
        results.push((await this.#read(resolve(directory, entry.name, file), valid)).value);
      } catch {
        // Unreadable entries are preserved on disk and simply not listed.
      }
    }
    return results;
  }

  async #read<T>(
    file: string,
    valid: (value: unknown) => value is T,
    remember = true,
  ): Promise<{ value: T; hash: string }> {
    let raw: string;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a file");
      raw = await readFile(file, "utf8");
    } catch {
      throw new LibraryError("That library item does not exist.");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new LibraryError("Unreadable library data. The file was preserved.");
    }
    if (!valid(value)) throw new LibraryError("Invalid library data. The file was preserved.");
    const hash = sha256(raw);
    if (remember)
      this.#seen.set(file, { revision: (value as { revision: number }).revision, hash });
    return { value, hash };
  }

  async #update<T extends { revision: number; updatedAt: string }>(
    file: string,
    valid: (value: unknown) => value is T,
    expectedRevision: number,
    change: (current: T) => T,
  ): Promise<T> {
    const seen = this.#seen.get(file);
    const current = await this.#read(file, valid, false);
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(file, { realpath: false, stale: 10_000, retries: 3 });
    } catch {
      throw new LibraryConflictError("This item is being saved elsewhere. Try again.");
    }
    try {
      if (current.value.revision !== expectedRevision)
        throw new LibraryConflictError("This item changed since it was opened. Reload it.");
      if (seen?.revision === expectedRevision && seen.hash !== current.hash)
        throw new LibraryConflictError("This item changed outside Folio. Reload it.");
      const next = {
        ...change(structuredClone(current.value)),
        revision: current.value.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (!valid(next)) throw new LibraryError("That change is not valid.");
      const raw = json(next);
      await writeAtomic(file, raw, {
        check: async () => {
          // Reject edits made outside Folio after this one was read, instead of overwriting them.
          if (sha256(await readFile(file, "utf8")) !== current.hash)
            throw new LibraryConflictError("This item changed outside Folio. Reload it.");
        },
      });
      this.#seen.set(file, { revision: next.revision, hash: sha256(raw) });
      return next;
    } finally {
      await release();
    }
  }
}

function cleanCourse(course: CourseRecord): CourseRecord {
  const next = {
    ...course,
    name: String(course.name).trim(),
    code: String(course.code).trim(),
    term: String(course.term).trim(),
  };
  if (!next.name) throw new LibraryError("Give the course a name.");
  if (!validCourse(next)) throw new LibraryError("Check the course details and try again.");
  return next;
}

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys) if (value[key] !== undefined) result[key] = value[key];
  return result;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
