/**
 * The tutor's drawings and demos (`show_visual`), shared by the main process, which checks them,
 * and the renderer, which shows them. A static SVG is shown as an image, which runs nothing; an
 * SVG with scripts or animation, and any HTML, runs only in a sealed frame.
 */

export type VisualKind = "svg" | "html";

/** A visual larger than this is refused. */
export const MAX_VISUAL = 200_000;

/** Libraries a demo may load, as the tags that load them. Nothing else is served to a demo. */
export const VISUAL_LIBRARIES: Record<string, string[]> = {
  katex: [
    '<link rel="stylesheet" href="folio-artifact://lib/katex/katex.min.css">',
    '<script src="folio-artifact://lib/katex/katex.min.js"></script>',
  ],
  pele: ['<script src="folio-artifact://lib/pele/pele.js"></script>'],
};
const LIBRARY_FILES = new Set(
  Object.values(VISUAL_LIBRARIES)
    .flat()
    .map((tag) => /(?:src|href)="([^"]+)"/.exec(tag)![1]!),
);

export function visualKind(source: string): VisualKind {
  return /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s/>]/i.test(source) ? "svg" : "html";
}

/** An SVG with nothing that could run or move: safe to show as a plain image. */
export function staticSvg(source: string): boolean {
  return (
    visualKind(source) === "svg" &&
    !/<script|<foreignObject|<animate|<set[\s>]|\son[a-z]+\s*=|javascript:/i.test(source)
  );
}

/** The visual's `<title>`, as plain text. */
export function visualTitle(source: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1];
  const text = title
    ?.replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 120) : null;
}

/** The libraries a visual loads, by name. */
export function visualLibraries(source: string): string[] {
  return Object.keys(VISUAL_LIBRARIES).filter((name) =>
    VISUAL_LIBRARIES[name]!.some((tag) => source.includes(/(?:src|href)="([^"]+)"/.exec(tag)![1]!)),
  );
}

/**
 * Why a visual can't be shown, in words that tell the tutor how to fix it; null when it can.
 * The frame enforces all of this anyway (no network, no storage, fixed libraries); refusing
 * early lets the tutor correct itself instead of showing the student a broken demo.
 */
export function visualProblem(source: string): string | null {
  if (!source.trim()) return "The visual is empty. Put the SVG or HTML itself in `source`.";
  if (source.length > MAX_VISUAL)
    return `The visual is ${source.length} characters; keep it under ${MAX_VISUAL}. Draw less, or split it.`;
  if (!visualTitle(source))
    return "Give the visual a short <title> describing it, in the student's language.";
  const kind = visualKind(source);
  if (kind === "svg" && !/<\/svg>\s*$/i.test(source))
    return "The SVG is not complete: it must end with </svg>.";
  const reference =
    /(?:\b(?:src|href|xlink:href|action|poster|data)\s*=\s*["']?\s*|url\(\s*["']?|@import\s+(?:url\()?\s*["']?|import\s*\(\s*["']|from\s+["'])((?:https?:)?\/\/[^"')\s]+|folio-artifact:\/\/[^"')\s]+)/gi;
  for (const [, url] of source.matchAll(reference)) {
    if (LIBRARY_FILES.has(url!)) continue;
    return `The visual loads ${url!.slice(0, 80)}, but demos have no network. Draw it yourself, or use a library Folio provides: ${Object.keys(VISUAL_LIBRARIES).join(", ")} (load it with the tags in the tool description).`;
  }
  if (
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\b/.test(
      source,
    )
  )
    return "Demos have no network: remove fetch, XMLHttpRequest, WebSocket and similar calls, and put the data in the code.";
  if (/\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie/.test(source))
    return "Demos cannot store anything: keep their state in variables.";
  if (
    /\b(?:window\.open|alert|confirm|prompt)\s*\(|\btop\.location\b|\bparent\.location\b/.test(
      source,
    )
  )
    return "Demos cannot open windows, show dialogs or navigate; show messages inside the demo instead.";
  return null;
}

/** Folio's colors as a visual sees them, in each theme. */
export const VISUAL_COLORS = {
  light: {
    "--folio-bg": "#ffffff",
    "--folio-surface": "#f7f7f8",
    "--folio-text": "#18181b",
    "--folio-text-2": "#52525b",
    "--folio-muted": "#71717a",
    "--folio-line": "#e4e4e7",
    "--folio-accent": "#2b59c3",
    "--folio-highlight": "#ffe433",
    "--folio-danger": "#d3392b",
    "--folio-success": "#1e8e4e",
  },
  dark: {
    "--folio-bg": "#161618",
    "--folio-surface": "#1e1e21",
    "--folio-text": "#ededef",
    "--folio-text-2": "#a1a1aa",
    "--folio-muted": "#7c7c85",
    "--folio-line": "#2a2a2e",
    "--folio-accent": "#7ab8ff",
    "--folio-highlight": "#ffe433",
    "--folio-danger": "#f0614f",
    "--folio-success": "#3fbf74",
  },
} as const;
export const VISUAL_FONT =
  '--folio-font:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--folio-mono:ui-monospace,"SF Mono",monospace';

/** The color variables of one theme, as CSS declarations. */
export function visualColors(theme: "light" | "dark"): string {
  return Object.entries(VISUAL_COLORS[theme])
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

/**
 * A still SVG as an image source, with Folio's colors for the theme defined inside it: an image
 * cannot see the page's styles, and it runs nothing whatever it holds.
 */
export function svgImage(source: string, theme: "light" | "dark"): string {
  const themed = source.replace(
    /<svg\b[^>]*>/i,
    (open) => `${open}<style>:root{${visualColors(theme)};${VISUAL_FONT}}</style>`,
  );
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themed)}`;
}
