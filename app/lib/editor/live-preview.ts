import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import {
  BulletWidget,
  CheckboxWidget,
  HtmlWidget,
  ImageWidget,
  LabelWidget,
  MathWidget,
  RuleWidget,
} from "./widgets.ts";

/**
 * Obsidian-style live preview. The note stays plain Markdown; decorations style it and hide or
 * replace its syntax — formulas become KaTeX, tables and HTML render, a task becomes a box —
 * everywhere except where the cursor is, which shows the source being edited. Source mode
 * keeps the styling and hides nothing. Decorations come from a state field because rendered
 * tables, HTML blocks and display formulas replace whole lines.
 */

/** Live preview (true) or source mode (false). Configure it through a compartment. */
export const livePreview = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? true,
});

/** The editor gained (true) or lost focus; dispatched by the view on its own. */
export const setFocus = StateEffect.define<boolean>();

/** An unfocused note shows no source at all, wherever its cursor was left. */
const focused = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setFocus)) value = effect.value;
    return value;
  },
});

/** Width of one character of the monospace list gutter, in em (Geist Mono's advance). */
export const MONO_EM = 0.6;
/** Width a task's box takes in place of "[ ]", in em. */
const BOX_EM = 1;

const VOID_TAGS = new Set(["br", "hr", "img", "wbr"]);

const hidden = Decoration.replace({});

export function buildPreview(state: EditorState): DecorationSet {
  return new Preview(state).build();
}

class Preview {
  private readonly ranges: Range<Decoration>[] = [];
  private readonly lineClasses = new Map<number, string[]>();
  /** Lines inside lists: hanging indent in em, and where the monospace gutter ends. */
  private readonly listLines = new Map<number, { hang: number; gutterTo: number }>();
  /** Inline HTML already drawn as a widget: nothing inside it is decorated again. */
  private readonly drawn: [number, number][] = [];
  private readonly state: EditorState;
  private readonly live: boolean;
  private readonly focus: boolean;

  constructor(state: EditorState) {
    this.state = state;
    this.live = state.facet(livePreview);
    this.focus = state.field(focused, false) ?? false;
  }

  build(): DecorationSet {
    syntaxTree(this.state).iterate({
      enter: (ref) => {
        if (this.drawn.some(([from, to]) => ref.from >= from && ref.to <= to)) return false;
        return this.visit(ref.node);
      },
    });
    for (const [at, classes] of this.lineClasses)
      this.ranges.push(Decoration.line({ class: classes.join(" ") }).range(at));
    for (const [at, { hang, gutterTo }] of this.listLines) {
      this.ranges.push(
        Decoration.line({
          class: "cm-list-line",
          attributes: { style: `--hang: ${hang.toFixed(2)}em` },
        }).range(at),
      );
      if (gutterTo > at)
        this.ranges.push(Decoration.mark({ class: "cm-list-gutter" }).range(at, gutterTo));
    }
    return Decoration.set(this.ranges, true);
  }

  // ── What the cursor touches ──────────────────────────────────────────────

  /** Whether the source of [from, to] shows: in source mode always, live only at the cursor. */
  private shows(from: number, to: number): boolean {
    if (!this.live) return true;
    if (!this.focus) return false;
    return this.state.selection.ranges.some((range) => range.from <= to && range.to >= from);
  }

  /** As `shows`, for every line that [from, to] touches. */
  private showsLines(from: number, to: number): boolean {
    const { doc } = this.state;
    return this.shows(doc.lineAt(from).from, doc.lineAt(to).to);
  }

  // ── Decorations ──────────────────────────────────────────────────────────

  private text(from: number, to: number): string {
    return this.state.doc.sliceString(from, to);
  }

  private mark(from: number, to: number, spec: Parameters<typeof Decoration.mark>[0]): void {
    if (to > from) this.ranges.push(Decoration.mark(spec).range(from, to));
  }

  private hide(from: number, to: number): void {
    if (to > from) this.ranges.push(hidden.range(from, to));
  }

  private replace(from: number, to: number, widget: WidgetType): void {
    this.ranges.push(Decoration.replace({ widget }).range(from, to));
  }

  /** Whole lines drawn as one rendered block. */
  private replaceLines(from: number, to: number, widget: WidgetType): void {
    this.ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
  }

  private lineClass(at: number, name: string): void {
    const line = this.state.doc.lineAt(at).from;
    const classes = this.lineClasses.get(line) ?? [];
    if (!classes.includes(name)) classes.push(name);
    this.lineClasses.set(line, classes);
  }

  private eachLine(from: number, to: number, visit: (from: number, to: number) => void): void {
    const { doc } = this.state;
    for (let n = doc.lineAt(from).number, last = doc.lineAt(to).number; n <= last; n++) {
      const line = doc.line(n);
      visit(line.from, line.to);
    }
  }

  /** Hides a mark and the one space after it, as in "# " or "> ". */
  private hideWithSpace(from: number, to: number): void {
    this.hide(from, this.text(to, to + 1) === " " ? to + 1 : to);
  }

  // ── Syntax ───────────────────────────────────────────────────────────────

  /** Returns false when the node's children need no decorations of their own. */
  private visit(node: SyntaxNode): boolean | void {
    switch (node.name) {
      case "ATXHeading1":
      case "ATXHeading2":
      case "ATXHeading3":
      case "ATXHeading4":
      case "ATXHeading5":
      case "ATXHeading6":
        return this.heading(node, Number(node.name.at(-1)));
      case "SetextHeading1":
      case "SetextHeading2":
        return this.setextHeading(node, Number(node.name.at(-1)));
      case "Emphasis":
        return this.inline(node, "cm-em", "EmphasisMark");
      case "StrongEmphasis":
        return this.inline(node, "cm-strong", "EmphasisMark");
      case "Strikethrough":
        return this.inline(node, "cm-strike", "StrikethroughMark");
      case "InlineCode":
        return this.inline(node, "cm-inline-code", "CodeMark");
      case "Link":
        return this.link(node);
      case "Image":
        return this.image(node);
      case "Autolink":
        return this.autolink(node);
      case "URL":
        // Bare addresses; a link's or image's own URL is handled with its link.
        if (node.parent?.name !== "Link" && node.parent?.name !== "Image")
          this.url(node.from, node.to, !this.shows(node.from, node.to));
        return;
      case "Escape":
        if (!this.shows(node.from, node.to)) this.hide(node.from, node.from + 1);
        return;
      case "HTMLTag":
        this.mark(node.from, node.to, { class: "cm-html-tag" });
        return;
      case "Comment":
        this.mark(node.from, node.to, { class: "cm-comment" });
        return;
      case "Paragraph":
      case "Task":
      case "TableCell":
        this.inlineHtml(node);
        return;
      case "Blockquote":
        this.eachLine(node.from, node.to, (from) => this.lineClass(from, "cm-quote"));
        return;
      case "QuoteMark":
        if (!this.showsLines(node.from, node.to)) this.hideWithSpace(node.from, node.to);
        return;
      case "ListItem":
        return this.listItem(node);
      case "HorizontalRule":
        this.lineClass(node.from, "cm-rule-line");
        if (!this.showsLines(node.from, node.to))
          this.replace(node.from, node.to, new RuleWidget());
        return false;
      case "FencedCode":
        return this.fencedCode(node);
      case "CodeBlock":
        this.eachLine(node.from, node.to, (from) => this.lineClass(from, "cm-codeblock"));
        return false;
      case "Table":
        return this.renderedBlock(node, "cm-table-source");
      case "HTMLBlock":
        return this.renderedBlock(node, "cm-html-source");
      case "CommentBlock":
        this.eachLine(node.from, node.to, (from) => this.lineClass(from, "cm-comment-block"));
        return false;
      case "LinkReference":
        this.eachLine(node.from, node.to, (from) => this.lineClass(from, "cm-link-reference"));
        return false;
      case "InlineMath":
        return this.inlineMath(node);
      case "BlockMath":
        return this.blockMath(node);
    }
  }

  private heading(node: SyntaxNode, level: number): void {
    this.lineClass(node.from, `cm-heading cm-h${level}`);
    if (this.showsLines(node.from, node.to)) return;
    for (const mark of node.getChildren("HeaderMark")) {
      if (mark.from === node.from) this.hideWithSpace(mark.from, mark.to);
      else {
        // A closing "##" goes with the spaces before it.
        let from = mark.from;
        while (from > node.from && this.text(from - 1, from) === " ") from--;
        this.hide(from, mark.to);
      }
    }
  }

  private setextHeading(node: SyntaxNode, level: number): void {
    const underline = node.getChild("HeaderMark");
    this.eachLine(node.from, underline ? underline.from - 1 : node.to, (from) =>
      this.lineClass(from, `cm-heading cm-h${level}`),
    );
    if (!underline) return;
    this.lineClass(underline.from, "cm-setext-underline");
    if (!this.showsLines(node.from, node.to)) this.hide(underline.from, underline.to);
  }

  /** Styled text whose delimiters ("**", "~~", backticks) hide away from the cursor. */
  private inline(node: SyntaxNode, name: string, marks: string): void {
    this.mark(node.from, node.to, { class: name });
    if (this.shows(node.from, node.to)) return;
    for (const mark of node.getChildren(marks)) this.hide(mark.from, mark.to);
  }

  private link(node: SyntaxNode): void {
    const [open, close] = node.getChildren("LinkMark");
    const url = node.getChild("URL");
    // "[word]" alone is plain text unless a URL or a reference label follows it.
    if (!open || !close || (!url && !node.getChild("LinkLabel"))) return;
    const href = url ? this.text(url.from, url.to) : undefined;
    const rendered = !this.shows(node.from, node.to);
    this.mark(open.to, close.from, {
      class: "cm-link",
      attributes: href ? { title: href, ...(rendered ? { "data-href": href } : {}) } : {},
    });
    if (rendered) {
      this.hide(open.from, open.to);
      this.hide(close.from, node.to);
    } else if (url) this.url(url.from, url.to, false);
  }

  private url(from: number, to: number, rendered: boolean): void {
    const href = this.text(from, to);
    this.mark(from, to, {
      class: "cm-link cm-url",
      attributes: rendered ? { "data-href": href, title: href } : { title: href },
    });
  }

  private autolink(node: SyntaxNode): boolean {
    const url = node.getChild("URL");
    if (!url) return false;
    const rendered = !this.shows(node.from, node.to);
    this.url(url.from, url.to, rendered);
    if (rendered) for (const mark of node.getChildren("LinkMark")) this.hide(mark.from, mark.to);
    return false;
  }

  private image(node: SyntaxNode): boolean | void {
    const [open, close] = node.getChildren("LinkMark");
    const url = node.getChild("URL");
    if (!open || !close || !url) return;
    if (this.shows(node.from, node.to)) {
      this.mark(node.from, node.to, { class: "cm-image-source" });
      return false;
    }
    this.replace(
      node.from,
      node.to,
      new ImageWidget(this.text(url.from, url.to), this.text(open.to, close.from)),
    );
    return false;
  }

  /**
   * Inline HTML: an opening tag and its closing tag in the same paragraph render together,
   * as do void tags such as <br>. Unpaired tags stay visible as source.
   */
  private inlineHtml(container: SyntaxNode): void {
    const tags = container.getChildren("HTMLTag");
    if (!tags.length || !this.live) return;
    const open: { name: string; from: number }[] = [];
    const spans: [number, number][] = [];
    for (const tag of tags) {
      const match = /^<(\/?)([A-Za-z][\w-]*)[^>]*?(\/?)>$/.exec(this.text(tag.from, tag.to));
      if (!match) continue;
      const [, closing, raw, selfClosing] = match;
      const name = raw!.toLowerCase();
      if (closing) {
        let at = open.length - 1;
        while (at >= 0 && open[at]!.name !== name) at--;
        if (at < 0) continue;
        spans.push([open[at]!.from, tag.to]);
        open.length = at;
      } else if (selfClosing || VOID_TAGS.has(name)) spans.push([tag.from, tag.to]);
      else open.push({ name, from: tag.from });
    }
    // Outermost spans only: "<b><i>x</i></b>" is one widget.
    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let end = -1;
    for (const [from, to] of spans) {
      if (from < end || this.shows(from, to)) continue;
      end = to;
      this.replace(from, to, new HtmlWidget(this.text(from, to), false));
      this.drawn.push([from, to]);
    }
  }

  private listItem(item: SyntaxNode): void {
    const mark = item.getChild("ListMark");
    if (!mark) return;
    const { doc } = this.state;
    const first = doc.lineAt(mark.from);
    const task = item.getChild("Task")?.getChild("TaskMarker");
    const ordered = item.parent?.name === "OrderedList";
    const shown = this.shows(mark.from, task ? task.to : mark.to);
    const lead = this.text(first.from, mark.from);

    if (ordered) this.mark(mark.from, mark.to, { class: "cm-list-number" });
    let hang: number | undefined;
    if (task) {
      const done = /x/i.test(this.text(task.from, task.to));
      if (done) this.mark(task.to, item.getChild("Task")!.to, { class: "cm-task-done" });
      if (!shown) {
        if (!ordered) this.hide(mark.from, task.from);
        this.replace(task.from, task.to, new CheckboxWidget(done));
        const before = ordered ? columns(this.text(first.from, task.from)) : columns(lead);
        hang = before * MONO_EM + BOX_EM + spaces(this.text(task.to, first.to)) * MONO_EM;
      }
    } else if (!shown && !ordered) this.replace(mark.from, mark.to, new BulletWidget());

    // The gutter (indent and marker) is monospace, so wrapped lines hang exactly under the text.
    if (/\S/.test(lead)) return; // a list inside a quote keeps the quote's own layout
    const contentFrom = task ? task.to : mark.to;
    const gutterTo = contentFrom + spaces(this.text(contentFrom, first.to));
    hang ??= columns(this.text(first.from, gutterTo)) * MONO_EM;
    this.listLines.set(first.from, { hang, gutterTo });
    // Further lines of the item hang by their own indent; nested items replace theirs later.
    const last = doc.lineAt(item.to).number;
    for (let n = first.number + 1; n <= last; n++) {
      const line = doc.line(n);
      const indent = spaces(line.text);
      this.listLines.set(line.from, {
        hang: columns(line.text.slice(0, indent)) * MONO_EM,
        gutterTo: line.from + indent,
      });
    }
  }

  private fencedCode(node: SyntaxNode): boolean {
    const { doc } = this.state;
    const first = doc.lineAt(node.from);
    const last = doc.lineAt(node.to);
    this.eachLine(node.from, node.to, (from) => this.lineClass(from, "cm-codeblock"));
    this.lineClass(first.from, "cm-codeblock-begin");
    this.lineClass(last.from, "cm-codeblock-end");
    if (this.showsLines(node.from, node.to)) {
      this.lineClass(first.from, "cm-fence");
      if (last.number > first.number) this.lineClass(last.from, "cm-fence");
      return false;
    }
    const info = node.getChild("CodeInfo");
    const language = info ? this.text(info.from, info.to) : "";
    if (language) this.replace(node.from, first.to, new LabelWidget(language));
    else this.hide(node.from, first.to);
    const marks = node.getChildren("CodeMark");
    const close = marks.length > 1 ? marks.at(-1)! : undefined;
    if (close && last.number > first.number) this.hide(close.from, last.to);
    return false;
  }

  /** A table or HTML block: rendered in place when it starts a line and the cursor is away. */
  private renderedBlock(node: SyntaxNode, sourceClass: string): boolean | void {
    const { doc } = this.state;
    const first = doc.lineAt(node.from);
    const last = doc.lineAt(node.to);
    if (this.live && first.from === node.from && !this.shows(first.from, last.to)) {
      this.replaceLines(first.from, last.to, new HtmlWidget(this.text(first.from, last.to), true));
      return false;
    }
    this.eachLine(node.from, node.to, (from) => this.lineClass(from, sourceClass));
  }

  private inlineMath(node: SyntaxNode): boolean {
    const [open, close] = node.getChildren("MathMark");
    if (!open || !close) return false;
    if (this.shows(node.from, node.to)) {
      this.mark(node.from, node.to, { class: "cm-math-source" });
      return false;
    }
    const opener = this.text(open.from, open.to);
    this.replace(
      node.from,
      node.to,
      new MathWidget(this.text(open.to, close.from).trim(), opener === "$$" || opener === "\\["),
    );
    return false;
  }

  private blockMath(node: SyntaxNode): void | boolean {
    const { doc } = this.state;
    const marks = node.getChildren("MathMark");
    const first = doc.lineAt(node.from);
    const last = doc.lineAt(node.to);
    const closed = marks.length === 2;
    const tex = closed ? this.mathSource(node, marks[0]!.to, marks[1]!.from) : "";
    if (this.live && closed && first.from === node.from && !this.shows(first.from, last.to)) {
      this.replaceLines(first.from, last.to, new MathWidget(tex, true, true));
      return false;
    }
    this.eachLine(node.from, node.to, (from) => this.lineClass(from, "cm-math-line"));
    this.mark(node.from, node.to, { class: "cm-math-source" });
    // While a formula is edited (or sits in a list or quote), its rendering shows beneath it.
    if (this.live && closed && tex)
      this.ranges.push(
        Decoration.widget({ widget: new MathWidget(tex, true, true), block: true, side: 1 }).range(
          last.to,
        ),
      );
  }

  /** A display formula's TeX, without the quote markers of the lines it spans. */
  private mathSource(node: SyntaxNode, from: number, to: number): string {
    let tex = "";
    let at = from;
    for (const quote of node.getChildren("QuoteMark")) {
      if (quote.from < from || quote.to > to) continue;
      tex += this.text(at, quote.from);
      at = this.text(quote.to, quote.to + 1) === " " ? quote.to + 1 : quote.to;
    }
    return (tex + this.text(at, to)).trim();
  }
}

function spaces(text: string): number {
  return /^[ \t]*/.exec(text)![0].length;
}

/** Columns of leading whitespace and markers; a tab reaches the next multiple of four. */
function columns(text: string): number {
  let column = 0;
  for (const char of text) column = char === "\t" ? column + 4 - (column % 4) : column + 1;
  return column;
}

/** The mouse button went down in the note (true) or came up again (false). */
export const setPointerDown = StateEffect.define<boolean>();

/**
 * While the mouse selects, what is rendered stays rendered: revealing the source of each
 * formula or link as the selection reaches it would reflow the line under the pointer, and the
 * selection would jump — worst in lines that mix Hebrew and English. It catches up on release.
 */
const pointerDown = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setPointerDown)) value = effect.value;
    return value;
  },
});

/** The live preview's decorations; exported for tests. */
export const preview = StateField.define<DecorationSet>({
  create: buildPreview,
  update(decorations, transaction) {
    const selecting = transaction.state.field(pointerDown, false);
    if (
      transaction.docChanged ||
      transaction.reconfigured ||
      transaction.effects.some((effect) => effect.is(setFocus) || effect.is(setPointerDown)) ||
      syntaxTree(transaction.state) !== syntaxTree(transaction.startState) ||
      (transaction.selection && !selecting)
    )
      return buildPreview(transaction.state);
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const pointer = ViewPlugin.fromClass(
  class {
    readonly view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
    }
    readonly release = () => {
      window.removeEventListener("mouseup", this.release);
      this.view.dispatch({ effects: setPointerDown.of(false) });
    };
    destroy() {
      window.removeEventListener("mouseup", this.release);
    }
  },
  {
    eventHandlers: {
      mousedown(event) {
        if (event.button !== 0) return false;
        // Not pressed yet: the press does not reveal what it lands on until it is released.
        if (!this.view.state.field(pointerDown)) {
          this.view.dispatch({ effects: setPointerDown.of(true) });
          window.addEventListener("mouseup", this.release);
        }
        return false;
      },
    },
  },
);

/** A rendered link opens on click, as in Obsidian; with the cursor inside it, ⌘-click opens. */
function openLink(event: MouseEvent): boolean {
  if (event.button !== 0 || !(event.target instanceof Element)) return false;
  const rendered = event.target.closest<HTMLElement>("[data-href]");
  const source =
    event.metaKey || event.ctrlKey ? event.target.closest<HTMLElement>(".cm-link") : null;
  const href = rendered?.dataset.href ?? source?.title;
  if (!href) return false;
  const url = /^www\./i.test(href) ? `https://${href}` : href;
  if (!/^https?:\/\//i.test(url)) return false;
  event.preventDefault();
  window.open(url, "_blank", "noopener");
  return true;
}

export function livePreviewExtension(): Extension {
  return [
    focused,
    pointerDown,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
    preview,
    pointer,
    EditorView.domEventHandlers({ mousedown: openLink }),
  ];
}
