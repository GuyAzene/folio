import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { privateDirectory, writeAtomic } from "../files.ts";
import { ASSET_FILE } from "./asset-names.ts";
import { pixelSize } from "./images.ts";
import { checkId, LibraryError, sha256, type LibraryStore } from "./store.ts";

export const MAX_ASSET_BYTES = 4 * 1024 * 1024;

export interface SavedAsset {
  /** The file's name: its SHA-256 and its kind. */
  file: string;
  /** How a note in the same course writes it: `assets/<file>`. */
  path: string;
  width: number;
  height: number;
}

/**
 * Figures in a course's notes, such as a diagram cropped from a homework PDF: PNG or JPEG files in
 * `courses/<course>/notes/assets/`, each named by its SHA-256. Saving the same picture again
 * changes nothing. A figure is never deleted with a note, so undoing an edit, bringing back an
 * earlier version or restoring a note from the Trash finds its figures where they were.
 */
export class NoteAssets {
  readonly #library: LibraryStore;

  constructor(library: LibraryStore) {
    this.#library = library;
  }

  async save(courseId: string, bytes: Uint8Array): Promise<SavedAsset> {
    checkId(courseId);
    await this.#library.course(courseId);
    if (bytes.byteLength > MAX_ASSET_BYTES)
      throw new LibraryError("That figure is too large; figures in notes are at most 4 MB.");
    const size = pixelSize(bytes);
    if (!size || !size.width || !size.height)
      throw new LibraryError("A figure in a note must be a PNG or JPEG image.");
    const file = `${sha256(bytes)}.${size.kind}`;
    const directory = this.#directory(courseId);
    await privateDirectory(directory, "library", LibraryError);
    const target = resolve(directory, file);
    const existing = await lstat(target).catch(() => null);
    if (existing && !existing.isFile()) throw new LibraryError("Folio couldn't save that figure.");
    // A file already there is kept only if it is these bytes; a damaged one is written again.
    const intact = existing && sha256(await readFile(target)) === file.slice(0, file.indexOf("."));
    if (!intact) await writeAtomic(target, bytes, { mode: 0o600 });
    return { file, path: `assets/${file}`, width: size.width, height: size.height };
  }

  /** A figure's bytes and type, only if it is exactly the file its name says. */
  async read(courseId: string, file: string): Promise<{ bytes: Uint8Array; type: string }> {
    checkId(courseId);
    if (!ASSET_FILE.test(file)) throw new LibraryError("Unknown figure.");
    const directory = this.#directory(courseId);
    const target = resolve(directory, file);
    const info = await lstat(target).catch(() => null);
    if (!info?.isFile()) throw new LibraryError("Unknown figure.");
    // Never through a link: the folder and the file are where their names say.
    if ((await realpath(target)) !== `${await realpath(directory)}${sep}${file}`)
      throw new LibraryError("Unknown figure.");
    const bytes = await readFile(target);
    if (`${sha256(bytes)}.${file.slice(-3)}` !== file)
      throw new LibraryError("That figure changed on disk.");
    return { bytes, type: file.endsWith(".png") ? "image/png" : "image/jpeg" };
  }

  #directory(courseId: string): string {
    return resolve(this.#library.courseDirectory(courseId), "notes", "assets");
  }
}
