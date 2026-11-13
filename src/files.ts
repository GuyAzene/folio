import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Whether Folio waits for the disk to keep what it writes before it goes on, so that a crash or
 * a power cut right after a save loses nothing. It always does unless FOLIO_FLUSH is "off". The
 * unit tests set that (tests/setup.ts), except where they check the flushing itself. They check
 * what Folio writes, not what a disk keeps through a power cut, and on GitHub's runners waiting
 * for the disk took most of their time.
 */
function flushing(): boolean {
  return process.env.FOLIO_FLUSH !== "off";
}

/** Waits until the disk has kept what was written to an open file. */
export async function flush(handle: FileHandle): Promise<void> {
  if (flushing()) await handle.sync();
}

/**
 * Opens a SQLite database for writing. SQLite waits for the disk on every commit, unless
 * flushing is off.
 */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  if (!flushing()) db.exec("PRAGMA synchronous = OFF");
  return db;
}

type ErrorClass = new (message: string) => Error;

/** Folio's private data never lives inside the repository. */
export function outsideProject(path: string, label: string, ErrorType: ErrorClass): void {
  const part = relative(PROJECT_ROOT, path);
  if (!part || (!part.startsWith("..") && !isAbsolute(part)))
    throw new ErrorType(`Folio ${label} must be stored outside the project directory.`);
}

/** Creates (or tightens) a 0700 directory that is not a symbolic link and not in the project. */
export async function privateDirectory(
  path: string,
  label: string,
  ErrorType: ErrorClass,
): Promise<void> {
  outsideProject(path, label, ErrorType);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink())
    throw new ErrorType(`Folio ${label} directories must not be symbolic links.`);
  outsideProject(await realpath(path), label, ErrorType);
  await chmod(path, 0o700);
}

/**
 * Writes a complete temporary file, runs `check` immediately before replacing the target
 * (to reject concurrent external edits), then renames it into place and syncs the directory.
 */
export async function writeAtomic(
  target: string,
  contents: string | Uint8Array,
  options: { mode?: number; check?: () => Promise<void> } = {},
): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600);
    try {
      await handle.writeFile(contents);
      await flush(handle);
    } finally {
      await handle.close();
    }
    await replaceFile(temporary, target, { check: options.check });
    await syncDirectory(dirname(target));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** What Windows answers a rename while something has either file open. */
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
/** The waits between tries on Windows: about three seconds in all. */
const PAUSES = [10, 20, 40, 80, 160, 320, 640, 1000, 1000];

/**
 * Runs `check`, then renames `from` over `to`. Windows refuses while anything has either file
 * open, such as an antivirus scan of the new file or another program reading the old one, so
 * there a refusal waits and tries again, running `check` again each time.
 */
export async function replaceFile(
  from: string,
  to: string,
  options: {
    check?: () => Promise<void>;
    platform?: NodeJS.Platform;
    move?: (from: string, to: string) => Promise<void>;
    pause?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const move = options.move ?? rename;
  const pause = options.pause ?? ((ms) => new Promise<void>((ready) => setTimeout(ready, ms)));
  for (let tried = 0; ; tried++) {
    await options.check?.();
    try {
      await move(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const busy = typeof code === "string" && BUSY.has(code);
      if ((options.platform ?? process.platform) !== "win32" || !busy || tried === PAUSES.length)
        throw error;
    }
    await pause(PAUSES[tried]!);
  }
}

/**
 * Flushes a folder's list of names to disk, so a rename into it survives a crash. Windows can't
 * open a folder to flush it, and its file system keeps a rename in its own journal, so there it
 * does nothing.
 */
export async function syncDirectory(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await flush(handle);
  } finally {
    await handle.close();
  }
}
