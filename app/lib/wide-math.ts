/**
 * Inline formulas wider than the line they sit in, such as a set-builder with rows of words, get
 * `math-wide`: they scroll inside themselves (app.css) instead of pushing the page sideways. The
 * reading view and the note editor both call this after drawing, and again when their width
 * changes.
 */
export function markWideMath(root: HTMLElement): void {
  measureWideMath(root)();
}

/** Measures now and returns what marks them, for CodeMirror's separate read and write phases. */
export function measureWideMath(root: HTMLElement): () => void {
  const formulas = [...root.querySelectorAll<HTMLElement>('.math[data-mode="inline"]')];
  // Read every width first, then write, so the page lays out once.
  const wide = formulas.map((math) => {
    const line = math.parentElement?.closest<HTMLElement>(
      "p, li, td, th, blockquote, .cm-line, .cm-rendered-block, div",
    );
    const room = (line ?? root).clientWidth;
    const width = math.classList.contains("math-wide")
      ? math.scrollWidth
      : math.getBoundingClientRect().width;
    return room > 0 && width > room + 1;
  });
  return () => formulas.forEach((math, index) => math.classList.toggle("math-wide", wide[index]!));
}
