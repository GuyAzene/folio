import { watch } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { writeAtomic } from "./files.ts";

/**
 * A settings file the student may also edit by hand (config.json, mcp.json): Folio writes it
 * whole and atomically, never over an edit it hasn't read, and notices edits made elsewhere.
 */
export class EditableFile {
  readonly path: string;
  readonly #changed: string;
  readonly #mode: number;
  /** The file as Folio last read or wrote it: null when there is none. */
  #text: string | null = null;
  #writing: Promise<unknown> = Promise.resolve();

  /** `changed` is the refusal when the file changed outside Folio since it was read. */
  constructor(path: string, options: { changed: string; mode?: number }) {
    this.path = path;
    this.#changed = options.changed;
    this.#mode = options.mode ?? 0o600;
  }

  get text(): string | null {
    return this.#text;
  }

  /** The file as it is on disk now. */
  async read(): Promise<string | null> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Reads the file again as what Folio knows. */
  async load(): Promise<string | null> {
    this.#text = await this.read();
    return this.#text;
  }

  /**
   * Replaces the file with what `next` makes of it, one write at a time. Refused, after `stale`
   * has read it again, when it changed outside Folio; `written` sees the new text before the next
   * write starts.
   */
  write(
    next: (text: string | null) => string,
    hooks: { stale: () => Promise<unknown>; written: (text: string) => void },
  ): Promise<void> {
    const run = this.#writing.then(async () => {
      const text = await this.read();
      if (text !== this.#text) {
        await hooks.stale();
        throw new Error(this.#changed);
      }
      const contents = next(text);
      // A file linked from elsewhere (a dotfiles folder) stays a link.
      const target = text === null ? this.path : await realpath(this.path);
      await writeAtomic(target, contents, {
        mode: this.#mode,
        check: async () => {
          if ((await this.read()) !== text) throw new Error(this.#changed);
        },
      });
      this.#text = contents;
      hooks.written(contents);
    });
    this.#writing = run.catch(() => undefined);
    return run;
  }

  /** Calls `edited` shortly after the file changes outside Folio, once Folio's writes are done. */
  watch(edited: () => Promise<void>): () => void {
    let timer: NodeJS.Timeout | undefined;
    const name = basename(this.path);
    const watcher = watch(dirname(this.path), { persistent: false }, (_event, changed) => {
      if (changed !== name) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void this.#writing
          .then(edited)
          .catch((error: unknown) => console.error(`Folio could not read ${name}:`, error));
      }, 150);
    });
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }
}
