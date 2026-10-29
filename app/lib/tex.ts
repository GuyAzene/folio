import katex from "katex";

/** A reply re-renders on every streamed token; its finished formulas do not change. */
const rendered = new Map<string, string>();
const CACHE_LIMIT = 2000;

/**
 * TeX to HTML with hidden MathML for screen readers, locked down for untrusted model output:
 * no links or HTML commands, bounded size and macro expansion, and invalid TeX shown as its
 * source in red instead of an exception. Every call gets fresh macros, so one message cannot
 * define commands for another.
 */
export function renderTex(tex: string, display: boolean): string {
  const key = `${display ? "D" : "I"}${tex}`;
  const hit = rendered.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: false,
      trust: false,
      // Hebrew inside \text{} would otherwise warn once per letter: KaTeX's fonts have no Hebrew.
      strict: "ignore",
      maxSize: 20,
      maxExpand: 1000,
      macros: {},
    });
  } catch {
    html = `<span class="katex-error">${escapeHtml(tex)}</span>`;
  }
  if (rendered.size >= CACHE_LIMIT) rendered.delete(rendered.keys().next().value!);
  rendered.set(key, html);
  return html;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
