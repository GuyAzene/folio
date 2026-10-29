import { deflateSync } from "node:zlib";

/**
 * A dependency-free builder for synthetic lecture slides: positioned text, vector drawings
 * and small raster images, all in top-left page points like the inventory's boxes. Every
 * fixture is disposable test data, never real course material.
 */

/** [x, y] in page points with a top-left origin. */
export type Point = [number, number];

/**
 * "sans" is Helvetica. "symbol" is the standard Symbol font: pass its byte codes (see SYMBOL).
 * "hebrew" draws Helvetica glyphs whose ToUnicode map yields Hebrew letters, written in visual
 * order the way many producers do, so pdf.js has to restore the logical order. The page shows
 * Latin glyphs; only the text layer is Hebrew. Brackets are not mirrored.
 */
export type SlideFont = "sans" | "symbol" | "hebrew";

export interface TextRun {
  text: string;
  font?: SlideFont;
}

export interface SlideText {
  x: number;
  /** The baseline, measured from the top of the page. */
  y: number;
  size?: number;
  text?: string;
  /** Consecutive runs on one line, each continuing where the previous one ended. */
  runs?: TextRun[];
}

export type SlideShape =
  | { kind: "line"; from: Point; to: Point; width?: number }
  | {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      /** Fill with this gray level (0 black, 1 white) instead of stroking. */
      fill?: number;
    }
  | { kind: "circle"; center: Point; radius: number }
  | { kind: "arrow"; from: Point; to: Point };

export interface SlideImage {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The raster's pixel size; a generated RGB gradient. */
  pixels?: [number, number];
  /** Shows only this part of the picture, through a clip path (top-left x, y, width, height). */
  clip?: [number, number, number, number];
}

export interface SyntheticSlide {
  width?: number;
  height?: number;
  /** The page's /Rotate, in degrees clockwise. */
  rotate?: number;
  shapes?: SlideShape[];
  images?: SlideImage[];
  texts?: SlideText[];
}

/** Byte codes in the Symbol font's built-in encoding. */
export const SYMBOL = {
  lessEqual: "\u00a3",
  greaterEqual: "\u00b3",
  sum: "\u00e5",
  arrowRight: "\u00ae",
} as const;

/** Hebrew letters (U+05D0 to U+05EA) map onto codes 0xC0 onward in the "hebrew" font. */
const HEBREW_FIRST = 0x05d0;
const HEBREW_LAST = 0x05ea;
const HEBREW_CODE = 0xc0;

/**
 * Logical Hebrew text to glyph codes in visual (left-to-right drawing) order: the line is
 * reversed, but a run from an ASCII letter or digit to the last one before the next Hebrew
 * letter keeps its own order, as in a right-to-left paragraph.
 */
function hebrewCodes(text: string): string {
  const tokens = text.match(/[0-9A-Za-z](?:[^\u05d0-\u05ea]*[0-9A-Za-z)\]}])?|./gu) ?? [];
  let codes = "";
  for (const token of tokens.reverse()) {
    const point = token.codePointAt(0)!;
    if (point >= HEBREW_FIRST && point <= HEBREW_LAST)
      codes += String.fromCharCode(HEBREW_CODE + point - HEBREW_FIRST);
    else if (point < 0x80) codes += token;
    else throw new Error(`The hebrew fixture font cannot encode ${token}`);
  }
  return codes;
}

function pdfString(bytes: string): string {
  let out = "(";
  for (const char of bytes) {
    const code = char.charCodeAt(0);
    if (code > 0xff) throw new Error(`Not a single-byte code: ${char}`);
    if (char === "\\" || char === "(" || char === ")") out += `\\${char}`;
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += char;
  }
  return `${out})`;
}

const n = (value: number) => String(Math.round(value * 1000) / 1000);

function shapeOperations(shape: SlideShape, height: number): string[] {
  const y = (value: number) => n(height - value);
  switch (shape.kind) {
    case "line":
      return [
        `${n(shape.width ?? 1)} w`,
        `${n(shape.from[0])} ${y(shape.from[1])} m`,
        `${n(shape.to[0])} ${y(shape.to[1])} l`,
        "S",
      ];
    case "rect":
      return [
        shape.fill === undefined ? "1 w" : `${n(shape.fill)} g`,
        `${n(shape.x)} ${y(shape.y + shape.height)} ${n(shape.width)} ${n(shape.height)} re`,
        shape.fill === undefined ? "S" : "f",
      ];
    case "circle": {
      const [cx, cy] = shape.center;
      const r = shape.radius;
      const k = r * 0.5523;
      const Y = height - cy;
      return [
        "1 w",
        `${n(cx + r)} ${n(Y)} m`,
        `${n(cx + r)} ${n(Y + k)} ${n(cx + k)} ${n(Y + r)} ${n(cx)} ${n(Y + r)} c`,
        `${n(cx - k)} ${n(Y + r)} ${n(cx - r)} ${n(Y + k)} ${n(cx - r)} ${n(Y)} c`,
        `${n(cx - r)} ${n(Y - k)} ${n(cx - k)} ${n(Y - r)} ${n(cx)} ${n(Y - r)} c`,
        `${n(cx + k)} ${n(Y - r)} ${n(cx + r)} ${n(Y - k)} ${n(cx + r)} ${n(Y)} c`,
        "S",
      ];
    }
    case "arrow": {
      const [x0, y0] = shape.from;
      const [x1, y1] = shape.to;
      const length = Math.hypot(x1 - x0, y1 - y0) || 1;
      const [ux, uy] = [(x1 - x0) / length, (y1 - y0) / length];
      const head = 8;
      const half = 4;
      const bx = x1 - ux * head;
      const by = y1 - uy * head;
      return [
        "1 w",
        `${n(x0)} ${y(y0)} m`,
        `${n(bx)} ${y(by)} l`,
        "S",
        `${n(x1)} ${y(y1)} m`,
        `${n(bx - uy * half)} ${y(by + ux * half)} l`,
        `${n(bx + uy * half)} ${y(by - ux * half)} l`,
        "h f",
      ];
    }
  }
}

function gradient([width, height]: [number, number]): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++) {
      const offset = (row * width + column) * 3;
      pixels[offset] = Math.round((column / Math.max(1, width - 1)) * 255);
      pixels[offset + 1] = Math.round((row / Math.max(1, height - 1)) * 255);
      pixels[offset + 2] = 128;
    }
  return pixels;
}

const FONT_KEYS: Record<SlideFont, string> = { sans: "F1", symbol: "F2", hebrew: "F3" };

function textOperations(text: SlideText, height: number): string {
  const runs = text.runs ?? [{ text: text.text ?? "" }];
  const size = n(text.size ?? 18);
  const operations = ["BT", `1 0 0 1 ${n(text.x)} ${n(height - text.y)} Tm`];
  for (const run of runs) {
    const font = run.font ?? "sans";
    const bytes = font === "hebrew" ? hebrewCodes(run.text) : run.text;
    operations.push(`/${FONT_KEYS[font]} ${size} Tf`, `${pdfString(bytes)} Tj`);
  }
  operations.push("ET");
  return operations.join("\n");
}

function hebrewToUnicode(): string {
  const count = HEBREW_LAST - HEBREW_FIRST + 1;
  const hex = (value: number, width: number) =>
    value.toString(16).toUpperCase().padStart(width, "0");
  const entries = Array.from(
    { length: count },
    (_, index) => `<${hex(HEBREW_CODE + index, 2)}> <${hex(HEBREW_FIRST + index, 4)}>`,
  );
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<00> <FF>",
    "endcodespacerange",
    `1 beginbfchar`,
    "<20> <0020>",
    "endbfchar",
    `${entries.length} beginbfchar`,
    ...entries,
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
}

/** Builds a valid PDF in memory. Text must be ASCII, Symbol byte codes, or Hebrew letters. */
export function syntheticSlides(slides: SyntheticSlide[]): Uint8Array {
  const encoder = new TextEncoder();
  const objects: Uint8Array[] = [];
  const add = (body: string | Uint8Array, stream?: Uint8Array): number => {
    const head = typeof body === "string" ? encoder.encode(body) : body;
    objects.push(
      stream
        ? concat([head, encoder.encode("\nstream\n"), stream, encoder.encode("\nendstream")])
        : head,
    );
    return objects.length;
  };

  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // The page tree, filled in once the pages exist.
  const sans = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const symbol = add("<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>");
  const cmap = encoder.encode(hebrewToUnicode());
  const toUnicode = add(`<< /Length ${cmap.length} >>`, cmap);
  const hebrew = add(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding ` +
      `/ToUnicode ${toUnicode} 0 R >>`,
  );
  const fonts = `/Font << /F1 ${sans} 0 R /F2 ${symbol} 0 R /F3 ${hebrew} 0 R >>`;

  const pageIds: number[] = [];
  for (const slide of slides) {
    const width = slide.width ?? 720;
    const height = slide.height ?? 540;
    const xObjects: string[] = [];
    const operations: string[] = [];
    for (const shape of slide.shapes ?? [])
      operations.push("q", ...shapeOperations(shape, height), "Q");
    for (const image of slide.images ?? []) {
      const pixels = image.pixels ?? [32, 24];
      const data = deflateSync(gradient(pixels));
      const id = add(
        `<< /Type /XObject /Subtype /Image /Width ${pixels[0]} /Height ${pixels[1]} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>`,
        data,
      );
      const name = `Im${xObjects.length + 1}`;
      xObjects.push(`/${name} ${id} 0 R`);
      const clip = image.clip
        ? [
            `${n(image.clip[0])} ${n(height - image.clip[1] - image.clip[3])} ${n(image.clip[2])} ${n(image.clip[3])} re W n`,
          ]
        : [];
      operations.push(
        "q",
        ...clip,
        `${n(image.width)} 0 0 ${n(image.height)} ${n(image.x)} ${n(height - image.y - image.height)} cm`,
        `/${name} Do`,
        "Q",
      );
    }
    for (const text of slide.texts ?? []) operations.push(textOperations(text, height));
    const content = encoder.encode(operations.join("\n"));
    const contentId = add(`<< /Length ${content.length} >>`, content);
    const resources = `<< ${fonts}${xObjects.length ? ` /XObject << ${xObjects.join(" ")} >>` : ""} >>`;
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(width)} ${n(height)}] ` +
          (slide.rotate ? `/Rotate ${slide.rotate} ` : "") +
          `/Resources ${resources} /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[1] = encoder.encode(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
  );

  const chunks: Uint8Array[] = [encoder.encode("%PDF-1.4\n%\u00e2\u00e3\n")];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = concat([
      encoder.encode(`${index + 1} 0 obj\n`),
      body,
      encoder.encode("\nendobj\n"),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const size = objects.length + 1;
  chunks.push(
    encoder.encode(
      `xref\n0 ${size}\n0000000000 65535 f \n` +
        offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
        `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return concat(chunks);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
