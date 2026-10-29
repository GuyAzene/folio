/**
 * Text direction for a block of prose, decided by Folio rather than by the browser's
 * first-strong-character rule: a Hebrew paragraph that opens with "Python", a formula or a
 * citation is still a Hebrew paragraph. Callers pass prose only (no code, math or URLs).
 */

export type Direction = "rtl" | "ltr";

/** Share of strong words written right to left at which a block reads right to left. */
export const RTL_SHARE = 0.4;

// Letters of the right-to-left scripts. JavaScript has no Bidi_Class property, so scripts stand
// in for it: their letters are exactly the strong right-to-left characters that occur in prose.
const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]/u;
const LETTER = /\p{L}/u;
// Text between an isolate initiator (LRI, RLI, FSI) and its PDI is skipped, as rule P2 does.
const ISOLATED = /[\u2066-\u2068][^\u2069]*(?:\u2069|$)/gu;

export interface DirectionEstimate {
  /** Null when the text has no strong words (numbers, punctuation, symbols). */
  direction: Direction | null;
  /** Words that start with a letter: how much evidence the verdict rests on. */
  words: number;
  /** The direction of the first word, as the browser's dir="auto" would decide. */
  first: Direction | null;
}

export function estimateDirection(text: string): DirectionEstimate {
  let rtl = 0;
  let ltr = 0;
  let first: Direction | null = null;
  const prose = text.replace(/^\uFEFF/, "").replace(ISOLATED, " ");
  for (const word of prose.split(/\s+/)) {
    const letter = LETTER.exec(word)?.[0];
    if (!letter) continue;
    const direction: Direction = RTL_LETTER.test(letter) ? "rtl" : "ltr";
    first ??= direction;
    if (direction === "rtl") rtl++;
    else ltr++;
  }
  const words = rtl + ltr;
  if (!words) return { direction: null, words, first };
  const share = rtl / words;
  if (share === RTL_SHARE) return { direction: first, words, first };
  return { direction: share > RTL_SHARE ? "rtl" : "ltr", words, first };
}

/**
 * Direction for text the student writes: that of its first letter, as in any editor. A line
 * that starts in Hebrew stays right to left and one that starts in English stays left to right,
 * however many words of the other language follow, so a line never flips while it is typed.
 * Callers leave formulas, code and links out first, so "$x$ היא" starts in Hebrew.
 */
export function writtenDirection(estimate: DirectionEstimate): Direction | null {
  return estimate.first;
}

// Arithmetic and signed numbers keep their reading order inside right-to-left text, where the
// bidi algorithm would otherwise show "3 + 4 = 7" as "7 = 4 + 3" and move the sign of "-5".
// A term is a number, optionally signed, or a signed number in parentheses such as "(-2)".
const NUMBER = String.raw`(?:\([+\-−]?\d+(?:[.,]\d+)*%?\)|[+\-−]?\d+(?:[.,]\d+)*%?)`;

/**
 * Runs of arithmetic or signed numbers that should stay left to right. `lessGreater` is how
 * the text spells "<" and ">": as themselves in source, as entities in HTML.
 */
export function numberRuns(lessGreater = "<|>"): RegExp {
  const operator = String.raw`(?:[+\-−×÷*/=≈≠≤≥^–—]|${lessGreater})`;
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}.])(?:${NUMBER}(?:\s*${operator}\s*${NUMBER})+|[\-−+]\d+(?:[.,]\d+)*%?)(?![\p{L}\p{N}])`,
    "gu",
  );
}

/** Whether the text contains any right-to-left letter. */
export function hasRtl(text: string): boolean {
  return RTL_LETTER.test(text);
}
