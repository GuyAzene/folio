import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { sourceShown } from "./live-preview.ts";

/**
 * Links between the student's notes, as in Obsidian: `[[Title]]` or `[[Title|shown text]]` points
 * at a note of the same course by its title, and `[[topic:slug]]` at a study-notes topic. In the
 * editor they are styled as links, open on click, and `[[` offers the course's notes and topics.
 */
export const WIKILINK = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;

export interface LinkTargets {
  /** What `[[` offers: each link target with how it is shown. */
  targets(): { target: string; label: string; detail?: string }[];
  open(target: string, newTab: boolean): void;
}

/** The link under a position of a line, if any. */
export function linkAt(text: string, offset: number): { target: string } | null {
  for (const match of text.matchAll(WIKILINK)) {
    const start = match.index;
    if (offset >= start && offset <= start + match[0].length) return { target: match[1]!.trim() };
  }
  return null;
}

/**
 * The read view's Markdown with each link turned into an in-page link Folio intercepts. Code
 * blocks and inline code are left as written.
 */
export function linkedMarkdown(text: string): string {
  return text
    .split(/(^```[\s\S]*?^```|`[^`\n]*`)/m)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            WIKILINK,
            (_match, target: string, shown?: string) =>
              `[${(shown ?? target.replace(/^topic:/, "")).trim()}](#wikilink:${encodeURIComponent(target.trim())})`,
          ),
    )
    .join("");
}

/** The target of a read-view link Folio made, or null for any other link. */
export function wikilinkTarget(href: string | null): string | null {
  return href?.startsWith("#wikilink:") ? decodeURIComponent(href.slice(10)) : null;
}

const link = Decoration.mark({ class: "cm-wikilink" });
const citation = Decoration.mark({ class: "cm-wikilink cm-citation" });
const tagMark = Decoration.mark({ class: "cm-tag" });
const hidden = Decoration.replace({});

/** A #tag, as note-meta reads them: after a space or the line start, not "# Heading". */
const TAG = /(^|[\s(])(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** Code, HTML and math are written as they are; nothing in them is a link or a tag. */
function literal(state: EditorState, at: number): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(at, 1);
    node;
    node = node.parent
  )
    if (/Code|HTML|Comment|Math|URL/.test(node.name)) return true;
  return false;
}

/**
 * Links and tags in the visible lines. In live preview a link away from the cursor shows only its
 * text, as in Obsidian: `[[Graph search]]` reads "Graph search", `[[topic:bfs|BFS]]` reads "BFS",
 * and a page citation reads as a chip. At the cursor, and in source mode, the brackets show.
 */
function decorate(view: EditorView): DecorationSet {
  const { state } = view;
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = state.sliceDoc(from, to);
    for (const match of text.matchAll(WIKILINK)) {
      const start = from + match.index;
      const end = start + match[0].length;
      if (literal(state, start)) continue;
      const target = match[1]!;
      const mark = /^page:/i.test(target.trim()) ? citation : link;
      if (sourceShown(state, start, end)) {
        ranges.push(mark.range(start, end));
        continue;
      }
      // What reads: the text after "|", or the target without a "topic:" prefix.
      const shownFrom =
        match[2] !== undefined
          ? start + 3 + target.length
          : start + 2 + (/^topic:/i.exec(target)?.[0].length ?? 0);
      const shownTo = end - 2;
      if (shownTo <= shownFrom) {
        ranges.push(mark.range(start, end));
        continue;
      }
      ranges.push(
        hidden.range(start, shownFrom),
        mark.range(shownFrom, shownTo),
        hidden.range(shownTo, end),
      );
    }
    for (const match of text.matchAll(TAG)) {
      const start = from + match.index + match[1]!.length;
      if (!literal(state, start)) ranges.push(tagMark.range(start, start + match[2]!.length));
    }
  }
  return Decoration.set(ranges, true);
}

const styled = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState) ||
        update.transactions.some((transaction) => transaction.reconfigured)
      )
        this.decorations = decorate(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function completions(links: LinkTargets) {
  return (context: CompletionContext): CompletionResult | null => {
    const typed = context.matchBefore(/\[\[[^[\]\n|]*$/);
    if (!typed) return null;
    const options: Completion[] = links.targets().map((item) => ({
      label: item.target,
      displayLabel: item.label,
      detail: item.detail,
      apply: (view, _completion, from, to) => {
        // Brackets typed with the link (closeBrackets adds them) are reused, not doubled.
        const closed = view.state.sliceDoc(to, to + 2) === "]]";
        view.dispatch({
          changes: { from, to, insert: closed ? item.target : `${item.target}]]` },
          selection: { anchor: from + item.target.length + 2 },
        });
      },
    }));
    return { from: typed.from + 2, options, validFor: /^[^[\]\n|]*$/ };
  };
}

export function wikilinks(links: LinkTargets): Extension {
  return [
    styled,
    autocompletion({ override: [completions(links)], icons: false }),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.target instanceof Element)) return false;
        const element = event.target.closest(".cm-wikilink");
        if (!element) return false;
        const position = view.posAtDOM(element);
        const line = view.state.doc.lineAt(position);
        const found = linkAt(line.text, position - line.from);
        if (!found) return false;
        event.preventDefault();
        links.open(found.target, event.metaKey || event.ctrlKey);
        return true;
      },
    }),
    EditorView.theme({
      ".cm-wikilink": {
        color: "var(--text)",
        textDecoration: "underline",
        textDecorationColor: "var(--line-strong)",
        textUnderlineOffset: "3px",
        cursor: "pointer",
      },
      ".cm-citation": {
        textDecoration: "none",
        fontFamily: "var(--font-sans)",
        fontSize: "0.8em",
        padding: "1px 6px",
        borderRadius: "5px",
        border: "1px solid var(--line-subtle)",
        background: "var(--sunken)",
        color: "var(--text-2)",
      },
      ".cm-tag": {
        fontFamily: "var(--font-sans)",
        fontSize: "0.85em",
        color: "var(--text-2)",
        background: "var(--sunken)",
        borderRadius: "4px",
        padding: "1px 4px",
      },
    }),
  ];
}
