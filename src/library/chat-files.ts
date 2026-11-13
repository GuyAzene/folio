import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { flush } from "../files.ts";
import { pdfPageCount } from "./pdf.ts";
import { LibraryError, LibraryIntegrityError, sha256 } from "./store.ts";

/** A PDF or Markdown file the student added to a chat, before or without adding it to a course. */
export interface ChatFile {
  /** The SHA-256 of its contents, which names it. */
  fileId: string;
  name: string;
  kind: "pdf" | "markdown";
  pages: number | null;
  size: number;
}

const MAX_BYTES = 300 * 1024 * 1024;
const FILE_ID = /^[0-9a-f]{64}$/;

export function isFileId(value: unknown): value is string {
  return typeof value === "string" && FILE_ID.test(value);
}

/**
 * Files added in chats, kept in `files/` in Folio's home under their hash: written once, made
 * read-only, and checked against the hash on every read, like a course's originals. A chat
 * reads one only where the student added it; adding it to a course copies it into the library.
 */
export class ChatFiles {
  readonly directory: string;

  constructor(home: string) {
    this.directory = resolve(home, "files");
  }

  path(file: Pick<ChatFile, "fileId" | "kind">): string {
    if (!isFileId(file.fileId)) throw new LibraryError("Unknown file.");
    return resolve(this.directory, `${file.fileId}.${file.kind === "pdf" ? "pdf" : "md"}`);
  }

  /** Copies in a file the student chose; the same file added twice is kept once. */
  async add(source: string): Promise<ChatFile> {
    const name = basename(source);
    const info = await lstat(source).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink())
      throw new LibraryError(`${name} is not a regular file.`);
    if (info.size > MAX_BYTES) throw new LibraryError(`${name} is too large.`);
    const extension = extname(source).toLowerCase();
    const kind =
      extension === ".pdf"
        ? "pdf"
        : [".md", ".markdown"].includes(extension)
          ? "markdown"
          : undefined;
    if (!kind) throw new LibraryError("Folio can add PDF and Markdown files to a chat for now.");
    const data = new Uint8Array(await readFile(source));
    let pages: number | null = null;
    if (kind === "pdf") {
      if (new TextDecoder().decode(data.subarray(0, 5)) !== "%PDF-")
        throw new LibraryError(`${name} is not a PDF.`);
      pages = await pdfPageCount(data).catch(() => {
        throw new LibraryError(`${name} could not be read as a PDF.`);
      });
    } else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new LibraryError(`${name} is not UTF-8 text.`);
      }
    }
    const file: ChatFile = { fileId: sha256(data), name, kind, pages, size: data.byteLength };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(file);
    if (await lstat(path).catch(() => undefined)) return file;
    const handle = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      // Added at the same moment from another question: the same bytes are already there.
      if (error.code === "EEXIST") return null;
      throw error;
    });
    if (!handle) return file;
    try {
      await handle.writeFile(data);
      await flush(handle);
    } finally {
      await handle.close();
    }
    await chmod(path, 0o400);
    return file;
  }

  /** The file's bytes, verified against its hash. */
  async read(file: Pick<ChatFile, "fileId" | "kind">): Promise<Uint8Array> {
    const data = new Uint8Array(
      await readFile(this.path(file)).catch(() => {
        throw new LibraryError("That file is no longer in Folio.");
      }),
    );
    if (sha256(data) !== file.fileId)
      throw new LibraryIntegrityError("That file changed outside Folio, so Folio won't read it.");
    return data;
  }
}
