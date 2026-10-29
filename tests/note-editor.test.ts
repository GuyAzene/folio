import { describe, expect, it } from "vite-plus/test";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { insertLink, toggleWrap } from "../app/lib/editor/commands.ts";
import {
  directionState,
  noteDirection,
  noteDirections,
  setKeyboardDirection,
} from "../app/lib/editor/direction.ts";
import {
  buildPreview,
  livePreview,
  livePreviewExtension,
  preview as previewField,
  setFocus,
  setPointerDown,
} from "../app/lib/editor/live-preview.ts";
import type { MathWidget } from "../app/lib/editor/widgets.ts";
import { fileChange, lineSeparator } from "../app/lib/editor/note-editor.ts";
import { noteMarkdown } from "../app/lib/editor/syntax.ts";
import { markdownToHtml } from "../app/lib/markdown.ts";

// Synthetic notes only; no course material.

function note(doc: string, options: { cursor?: number; live?: boolean; focus?: boolean } = {}) {
  const extensions: Extension[] = [
    EditorState.lineSeparator.of(lineSeparator(doc)),
    noteMarkdown(),
    livePreview.of(options.live ?? true),
    livePreviewExtension(),
  ];
  const state = EditorState.create({
    doc,
    extensions,
    selection: EditorSelection.cursor(options.cursor ?? 0),
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** Math the editor's parser finds, as the TeX inside the delimiters. */
function editorMath(doc: string): string[] {
  const state = note(doc);
  const found: string[] = [];
  ensureSyntaxTree(state, state.doc.length, 5000)!.iterate({
    enter(ref) {
      if (ref.name !== "InlineMath" && ref.name !== "BlockMath") return;
      const marks = ref.node.getChildren("MathMark");
      if (marks.length === 2) found.push(state.sliceDoc(marks[0]!.to, marks[1]!.from).trim());
      return false;
    },
  });
  return found;
}

/** Math the chat renderer finds. */
function chatMath(doc: string): string[] {
  return [...markdownToHtml(doc).matchAll(/data-tex="([^"]*)"/g)].map((match) =>
    decodeURIComponent(match[1]!),
  );
}

interface Seen {
  from: number;
  to: number;
  kind: "hidden" | "widget" | "block" | "mark" | "line";
  widget?: string;
  className?: string;
}

/** The live preview's decorations in a readable form. */
function preview(state: EditorState, focused = false): Seen[] {
  const focusedState = focused ? state.update({ effects: setFocus.of(true) }).state : state;
  const seen: Seen[] = [];
  buildPreview(focusedState).between(0, focusedState.doc.length, (from, to, value: Decoration) => {
    const spec = value.spec as {
      widget?: object;
      block?: boolean;
      class?: string;
      attributes?: object;
    };
    if (from === to && !spec.widget) seen.push({ from, to, kind: "line", className: spec.class });
    else if (spec.widget)
      seen.push({
        from,
        to,
        kind: spec.block ? "block" : "widget",
        widget: spec.widget.constructor.name,
      });
    else if (spec.class || spec.attributes)
      seen.push({ from, to, kind: "mark", className: spec.class });
    else seen.push({ from, to, kind: "hidden" });
  });
  return seen;
}

const hidden = (state: EditorState, focused = false) =>
  preview(state, focused)
    .filter((item) => item.kind === "hidden")
    .map((item) => state.sliceDoc(item.from, item.to));
const widgets = (state: EditorState, focused = false) =>
  preview(state, focused)
    .filter((item) => item.kind === "widget" || item.kind === "block")
    .map((item) => [item.widget, state.sliceDoc(item.from, item.to)]);

describe("note syntax", () => {
  it("reads math exactly where the chat renderer does", () => {
    const fixtures = [
      "$x$",
      "cost $5 and $6",
      "$a\\$ b",
      "$\\{a^n b^n \\mid n \\ge 0\\}$ here",
      "\\(a+b\\) and \\[x^2\\]",
      "inline $$\\sum x$$ display",
      "*see $a*b$ here*",
      "`$x$` is code",
      "$x $ is not math",
      "$$\n\\frac{1}{2}\n$$",
      "\\[\n\\int_0^1 x\\,dx\n\\]",
      "שפה $L = \\{w \\mid |w| \\le 3\\}$ סופית",
    ];
    for (const fixture of fixtures) expect(editorMath(fixture), fixture).toEqual(chatMath(fixture));
  });

  it("lets a formula end in an escaped brace, in the chat as in notes", () => {
    expect(chatMath("$\\{a\\}$")).toEqual(["\\{a\\}"]);
    expect(chatMath("cost $5 and $6")).toEqual([]);
  });

  it("ends unclosed display math at a blank line instead of swallowing the note", () => {
    const state = note("$$\nx + y\n\nafter");
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    const names: string[] = [];
    tree.iterate({ enter: (ref) => void names.push(ref.name) });
    expect(names).toContain("BlockMath");
    expect(names.filter((name) => name === "Paragraph")).toHaveLength(1);
  });

  it("keeps display math inside its quote, without the quote markers in its TeX", () => {
    expect(editorMath("> $$\n> a+b\n> $$\n\noutside")).toEqual(["> a+b\n>"]);
    // Not at the start of its line, so it renders beneath its source rather than in place.
    const state = note("> $$\n> a+b\n> $$");
    const drawn: string[] = [];
    buildPreview(state).between(0, state.doc.length, (_from, _to, value) => {
      const widget = (value.spec as { widget?: MathWidget }).widget;
      if (widget) drawn.push(widget.tex);
    });
    expect(drawn).toEqual(["a+b"]);
  });
});

describe("live preview", () => {
  it("hides syntax and renders math away from the cursor", () => {
    const state = note("# Title\n\n**bold** and $x^2$ and `code`", { cursor: 0 });
    expect(hidden(state)).toEqual(["# ", "**", "**", "`", "`"]);
    expect(widgets(state)).toEqual([["MathWidget", "$x^2$"]]);
  });

  it("shows the source of what the cursor is in, and only that", () => {
    const doc = "# Title\n\n**bold** and $x^2$";
    const inBold = note(doc, { cursor: doc.indexOf("bold") + 1 });
    expect(hidden(inBold, true)).toEqual(["# "]);
    expect(widgets(inBold, true)).toEqual([["MathWidget", "$x^2$"]]);
    const inMath = note(doc, { cursor: doc.indexOf("x^2") });
    expect(widgets(inMath, true)).toEqual([]);
    expect(hidden(inMath, true)).toEqual(["# ", "**", "**"]);
  });

  it("keeps what is rendered while the mouse selects, and catches up on release", () => {
    const drawn = (state: EditorState) => {
      let count = 0;
      state.field(previewField).between(0, state.doc.length, (_from, _to, value) => {
        if ((value.spec as { widget?: object }).widget) count++;
      });
      return count;
    };
    let state = note("a $x$ b", { cursor: 0 });
    state = state.update({ effects: [setFocus.of(true), setPointerDown.of(true)] }).state;
    state = state.update({ selection: EditorSelection.range(0, 7) }).state;
    expect(drawn(state)).toBe(1);
    state = state.update({ effects: setPointerDown.of(false) }).state;
    expect(drawn(state)).toBe(0);
  });

  it("shows no source at all when the editor is not focused", () => {
    const doc = "**bold**";
    expect(hidden(note(doc, { cursor: 3 }), false)).toEqual(["**", "**"]);
  });

  it("hides nothing in source mode, but keeps the styling", () => {
    const state = note("# Title\n\n**bold** $x$\n\n| a |\n|---|\n| 1 |", { live: false });
    const seen = preview(state);
    expect(seen.filter((item) => item.kind !== "mark" && item.kind !== "line")).toEqual([]);
    expect(seen.some((item) => item.className === "cm-strong")).toBe(true);
  });

  it("renders tables, HTML blocks and display math as blocks", () => {
    const doc =
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n<details><summary>s</summary>x</details>\n\n$$\nx\n$$";
    expect(widgets(note(doc)).map(([widget]) => widget)).toEqual([
      "HtmlWidget",
      "HtmlWidget",
      "MathWidget",
    ]);
    expect(preview(note(doc)).filter((item) => item.kind === "block")).toHaveLength(3);
  });

  it("shows a formula being edited with its rendering beneath it", () => {
    const doc = "$$\nx^2\n$$";
    const state = note(doc, { cursor: 4 });
    const seen = preview(state, true);
    expect(seen.filter((item) => item.kind === "block")).toEqual([
      { from: doc.length, to: doc.length, kind: "block", widget: "MathWidget" },
    ]);
  });

  it("turns tasks into boxes and bullets into dots, with the marker shown at the cursor", () => {
    const doc = "- [ ] open\n- [x] done\n- plain\n1. first";
    expect(widgets(note(doc))).toEqual([
      ["CheckboxWidget", "[ ]"],
      ["CheckboxWidget", "[x]"],
      ["BulletWidget", "-"],
    ]);
    expect(hidden(note(doc))).toEqual(["- ", "- "]);
    expect(widgets(note(doc, { cursor: 1 }), true)[0]).toEqual(["CheckboxWidget", "[x]"]);
  });

  it("hangs wrapped list lines under the item's text", () => {
    const doc = "- item\n  - nested\n- [ ] task";
    const lines = preview(note(doc))
      .filter((item) => item.className === "cm-list-line")
      .map((item) => item.from);
    expect(lines).toEqual([0, 7, 18]);
    const styles = buildPreview(note(doc));
    const hangs: string[] = [];
    styles.between(0, doc.length, (from, to, value) => {
      const style = (value.spec as { attributes?: { style?: string } }).attributes?.style;
      if (style) hangs.push(style);
    });
    // "• " is two monospace columns; "  • " four; a task's box is one em plus its space.
    expect(hangs).toEqual(["--hang: 1.20em", "--hang: 2.40em", "--hang: 1.60em"]);
  });

  it("renders paired inline HTML and void tags, and leaves an unpaired tag as source", () => {
    const state = note("a <u>b</u> c<br>d <i>open");
    expect(widgets(state)).toEqual([
      ["HtmlWidget", "<u>b</u>"],
      ["HtmlWidget", "<br>"],
    ]);
  });

  it("renders links as their text and keeps the address for opening", () => {
    const state = note("see [the page](https://example.com) now");
    expect(hidden(state)).toEqual(["[", "](https://example.com)"]);
    const link = preview(state).find((item) => item.className === "cm-link")!;
    expect(state.sliceDoc(link.from, link.to)).toBe("the page");
  });

  it("leaves a bracketed word that is not a link alone", () => {
    expect(hidden(note("an [aside] here"))).toEqual([]);
  });
});

describe("note direction", () => {
  const directions = (doc: string) => noteDirections(note(doc));

  it("gives each line the direction of its first letter", () => {
    const { lines } = directions("Python היא שפת תכנות נוחה\n\nשורה בעברית\n\nAn English line");
    // The blank line between keeps the direction before it.
    expect(lines).toEqual(["ltr", "ltr", "rtl", "rtl", "ltr"]);
  });

  it("keeps a line that starts in English left to right as Hebrew words are typed", () => {
    for (const typed of ["Hello", "Hello ש", "Hello שלום", "Hello שלום עולם רב לכולם"])
      expect(directions(typed).lines, typed).toEqual(["ltr"]);
  });

  it("looks past a formula, code or a link to the first word", () => {
    expect(directions("$x^2$ היא פונקציה").lines).toEqual(["rtl"]);
    expect(directions("`map` היא פונקציה").lines).toEqual(["rtl"]);
    expect(directions("https://example.com הוא אתר").lines).toEqual(["rtl"]);
  });

  it("keeps a line that starts in Hebrew right to left as English words are typed", () => {
    for (const typed of [
      "שלום",
      "שלום this",
      "שלום this is",
      "שלום this is my first note",
      "שלום this is my first note מה קורה",
    ])
      expect(directions(typed).lines, typed).toEqual(["rtl"]);
  });

  it("decides each line of a paragraph on its own", () => {
    expect(directions("שלום עולם\nhello world\nשוב עברית").lines).toEqual(["rtl", "ltr", "rtl"]);
  });

  it("keeps a line without words, such as a formula, in the direction before it", () => {
    expect(directions("שלום this is my first note מה קורה\n$\\dfrac12$").lines).toEqual([
      "rtl",
      "rtl",
    ]);
  });

  it("keeps a Hebrew note right to left across blank lines, rules and code", () => {
    const { lines } = directions("שלום עולם\n\n```\ncode\n```\n\n---\n");
    expect(lines).toEqual(["rtl", "rtl", "ltr", "ltr", "ltr", "rtl", "rtl", "rtl"]);
  });

  it("isolates formulas, code, addresses and arithmetic in Hebrew lines", () => {
    const doc = "הנוסחה $x^2$ והקוד `f(x)` באתר https://example.com וגם 3 + 4 = 7";
    const { islands } = directions(doc);
    expect(islands.map(({ from, to, direction }) => [doc.slice(from, to), direction])).toEqual([
      ["$x^2$", "ltr"],
      ["`f(x)`", "ltr"],
      ["https://example.com", "ltr"],
      ["3 + 4 = 7", "ltr"],
    ]);
  });

  it("gives each list item and task its own direction, markers aside", () => {
    expect(
      directions("1. First step\n2. שלב שני\n- [ ] read the proof\n- [x] לקרוא").lines,
    ).toEqual(["ltr", "rtl", "ltr", "rtl"]);
  });

  it("gives a table's rows one direction, so its columns line up", () => {
    expect(directions("| מושג | הגדרה |\n|---|---|\n| DFA | deterministic |").lines).toEqual([
      "rtl",
      "rtl",
      "rtl",
    ]);
  });

  it("keeps HTML tags in a Hebrew block left to right", () => {
    const doc = "<details><summary>הוכחה</summary>\nנבנה אוטומט\n</details>";
    const { lines, islands } = directions(doc);
    expect(lines).toEqual(["rtl", "rtl", "rtl"]);
    expect(islands.map(({ from, to }) => doc.slice(from, to))).toEqual([
      "<details>",
      "<summary>",
      "</summary>",
      "</details>",
    ]);
  });

  it("starts the empty line at the cursor on the keyboard's side", () => {
    const rtlLines = (state: EditorState) => {
      const starts: number[] = [];
      state.field(directionState).lines.between(0, state.doc.length, (from) => {
        starts.push(state.doc.lineAt(from).number);
      });
      return starts;
    };
    const doc = "An English line\n\n- ";
    let state = EditorState.create({
      doc,
      extensions: [noteMarkdown(), noteDirection()],
      selection: EditorSelection.cursor(doc.length),
    });
    expect(rtlLines(state)).toEqual([]);
    state = state.update({ effects: setKeyboardDirection.of("rtl") }).state;
    // Only the cursor's line, and only while it is empty: an empty list item counts.
    expect(rtlLines(state)).toEqual([3]);
    state = state.update({ selection: EditorSelection.cursor(0) }).state;
    expect(rtlLines(state)).toEqual([]);
    state = state.update({ selection: EditorSelection.cursor(doc.length) }).state;
    state = state.update({ changes: { from: doc.length, insert: "word" } }).state;
    expect(rtlLines(state)).toEqual([]);
  });
});

describe("note text", () => {
  it("keeps the file's own line endings byte for byte", () => {
    for (const doc of ["a\nb\n", "a\r\nb\r\n", "a\r\nb\nc", "no newline"]) {
      const state = note(doc);
      expect(state.sliceDoc()).toBe(doc);
    }
    const windows = note("one\r\ntwo");
    const typed = windows.update({ changes: { from: 3, insert: windows.lineBreak + "new" } }).state;
    expect(typed.sliceDoc()).toBe("one\r\nnew\r\ntwo");
  });

  it("merges a version saved elsewhere as the smallest change, keeping the cursor", () => {
    const doc = "# Note\n\nfirst line\nsecond line\n";
    const state = note(doc, { cursor: doc.indexOf("second") + 3 });
    const saved = "# Note\n\nfirst line, edited\nsecond line\n";
    const merged = state.update(fileChange(state, saved)).state;
    expect(merged.sliceDoc()).toBe(saved);
    expect(merged.selection.main.head).toBe(saved.indexOf("second") + 3);
  });

  it("merges into a Windows file without changing its line endings", () => {
    const state = note("a\r\nb\r\nc");
    const merged = state.update(fileChange(state, "a\r\nB\r\nc")).state;
    expect(merged.sliceDoc()).toBe("a\r\nB\r\nc");
  });
});

describe("formatting commands", () => {
  const run = (doc: string, from: number, to: number, command: typeof insertLink) => {
    let state = EditorState.create({ doc, selection: EditorSelection.range(from, to) });
    command({ state, dispatch: (transaction) => (state = transaction.state) });
    return {
      doc: state.sliceDoc(),
      selected: state.sliceDoc(state.selection.main.from, state.selection.main.to),
      head: state.selection.main.head,
    };
  };

  it("wraps a selection and unwraps it again", () => {
    const bold = run("a word here", 2, 6, toggleWrap("**"));
    expect(bold).toMatchObject({ doc: "a **word** here", selected: "word" });
    expect(run(bold.doc, 4, 8, toggleWrap("**")).doc).toBe("a word here");
    expect(run("a **word** here", 2, 10, toggleWrap("**")).doc).toBe("a word here");
  });

  it("puts the cursor between the markers when nothing is selected", () => {
    expect(run("ab", 1, 1, toggleWrap("**"))).toMatchObject({ doc: "a****b", head: 3 });
  });

  it("makes a link from text or from an address", () => {
    expect(run("see this", 4, 8, insertLink)).toMatchObject({ doc: "see [this]()", head: 11 });
    expect(run("https://x.org", 0, 13, insertLink)).toMatchObject({
      doc: "[](https://x.org)",
      head: 1,
    });
  });
});

describe("diagrams in notes", () => {
  const doc = "Intro\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter";
  const drawn = (state: EditorState, focused = false) =>
    preview(state, focused).filter((item) => item.widget === "DiagramWidget");

  it("draws a closed mermaid block in place while the cursor is away", () => {
    const state = note(doc, { cursor: 0 });
    expect(drawn(state, true)).toEqual([
      {
        from: doc.indexOf("```"),
        to: doc.lastIndexOf("```") + 3,
        kind: "block",
        widget: "DiagramWidget",
      },
    ]);
    // Unfocused, the note shows no source at all.
    expect(drawn(state)).toHaveLength(1);
  });

  it("shows the source with the drawing beneath it while the block is edited", () => {
    const state = note(doc, { cursor: doc.indexOf("A -->") });
    const seen = drawn(state, true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.from).toBe(seen[0]!.to);
    expect(seen[0]!.from).toBe(doc.lastIndexOf("```") + 3);
  });

  it("never draws a block still being written, another language, or in source mode", () => {
    for (const unfinished of [
      "```mermaid\nflowchart LR\n  A --> B",
      "````mermaid\nflowchart LR\n  A --> B\n```",
      "```js\nconst a = 1;\n```",
      "```\nflowchart LR\n  A --> B\n```",
    ])
      expect(drawn(note(unfinished, { cursor: 0 }), true), unfinished).toEqual([]);
    expect(drawn(note(doc, { cursor: 0, live: false }), true)).toEqual([]);
  });

  it("draws a block inside a quote beneath it, without the quote markers", () => {
    const quoted = "> ```mermaid\n> flowchart LR\n>   A --> B\n> ```\n\nAfter";
    const state = note(quoted, { cursor: quoted.length });
    const seen = preview(state, true).find((item) => item.widget === "DiagramWidget");
    expect(seen).toMatchObject({ kind: "block" });
    const widget = buildPreview(state.update({ effects: setFocus.of(true) }).state);
    let source = "";
    widget.between(0, quoted.length, (_from, _to, value) => {
      const spec = value.spec as { widget?: { source?: string } };
      if (spec.widget?.source) source = spec.widget.source;
    });
    expect(source).toBe("flowchart LR\n  A --> B");
  });
});
