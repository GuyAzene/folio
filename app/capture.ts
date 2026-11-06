import "./fonts.ts";
import { forceParsing } from "@codemirror/language";
import { mount, unmount } from "svelte";
import type {
  CapturePayload,
  NoteFinding,
  NoteInspection,
  NoteLayout,
} from "../src/library/note-render.ts";
import { citationLabel } from "../src/library/note-meta.ts";
import NoteReading from "./components/NoteReading.svelte";
import { demoPlaceholders } from "./lib/demo-placeholder.ts";
import { createNoteEditor, type NoteEditor } from "./lib/editor/note-editor.ts";
import { shortTitle } from "./lib/titles.ts";

/**
 * The hidden page that draws one note for the tutor to look at, with the very code the app draws
 * it with: the reading view, or the editor's live preview, read-only and unfocused so no source
 * shows. The main process (src/desktop/note-capture.ts) drives it through `folioCapture`; it has
 * no bridge to the app, no storage of its own and never draws the app around the note.
 */

const root = document.getElementById("capture")!;
let editor: NoteEditor | undefined;
let reading: ReturnType<typeof mount> | undefined;
let article: HTMLElement | undefined;
/** How many lines the note has. */
let lineCount = 0;

const FONTS = [
  '17px "Newsreader Variable"',
  'italic 17px "Newsreader Variable"',
  '17px "Frank Ruhl Libre Variable"',
  '14px "Inter Variable"',
  '14px "Noto Sans Hebrew Variable"',
  '14px "Geist Mono Variable"',
];

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

async function render(payload: CapturePayload): Promise<NoteLayout> {
  clear();
  lineCount = payload.content.split("\n").length;
  document.documentElement.dataset.theme = "light";
  // Fonts first: diagrams measure their labels in them, and late fonts change every height.
  await Promise.race([
    Promise.all(FONTS.map((font) => document.fonts.load(font, "Aא"))),
    wait(3000),
  ]).catch(() => undefined);
  const titles = new Map(payload.documents.map((document) => [document.id, document.title]));
  const linkLabel = (target: string, shown: string) =>
    citationLabel(target, shown, (id) => {
      const title = titles.get(id);
      return title ? shortTitle(title, payload.courseName) : null;
    });
  if (payload.view === "read") {
    reading = mount(NoteReading, {
      target: root,
      props: {
        content: payload.content,
        linkLabel,
        courseId: payload.courseId,
        demos: demoPlaceholders,
        sourceLines: true,
      },
    });
    await frame();
    article = root.querySelector("article") ?? undefined;
  } else {
    editor = createNoteEditor(root, {
      doc: payload.content,
      live: true,
      readOnly: true,
      inFlow: true,
      courseId: payload.courseId ?? undefined,
      demos: demoPlaceholders,
      links: { targets: () => [], open: () => {}, label: linkLabel },
      onChange: () => {},
    });
    // Parse the whole note now, so every line is decorated as it will be.
    forceParsing(editor.view, editor.view.state.doc.length, 3000);
  }
  return settle();
}

/** Waits for the note to stop changing: images decoded, fonts loaded, nothing moving. */
async function settle(): Promise<NoteLayout> {
  editor?.view.requestMeasure();
  await frame();
  await Promise.race([
    Promise.all([...root.querySelectorAll("img")].map((image) => image.decode().catch(() => {}))),
    wait(3000),
  ]);
  await Promise.race([document.fonts.ready, wait(3000)]);
  await quiet(150, 2000);
  await frame();
  await frame();
  return layout();
}

/** Resolves once nothing in the page has changed for `ms`, or after `max`. */
function quiet(ms: number, max: number): Promise<void> {
  return new Promise((done) => {
    let timer = setTimeout(finish, ms);
    const cap = setTimeout(finish, max);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(finish, ms);
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    function finish() {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      done();
    }
  });
}

function layout(): NoteLayout {
  const height = Math.ceil(document.documentElement.scrollHeight);
  if (!editor) return { height, complete: true };
  const { viewport, state } = editor.view;
  return { height, complete: viewport.from === 0 && viewport.to === state.doc.length };
}

function clear(): void {
  editor?.destroy();
  editor = undefined;
  if (reading) void unmount(reading);
  reading = undefined;
  article = undefined;
  root.replaceChildren();
}

// ── What the tutor is told ─────────────────────────────────────────────────

const top = (element: Element) => element.getBoundingClientRect().top + window.scrollY;
const bottom = (element: Element) => element.getBoundingClientRect().bottom + window.scrollY;
const snippet = (text: string | null | undefined) =>
  (text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);

/** The note's line (1-based) that drew this element. */
function lineOf(element: Element): number {
  if (editor) {
    try {
      return editor.view.state.doc.lineAt(editor.view.posAtDOM(element)).number;
    } catch {
      return 0;
    }
  }
  const block = element.closest<HTMLElement>("[data-line]");
  if (block) return Number(block.dataset.line);
  // Diagrams and drawings carry no line of their own: the block before them says where they are.
  let previous: Element | null = element.closest("article > *");
  while (previous && !(previous as HTMLElement).dataset?.line)
    previous = previous.previousElementSibling;
  return previous ? Number((previous as HTMLElement).dataset.line) : 0;
}

/** The note's blocks from the top, where a picture may be cut between them. */
function blocks(): { top: number; bottom: number; line: number }[] {
  const children = editor ? [...editor.view.contentDOM.children] : [...(article?.children ?? [])];
  return children
    .filter((child) => child.getBoundingClientRect().height > 0)
    .map((child) => ({ top: top(child), bottom: bottom(child), line: lineOf(child) }));
}

function headings(): { top: number; text: string; line: number }[] {
  const shown = editor
    ? [...editor.view.contentDOM.querySelectorAll(".cm-heading")]
    : [...(article?.querySelectorAll("h1, h2, h3, h4, h5, h6") ?? [])];
  return shown.map((heading) => ({
    top: top(heading),
    text: snippet(heading.textContent),
    line: lineOf(heading),
  }));
}

/** Text of an element, or the TeX of a formula. */
function described(element: Element): string {
  const math = element.closest<HTMLElement>(".math");
  if (math?.dataset.tex) return snippet(math.dataset.tex);
  if (element instanceof HTMLImageElement) return snippet(element.alt || element.src);
  return snippet(element.textContent);
}

/** What scrolls sideways on its own when it is too wide. */
const SCROLLERS =
  '.math[data-mode="display"], .math-wide, .table-scroll, pre, .cm-math-block, .cm-rendered-block';

function inspect(): NoteInspection {
  const findings: NoteFinding[] = [];
  const add = (kind: NoteFinding["kind"], element: Element, text: string) => {
    if (findings.length < 30) findings.push({ kind, line: lineOf(element), text });
  };
  const scope = editor ? editor.view.contentDOM : (article ?? root);
  const column = scope.getBoundingClientRect();
  const style = getComputedStyle(scope);
  const right = column.right - parseFloat(style.paddingRight) + 2;

  for (const error of scope.querySelectorAll(".katex-error"))
    add(
      "math-error",
      error,
      `${snippet(error.getAttribute("title"))}: ${snippet(error.textContent)}`,
    );
  if (document.documentElement.scrollWidth > window.innerWidth + 1)
    findings.push({
      kind: "too-wide",
      line: 0,
      text: `the page is ${document.documentElement.scrollWidth}px wide for a ${window.innerWidth}px view, so it scrolls sideways`,
    });
  const wide = new Set<Element>();
  for (const element of scope.querySelectorAll(
    ".math, img, table, pre, [style], .cm-rendered-inline, .cm-rendered-block > *",
  )) {
    // Inside a formula, or inside something that scrolls on its own (found below), it isn't
    // wider than the column: it is hidden in what scrolls.
    if (element.parentElement?.closest(".katex, " + SCROLLERS)) continue;
    if ([...wide].some((outer) => outer.contains(element))) continue;
    if (element.getBoundingClientRect().right > right) {
      wide.add(element);
      add("too-wide", element, described(element));
    }
  }
  for (const element of scope.querySelectorAll(SCROLLERS))
    if (element.scrollWidth > element.clientWidth + 1) add("scrolls", element, described(element));
  for (const tag of scope.querySelectorAll(".cm-html-tag"))
    add("html-as-text", tag, snippet(tag.textContent));
  for (const line of scope.querySelectorAll(".cm-html-source"))
    add("html-as-text", line, snippet(line.textContent));
  // CodeMirror sets empty images beside its widgets, to place the cursor; they show nothing.
  for (const image of scope.querySelectorAll<HTMLImageElement>("img:not(.cm-widgetBuffer)"))
    if (image.complete && image.naturalWidth === 0) add("image-missing", image, described(image));
  for (const missing of scope.querySelectorAll(".cm-image-missing"))
    add("image-missing", missing, snippet(missing.textContent));
  for (const source of scope.querySelectorAll(".cm-math-source"))
    add("raw-tex", source, snippet(source.textContent));
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest(".math, code, pre, .katex, .cm-math-source")) continue;
    if (/\\[A-Za-z]{2,}/.test(node.textContent ?? ""))
      add("raw-tex", parent, snippet(node.textContent));
  }
  for (const math of scope.querySelectorAll(
    'span.math[data-mode="display"], .cm-math[data-mode="display"]:not(.cm-math-block)',
  ))
    add("display-in-sentence", math, described(math));
  for (const diagram of scope.querySelectorAll(".diagram.is-broken"))
    add("diagram-error", diagram, snippet(diagram.querySelector(".diagram-note")?.textContent));
  for (const demo of scope.querySelectorAll(".demo-placeholder"))
    add("demo", demo, snippet(demo.textContent));
  for (const [element, theme] of lowContrast(scope))
    add("low-contrast", element, `${theme} mode: ${described(element)}`);
  if (editor && !layout().complete)
    findings.push({ kind: "incomplete", line: 0, text: "the note is too long to draw in full" });

  return {
    width: window.innerWidth,
    height: Math.ceil(document.documentElement.scrollHeight),
    blocks: blocks(),
    headings: headings(),
    findings,
    lines: lineCount,
  };
}

/** Colored blocks whose text is hard to read, in light or dark mode. */
function lowContrast(scope: HTMLElement): [Element, "light" | "dark"][] {
  const colored = [...scope.querySelectorAll<HTMLElement>("[style]")].filter((element) =>
    /background/i.test(element.getAttribute("style") ?? ""),
  );
  const found: [Element, "light" | "dark"][] = [];
  const html = document.documentElement;
  for (const theme of ["light", "dark"] as const) {
    html.dataset.theme = theme;
    for (const element of colored) {
      const text = rgb(getComputedStyle(element).color);
      const back = rgb(getComputedStyle(element).backgroundColor);
      if (text && back && contrast(text, back) < 3 && !found.some(([seen]) => seen === element))
        found.push([element, theme]);
    }
  }
  html.dataset.theme = "light";
  return found;
}

function rgb(value: string): [number, number, number] | null {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(value);
  if (!match || match[4] === "0") return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const luminance = (color: [number, number, number]) => {
    const [r, g, bl] = color.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Where lines `from` to `to` (1-based) are drawn, from the top of the page, or null. */
function locate(from: number, to: number): { top: number; bottom: number } | null {
  if (editor) {
    const { doc } = editor.view.state;
    if (from < 1 || to > doc.lines || from > to) return null;
    const first = editor.view.lineBlockAt(doc.line(from).from);
    const last = editor.view.lineBlockAt(doc.line(to).to);
    const offset = editor.view.documentTop + window.scrollY;
    return { top: first.top + offset, bottom: last.bottom + offset };
  }
  const shown = blocks();
  const inside = shown.filter((block, index) => {
    const next = shown[index + 1]?.line ?? Infinity;
    return block.line <= to && next > from;
  });
  if (!inside.length) return null;
  return {
    top: Math.min(...inside.map((block) => block.top)),
    bottom: Math.max(...inside.map((block) => block.bottom)),
  };
}

declare global {
  interface Window {
    folioCapture: {
      render(payload: CapturePayload): Promise<NoteLayout>;
      settle(): Promise<NoteLayout>;
      inspect(): NoteInspection;
      locate(from: number, to: number): { top: number; bottom: number } | null;
    };
  }
}

window.folioCapture = { render, settle, inspect, locate };
