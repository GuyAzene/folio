import { createHash } from "node:crypto";
import { OPS, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  closeSource,
  multiply,
  openSource,
  pageViewport,
  textItems,
  textLayerHealth,
  transformBox,
  type Matrix,
  type PageTextItem,
  type SourceDocument,
} from "./pages.ts";
import type { Box, PageInventory, Region, RegionKind, SourceInventory } from "./types.ts";

/**
 * The region inventory (ingestion step 3): code, not a model, decides what exists on each page.
 * Later steps must account for every region ID here. Same input, same output: every rule below
 * is deterministic and every sort has a total order.
 */

export const INVENTORY_VERSION = 1;

/** Text items on one line overlap vertically by at least this share of the shorter item. */
const LINE_OVERLAP = 0.5;
/** A horizontal gap wider than this many font sizes splits a line (columns, table cells). */
const LINE_SPLIT_GAP = 2;
/** A gap wider than this many font sizes between joined items becomes a space. */
const SPACE_GAP = 0.15;
/**
 * Lines join a block when their baselines are at most 1.8 font sizes apart (1.5 line heights at
 * the usual 1.2 leading), their sizes differ by at most 25%, and they overlap horizontally.
 */
const BLOCK_PITCH = 1.8;
const BLOCK_SIZE_RATIO = 1.25;
/** Regions whose tops are within this many points share a reading-order row. */
const ROW_TOLERANCE = 8;
/** Vector shapes closer than this many points belong to one drawing. */
const CLUSTER_GAP = 6;
/** A text item is a drawing's label when its center is inside the drawing, give or take this. */
const LABEL_MARGIN = 2;
/** Images and unlabeled drawings smaller than this on both sides, or this thin, are decoration. */
const MIN_VISUAL = 10;
const MAX_THIN = 3;
/** Shapes covering this share of the page in both directions are backgrounds or page frames. */
const BACKGROUND_SHARE = 0.9;
/** Shapes spanning this share of the page in either direction are bands, side bars or rules. */
const BLEED_SHARE = 0.95;

const UNIT: Box = [0, 0, 1, 1];

interface Shape {
  box: Box;
}

interface Visuals {
  images: Box[];
  shapes: Shape[];
}

function intersect(a: Box, b: Box): Box | null {
  const box: Box = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return box[0] <= box[2] && box[1] <= box[3] ? box : null;
}

function union(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function near(a: Box, b: Box, gap: number): boolean {
  return a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3];
}

const width = (box: Box) => box[2] - box[0];
const height = (box: Box) => box[3] - box[1];
/** Code-unit order, the same on every machine (unlike localeCompare). */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round = (value: number) => Math.round(value * 100) / 100 || 0;
const roundBox = (box: Box): Box => [round(box[0]), round(box[1]), round(box[2]), round(box[3])];

function finiteBox(values: ArrayLike<number> | null | undefined): Box | null {
  if (!values || values.length < 4) return null;
  const box: Box = [values[0]!, values[1]!, values[2]!, values[3]!];
  return box.every(Number.isFinite) && box[0] <= box[2] && box[1] <= box[3] ? box : null;
}

/**
 * Images and painted vector paths from the operator list, in page points with a top-left origin.
 * The walk tracks the current transformation matrix the way pdf.js's canvas renderer does:
 * save/restore, transform, form XObjects (matrix and bounding box), transparency groups and
 * annotation appearances. Clip paths narrow what follows, so cropped pictures keep only their
 * visible part. Uses pdf.js 6's operator format: constructPath carries [paint op, [path], minMax].
 */
function collectVisuals(
  fnArray: number[],
  argsArray: unknown[][],
  base: Matrix,
  page: Box,
): Visuals {
  const images: Box[] = [];
  const shapes: Shape[] = [];
  let ctm = base;
  let clip: Box | null = page;
  let pendingClip = false;
  const stack: { ctm: Matrix; clip: Box | null }[] = [];
  const push = () => stack.push({ ctm, clip });
  const pop = () => {
    const state = stack.pop();
    if (state) ({ ctm, clip } = state);
  };
  const visible = (box: Box) => (clip ? intersect(box, clip) : null);
  const image = (m: Matrix) => {
    const box = visible(transformBox(m, UNIT));
    if (box) images.push(box);
  };

  for (let index = 0; index < fnArray.length; index++) {
    const args = (argsArray[index] ?? []) as unknown[];
    switch (fnArray[index]) {
      case OPS.save:
      case OPS.beginGroup:
        push();
        break;
      case OPS.restore:
      case OPS.endGroup:
      case OPS.paintFormXObjectEnd:
      case OPS.endAnnotation:
        pop();
        break;
      case OPS.transform:
        ctm = multiply(ctm, args as Matrix);
        break;
      case OPS.paintFormXObjectBegin: {
        push();
        const [matrix, bbox] = args as [ArrayLike<number> | null, ArrayLike<number> | null];
        if (matrix) ctm = multiply(ctm, Array.from(matrix) as Matrix);
        const formBox = finiteBox(bbox);
        if (formBox && clip) clip = intersect(clip, transformBox(ctm, formBox));
        break;
      }
      case OPS.beginAnnotation: {
        // Appearance streams start again from the page: rect is in page space.
        push();
        const [, rect, transform, matrix] = args as [unknown, number[], number[], number[]];
        const annotationBox = finiteBox(rect);
        clip = annotationBox ? intersect(page, transformBox(base, annotationBox)) : page;
        ctm = multiply(multiply(base, transform as Matrix), matrix as Matrix);
        break;
      }
      case OPS.clip:
      case OPS.eoClip:
        pendingClip = true;
        break;
      case OPS.constructPath: {
        const [paint, , minMax] = args as [number, unknown, ArrayLike<number> | null];
        const pathBox = finiteBox(minMax);
        const box = pathBox && transformBox(ctm, pathBox);
        if (box && paint !== OPS.endPath) {
          const shown = visible(box);
          if (shown) shapes.push({ box: shown });
        }
        if (pendingClip) clip = box && clip ? intersect(clip, box) : null;
        pendingClip = false;
        break;
      }
      case OPS.shadingFill:
        // A gradient painted through a clip path is a filled shape the size of the clip.
        if (clip) shapes.push({ box: clip });
        break;
      case OPS.paintSolidColorImageMask: {
        const box = visible(transformBox(ctm, UNIT));
        if (box) shapes.push({ box });
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        image(ctm);
        break;
      case OPS.paintImageXObjectRepeat: {
        const [, scaleX, scaleY, positions] = args as [unknown, number, number, ArrayLike<number>];
        for (let p = 0; p + 1 < positions.length; p += 2)
          image(multiply(ctm, [scaleX, 0, 0, scaleY, positions[p]!, positions[p + 1]!]));
        break;
      }
      case OPS.paintImageMaskXObjectRepeat: {
        const [, scaleX, skewX, skewY, scaleY, positions] = args as [
          unknown,
          number,
          number,
          number,
          number,
          ArrayLike<number>,
        ];
        for (let p = 0; p + 1 < positions.length; p += 2)
          image(multiply(ctm, [scaleX, skewX, skewY, scaleY, positions[p]!, positions[p + 1]!]));
        break;
      }
      case OPS.paintImageMaskXObjectGroup: {
        const [group] = args as [{ transform: number[] }[]];
        for (const entry of group ?? []) image(multiply(ctm, entry.transform as Matrix));
        break;
      }
      case OPS.paintInlineImageXObjectGroup: {
        const [, map] = args as [unknown, { transform: number[] }[]];
        for (const entry of map ?? []) image(multiply(ctm, entry.transform as Matrix));
        break;
      }
    }
  }
  return { images, shapes };
}

/**
 * Groups of box indices linked when within `gap` points of each other, directly or through
 * other boxes. Each group is in ascending index order, groups in order of their first index.
 */
function clusterBoxes(boxes: Box[], gap: number): number[][] {
  const parent = boxes.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) index = parent[index] = parent[parent[index]!]!;
    return index;
  };
  // Sweep in left-edge order: once a box starts past another's right edge, so do the rest.
  const order = boxes.map((_, index) => index).sort((a, b) => boxes[a]![0] - boxes[b]![0] || a - b);
  for (let i = 0; i < order.length; i++) {
    const a = boxes[order[i]!]!;
    for (let j = i + 1; j < order.length; j++) {
      const b = boxes[order[j]!]!;
      if (b[0] - gap > a[2]) break;
      if (near(a, b, gap)) {
        const [rootA, rootB] = [find(order[i]!), find(order[j]!)];
        parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < boxes.length; index++) {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), index]);
  }
  return [...groups.values()];
}

// Text: lines, blocks and logical order.

const RTL_LETTER = /[\u0590-\u05ff\u0600-\u06ff\u0700-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u;
const LETTER = /\p{L}/u;

function letterCounts(text: string): { rtl: number; ltr: number } {
  let rtl = 0;
  let ltr = 0;
  for (const char of text)
    if (RTL_LETTER.test(char)) rtl++;
    else if (LETTER.test(char)) ltr++;
  return { rtl, ltr };
}

/** "ltr", "rtl" or "mixed" from the items' letters; pdf.js's dirs when there are no letters. */
function directionOf(items: PageTextItem[]): Region["direction"] {
  let rtl = false;
  let ltr = false;
  for (const item of items) {
    const counts = letterCounts(item.str);
    rtl ||= counts.rtl > 0;
    ltr ||= counts.ltr > 0;
  }
  if (!rtl && !ltr) {
    if (!items.length) return null;
    rtl = items.some((item) => item.dir === "rtl");
    ltr = items.some((item) => item.dir !== "rtl");
  }
  return rtl && ltr ? "mixed" : rtl ? "rtl" : "ltr";
}

interface Line {
  items: PageTextItem[];
  box: Box;
  baseline: number;
  /** The size carrying the most characters, so a subscript does not change it. */
  size: number;
  text: string;
  rtl: boolean;
  /** Upright text; rotated and vertical lines stay blocks of their own. */
  horizontal: boolean;
}

function dominantSize(items: PageTextItem[]): number {
  const weights = new Map<number, number>();
  for (const item of items) {
    const size = round(item.size);
    weights.set(size, (weights.get(size) ?? 0) + item.str.trim().length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of [...weights].sort((a, b) => a[0] - b[0]))
    if (weight > bestWeight) [best, bestWeight] = [size, weight];
  return best;
}

/**
 * Logical order for one line, by the bidi rules applied to whole items (pdf.js has already
 * ordered the characters inside each item). Items are strong right-to-left (pdf.js dir "rtl"),
 * strong left-to-right (letters, dir "ltr"), or neutral (digits, symbols), which take the
 * direction of matching strong neighbours or else the line's. On a right-to-left line the runs
 * are read from the right; inside a run, right-to-left items are reversed.
 */
function logicalOrder(visual: PageTextItem[], rtlLine: boolean): PageTextItem[] {
  const strong = visual.map((item) =>
    item.dir === "rtl" ? "R" : LETTER.test(item.str) ? "L" : null,
  );
  const resolved = strong.map((kind, index) => {
    if (kind) return kind;
    const before = strong.slice(0, index).findLast((value) => value !== null);
    const after = strong.slice(index + 1).find((value) => value !== null);
    return before && before === after ? before : rtlLine ? "R" : "L";
  });
  const runs: { kind: string; items: PageTextItem[] }[] = [];
  visual.forEach((item, index) => {
    const kind = resolved[index]!;
    if (runs.at(-1)?.kind === kind) runs.at(-1)!.items.push(item);
    else runs.push({ kind, items: [item] });
  });
  if (rtlLine) runs.reverse();
  return runs.flatMap((run) => (run.kind === "R" ? [...run.items].reverse() : run.items));
}

function joinItems(items: PageTextItem[], size: number): string {
  let text = "";
  items.forEach((item, index) => {
    const previous = items[index - 1];
    if (previous) {
      const gap = Math.max(item.box[0], previous.box[0]) - Math.min(item.box[2], previous.box[2]);
      if (gap > SPACE_GAP * size && !/\s$/u.test(text) && !/^\s/u.test(item.str)) text += " ";
    }
    text += item.str;
  });
  return text.replace(/\s+/gu, " ").trim();
}

function makeLine(visual: PageTextItem[]): Line {
  const counts = letterCounts(visual.map((item) => item.str).join(""));
  const rtl = counts.rtl > counts.ltr;
  const size = dominantSize(visual);
  const items = logicalOrder(visual, rtl);
  const main = visual.find((item) => round(item.size) === size) ?? visual[0]!;
  return {
    items,
    box: visual.map((item) => item.box).reduce(union),
    baseline: main.origin[1],
    size,
    text: joinItems(items, size),
    rtl,
    horizontal: visual.every((item) => item.horizontal),
  };
}

function verticalOverlap(a: Box, b: Box): number {
  return Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
}

/**
 * Lines from text items: items whose boxes overlap vertically by half the shorter height share a
 * row (subscripts and superscripts included), and a row splits wherever a horizontal gap is wider
 * than two font sizes. Rotated or vertical text keeps one line per item.
 */
function buildLines(items: PageTextItem[]): Line[] {
  const rows: { box: Box; items: PageTextItem[] }[] = [];
  const lines: Line[] = [];
  const sorted = [...items].sort(
    (a, b) => a.origin[1] - b.origin[1] || a.box[0] - b.box[0] || a.box[2] - b.box[2],
  );
  for (const item of sorted) {
    if (!item.horizontal) {
      lines.push(makeLine([item]));
      continue;
    }
    let best: (typeof rows)[number] | undefined;
    let bestShare = 0;
    for (const row of rows) {
      const shorter = Math.min(height(item.box), height(row.box));
      const share = shorter > 0 ? verticalOverlap(item.box, row.box) / shorter : 0;
      if (share >= LINE_OVERLAP && share > bestShare) {
        best = row;
        bestShare = share;
      }
    }
    if (best) {
      best.items.push(item);
      best.box = union(best.box, item.box);
    } else rows.push({ box: item.box, items: [item] });
  }
  for (const row of rows) {
    const visual = [...row.items].sort(
      (a, b) => a.box[0] - b.box[0] || a.box[2] - b.box[2] || a.origin[1] - b.origin[1],
    );
    let segment: PageTextItem[] = [];
    let right = -Infinity;
    for (const item of visual) {
      const size = Math.max(item.size, segment.at(-1)?.size ?? 0);
      if (segment.length && item.box[0] - right > LINE_SPLIT_GAP * size) {
        lines.push(makeLine(segment));
        segment = [];
        right = -Infinity;
      }
      segment.push(item);
      right = Math.max(right, item.box[2]);
    }
    if (segment.length) lines.push(makeLine(segment));
  }
  return lines;
}

interface Block {
  lines: Line[];
  box: Box;
}

function overlapsHorizontally(a: Box, b: Box): boolean {
  return Math.min(a[2], b[2]) > Math.max(a[0], b[0]);
}

/** Lines into blocks, top to bottom (see BLOCK_PITCH); each line joins the nearest fitting block. */
function buildBlocks(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  const sorted = [...lines].sort(
    (a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0] || a.box[2] - b.box[2],
  );
  for (const line of sorted) {
    let best: Block | undefined;
    let bestPitch = Infinity;
    for (const block of blocks) {
      const last = block.lines.at(-1)!;
      const pitch = line.baseline - last.baseline;
      const sizes = [line.size, last.size].sort((a, b) => a - b);
      if (
        line.horizontal &&
        last.horizontal &&
        pitch > 0 &&
        pitch <= BLOCK_PITCH * sizes[1]! &&
        sizes[1]! <= BLOCK_SIZE_RATIO * sizes[0]! &&
        overlapsHorizontally(line.box, block.box) &&
        pitch < bestPitch
      ) {
        best = block;
        bestPitch = pitch;
      }
    }
    if (best) {
      best.lines.push(line);
      best.box = union(best.box, line.box);
    } else blocks.push({ lines: [line], box: line.box });
  }
  return blocks;
}

// Reading order.

interface Draft {
  kind: RegionKind;
  box: Box;
  text: string;
  direction: Region["direction"];
}

const KIND_ORDER: Record<RegionKind, number> = { text: 0, image: 1, drawing: 2 };

/**
 * Reading order: rows from the top (regions whose tops are within ROW_TOLERANCE share a row),
 * then left to right, or right to left on a right-to-left page. Ties fall back to the box, kind
 * and text, so the order is total.
 */
function readingOrder<T extends { box: Box }>(
  entries: T[],
  rtl: boolean,
  tie: (a: T, b: T) => number = () => 0,
): T[] {
  const byTop = [...entries].sort(
    (a, b) =>
      a.box[1] - b.box[1] ||
      a.box[0] - b.box[0] ||
      a.box[2] - b.box[2] ||
      a.box[3] - b.box[3] ||
      tie(a, b),
  );
  const ordered: T[] = [];
  for (let start = 0; start < byTop.length;) {
    let end = start + 1;
    while (end < byTop.length && byTop[end]!.box[1] - byTop[start]!.box[1] <= ROW_TOLERANCE) end++;
    const row = byTop
      .slice(start, end)
      .sort((a, b) =>
        rtl
          ? b.box[2] - a.box[2] || b.box[0] - a.box[0] || a.box[1] - b.box[1] || tie(a, b)
          : a.box[0] - b.box[0] || a.box[2] - b.box[2] || a.box[1] - b.box[1] || tie(a, b),
      );
    ordered.push(...row);
    start = end;
  }
  return ordered;
}

// Numbers.

const MATH_TOKEN = new RegExp(
  [
    // A single Latin or Greek letter applied to an argument, one level of nesting, with an
    // optional coefficient: O(V + E), 2T(n/2), Θ(n log n).
    String.raw`(?<![\p{L}\p{N}])\d*[A-Za-z\u0391-\u03a9\u03b1-\u03c9]\((?:[^()\n]|\([^()\n]*\))+\)`,
    // Powers and indices: 2^n, x_1, a_{i+1}, n^{2}.
    String.raw`[\p{L}\p{N})]+(?:[\^_](?:\{[^{}\n]*\}|[\p{L}\p{N}]+))+`,
    // A letter with a numeric index: q0, x1, v12.
    String.raw`(?<![\p{L}\p{N}])[A-Za-z\u0391-\u03a9\u03b1-\u03c9]\d+(?![\p{L}\p{N}])`,
    // Numbers, with a sign only where it cannot be a hyphen: 3.14, 1,000, 10:30, 1/2, 50%, -3.
    String.raw`(?:(?<![\p{L}\p{N})\]])[-\u2212+])?\d+(?:[.,:/]\d+)*%?`,
    // ASCII operators.
    String.raw`<=|>=|!=|==|->|=>|:=`,
    // Math symbols and arrows (single ASCII symbols such as + and = are skipped below).
    String.raw`[\p{Sm}\u2190-\u21ff]`,
    // A Greek letter standing alone: λ, ε, Σ.
    String.raw`(?<!\p{L})[\u0391-\u03a9\u03b1-\u03c9](?!\p{L})`,
  ].join("|"),
  "gu",
);

/**
 * Numbers and math-like tokens a region's text must keep, in first-occurrence order without
 * repeats. The rule, applied left to right with earlier patterns winning at a position:
 * single-letter function applications such as O(V + E) and 2T(n/2); powers and indices such
 * as 2^n and x_1; letters with numeric indices such as q0; numbers (decimals, thousands,
 * ratios, times, percentages, signed); the ASCII operators <= >= != == -> => :=; non-ASCII
 * math symbols and arrows such as ≤ and ∑; and Greek letters standing alone. Single ASCII
 * symbols (+, =, <) are too common in prose to check.
 */
export function extractNumbers(text: string): string[] {
  const tokens: string[] = [];
  for (const [token] of text.matchAll(MATH_TOKEN)) {
    if (token.length === 1 && token.charCodeAt(0) < 0x80 && !/\d/.test(token)) continue;
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

// The page.

/** Drops repeated runs drawn at the same place (shadow or fake-bold text). */
function dedupe(items: PageTextItem[]): PageTextItem[] {
  const kept: PageTextItem[] = [];
  for (const item of items)
    if (
      !kept.some(
        (other) =>
          other.str === item.str &&
          other.box.every((value, index) => Math.abs(value - item.box[index]!) <= 1),
      )
    )
      kept.push(item);
  return kept;
}

/** `outer` contains `inner`, give or take `slack` points. */
function contains(outer: Box, inner: Box, slack: number): boolean {
  return (
    inner[0] >= outer[0] - slack &&
    inner[1] >= outer[1] - slack &&
    inner[2] <= outer[2] + slack &&
    inner[3] <= outer[3] + slack
  );
}

const area = (box: Box) => width(box) * height(box);

/**
 * Drawings from vector shapes:
 * 1. Shapes covering 90% of the page both ways (backgrounds, page frames) or 95% either way
 *    (header and footer bands, side bars, full-width rules) are template, not content.
 * 2. Shapes within CLUSTER_GAP points of each other, directly or through others, form a cluster,
 *    and a cluster inside another's box joins it (a logo drawn inside a device's outline).
 * 3. Text items whose centers fall inside a cluster (within LABEL_MARGIN) become its labels; an
 *    item inside nested clusters goes to the smallest.
 * 4. A cluster that is a single shape around text (a callout, a framed definition, a highlight)
 *    is a text container: the shape is dropped and its text stays text.
 * 5. Unlabeled clusters under MIN_VISUAL points both ways (bullets, dots), at most MAX_THIN
 *    points thick (rules, underlines, fraction bars), or lying on a picture (its frame, or marks
 *    drawn over a screenshot, which a crop of the picture shows) are not drawings of their own.
 */
function buildDrawings(
  shapes: Shape[],
  items: PageTextItem[],
  images: Box[],
  pageWidth: number,
  pageHeight: number,
): { drawings: Draft[]; labelled: Set<PageTextItem> } {
  const content = shapes.filter(({ box }) => {
    const wide = width(box) / pageWidth;
    const tall = height(box) / pageHeight;
    if (wide >= BACKGROUND_SHARE && tall >= BACKGROUND_SHARE) return false;
    return wide < BLEED_SHARE && tall < BLEED_SHARE;
  });
  const linked = clusterBoxes(
    content.map(({ box }) => box),
    CLUSTER_GAP,
  ).map((group) => group.map((index) => content[index]!.box));
  const boxes = linked.map((group) => group.reduce(union));
  // Each cluster joins the largest cluster whose box contains it; ties go to the earlier one.
  const outermost = boxes.map((box, index) => {
    let owner = index;
    boxes.forEach((other, candidate) => {
      const larger =
        area(other) > area(boxes[owner]!) ||
        (area(other) === area(boxes[owner]!) && candidate < owner);
      if (candidate !== index && larger && contains(other, box, 1)) owner = candidate;
    });
    return owner;
  });
  const merged = new Map<number, Box[]>();
  linked.forEach((group, index) => {
    let root = index;
    while (outermost[root] !== root) root = outermost[root]!;
    merged.set(root, [...(merged.get(root) ?? []), ...group]);
  });
  const clusters = [...merged.keys()]
    .sort((a, b) => a - b)
    .map((root) => {
      const group = merged.get(root)!;
      const distinct = new Set(group.map((box) => box.map((value) => Math.round(value)).join(",")));
      return { box: group.reduce(union), shapes: distinct.size, labels: [] as PageTextItem[] };
    });
  const bySize = [...clusters].sort(
    (a, b) => area(a.box) - area(b.box) || a.box[1] - b.box[1] || a.box[0] - b.box[0],
  );
  for (const item of items) {
    const cx = (item.box[0] + item.box[2]) / 2;
    const cy = (item.box[1] + item.box[3]) / 2;
    const owner = bySize.find(({ box }) => contains(box, [cx, cy, cx, cy], LABEL_MARGIN));
    owner?.labels.push(item);
  }
  const drawings: Draft[] = [];
  const labelled = new Set<PageTextItem>();
  for (const cluster of clusters) {
    if (cluster.labels.length) {
      if (cluster.shapes === 1) continue;
    } else {
      const small = width(cluster.box) < MIN_VISUAL && height(cluster.box) < MIN_VISUAL;
      if (small || Math.min(width(cluster.box), height(cluster.box)) <= MAX_THIN) continue;
      if (images.some((image) => contains(image, cluster.box, LABEL_MARGIN))) continue;
    }
    for (const label of cluster.labels) labelled.add(label);
    const lines = buildLines(cluster.labels);
    const rtl = lines.filter((line) => line.rtl).length > lines.length / 2;
    drawings.push({
      kind: "drawing",
      box: cluster.labels.map((label) => label.box).reduce(union, cluster.box),
      text: readingOrder(lines, rtl, (a, b) => compareText(a.text, b.text))
        .map((line) => line.text)
        .join("\n"),
      direction: directionOf(cluster.labels),
    });
  }
  return { drawings, labelled };
}

/**
 * Images: overlapping or touching pictures (tiles of one picture, an icon on a photo) merge into
 * one region; pictures under MIN_VISUAL points both ways or at most MAX_THIN thick are dropped.
 */
function buildImages(boxes: Box[]): Draft[] {
  return clusterBoxes(boxes, 1)
    .map((group) => group.map((index) => boxes[index]!).reduce(union))
    .filter((box) => {
      const small = width(box) < MIN_VISUAL && height(box) < MIN_VISUAL;
      return !small && Math.min(width(box), height(box)) > MAX_THIN;
    })
    .map((box) => ({ kind: "image", box, text: "", direction: null }));
}

async function inventoryPage(page: PDFPageProxy, pageNumber: number): Promise<PageInventory> {
  const viewport = pageViewport(page);
  const pageBox: Box = [0, 0, viewport.width, viewport.height];
  const layer = await textItems(page);
  const operators = await page.getOperatorList();
  const visuals = collectVisuals(
    operators.fnArray,
    operators.argsArray as unknown[][],
    viewport.transform as Matrix,
    pageBox,
  );

  const items = dedupe(
    layer.filter((item) => item.str.trim() !== "" && intersect(item.box, pageBox)),
  );
  const images = buildImages(visuals.images);
  const { drawings, labelled } = buildDrawings(
    visuals.shapes,
    items,
    images.map((image) => image.box),
    viewport.width,
    viewport.height,
  );
  const blocks = buildBlocks(buildLines(items.filter((item) => !labelled.has(item))));
  const texts: Draft[] = blocks.map((block) => ({
    kind: "text",
    box: block.box,
    text: block.lines.map((line) => line.text).join("\n"),
    direction: directionOf(block.lines.flatMap((line) => line.items)),
  }));

  const counts = letterCounts(items.map((item) => item.str).join(""));
  const drafts = readingOrder(
    [...texts, ...images, ...drawings].map((draft) => ({
      ...draft,
      box: roundBox(draft.box),
    })),
    counts.rtl > counts.ltr,
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || compareText(a.text, b.text),
  );
  return {
    page: pageNumber,
    width: round(viewport.width),
    height: round(viewport.height),
    regions: drafts.map((draft, index) => ({
      id: `p${pageNumber}.r${index + 1}`,
      page: pageNumber,
      kind: draft.kind,
      box: draft.box,
      text: draft.text,
      direction: draft.kind === "image" ? null : draft.direction,
      numbers: extractNumbers(draft.text),
    })),
    textLayer: textLayerHealth(layer),
    characters: layer.reduce((sum, item) => sum + (item.str.match(/\S/gu)?.length ?? 0), 0),
  };
}

/**
 * One page's regions in reading order, with its text-layer health. `characters` counts the text
 * layer's non-whitespace characters, drawing labels included.
 */
export async function buildPageInventory(
  doc: SourceDocument,
  pageNumber: number,
): Promise<PageInventory> {
  const page = await doc.getPage(pageNumber);
  try {
    return await inventoryPage(page, pageNumber);
  } finally {
    page.cleanup();
  }
}

/** The inventory of an open document; sha256 must be the hash of its bytes. */
export async function buildDocumentInventory(
  doc: SourceDocument,
  sha256: string,
): Promise<SourceInventory> {
  const pages: PageInventory[] = [];
  for (let page = 1; page <= doc.numPages; page++) pages.push(await buildPageInventory(doc, page));
  return { version: INVENTORY_VERSION, sha256, pages };
}

/** Every page's inventory. Rejects a hash that does not match the bytes. */
export async function buildInventory(data: Uint8Array, sha256: string): Promise<SourceInventory> {
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== sha256) throw new Error(`The source's hash is ${actual}, not ${sha256}`);
  const doc = await openSource(data);
  try {
    return await buildDocumentInventory(doc, sha256);
  } finally {
    await closeSource(doc);
  }
}
