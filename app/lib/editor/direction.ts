import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  Direction as BidiDirection,
  EditorView,
  ViewPlugin,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import {
  estimateDirection,
  hasRtl,
  numberRuns,
  writtenDirection,
  type Direction,
} from "../direction.ts";

/**
 * Text direction in the note editor, line by line as the student writes: each line takes the
 * direction of its first letter (formulas, code and links aside) and keeps it whatever follows,
 * so it never flips while it is typed. A line without words of its own (a formula,
 * a rule, numbers) keeps the direction of the line before it, and the empty line the cursor is
 * on follows the keyboard: with a Hebrew layout the cursor starts on the right. Code, formulas,
 * URLs, HTML tags and arithmetic stay left-to-right islands inside Hebrew lines.
 */

/** Blocks that are always left to right and do not change the direction after them. */
const LEFT_TO_RIGHT = new Set(["FencedCode", "CodeBlock", "BlockMath", "CommentBlock"]);

/** Syntax that is not prose: it neither counts toward direction nor reorders with it. */
const NOT_PROSE = new Set([
  "InlineMath",
  "InlineCode",
  "URL",
  "Autolink",
  "HTMLTag",
  "Comment",
  "Image",
  "LinkTitle",
  "LinkLabel",
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "TaskMarker",
  "EmphasisMark",
  "StrikethroughMark",
  "LinkMark",
  "TableDelimiter",
  "Escape",
  "Entity",
]);

/** Syntax kept left to right inside a right-to-left line. */
const ISOLATED = new Set(["InlineMath", "InlineCode", "URL", "Autolink", "HTMLTag"]);

/** A stretch of text that keeps its own direction inside a line of the other direction. */
export interface Island {
  from: number;
  to: number;
  direction: Direction;
}

export interface Directions {
  /** The direction of every line, indexed by line number − 1. */
  lines: Direction[];
  /** Lines with nothing but list, quote or heading markers: they follow the keyboard. */
  empty: boolean[];
  /** Left-to-right islands in right-to-left lines, outer ones first. */
  islands: Island[];
}

const NUMBER_RUN = numberRuns();
const MARKERS_ONLY = /^\s*(?:>\s*)*(?:#{1,6}|[-*+]|\d+[.)])?\s*(?:\[[ xX]\])?\s*$/;

export function noteDirections(state: EditorState): Directions {
  const { doc } = state;
  const fixed = new Set<number>();
  const tables: { first: number; last: number }[] = [];
  // Ranges that are not prose, and those of them kept left to right, in document order.
  const blanks: [number, number][] = [];
  const isolated: [number, number][] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      const first = doc.lineAt(ref.from).number;
      const last = doc.lineAt(ref.to).number;
      if (LEFT_TO_RIGHT.has(ref.name)) {
        for (let n = first; n <= last; n++) fixed.add(n);
        return false;
      }
      if (ref.name === "Table") tables.push({ first, last });
      // An HTML block's tags are not Markdown nodes; each reads left to right, so "<summary>"
      // never shows as ">summary<", and only the text between them is prose.
      if (ref.name === "HTMLBlock") {
        for (const tag of doc.sliceString(ref.from, ref.to).matchAll(/<[^>]*>/g)) {
          const from = ref.from + tag.index;
          blanks.push([from, from + tag[0].length]);
          isolated.push([from, from + tag[0].length]);
        }
        return false;
      }
      if (!NOT_PROSE.has(ref.name)) return;
      blanks.push([ref.from, ref.to]);
      if (ISOLATED.has(ref.name) && !isInsideLink(ref.node)) isolated.push([ref.from, ref.to]);
      return false;
    },
  });

  // Each line's prose, the same length as its source, with everything that is not prose blanked.
  const prose: string[] = [];
  const own: (Direction | null)[] = [];
  const empty: boolean[] = [];
  let next = 0;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    while (next < blanks.length && blanks[next]![1] <= line.from) next++;
    let text = line.text;
    for (let i = next; i < blanks.length && blanks[i]![0] < line.to; i++) {
      const from = Math.max(blanks[i]![0], line.from) - line.from;
      const to = Math.min(blanks[i]![1], line.to) - line.from;
      if (to > from) text = text.slice(0, from) + " ".repeat(to - from) + text.slice(to);
    }
    prose.push(text);
    own.push(fixed.has(n) ? null : writtenDirection(estimateDirection(text)));
    empty.push(!fixed.has(n) && MARKERS_ONLY.test(line.text));
  }
  // A table's rows share one direction, so its columns line up.
  const table = new Map<number, Direction | null>();
  for (const { first, last } of tables) {
    const direction = writtenDirection(estimateDirection(prose.slice(first - 1, last).join(" ")));
    for (let n = first; n <= last; n++) table.set(n, direction);
  }

  // Lines before the first one with words take that line's direction.
  let current: Direction = own.find((direction) => direction) ?? "ltr";
  const lines: Direction[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    if (fixed.has(n)) {
      lines.push("ltr");
      continue;
    }
    const direction = (table.has(n) ? table.get(n) : own[n - 1]) ?? current;
    current = direction;
    lines.push(direction);
  }

  const islands: Island[] = [];
  let island = 0;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    while (island < isolated.length && isolated[island]![0] < line.from) island++;
    if (lines[n - 1] !== "rtl") continue;
    for (let i = island; i < isolated.length && isolated[i]![0] <= line.to; i++)
      islands.push({ from: isolated[i]![0], to: isolated[i]![1], direction: "ltr" });
    for (const run of prose[n - 1]!.matchAll(NUMBER_RUN))
      islands.push({
        from: line.from + run.index,
        to: line.from + run.index + run[0].length,
        direction: "ltr",
      });
  }
  islands.sort((a, b) => a.from - b.from || b.to - a.to);
  return { lines, empty, islands };
}

/** A link's own URL is hidden in the live preview; only bare addresses need isolating. */
function isInsideLink(node: SyntaxNode): boolean {
  return node.name === "URL" && (node.parent?.name === "Link" || node.parent?.name === "Image");
}

/** The keyboard layout's direction, when the browser can tell (Chromium's Keyboard API). */
export const setKeyboardDirection = StateEffect.define<Direction | null>();

const keyboard = StateField.define<Direction | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setKeyboardDirection)) value = effect.value;
    return value;
  },
});

interface DirectionState {
  analysis: Directions;
  /** The empty cursor line, turned to the keyboard's direction. */
  cursor: { line: number; direction: Direction } | null;
  lines: DecorationSet;
  isolates: DecorationSet;
}

const rtlLine = Decoration.line({ attributes: { dir: "rtl" } });
const ltrIsland = Decoration.mark({ attributes: { dir: "ltr" }, bidiIsolate: BidiDirection.LTR });

function cursorLine(state: EditorState, analysis: Directions): DirectionState["cursor"] {
  const typing = state.field(keyboard, false);
  if (!typing) return null;
  const line = state.doc.lineAt(state.selection.main.head).number;
  return analysis.empty[line - 1] ? { line, direction: typing } : null;
}

function decorate(
  state: EditorState,
  analysis: Directions,
  isolates?: DecorationSet,
): DirectionState {
  const cursor = cursorLine(state, analysis);
  const ranges: Range<Decoration>[] = [];
  analysis.lines.forEach((direction, index) => {
    const own = cursor?.line === index + 1 ? cursor.direction : direction;
    if (own === "rtl") ranges.push(rtlLine.range(state.doc.line(index + 1).from));
  });
  return {
    analysis,
    cursor,
    lines: Decoration.set(ranges),
    isolates:
      isolates ??
      Decoration.set(
        analysis.islands
          .filter(({ from, to }) => to > from)
          .map(({ from, to }) => ltrIsland.range(from, to)),
        true,
      ),
  };
}

/** Line directions and left-to-right islands; exported for tests. */
export const directionState = StateField.define<DirectionState>({
  create: (state) => decorate(state, noteDirections(state)),
  update(value, transaction) {
    const { state } = transaction;
    if (transaction.docChanged || syntaxTree(state) !== syntaxTree(transaction.startState))
      return decorate(state, noteDirections(state));
    const cursor = cursorLine(state, value.analysis);
    if (cursor?.line === value.cursor?.line && cursor?.direction === value.cursor?.direction)
      return value;
    return decorate(state, value.analysis, value.isolates);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.lines),
    EditorView.decorations.from(field, (value) => value.isolates),
    EditorView.bidiIsolatedRanges.from(field, (value) => value.isolates),
  ],
});

type KeyboardApi = { getLayoutMap?: () => Promise<Map<string, string>> };

/**
 * Watches the keyboard layout: on focus, clicks and key presses it asks the browser which
 * letters the home-row keys type, which tells a Hebrew layout from an English one.
 */
const keyboardLayout = ViewPlugin.fromClass(
  class {
    private asking = false;
    readonly view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      if (view.hasFocus) this.check();
    }
    check(): void {
      const api = (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard;
      if (this.asking || !api?.getLayoutMap) return;
      this.asking = true;
      api.getLayoutMap().then(
        (map) => {
          this.asking = false;
          const letters = ["KeyA", "KeyS", "KeyD", "KeyF", "KeyJ", "KeyK", "KeyL"]
            .map((code) => map.get(code) ?? "")
            .join("");
          const direction = hasRtl(letters) ? "rtl" : /\p{L}/u.test(letters) ? "ltr" : null;
          if (direction !== this.view.state.field(keyboard, false))
            this.view.dispatch({ effects: setKeyboardDirection.of(direction) });
        },
        () => (this.asking = false),
      );
    }
  },
  {
    eventHandlers: {
      focus() {
        this.check();
      },
      keydown() {
        this.check();
      },
      mousedown() {
        this.check();
      },
    },
  },
);

export function noteDirection(): Extension {
  return [EditorView.perLineTextDirection.of(true), keyboard, directionState, keyboardLayout];
}
