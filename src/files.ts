import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.check?.();
    await rename(temporary, target);
    await syncDirectory(dirname(target));
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Flushes a folder's list of names to disk, so a rename into it survives a crash. Windows can't
 * open a folder to flush it, and its file system keeps a rename in its own journal, so there it
 * does nothing.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
