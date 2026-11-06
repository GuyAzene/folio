import type { ImageContent } from "@earendil-works/pi-ai";
import {
  closeSource,
  openSource,
  renderPageJpeg,
  renderRegion,
  textColumn,
  type SourceDocument,
} from "../ingest/pages.ts";
import { pdfPageText, type PageTextOptions } from "./pdf.ts";
import type { DocumentRecord, LibraryStore } from "./store.ts";

/**
 * Reads course PDFs the way the tutor needs them: a page's text, or the page itself as an
 * image so diagrams and handwriting-style slides are seen, not guessed from text. A few
 * documents stay open and recent page images are kept, so a back-and-forth about one slide
 * does not reopen or re-render it. Originals are verified against their hash when opened.
 */
export class PageReader {
  readonly #library: LibraryStore;
  readonly #open = new Map<string, Promise<SourceDocument>>();
  readonly #images = new Map<string, Promise<Uint8Array>>();

  constructor(library: LibraryStore) {
    this.#library = library;
  }

  /** The page's text; with `emphasis`, its bold and italic marked as its fonts give them. */
  async text(document: DocumentRecord, page: number, options?: PageTextOptions): Promise<string> {
    return pdfPageText(await this.#document(document), page, options);
  }

  /** The page as a JPEG (about 100–200 KB). */
  image(document: DocumentRecord, page: number): Promise<Uint8Array> {
    return this.#image(document.sha256, page, () => this.#document(document));
  }

  /** A page of a PDF the student added to a chat, which `load` reads and verifies. */
  async fileText(
    fileId: string,
    page: number,
    load: () => Promise<Uint8Array>,
    options?: PageTextOptions,
  ): Promise<string> {
    return pdfPageText(await this.#source(`file:${fileId}`, load), page, options);
  }

  fileImage(fileId: string, page: number, load: () => Promise<Uint8Array>): Promise<Uint8Array> {
    return this.#image(fileId, page, () => this.#source(`file:${fileId}`, load));
  }

  /**
   * A region of a page, as fractions of it (`[left, top, right, bottom]` from the top-left): a
   * JPEG for a closer look, or a PNG for a figure kept in a note.
   */
  async region(
    document: DocumentRecord,
    page: number,
    region: RegionBox,
    options?: RegionOptions,
  ): Promise<Uint8Array> {
    return (await renderRegion(await this.#document(document), page, region, options)).data;
  }

  async fileRegion(
    fileId: string,
    page: number,
    load: () => Promise<Uint8Array>,
    region: RegionBox,
    options?: RegionOptions,
  ): Promise<Uint8Array> {
    const doc = await this.#source(`file:${fileId}`, load);
    return (await renderRegion(doc, page, region, options)).data;
  }

  /** Where a page's text column runs, as fractions of its width; null when it can't tell. */
  async column(document: DocumentRecord, page: number): Promise<[number, number] | null> {
    return textColumn(await this.#document(document), page);
  }

  async fileColumn(
    fileId: string,
    page: number,
    load: () => Promise<Uint8Array>,
  ): Promise<[number, number] | null> {
    return textColumn(await this.#source(`file:${fileId}`, load), page);
  }

  #image(hash: string, page: number, open: () => Promise<SourceDocument>): Promise<Uint8Array> {
    const key = `${hash}:${page}`;
    let image = this.#images.get(key);
    if (!image) {
      image = open().then((doc) => renderPageJpeg(doc, page));
      image.catch(() => this.#images.delete(key));
      this.#images.set(key, image);
      if (this.#images.size > 24) this.#images.delete(this.#images.keys().next().value!);
    }
    return image;
  }

  async close(): Promise<void> {
    const open = [...this.#open.values()];
    this.#open.clear();
    this.#images.clear();
    await Promise.allSettled(open.map((doc) => doc.then(closeSource)));
  }

  #document(document: DocumentRecord): Promise<SourceDocument> {
    return this.#source(
      `${document.id}:${document.sha256}`,
      async () => (await this.#library.readOriginal(document.id)).data,
    );
  }

  #source(key: string, load: () => Promise<Uint8Array>): Promise<SourceDocument> {
    let opening = this.#open.get(key);
    if (!opening) {
      // Font names let a page's text mark its bold and italic.
      opening = load().then((data) => openSource(data, { fontNames: true }));
      opening.catch(() => this.#open.delete(key));
      this.#open.set(key, opening);
      // Keep a few documents open; release the oldest.
      if (this.#open.size > 4) {
        const [oldest] = this.#open.keys();
        void this.#open.get(oldest!)?.then(closeSource, () => undefined);
        this.#open.delete(oldest!);
      }
    }
    return opening;
  }
}

/** `[left, top, right, bottom]`, each a fraction of the page from its top-left corner. */
export type RegionBox = [number, number, number, number];
export interface RegionOptions {
  maxEdge?: number;
  format?: "jpeg" | "png";
}

/** A page image as model input. */
export function jpeg(data: Uint8Array): ImageContent {
  return { type: "image", data: Buffer.from(data).toString("base64"), mimeType: "image/jpeg" };
}
