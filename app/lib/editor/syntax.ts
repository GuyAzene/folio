import { markdown } from "@codemirror/lang-markdown";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { BlockContext, Element, Line, MarkdownConfig } from "@lezer/markdown";
import { GFM } from "@lezer/markdown";
import { tags } from "@lezer/highlight";
import { BLOCK_MATH, INLINE_MATH } from "../math-syntax.ts";

/**
 * The Markdown a note is written in: CommonMark with GitHub's tables, task lists, strikethrough
 * and links, plus TeX math read by the same rules as the chat renderer. Emoji, subscript and
 * superscript shortcuts are left out because the reading view does not render them.
 */

const DOLLAR = 36;
const BACKSLASH = 92;

/** Where `close` next occurs in `text` from `from`, stepping over backslash pairs. */
function findCloser(text: string, from: number, close: string): number {
  for (let i = from; i < text.length; i++) {
    if (text.startsWith(close, i)) return i;
    if (text.charCodeAt(i) === BACKSLASH) i++;
  }
  return -1;
}

export const mathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: tags.special(tags.content) },
    { name: "BlockMath", block: true, style: tags.special(tags.content) },
    { name: "MathMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "InlineMath",
      // Before Escape, which would otherwise take "\(" and "\[" as escaped punctuation.
      before: "Escape",
      parse(cx, next, pos) {
        if (next !== DOLLAR && next !== BACKSLASH) return -1;
        const text = cx.slice(pos, cx.end);
        for (const rule of INLINE_MATH) {
          const match = rule.pattern.exec(text);
          if (!match) continue;
          const end = pos + match[0].length;
          return cx.addElement(
            cx.elt("InlineMath", pos, end, [
              cx.elt("MathMark", pos, pos + rule.open.length),
              cx.elt("MathMark", end - rule.close.length, end),
            ]),
          );
        }
        return -1;
      },
    },
  ],
  parseBlock: [
    {
      name: "BlockMath",
      before: "FencedCode",
      parse(cx: BlockContext, line: Line) {
        if (line.indent - line.baseIndent > 3) return false;
        const rule = BLOCK_MATH.find((rule) => line.text.startsWith(rule.open, line.pos));
        if (!rule) return false;
        const from = cx.lineStart + line.pos;
        const children: Element[] = [cx.elt("MathMark", from, from + rule.open.length)];
        let at = line.pos + rule.open.length;
        for (let first = true; ; first = false) {
          const found = findCloser(line.text, at, rule.close);
          if (found >= 0) {
            const after = found + rule.close.length;
            // Text after the closer on the opening line makes it inline math in a paragraph.
            if (first && /\S/.test(line.text.slice(after))) return false;
            // A formula with nothing inside is not math, as in the chat.
            if (first && !/\S/.test(line.text.slice(line.pos + rule.open.length, found)))
              return false;
            children.push(cx.elt("MathMark", cx.lineStart + found, cx.lineStart + after));
            const end = cx.lineStart + line.text.length;
            cx.nextLine();
            cx.addElement(cx.elt("BlockMath", from, end, children));
            return true;
          }
          // TeX has no blank lines inside display math, so an unclosed formula ends at one,
          // or where its list or quote ends, rather than swallowing the rest of the note.
          const end = cx.lineStart + line.text.length;
          if (
            !cx.nextLine() ||
            line.pos === line.text.length ||
            (line as Line & { depth: number }).depth < cx.depth
          ) {
            cx.addElement(cx.elt("BlockMath", from, end, children));
            return true;
          }
          children.push(...line.markers);
          at = line.pos;
        }
      },
      endLeaf: (_cx, line) =>
        BLOCK_MATH.some((rule) => line.text.startsWith(rule.open, line.pos)) &&
        line.indent - line.baseIndent < 4,
    },
  ],
};

/** Code blocks are highlighted for any language CodeMirror knows, loaded on first use. */
const codeLanguages = (info: string) =>
  LanguageDescription.matchLanguageName(languages, info, true) ?? null;

export const noteMarkdown = () =>
  markdown({
    extensions: [GFM, mathSyntax],
    codeLanguages,
    // The live preview shows HTML rendered; completing tags while typing would fight it.
    completeHTMLTags: false,
  });
