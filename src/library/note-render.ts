/**
 * Pictures of a note, as Folio draws it, for the tutor to look at (`view_note`). The window
 * (app/capture.ts) draws the note and inspects it; the main process (src/desktop/note-capture.ts)
 * cuts it into pictures. These are the shapes they share, and the parts that need no window.
 */

export type NoteViewName = "edit" | "read";

/** What the hidden page is given to draw. */
export interface CapturePayload {
  content: string;
  view: NoteViewName;
  courseId: string | null;
  courseName: string;
  /** The course's documents, so a page citation reads with its file's name. */
  documents: { id: string; title: string }[];
}

export interface NoteLayout {
  /** The drawn note's height, in CSS pixels. */
  height: number;
  /** Every line was drawn: the editor draws only what is in view, so a long note may not be. */
  complete: boolean;
}

export type FindingKind =
  | "math-error"
  | "too-wide"
  | "scrolls"
  | "html-as-text"
  | "image-missing"
  | "raw-tex"
  | "display-in-sentence"
  | "diagram-error"
  | "low-contrast"
  | "demo"
  | "incomplete";

/** Something the page noticed in how the note was drawn, at a line of the note (0: no line). */
export interface NoteFinding {
  kind: FindingKind;
  line: number;
  text: string;
}

export interface NoteInspection {
  width: number;
  height: number;
  /** The note's blocks from the top, where a picture may be cut between them. */
  blocks: { top: number; bottom: number; line: number }[];
  headings: { top: number; text: string; line: number }[];
  findings: NoteFinding[];
  /** How many lines the note has. */
  lines: number;
}

export interface NoteRenderRequest {
  content: string;
  courseId: string;
  courseName: string;
  documents: { id: string; title: string }[];
  view: NoteViewName;
  /** A closer, sharper picture of these lines (1-based) instead of the whole note. */
  closeUp?: { from: number; to: number };
}

export interface NoteTile {
  part: number;
  /** Where the picture starts and how tall it is, in CSS pixels of the drawn note. */
  top: number;
  height: number;
  jpeg: Uint8Array;
  /** The note's lines it shows, first and last (1-based). */
  lines: [number, number];
  headings: string[];
}

export interface NoteRendering {
  view: NoteViewName;
  width: number;
  height: number;
  complete: boolean;
  tiles: NoteTile[];
  closeUp?: { jpeg: Uint8Array; lines: [number, number] };
  findings: NoteFinding[];
  lines: number;
}

/** Draws a note and returns its pictures; the main process provides it, tests fake it. */
export type NoteRenderer = (
  request: NoteRenderRequest,
  signal?: AbortSignal,
) => Promise<NoteRendering>;

/** The note's column as the student sees it: 720 pixels of text with 32 on each side. */
export const TILE_WIDTH = 784;
/**
 * A picture's height at most. 784 × 1456 keeps the long edge under the 1568 pixels most vision
 * models take without shrinking.
 */
export const TILE_HEIGHT = 1456;
/** At most this many pictures: a longer note is drawn only this far. */
export const MAX_TILES = 24;

/**
 * Where to cut a drawn note `height` tall into pictures at most `max` tall: between blocks, so a
 * formula or a table is never cut in half, unless one block alone is taller than a picture.
 */
export function tileCuts(bottoms: number[], height: number, max = TILE_HEIGHT): [number, number][] {
  const ends = [...new Set(bottoms.map((bottom) => Math.ceil(bottom)))].sort((a, b) => a - b);
  const tiles: [number, number][] = [];
  let start = 0;
  while (start < height && tiles.length < MAX_TILES) {
    const limit = start + max;
    if (limit >= height) {
      tiles.push([start, Math.ceil(height)]);
      break;
    }
    // The last block that ends inside this picture; a picture far too short is not worth it.
    const fit = ends.filter((end) => end > start + max / 4 && end <= limit).at(-1);
    const end = fit ?? limit;
    tiles.push([start, end]);
    start = end;
  }
  return tiles;
}

/** The note's lines a picture from `top` to `bottom` shows, from the blocks that are in it. */
export function tileLines(
  blocks: NoteInspection["blocks"],
  top: number,
  bottom: number,
  lines: number,
): [number, number] {
  const ordered = [...blocks].sort((a, b) => a.top - b.top);
  const first = ordered.find((block) => block.bottom > top && block.line > 0);
  const after = ordered.find((block) => block.top >= bottom && block.line > 0);
  const from = first?.line ?? 1;
  const to = after ? Math.max(from, after.line - 1) : Math.max(from, lines);
  return [from, to];
}

const KIND: Record<FindingKind, string> = {
  "math-error": "a formula that can't be drawn",
  "too-wide": "wider than the note's column",
  scrolls: "scrolls sideways, so part of it is hidden",
  "html-as-text": "HTML shown as text instead of drawn",
  "image-missing": "a figure that doesn't load",
  "raw-tex": "TeX shown as text instead of a formula",
  "display-in-sentence": "a displayed formula inside a sentence, which splits the line",
  "diagram-error": "a diagram that can't be drawn",
  "low-contrast": "text hard to read on its color",
  demo: "a demo, shown here as a placeholder (it runs in Folio)",
  incomplete: "not all of the note could be drawn",
};

/** The findings, as the tutor reads them. */
export function findingsText(findings: NoteFinding[]): string {
  if (!findings.length)
    return "Nothing looked broken in how it was drawn: no formula errors, nothing too wide, no HTML shown as text, no missing figures. Compare the picture with the source yourself.";
  const lines = findings.map(
    (finding) =>
      `- ${finding.line ? `line ${finding.line}, ` : ""}${KIND[finding.kind]}${finding.text ? `: ${finding.text}` : ""}`,
  );
  return `What looked wrong in how it was drawn (${findings.length}):\n${lines.join("\n")}`;
}
