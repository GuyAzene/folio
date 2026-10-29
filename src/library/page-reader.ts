import type { ImageContent } from "@earendil-works/pi-ai";
import { closeSource, openSource, renderPageJpeg, type SourceDocument } from "../ingest/pages.ts";
import { pdfPageText } from "./pdf.ts";
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

  async text(document: DocumentRecord, page: number): Promise<string> {
    return pdfPageText(await this.#document(document), page);
  }

  /** The page as a JPEG (about 100–200 KB). */
  image(document: DocumentRecord, page: number): Promise<Uint8Array> {
    const key = `${document.sha256}:${page}`;
    let image = this.#images.get(key);
    if (!image) {
      image = this.#document(document).then((doc) => renderPageJpeg(doc, page));
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
    const key = `${document.id}:${document.sha256}`;
    let opening = this.#open.get(key);
    if (!opening) {
      opening = this.#library.readOriginal(document.id).then(({ data }) => openSource(data));
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

/** A page image as model input. */
export function jpeg(data: Uint8Array): ImageContent {
  return { type: "image", data: Buffer.from(data).toString("base64"), mimeType: "image/jpeg" };
}
