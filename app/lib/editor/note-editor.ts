import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from "@codemirror/commands";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap, placeholder } from "@codemirror/view";
import { insertLink, toggleWrap } from "./commands.ts";
import { noteDirection } from "./direction.ts";
import { livePreview, livePreviewExtension } from "./live-preview.ts";
import { noteMarkdown } from "./syntax.ts";
import { noteHighlight, noteTheme } from "./theme.ts";

/**
 * Folio's Markdown note editor: CodeMirror 6 with an Obsidian-style live preview, TeX math,
 * rendered HTML and tables, and per-line Hebrew/English direction. The file's text is edited
 * as it is — line endings included — so a save writes back exactly what was read plus the
 * student's typing, and changes made elsewhere can be merged in by position.
 */

export interface NoteEditorOptions {
  doc: string;
  /** Live preview, or source mode with nothing hidden. */
  live: boolean;
  placeholder?: string;
  /** The student changed the text (not called for `setDoc`). */
  onChange(doc: string): void;
  onBlur?(): void;
  /** ⌘S: save now instead of waiting for the pause in typing. */
  onSave?(): void;
  /** ⌘E: switch to the reading view, as in Obsidian. */
  onRead?(): void;
}

export interface NoteEditor {
  readonly view: EditorView;
  /** Replaces the text with a version saved elsewhere, keeping the cursor where it can. */
  setDoc(doc: string): void;
  setLive(live: boolean): void;
  focus(): void;
  destroy(): void;
}

/** Marks changes that came from the file rather than from the student. */
const fromFile = Annotation.define<boolean>();

/** The file's own line ending: "\r\n" if it uses any, so a Windows file stays one. */
export function lineSeparator(doc: string): string {
  return doc.includes("\r\n") ? "\r\n" : "\n";
}

export function noteExtensions(options: Omit<NoteEditorOptions, "doc">, mode = new Compartment()) {
  const run = (callback?: () => void) => () => {
    callback?.();
    return !!callback;
  };
  return [
    mode.of(livePreview.of(options.live)),
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    indentUnit.of("    "),
    noteMarkdown(),
    syntaxHighlighting(noteHighlight),
    noteDirection(),
    livePreviewExtension(),
    closeBrackets(),
    search({ top: true }),
    highlightSelectionMatches(),
    keymap.of([
      { key: "Mod-b", run: toggleWrap("**") },
      { key: "Mod-i", run: toggleWrap("*") },
      { key: "Mod-Shift-x", run: toggleWrap("~~") },
      { key: "Mod-`", run: toggleWrap("`") },
      { key: "Mod-k", run: insertLink },
      { key: "Mod-s", run: run(options.onSave), preventDefault: true },
      { key: "Mod-e", run: run(options.onRead) },
      { key: "Tab", run: indentMore },
      { key: "Shift-Tab", run: indentLess },
      ...closeBracketsKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    placeholder(options.placeholder ?? ""),
    noteTheme,
    EditorView.contentAttributes.of({
      spellcheck: "true",
      autocorrect: "on",
      autocapitalize: "sentences",
      "aria-label": "Note",
    }),
    EditorView.updateListener.of((update) => {
      if (
        update.docChanged &&
        update.transactions.some((transaction) => !transaction.annotation(fromFile))
      )
        options.onChange(update.state.sliceDoc());
    }),
    EditorView.domEventHandlers({ blur: () => options.onBlur?.() }),
  ] satisfies Extension[];
}

/**
 * The smallest edit that turns the open text into a version saved elsewhere, so the cursor and
 * the student's place stay where they were. Not undoable: it is the file's change, not theirs.
 */
export function fileChange(state: EditorState, doc: string): TransactionSpec {
  // Positions count a line break as one, whatever the file's line ending.
  const current = state.doc.toString();
  const nextText = state.toText(doc);
  const next = nextText.toString();
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  let end = 0;
  while (
    end < current.length - start &&
    end < next.length - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  return {
    changes: {
      from: start,
      to: current.length - end,
      insert: nextText.slice(start, next.length - end),
    },
    annotations: [fromFile.of(true), Transaction.addToHistory.of(false)],
  };
}

export function createNoteEditor(parent: HTMLElement, options: NoteEditorOptions): NoteEditor {
  const mode = new Compartment();
  const extensions = noteExtensions(options, mode);
  const stateFor = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [EditorState.lineSeparator.of(lineSeparator(doc)), extensions],
    });
  const view = new EditorView({ state: stateFor(options.doc), parent });

  return {
    view,
    setDoc(doc) {
      const { state } = view;
      if (state.sliceDoc() === doc) return;
      // A file that switched line endings is a new document; otherwise merge in the difference.
      if (lineSeparator(doc) !== state.lineBreak) {
        view.setState(stateFor(doc));
        return;
      }
      view.dispatch(fileChange(state, doc));
    },
    setLive(live) {
      view.dispatch({ effects: mode.reconfigure(livePreview.of(live)) });
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}
