import { createHash } from "node:crypto";
import { appendFile, chmod, lstat, readFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { writeAtomic } from "./files.ts";

/** The revision of a note that has never been saved. */
export const MISSING_NOTE = "missing";
export const MAX_NOTE_CHARACTERS = 1_000_000;

export class NoteConflictError extends Error {}
export class NoteFormatError extends Error {}

export interface NoteFile {
  content: string;
  /** The SHA-256 of the content, or MISSING_NOTE. */
  revision: string;
  updatedAt: string | null;
}

const CHANGED = "This note changed outside this editor. Reload it before saving.";

/** Who changed a note: the student, or the tutor answering in a chat. */
export type NoteAuthor = { kind: "student" } | { kind: "tutor"; chatId: string };

/**
 * One earlier version of a note: what it held before a change, who made that change and when.
 * Kept in `<note>.history.jsonl` beside the note, oldest first.
 */
export interface NoteHistoryEntry {
  v: 1;
  at: string;
  author: NoteAuthor;
  /** The revision the note had before the change, which an undo restores. */
  revision: string;
  content: string;
}

/** The student's own saves are kept at most this often; every tutor change is kept. */
const STUDENT_EVERY = 5 * 60_000;

export const historyFile = (file: string) => `${file}.history.jsonl`;

/** A note's earlier versions, oldest first; a damaged line is skipped, never fatal. */
export async function readNoteHistory(file: string): Promise<NoteHistoryEntry[]> {
  const raw = await readFile(historyFile(file), "utf8").catch(() => "");
  return raw.split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line) as NoteHistoryEntry;
      return entry?.v === 1 && typeof entry.content === "string" ? [entry] : [];
    } catch {
      return [];
    }
  });
}

/** Reads a Markdown note. A missing file reads as an empty note. */
export async function readNoteFile(file: string): Promise<NoteFile> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new NoteFormatError("The note must be a regular file.");
    await chmod(file, 0o600);
    const content = await readFile(file, "utf8");
    return {
      content,
      revision: createHash("sha256").update(content).digest("hex"),
      updatedAt: info.mtime.toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { content: "", revision: MISSING_NOTE, updatedAt: null };
  }
}

/**
 * Replaces a note only while it still has `expectedRevision`. The revision is checked again
 * immediately before the rename, so edits made in other apps (which ignore Folio's lock) are
 * rejected instead of overwritten.
 */
export async function writeNoteFile(
  file: string,
  content: string,
  expectedRevision: string,
  /** Who is saving; with it, the version being replaced is kept for undo. */
  author?: NoteAuthor,
  /** Keep the replaced version even if the student saved moments ago, as a restore does. */
  always = false,
): Promise<NoteFile> {
  if (content.length > MAX_NOTE_CHARACTERS) throw new NoteFormatError("This note is too long.");
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(file, {
      realpath: false,
      lockfilePath: `${file}.lock`,
      retries: 0,
      stale: 10_000,
    });
  } catch {
    throw new NoteConflictError("This note is being saved elsewhere. Retry after reloading.");
  }
  try {
    const previous = await readNoteFile(file);
    if (previous.revision !== expectedRevision) throw new NoteConflictError(CHANGED);
    if (author && previous.revision !== MISSING_NOTE && previous.content !== content) {
      const last = (await readNoteHistory(file)).at(-1);
      const often =
        !always &&
        author.kind === "student" &&
        last?.author.kind === "student" &&
        Date.now() - Date.parse(last.at) < STUDENT_EVERY;
      if (!often) {
        const entry: NoteHistoryEntry = {
          v: 1,
          at: new Date().toISOString(),
          author,
          revision: previous.revision,
          content: previous.content,
        };
        await appendFile(historyFile(file), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      }
    }
    await writeAtomic(file, content, {
      check: async () => {
        if ((await readNoteFile(file)).revision !== expectedRevision)
          throw new NoteConflictError(CHANGED);
      },
    });
    return await readNoteFile(file);
  } finally {
    await release();
  }
}
