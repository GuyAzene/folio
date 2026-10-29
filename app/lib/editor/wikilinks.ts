import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

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
const matcher = new MatchDecorator({ regexp: WIKILINK, decoration: () => link });
const styled = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = matcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = matcher.updateDeco(update, this.decorations);
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
    }),
  ];
}
