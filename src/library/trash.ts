import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { writeAtomic } from "../files.ts";

/**
 * Folio's own Trash, inside its home: removing a file, note, chat or course moves it into
 * `trash/<entry>/files/` at the same relative path, so restoring moves it straight back. An
 * entry leaves the Trash, by the student's choice or after 30 days, through `discard` — the
 * Mac's Trash in the app, where Finder's Put Back returns it to Folio's Trash.
 */

export const TRASH_DAYS = 30;
const DAY = 86_400_000;

export type TrashKind = "document" | "note" | "chat" | "course";

export interface TrashEntry {
  version: 1;
  id: string;
  kind: TrashKind;
  title: string;
  courseId: string | null;
  courseName: string | null;
  removedAt: string;
  /** What was moved, relative to Folio's home. */
  paths: string[];
  /** What a removed course held, so the Trash can say what restoring brings back. */
  contents?: { documents: number; notes: number; chats: number };
  /** The study-notes version from before a studied file was removed, to bring its notes back. */
  knowledge?: { courseId: string; generation: number; documentIds: string[] };
}

export type TrashInput = Omit<TrashEntry, "version" | "id" | "removedAt" | "paths"> & {
  /** Absolute paths inside Folio's home. */
  paths: string[];
};

export class TrashError extends Error {}

/** Only Folio's own data can go into the Trash or come back out of it. */
const ROOTS = ["library/documents/", "library/courses/", "sessions/"];

export class Trash {
  readonly home: string;
  readonly directory: string;
  readonly #discard: (path: string) => Promise<void>;

  constructor(home: string, options: { discard?: (path: string) => Promise<void> } = {}) {
    this.home = resolve(home);
    this.directory = resolve(this.home, "trash");
    this.#discard = options.discard ?? ((path) => rm(path, { recursive: true, force: true }));
  }

  /** Moves the paths into a new entry. If one move fails, those before it move back. */
  async put(input: TrashInput): Promise<TrashEntry> {
    const id = randomUUID();
    const folder = resolve(this.directory, id);
    const paths = input.paths.map((path) => this.#relative(path));
    const entry: TrashEntry = {
      ...input,
      version: 1,
      id,
      removedAt: new Date().toISOString(),
      paths,
    };
    await mkdir(resolve(folder, "files"), { recursive: true, mode: 0o700 });
    // The record comes first: if Folio stops halfway, restoring finds each item where it is.
    await writeAtomic(resolve(folder, "entry.json"), `${JSON.stringify(entry, null, 2)}\n`);
    const moved: string[] = [];
    try {
      for (const path of paths) {
        const target = resolve(folder, "files", path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await rename(resolve(this.home, path), target);
        moved.push(path);
      }
    } catch (error) {
      for (const path of moved.reverse())
        await rename(resolve(folder, "files", path), resolve(this.home, path)).catch(() => {});
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
    return entry;
  }

  /** Every entry, most recently removed first. */
  async list(): Promise<TrashEntry[]> {
    const entries: TrashEntry[] = [];
    for (const name of await readdir(this.directory).catch(() => [] as string[])) {
      const entry = await this.#read(resolve(this.directory, name));
      if (entry) entries.push(entry);
    }
    return entries.sort((a, b) => b.removedAt.localeCompare(a.removedAt));
  }

  /** Moves everything in the entry back where it was, refusing if something now stands there. */
  async restore(id: string): Promise<TrashEntry> {
    const { entry, folder } = await this.#find(id);
    for (const path of entry.paths)
      if (
        (await exists(resolve(folder, "files", path))) &&
        (await exists(resolve(this.home, path)))
      )
        throw new TrashError(`Something else is already where "${entry.title}" was.`);
    for (const path of entry.paths) {
      const source = resolve(folder, "files", path);
      if (!(await exists(source))) continue;
      const target = resolve(this.home, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(source, target);
    }
    await rm(folder, { recursive: true, force: true });
    return entry;
  }

  /** Takes the entry out of Folio's Trash for good, under a name the Mac's Trash can show. */
  async discard(id: string): Promise<void> {
    const { entry, folder } = await this.#find(id);
    const base = `Folio – ${entry.title.replace(/[/:\\\0]/g, "-").slice(0, 80)}`;
    let named = resolve(this.directory, base);
    for (let n = 2; await exists(named); n++) named = resolve(this.directory, `${base} ${n}`);
    await rename(folder, named);
    await this.#discard(named);
  }

  /** Discards entries removed more than 30 days ago; returns how many. */
  async purge(now = Date.now()): Promise<number> {
    let count = 0;
    for (const entry of await this.list())
      if (now - Date.parse(entry.removedAt) > TRASH_DAYS * DAY) {
        await this.discard(entry.id);
        count++;
      }
    return count;
  }

  async #find(id: string): Promise<{ entry: TrashEntry; folder: string }> {
    for (const name of await readdir(this.directory).catch(() => [] as string[])) {
      const folder = resolve(this.directory, name);
      const entry = await this.#read(folder);
      if (entry?.id === id) return { entry, folder };
    }
    throw new TrashError("That is no longer in the Trash.");
  }

  async #read(folder: string): Promise<TrashEntry | null> {
    try {
      const entry = JSON.parse(await readFile(resolve(folder, "entry.json"), "utf8")) as TrashEntry;
      // An edited record must not move anything outside Folio's own data.
      if (entry.version !== 1 || typeof entry.id !== "string" || !Array.isArray(entry.paths))
        return null;
      entry.paths.forEach((path) => this.#relative(resolve(this.home, path)));
      return entry;
    } catch {
      return null;
    }
  }

  #relative(path: string): string {
    const inside = relative(this.home, resolve(path)).split(sep).join("/");
    if (
      isAbsolute(inside) ||
      inside.split("/").includes("..") ||
      !ROOTS.some((root) => inside.startsWith(root) && inside.length > root.length)
    )
      throw new TrashError("Only Folio's own files can go into its Trash.");
    return inside;
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
