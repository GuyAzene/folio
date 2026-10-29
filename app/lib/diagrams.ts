import DOMPurify from "dompurify";
import { PeleError, render } from "pele";
import { escapeHtml } from "./tex.ts";

/**
 * Mermaid diagrams, drawn by Pele. Pele cannot run code: it escapes diagram text and emits only
 * shapes and text. Folio still fixes every option, turns off links and images, and sanitizes the
 * SVG once more before it joins the page, the same trust KaTeX gets for math. Colors come from
 * CSS variables (see app.css), so a theme switch needs no redraw.
 */

/** Part of every cache key and saved export, so a new Pele version redraws. */
export const RENDERER = "pele@1.12.0";
const FONT = '"Inter Variable", "Noto Sans Hebrew Variable", ui-sans-serif, system-ui, sans-serif';
/** A diagram's source may be this long; Pele's own output limit applies too. */
const MAX_SOURCE = 20_000;
const CACHE_SIZE = 300;

export type Drawn =
  | { ok: true; svg: string; width: number; height: number }
  | { ok: false; message: string };

const cache = new Map<string, Drawn>();
let ids = 0;

/** Draws one diagram, or says in plain words why it can't. Never throws. */
export function drawDiagram(source: string): Drawn {
  const key = `${RENDERER}\n${source}`;
  const hit = cache.get(key);
  if (hit) {
    // Least recently used goes first.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const drawn = draw(source);
  cache.set(key, drawn);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return drawn;
}

/** A drawing's height if it was drawn already; never draws, so it is cheap to ask for many. */
export function drawnHeight(source: string): number | undefined {
  const hit = cache.get(`${RENDERER}\n${source}`);
  return hit?.ok ? hit.height : undefined;
}

/** Forgets every drawing, as when the page's fonts finish loading and text measures differently. */
export function forgetDiagrams(): void {
  cache.clear();
}

function draw(source: string): Drawn {
  if (source.length > MAX_SOURCE)
    return { ok: false, message: "This diagram is too long to draw, so it is shown as text." };
  try {
    const result = render(source, {
      fontFamily: FONT,
      fontSize: 14,
      idPrefix: `d${++ids}-`,
      links: false,
      images: false,
    });
    const svg = clean(result.svg);
    if (!svg)
      return { ok: false, message: "This diagram couldn't be drawn, so it is shown as text." };
    return { ok: true, svg, width: result.width, height: result.height };
  } catch (error) {
    if (error instanceof PeleError && error.code === "unsupported-diagram")
      return {
        ok: false,
        message: "Folio can't draw this kind of diagram yet, so it is shown as text.",
      };
    if (error instanceof PeleError && error.code === "limit")
      return { ok: false, message: "This diagram is too large to draw, so it is shown as text." };
    if (error instanceof PeleError && error.line)
      return {
        ok: false,
        message: `This diagram has a mistake on line ${error.line}, so it is shown as text.`,
      };
    return { ok: false, message: "This diagram couldn't be drawn, so it is shown as text." };
  }
}

/** An SVG-only pass: no scripts, no foreign HTML, and no style that reaches outside the drawing. */
function clean(svg: string): string | null {
  const out = DOMPurify.isSupported
    ? DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true },
        FORBID_TAGS: ["foreignObject", "a", "image", "use", "script", "style"],
      })
    : svg;
  if (!out.startsWith("<svg") || /url\(\s*['"]?(?!#)/i.test(out)) return null;
  return out;
}

/** What a reply or note shows for a closed ```mermaid fence, filled in after sanitizing. */
export function diagramHtml(source: string): string {
  const drawn = drawDiagram(source);
  const encoded = encodeURIComponent(source);
  if (!drawn.ok)
    return `<div class="diagram is-broken" dir="ltr" data-source="${encoded}"><pre dir="ltr"><code class="language-mermaid">${escapeHtml(source)}\n</code></pre><p class="diagram-note">${escapeHtml(drawn.message)}</p></div>`;
  return `<div class="diagram" dir="ltr" data-source="${encoded}"><div class="diagram-drawing" role="img" aria-label="Diagram">${drawn.svg}</div><div class="diagram-tools"><button type="button" data-diagram="copy">Copy</button><button type="button" data-diagram="save">Save SVG</button><button type="button" data-diagram="enlarge">Enlarge</button></div></div>`;
}
