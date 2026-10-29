/**
 * Where TeX math starts and ends in Markdown. The chat renderer (marked) and the note editor
 * (Lezer) both read math with these rules, so a formula that renders in a reply renders the
 * same way once it is pasted into a note.
 */

export interface InlineMathRule {
  open: string;
  close: string;
  /** Matches at the start of the text: the whole formula, with the TeX as group 1. */
  pattern: RegExp;
  display: boolean;
}

// Backslash pairs are opaque while looking for the closer, and math never crosses a backtick.
export const INLINE_MATH: readonly InlineMathRule[] = [
  { open: "\\(", close: "\\)", pattern: /^\\\(((?:\\[\s\S]|[^\\`])+?)\\\)/, display: false },
  { open: "\\[", close: "\\]", pattern: /^\\\[((?:\\[\s\S]|[^\\`])+?)\\\]/, display: true },
  { open: "$$", close: "$$", pattern: /^\$\$((?:\\[\s\S]|[^\\`$])+?)\$\$/, display: true },
  // Pandoc's rule keeps currency as text: no space inside the delimiters, no digit after.
  // The last character may be escaped, as in "\{a\}", but "\$" never closes.
  {
    open: "$",
    close: "$",
    pattern: /^\$(?=[^\s$])((?:\\[\s\S]|[^\\`$\n])*?(?:\\[^\s$]|[^\s\\$]))\$(?!\d)/,
    display: false,
  },
];

/** Display math that stands as its own block: the closer ends its line. */
export const BLOCK_MATH: readonly { open: string; close: string; pattern: RegExp }[] = [
  {
    open: "$$",
    close: "$$",
    pattern: /^ {0,3}\$\$((?:\\[\s\S]|[^\\$])+?)\$\$[ \t]*(?:\n+|$)/,
  },
  {
    open: "\\[",
    close: "\\]",
    pattern: /^ {0,3}\\\[((?:\\[\s\S]|[^\\])+?)\\\][ \t]*(?:\n+|$)/,
  },
];

/** Any inline formula, for masking math out of other syntax (emphasis, direction). */
export const MATH_SPAN =
  /\\\((?:\\[\s\S]|[^\\`])+?\\\)|\\\[(?:\\[\s\S]|[^\\`])+?\\\]|\$\$(?:\\[\s\S]|[^\\`$])+?\$\$|\$(?=[^\s$])(?:\\[\s\S]|[^\\`$\n])*?(?:\\[^\s$]|[^\s\\$])\$(?!\d)/g;
