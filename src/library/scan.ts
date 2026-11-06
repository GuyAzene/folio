import { lstat, readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { DEFAULT_CATEGORIES, guessCategory, type Category } from "./categories.ts";
import { LibraryError, titleFromName, type DocumentRole } from "./store.ts";

export interface ScannedFile {
  path: string;
  /** The path inside the scanned folder. */
  name: string;
  title: string;
  role: DocumentRole;
  /** The category its name points to, by id. */
  category: string;
  kind: "pdf" | "markdown";
  size: number;
}

export interface FolderScan {
  path: string;
  folderName: string;
  files: ScannedFile[];
  /** Other files Folio cannot import yet. */
  skipped: number;
  /** True when the folder held more files than one scan lists. */
  truncated: boolean;
}

const MAX_FILES = 400;
const MAX_DEPTH = 3;
const MAX_BYTES = 300 * 1024 * 1024;

/**
 * Lists the PDFs and Markdown files in a folder the student chose, with a first guess at each
 * one's category. It only reads names and sizes; nothing is copied until the student creates the
 * course. Hidden entries and symbolic links are skipped.
 */
export async function scanFolder(
  root: string,
  categories: readonly Category[] = DEFAULT_CATEGORIES,
): Promise<FolderScan> {
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink())
    throw new LibraryError("Choose a regular folder.");
  const files: ScannedFile[] = [];
  let skipped = 0;
  let truncated = false;

  async function walk(directory: string, depth: number): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      const kind =
        extension === ".pdf"
          ? "pdf"
          : extension === ".md" || extension === ".markdown"
            ? "markdown"
            : undefined;
      if (!kind) {
        skipped++;
        continue;
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const size = (await lstat(path)).size;
      if (size > MAX_BYTES) {
        skipped++;
        continue;
      }
      files.push({
        path,
        // With forward slashes on Windows too, as the window shows it.
        name: relative(root, path).split(sep).join("/"),
        title: titleFromName(entry.name),
        ...guessed(entry.name, kind),
        kind,
        size,
      });
    }
  }

  function guessed(name: string, kind: "pdf" | "markdown") {
    const category = guessCategory(name, kind, categories);
    return { role: category.kind, category: category.id };
  }

  await walk(root, 1);
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { path: root, folderName: basename(root), files, skipped, truncated };
}
