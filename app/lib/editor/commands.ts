import { EditorSelection, type StateCommand } from "@codemirror/state";

/**
 * Formatting shortcuts. Each one edits the Markdown text itself: wrapping a selection in "**"
 * adds the markers, and wrapping text that already has them takes them away.
 */
export function toggleWrap(marker: string): StateCommand {
  const size = marker.length;
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - size, range.from);
      const after = state.sliceDoc(range.to, range.to + size);
      if (before === marker && after === marker)
        return {
          changes: [
            { from: range.from - size, to: range.from },
            { from: range.to, to: range.to + size },
          ],
          range: EditorSelection.range(range.from - size, range.to - size),
        };
      const inner = state.sliceDoc(range.from, range.to);
      if (inner.length >= 2 * size && inner.startsWith(marker) && inner.endsWith(marker))
        return {
          changes: { from: range.from, to: range.to, insert: inner.slice(size, -size) },
          range: EditorSelection.range(range.from, range.to - 2 * size),
        };
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + size, range.to + size),
      };
    });
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input.format" }));
    return true;
  };
}

/** "[selection]()" with the cursor in the parentheses; a selected address becomes the target. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(text)) {
      const insert = `[](${text})`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const insert = `[${text}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length - 1),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input.format" }));
  return true;
};
