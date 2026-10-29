import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { MONO_EM } from "./live-preview.ts";

/**
 * The note editor's look, matching the reading view (Newsreader with Frank Ruhl Libre for
 * Hebrew, 17/28) so switching between writing and reading does not move the text. Colors are
 * Folio's theme variables, so light and dark follow the app.
 */
export const noteTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "transparent",
    fontFamily: "var(--font-serif)",
    fontSize: "17px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "28px",
    scrollbarWidth: "thin",
    scrollbarColor: "transparent transparent",
  },
  ".cm-scroller:hover": { scrollbarColor: "var(--line-strong) transparent" },
  ".cm-content": {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: "784px",
    margin: "0 auto",
    padding: "40px 32px 40vh",
    caretColor: "var(--text)",
  },
  "@media (max-width: 640px)": { ".cm-content": { padding: "24px 16px 40vh" } },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "1.5px solid var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--highlight-wash)" },
  ".cm-placeholder": { color: "var(--text-4)" },

  // Headings
  ".cm-heading": { fontWeight: "600", letterSpacing: "-0.01em" },
  ".cm-h1": { fontSize: "28px", lineHeight: "36px", paddingTop: "8px" },
  ".cm-h2": { fontSize: "21px", lineHeight: "30px", paddingTop: "18px" },
  ".cm-h3": { fontSize: "18px", lineHeight: "26px", paddingTop: "12px" },
  ".cm-h4, .cm-h5, .cm-h6": { paddingTop: "8px" },
  ".cm-setext-underline": { color: "var(--text-4)" },

  // Inline
  ".cm-strong": { fontWeight: "600" },
  // Folio sets no italic type; emphasis is a weight, as in the reading view.
  ".cm-em": { fontWeight: "500" },
  ".cm-strike": { textDecoration: "line-through", color: "var(--text-3)" },
  ".cm-inline-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.8em",
    padding: "1px 4px",
    borderRadius: "5px",
    backgroundColor: "var(--sunken)",
    border: "1px solid var(--line-subtle)",
  },
  ".cm-link": {
    color: "var(--info)",
    textDecoration: "underline",
    textUnderlineOffset: "3px",
    textDecorationColor: "color-mix(in srgb, var(--info) 35%, transparent)",
  },
  ".cm-link[data-href]": { cursor: "pointer" },
  ".cm-url:not([data-href])": { color: "var(--text-3)", textDecoration: "none" },
  ".cm-html-tag": { fontFamily: "var(--font-mono)", fontSize: "0.8em", color: "var(--text-3)" },
  ".cm-comment, .cm-comment-block": { color: "var(--text-4)" },
  ".cm-link-reference": { color: "var(--text-3)" },
  ".cm-image": { maxWidth: "100%", borderRadius: "8px", verticalAlign: "bottom" },
  ".cm-image-missing": {
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    color: "var(--text-3)",
    padding: "2px 8px",
    borderRadius: "6px",
    border: "1px dashed var(--line-strong)",
  },
  ".cm-image-source": { color: "var(--text-3)" },

  // Math
  ".cm-math-source": { fontFamily: "var(--font-mono)", fontSize: "0.8em", color: "var(--text-2)" },
  ".cm-math.cm-math": { whiteSpace: "nowrap" },
  ".cm-math-block": {
    display: "block",
    padding: "6px 0",
    overflowX: "auto",
    overflowY: "hidden",
    textAlign: "center",
  },
  ".cm-math-block .katex-display": { margin: "0" },

  // Quotes, rules
  ".cm-quote": {
    borderInlineStart: "2px solid var(--line-strong)",
    paddingInlineStart: "14px",
    color: "var(--text-2)",
  },
  ".cm-rule": {
    display: "inline-block",
    width: "100%",
    height: "1px",
    verticalAlign: "middle",
    backgroundColor: "var(--line)",
  },

  // Lists: the gutter is monospace so wrapped lines hang exactly under the item's text.
  ".cm-list-line": {
    paddingInlineStart: "var(--hang)",
    textIndent: "calc(-1 * var(--hang))",
  },
  ".cm-list-gutter": { fontFamily: "var(--font-mono)", color: "var(--text-3)" },
  ".cm-bullet": { display: "inline-block", width: `${MONO_EM}em`, textAlign: "center" },
  ".cm-task-box": {
    appearance: "none",
    boxSizing: "border-box",
    width: "1em",
    height: "1em",
    margin: "0",
    verticalAlign: "-0.15em",
    borderRadius: "4px",
    border: "1.5px solid var(--line-strong)",
    backgroundColor: "var(--surface)",
    cursor: "default",
  },
  ".cm-task-box:checked": {
    borderColor: "var(--ink)",
    backgroundColor: "var(--ink)",
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.5l2.5 2.5L12 5.5' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
    backgroundSize: "100%",
  },
  ".cm-task-done": {
    color: "var(--text-3)",
    textDecoration: "line-through",
    textDecorationColor: "var(--text-4)",
  },

  // Code, tables and HTML shown as source
  ".cm-codeblock": {
    fontFamily: "var(--font-mono)",
    fontSize: "14px",
    lineHeight: "22px",
    backgroundColor: "var(--sunken)",
    paddingInline: "16px",
  },
  ".cm-codeblock-begin": {
    borderTopLeftRadius: "10px",
    borderTopRightRadius: "10px",
    paddingTop: "8px",
  },
  ".cm-codeblock-end": {
    borderBottomLeftRadius: "10px",
    borderBottomRightRadius: "10px",
    paddingBottom: "8px",
  },
  ".cm-fence": { color: "var(--text-4)" },
  ".cm-code-label": {
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    color: "var(--text-3)",
  },
  ".cm-table-source, .cm-html-source": {
    fontFamily: "var(--font-mono)",
    fontSize: "14px",
    color: "var(--text-2)",
  },
  // Rendered HTML lays out as HTML: the editor's preserved whitespace would turn the line
  // breaks between table rows into empty cells.
  ".cm-rendered-block, .cm-rendered-inline, .cm-math, .cm-math-block": { whiteSpace: "normal" },
  ".cm-rendered-block": {
    fontSize: "inherit",
    lineHeight: "inherit",
    padding: "4px 0",
    overflowX: "auto",
  },

  // Search
  ".cm-panels": {
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line-subtle)" },
  ".cm-search": { padding: "6px 10px" },
  ".cm-search input, .cm-search button, .cm-search label": { fontSize: "13px" },
  ".cm-textfield": {
    backgroundColor: "var(--bg)",
    border: "1px solid var(--line)",
    borderRadius: "6px",
    padding: "3px 6px",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--surface)",
    border: "1px solid var(--line)",
    borderRadius: "6px",
    padding: "3px 8px",
  },
  ".cm-searchMatch": { backgroundColor: "var(--highlight-wash)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--highlight)" },
});

/** Code inside fenced blocks, and Markdown syntax marks shown while editing. */
export const noteHighlight = HighlightStyle.define([
  { tag: tags.processingInstruction, color: "var(--text-4)" },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--code-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--code-number)" },
  { tag: [tags.comment, tags.meta], color: "var(--code-comment)" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--code-function)",
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--code-type)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--code-property)" },
  { tag: [tags.tagName, tags.angleBracket], color: "var(--text-3)" },
  { tag: tags.invalid, color: "var(--danger)" },
]);
