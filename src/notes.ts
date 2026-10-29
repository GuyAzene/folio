import { createHash } from "node:crypto";
import { chmod, lstat, readFile } from "node:fs/promises";
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
    if ((await readNoteFile(file)).revision !== expectedRevision)
      throw new NoteConflictError(CHANGED);
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
