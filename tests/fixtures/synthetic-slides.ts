import { deflateSync, inflateSync } from "node:zlib";

/**
 * A dependency-free builder for synthetic lecture slides: positioned text, vector drawings
 * and raster images, all in top-left page points like the inventory's boxes. Every fixture is
 * disposable test data, never real course material.
 */

/** [x, y] in page points with a top-left origin. */
export type Point = [number, number];

/**
 * "sans" is Helvetica. "symbol" is the standard Symbol font: pass its byte codes (see SYMBOL).
 * "hebrew" draws Helvetica glyphs whose ToUnicode map yields Hebrew letters, written in visual
 * order the way many producers do, so pdf.js has to restore the logical order. The page shows
 * Latin glyphs; only the text layer is Hebrew. Brackets are not mirrored. To show Hebrew, draw
 * it into a `png` image and lay `invisible` Hebrew text over it.
 * "math" draws Helvetica-Oblique letters whose text layer is Unicode mathematical italic (𝑀,
 * 𝑥), as equation editors encode them; digits and other characters stay as they are.
 */
export type SlideFont = "sans" | "symbol" | "hebrew" | "math";

export interface TextRun {
  text: string;
  font?: SlideFont;
  /** This run's own size, such as a smaller subscript; the text's size otherwise. */
  size?: number;
  /** Raises the run above the baseline, in points; negative for a subscript. */
  rise?: number;
}

export interface SlideText {
  x: number;
  /** The baseline, measured from the top of the page. */
  y: number;
  size?: number;
  text?: string;
  /** Consecutive runs on one line, each continuing where the previous one ended. */
  runs?: TextRun[];
  /**
   * In the text layer but not drawn (render mode 3), as on a scanned slide whose text was
   * recognized: laid over a picture, it gives the picture's words a text layer.
   */
  invisible?: boolean;
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
  /**
   * A picture to show instead of the gradient: an 8-bit RGB or RGBA PNG, not interlaced, as
   * @napi-rs/canvas encodes one. Its transparency becomes a soft mask.
   */
  png?: Uint8Array;
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
 * Mathematical italic for each ASCII letter: A–Z from U+1D434, a–z from U+1D44E, except h,
 * whose italic form is the Planck constant (U+210E) because its slot is unassigned.
 */
function mathItalic(letter: string): string {
  if (letter === "h") return "\u210e";
  const code = letter.charCodeAt(0);
  return String.fromCodePoint(code >= 0x61 ? 0x1d44e + code - 0x61 : 0x1d434 + code - 0x41);
}

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

const FONT_KEYS: Record<SlideFont, string> = {
  sans: "F1",
  symbol: "F2",
  hebrew: "F3",
  math: "F4",
};

function textOperations(text: SlideText, height: number): string {
  const runs = text.runs ?? [{ text: text.text ?? "" }];
  // Text state outlives ET: an invisible text keeps its render mode to itself.
  const operations = [
    ...(text.invisible ? ["q"] : []),
    "BT",
    `1 0 0 1 ${n(text.x)} ${n(height - text.y)} Tm`,
    ...(text.invisible ? ["3 Tr"] : []),
  ];
  let rise = 0;
  for (const run of runs) {
    const font = run.font ?? "sans";
    const bytes = font === "hebrew" ? hebrewCodes(run.text) : run.text;
    if ((run.rise ?? 0) !== rise) operations.push(`${n((rise = run.rise ?? 0))} Ts`);
    operations.push(
      `/${FONT_KEYS[font]} ${n(run.size ?? text.size ?? 18)} Tf`,
      `${pdfString(bytes)} Tj`,
    );
  }
  if (rise) operations.push("0 Ts");
  operations.push("ET", ...(text.invisible ? ["Q"] : []));
  return operations.join("\n");
}

/** A ToUnicode CMap for single-byte codes, each mapped to a string of one or more characters. */
function toUnicode(entries: [code: number, text: string][]): string {
  const hex = (value: number, width: number) =>
    value.toString(16).toUpperCase().padStart(width, "0");
  // A JavaScript string is already UTF-16: its code units, surrogate pairs included.
  const utf16 = (text: string) =>
    Array.from({ length: text.length }, (_, index) => hex(text.charCodeAt(index), 4)).join("");
  const lines: string[] = [];
  // A bfchar block holds at most 100 entries.
  for (let at = 0; at < entries.length; at += 100) {
    const block = entries.slice(at, at + 100);
    lines.push(
      `${block.length} beginbfchar`,
      ...block.map(([code, text]) => `<${hex(code, 2)}> <${utf16(text)}>`),
      "endbfchar",
    );
  }
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
    ...lines,
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
  const mapped = (baseFont: string, entries: [number, string][]) => {
    const cmap = encoder.encode(toUnicode(entries));
    const map = add(`<< /Length ${cmap.length} >>`, cmap);
    return add(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /Encoding /WinAnsiEncoding ` +
        `/ToUnicode ${map} 0 R >>`,
    );
  };
  const hebrew = mapped("Helvetica", [
    [0x20, " "],
    ...Array.from({ length: HEBREW_LAST - HEBREW_FIRST + 1 }, (_, index): [number, string] => [
      HEBREW_CODE + index,
      String.fromCharCode(HEBREW_FIRST + index),
    ]),
  ]);
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const math = mapped(
    "Helvetica-Oblique",
    letters.split("").map((letter): [number, string] => [letter.charCodeAt(0), mathItalic(letter)]),
  );
  const fonts = `/Font << /F1 ${sans} 0 R /F2 ${symbol} 0 R /F3 ${hebrew} 0 R /F4 ${math} 0 R >>`;

  const pageIds: number[] = [];
  for (const slide of slides) {
    const width = slide.width ?? 720;
    const height = slide.height ?? 540;
    const xObjects: string[] = [];
    const operations: string[] = [];
    for (const shape of slide.shapes ?? [])
      operations.push("q", ...shapeOperations(shape, height), "Q");
    for (const image of slide.images ?? []) {
      const picture = image.png
        ? decodePng(image.png)
        : { size: image.pixels ?? [32, 24], rgb: gradient(image.pixels ?? [32, 24]), alpha: null };
      const [pixelWidth, pixelHeight] = picture.size;
      const raster = (colorSpace: string, samples: Uint8Array, extra = "") => {
        const data = deflateSync(samples);
        return add(
          `<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} ` +
            `/ColorSpace /${colorSpace} /BitsPerComponent 8 /Filter /FlateDecode${extra} /Length ${data.length} >>`,
          data,
        );
      };
      const mask = picture.alpha ? raster("DeviceGray", picture.alpha) : null;
      const id = raster("DeviceRGB", picture.rgb, mask ? ` /SMask ${mask} 0 R` : "");
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

/**
 * The pixels of an 8-bit RGB or RGBA PNG that is not interlaced: RGB samples, and the alpha
 * channel when any pixel is not opaque. Anything else is refused rather than drawn wrong.
 */
function decodePng(png: Uint8Array): {
  size: [number, number];
  rgb: Uint8Array;
  alpha: Uint8Array | null;
} {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((byte, index) => png[index] !== byte)) throw new Error("Not a PNG.");
  let header = { width: 0, height: 0, depth: 0, color: 0, interlace: 0 };
  const data: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR")
      header = {
        width: view.getUint32(at + 8),
        height: view.getUint32(at + 12),
        depth: body[8]!,
        color: body[9]!,
        interlace: body[12]!,
      };
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const { width, height, depth, color, interlace } = header;
  if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0)
    throw new Error("Only 8-bit RGB or RGBA PNGs that are not interlaced can be embedded.");
  const channels = color === 6 ? 4 : 3;
  const stride = width * channels;
  const filtered = inflateSync(concat(data));
  const pixels = new Uint8Array(height * stride);
  for (let row = 0; row < height; row++) {
    const filter = filtered[row * (stride + 1)]!;
    const line = filtered.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? pixels[row * stride + index - channels]! : 0;
      const up = row ? pixels[(row - 1) * stride + index]! : 0;
      const corner = row && index >= channels ? pixels[(row - 1) * stride + index - channels]! : 0;
      let value = line[index]!;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner;
        const [a, b, c] = [estimate - left, estimate - up, estimate - corner].map(Math.abs);
        value += a! <= b! && a! <= c! ? left : b! <= c! ? up : corner;
      }
      pixels[row * stride + index] = value & 0xff;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel++) {
    rgb.set(pixels.subarray(pixel * channels, pixel * channels + 3), pixel * 3);
    alpha[pixel] = channels === 4 ? pixels[pixel * channels + 3]! : 255;
  }
  return { size: [width, height], rgb, alpha: alpha.some((value) => value < 255) ? alpha : null };
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
