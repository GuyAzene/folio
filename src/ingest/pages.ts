import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PageViewport,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Box, TextLayerHealth } from "./types.ts";

/**
 * Page preparation (ingestion step 2): open a source, render pages and crops for models, and
 * read the positioned text layer the inventory is built from.
 */

export type SourceDocument = PDFDocumentProxy;

/** A 2D affine matrix [a, b, c, d, e, f], as PDF and canvas use them. */
export type Matrix = [number, number, number, number, number, number];

/** The long edge most vision models accept without downscaling. */
export const DEFAULT_MAX_EDGE = 1568;
/** Whole pages render at this density unless the long-edge cap is lower. */
const PAGE_DPI = 200;
/** Crops are close-up re-reads; they may go up to this density. */
const CROP_DPI = 400;
const DEFAULT_CROP_PADDING = 8;

/** pdf.js's bundled fonts, CMaps and decoders, so pages that rely on them still render. */
function bundledData(): Record<string, string> {
  try {
    const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
    return {
      standardFontDataUrl: `${join(root, "standard_fonts")}/`,
      cMapUrl: `${join(root, "cmaps")}/`,
      wasmUrl: `${join(root, "wasm")}/`,
    };
  } catch {
    return {};
  }
}

/** Opens a PDF for reading only: no scripts, no embedded font faces, no network. */
export function openSource(data: Uint8Array): Promise<SourceDocument> {
  return getDocument({
    // pdf.js transfers the buffer it is given; keep the caller's copy intact.
    data: data.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    ...bundledData(),
  }).promise;
}

/** Releases the document and its worker. */
export function closeSource(doc: SourceDocument): Promise<void> {
  return doc.loadingTask.destroy();
}

/** a × b: applies b first, then a. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The axis-aligned box around a rectangle [x0, y0, x1, y1] after a transform. */
export function transformBox(m: Matrix, [x0, y0, x1, y1]: Box): Box {
  const corners = [
    applyMatrix(m, x0, y0),
    applyMatrix(m, x1, y0),
    applyMatrix(m, x0, y1),
    applyMatrix(m, x1, y1),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The page at scale 1: points with a top-left origin, page rotation applied. */
export function pageViewport(page: PDFPageProxy): PageViewport {
  return page.getViewport({ scale: 1 });
}

export interface RenderedImage {
  png: Uint8Array;
  /** Pixel size. */
  width: number;
  height: number;
  /** Pixels per page point. */
  scale: number;
}

export interface RenderedCrop extends RenderedImage {
  /** The rendered area in page points (the requested box plus padding, kept on the page). */
  box: Box;
}

async function draw(
  page: PDFPageProxy,
  scale: number,
  [x0, y0, x1, y1]: Box,
  maxEdge: number,
): Promise<RenderedImage> {
  const width = Math.max(1, Math.min(maxEdge, Math.round((x1 - x0) * scale)));
  const height = Math.max(1, Math.min(maxEdge, Math.round((y1 - y0) * scale)));
  const canvas = createCanvas(width, height);
  const viewport = page.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
  // pdf.js drives any canvas with a 2D context; @napi-rs/canvas is the one pdf.js uses in Node.
  const target = canvas as unknown as Parameters<PDFPageProxy["render"]>[0]["canvas"];
  await page.render({ canvas: target, viewport }).promise;
  const png = await canvas.encode("png");
  return { png: new Uint8Array(png.buffer, png.byteOffset, png.byteLength), width, height, scale };
}

/** Renders a whole page at about 200 DPI, capped so its long edge is at most maxEdge pixels. */
export async function renderPage(
  doc: SourceDocument,
  pageNumber: number,
  { maxEdge = DEFAULT_MAX_EDGE }: { maxEdge?: number } = {},
): Promise<RenderedImage> {
  const page = await doc.getPage(pageNumber);
  try {
    const { width, height } = pageViewport(page);
    const scale = Math.min(PAGE_DPI / 72, maxEdge / Math.max(width, height));
    return await draw(page, scale, [0, 0, width, height], maxEdge);
  } finally {
    page.cleanup();
  }
}

/**
 * A whole page as the tutor sees it: a JPEG on a white page, small enough to keep in a saved
 * chat. Separate from `renderPage`, whose PNG bytes key ingestion's cached steps.
 */
export async function renderPageJpeg(
  doc: SourceDocument,
  pageNumber: number,
  { maxEdge = 1280, quality = 82 }: { maxEdge?: number; quality?: number } = {},
): Promise<Uint8Array> {
  const page = await doc.getPage(pageNumber);
  try {
    const { width, height } = pageViewport(page);
    const scale = Math.min(PAGE_DPI / 72, maxEdge / Math.max(width, height));
    const canvas = createCanvas(
      Math.max(1, Math.min(maxEdge, Math.round(width * scale))),
      Math.max(1, Math.min(maxEdge, Math.round(height * scale))),
    );
    // JPEG has no transparency: paint the paper first.
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const target = canvas as unknown as Parameters<PDFPageProxy["render"]>[0]["canvas"];
    await page.render({ canvas: target, viewport: page.getViewport({ scale }) }).promise;
    const jpeg = await canvas.encode("jpeg", quality);
    return new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  } finally {
    page.cleanup();
  }
}

/**
 * Renders one region (a box in page points, top-left origin) for a close-up re-read: up to
 * about 400 DPI, capped so the long edge is at most maxEdge pixels.
 */
export async function renderCrop(
  doc: SourceDocument,
  pageNumber: number,
  box: Box,
  {
    maxEdge = DEFAULT_MAX_EDGE,
    padding = DEFAULT_CROP_PADDING,
  }: { maxEdge?: number; padding?: number } = {},
): Promise<RenderedCrop> {
  const page = await doc.getPage(pageNumber);
  try {
    const { width, height } = pageViewport(page);
    const crop: Box = [
      Math.max(0, Math.min(box[0], box[2]) - padding),
      Math.max(0, Math.min(box[1], box[3]) - padding),
      Math.min(width, Math.max(box[0], box[2]) + padding),
      Math.min(height, Math.max(box[1], box[3]) + padding),
    ];
    if (crop[2] - crop[0] < 1 || crop[3] - crop[1] < 1)
      throw new RangeError(`The crop [${box.join(", ")}] is outside page ${pageNumber}`);
    const scale = Math.min(CROP_DPI / 72, maxEdge / Math.max(crop[2] - crop[0], crop[3] - crop[1]));
    return { ...(await draw(page, scale, crop, maxEdge)), box: crop };
  } finally {
    page.cleanup();
  }
}

export interface PageTextItem {
  /** pdf.js's text for this run, in logical order within the run. */
  str: string;
  /** pdf.js's direction for the run: it applies a bidi subset to each chunk of text. */
  dir: "ltr" | "rtl" | "ttb";
  /** Glyph box in page points, top-left origin, from the font's ascent and descent. */
  box: Box;
  /** Start of the baseline in page points, top-left origin. */
  origin: [number, number];
  /** Effective font size in points (the text matrix's vertical scale). */
  size: number;
  /** pdf.js's glyph height in points; 0 for runs of spaces. */
  height: number;
  /** Advance along the baseline in points. */
  width: number;
  /** Drawn left to right on a horizontal baseline, after page rotation. */
  horizontal: boolean;
  fontName: string;
  hasEOL: boolean;
}

/** Font metrics pdf.js reports as null or out of range fall back to typical Latin values. */
function metric(value: number | null | undefined, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** The text layer with positions; includes pdf.js's empty end-of-line markers and spaces. */
export async function textItems(page: PDFPageProxy): Promise<PageTextItem[]> {
  const viewport = pageViewport(page);
  const content = await page.getTextContent();
  const items: PageTextItem[] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const style = content.styles[item.fontName];
    const ascent = metric(style?.ascent, 0.8, 0.3, 1.5);
    const descent = metric(style?.descent, -0.2, -1, 0);
    const m = multiply(viewport.transform as Matrix, item.transform as Matrix);
    const along = Math.hypot(m[0], m[1]);
    const size = Math.hypot(m[2], m[3]);
    const [ux, uy] = along > 0 ? [m[0] / along, m[1] / along] : [1, 0];
    // The "up" direction on the page; in top-left coordinates upright text has (0, -1).
    const [vx, vy] = size > 0 ? [m[2] / size, m[3] / size] : [uy, -ux];
    const origin: [number, number] = [m[4], m[5]];
    const dir = item.dir === "rtl" || item.dir === "ttb" ? item.dir : "ltr";
    let box: Box;
    if (dir === "ttb") {
      // Vertical fonts: pdf.js reports the advance as height and the glyph size as width.
      box = [
        origin[0] - item.width / 2,
        origin[1],
        origin[0] + item.width / 2,
        origin[1] + item.height,
      ];
    } else {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const t of [0, item.width])
        for (const s of [descent * size, ascent * size]) {
          xs.push(origin[0] + ux * t + vx * s);
          ys.push(origin[1] + uy * t + vy * s);
        }
      box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    items.push({
      str: item.str,
      dir,
      box,
      origin,
      size,
      height: item.height,
      width: item.width,
      horizontal: dir !== "ttb" && Math.abs(uy) < 0.01 && ux > 0 && vy < 0,
      fontName: item.fontName,
      hasEOL: item.hasEOL,
    });
  }
  return items;
}

/** The page's positioned text layer. */
export async function pageText(doc: SourceDocument, pageNumber: number): Promise<PageTextItem[]> {
  const page = await doc.getPage(pageNumber);
  try {
    return await textItems(page);
  } finally {
    page.cleanup();
  }
}

const REPLACEMENT = /\ufffd/u;
const PRIVATE_USE = /[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
/** A run that is one private-use character: a Symbol or Wingdings bullet. */
const BULLET = new RegExp(`^${PRIVATE_USE.source}$`, "u");
// C0 and C1 controls other than tab and line breaks: fonts without a Unicode map.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const HEBREW_WORD = /[\u05d0-\u05ea]{2,}/gu;
const HEBREW_FINAL = /[\u05da\u05dd\u05df\u05e3\u05e5]/u;
/** Fewer letters and digits than this is nothing to anchor to. */
const MIN_MEANINGFUL = 3;

/**
 * How far the text layer can be trusted.
 * - "suspect": a replacement character (U+FFFD), private-use characters, control characters,
 *   or Hebrew in visual order (final letter forms, which only end words, start more words
 *   than they end, at least twice). A run that is a single private-use character is a
 *   Symbol or Wingdings bullet and does not count.
 * - "empty": fewer than three letters and digits, as on a scan or a slide exported as a picture.
 * - "ok" otherwise.
 */
export function textLayerHealth(items: readonly { str: string }[]): TextLayerHealth {
  let meaningful = 0;
  let finalFirst = 0;
  let finalLast = 0;
  let garbage = false;
  for (const { str } of items) {
    if (BULLET.test(str.trim())) continue;
    if (REPLACEMENT.test(str) || PRIVATE_USE.test(str) || CONTROL.test(str)) garbage = true;
    meaningful += str.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    for (const word of str.match(HEBREW_WORD) ?? []) {
      if (HEBREW_FINAL.test(word[0]!)) finalFirst++;
      if (HEBREW_FINAL.test(word.at(-1)!)) finalLast++;
    }
  }
  if (garbage || (finalFirst >= 2 && finalFirst > finalLast)) return "suspect";
  return meaningful < MIN_MEANINGFUL ? "empty" : "ok";
}
