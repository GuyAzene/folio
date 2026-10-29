import { EditorView, WidgetType } from "@codemirror/view";
import { mountDemos } from "../demo-slots.ts";
import { diagramHtml, drawnHeight } from "../diagrams.ts";
import { estimateDirection } from "../direction.ts";
import { renderMarkdown } from "../markdown.ts";
import { renderTex } from "../tex.ts";

/**
 * What the live preview draws in place of Markdown source. Every widget is rebuilt only when
 * its content changes (`eq`), and a click on most of them puts the cursor into the source.
 */

/** A KaTeX formula, inline or on its own line. */
export class MathWidget extends WidgetType {
  readonly tex: string;
  readonly display: boolean;
  readonly block: boolean;
  constructor(tex: string, display: boolean, block = false) {
    super();
    this.tex = tex;
    this.display = display;
    this.block = block;
  }
  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display && other.block === this.block;
  }
  toDOM(): HTMLElement {
    const element = document.createElement(this.block ? "div" : "span");
    element.className = this.block ? "cm-math-block math" : "cm-math math";
    element.dir = "ltr";
    element.dataset.mode = this.display ? "display" : "inline";
    element.innerHTML = renderTex(this.tex, this.display);
    return element;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Part of the note drawn as HTML: a table, an HTML block, or inline tags. It is rendered and
 * sanitized only when it comes into view; markup that sanitizes to nothing shows as source.
 */
export class HtmlWidget extends WidgetType {
  readonly source: string;
  readonly block: boolean;
  constructor(source: string, block: boolean) {
    super();
    this.source = source;
    this.block = block;
  }
  eq(other: HtmlWidget): boolean {
    return other.source === this.source && other.block === this.block;
  }
  toDOM(): HTMLElement {
    const element = document.createElement(this.block ? "div" : "span");
    const html = this.block
      ? renderMarkdown(this.source, { note: true })
      : renderMarkdown(this.source, { note: true })
          .trim()
          .replace(/^<p[^>]*>([\s\S]*)<\/p>$/, "$1");
    if (!html.trim()) {
      element.className = "cm-html-tag";
      element.textContent = this.source;
      return element;
    }
    element.className = this.block
      ? "cm-rendered-block prose-folio prose-reading"
      : "cm-rendered-inline";
    element.innerHTML = html;
    // A block takes the direction the renderer gave it (a table, say) or that of its words
    // (raw HTML such as <details>), so a Hebrew block sits on the right.
    if (this.block)
      element.dir =
        element.firstElementChild?.getAttribute("dir") ??
        estimateDirection(element.textContent ?? "").direction ??
        "auto";
    return element;
  }
  // Links inside rendered HTML open; anything else puts the cursor into the source.
  ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && !!event.target.closest("a[href]");
  }
}

/**
 * A ```mermaid block drawn by Pele: in place of the block when the cursor is away, or beneath its
 * source while it is edited. A source with a mistake says on which line, under the source.
 */
export class DiagramWidget extends WidgetType {
  readonly source: string;
  constructor(source: string) {
    super();
    this.source = source;
  }
  eq(other: DiagramWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const element = document.createElement("div");
    element.className = "cm-diagram";
    element.dir = "ltr";
    element.innerHTML = diagramHtml(this.source);
    return element;
  }
  /**
   * A drawing's height once it was drawn, so scrolling back past it does not jump. Diagrams not
   * yet drawn get a typical height: drawing a long note's every diagram to measure it would stall.
   */
  get estimatedHeight(): number {
    return (drawnHeight(this.source) ?? 220) + 34;
  }
  // The diagram's buttons work; a click anywhere else puts the cursor into the source.
  ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && !!event.target.closest("button");
  }
}

/**
 * A ```demo block, run in its sealed frame. With the cursor away it runs in place of the block;
 * while the block is edited it waits under the source for the student to press Run, so code
 * that is half written never runs.
 */
export class DemoWidget extends WidgetType {
  readonly source: string;
  readonly armed: boolean;
  #stop?: () => void;
  constructor(source: string, armed: boolean) {
    super();
    this.source = source;
    this.armed = armed;
  }
  eq(other: DemoWidget): boolean {
    return other.source === this.source && other.armed === this.armed;
  }
  toDOM(): HTMLElement {
    const element = document.createElement("div");
    element.className = "cm-demo";
    element.dir = "ltr";
    const slot = document.createElement("div");
    slot.className = "demo-slot";
    slot.dataset.source = encodeURIComponent(this.source);
    const run = () => (this.#stop = mountDemos(element));
    if (this.armed) {
      element.append(slot);
      queueMicrotask(run);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-demo-run";
      button.textContent = "Run demo";
      button.onclick = () => {
        button.replaceWith(slot);
        run();
      };
      element.append(button);
    }
    return element;
  }
  destroy(): void {
    this.#stop?.();
  }
  get estimatedHeight(): number {
    return this.armed ? 200 : 40;
  }
  // The demo's own controls and the Run button work; elsewhere a click edits the source.
  ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && !!event.target.closest("button, iframe");
  }
}

export class ImageWidget extends WidgetType {
  readonly src: string;
  readonly alt: string;
  constructor(src: string, alt: string) {
    super();
    this.src = src;
    this.alt = alt;
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM(): HTMLElement {
    const image = document.createElement("img");
    image.className = "cm-image";
    image.src = this.src;
    image.alt = this.alt;
    // Only local and data images load; anything else shows its description instead.
    image.onerror = () => {
      const missing = document.createElement("span");
      missing.className = "cm-image-missing";
      missing.textContent = this.alt || "Image";
      image.replaceWith(missing);
    };
    return image;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

export class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const bullet = document.createElement("span");
    bullet.className = "cm-bullet";
    bullet.textContent = "•";
    return bullet;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** A task's box. Clicking it ticks the task in the source: "[ ]" becomes "[x]". */
export class CheckboxWidget extends WidgetType {
  readonly checked: boolean;
  constructor(checked: boolean) {
    super();
    this.checked = checked;
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-box";
    box.checked = this.checked;
    box.tabIndex = -1;
    box.setAttribute("aria-label", this.checked ? "Done" : "Not done");
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const at = view.posAtDOM(box);
      const marker = view.state.sliceDoc(at, at + 3);
      if (!/^\[[ xX]\]$/.test(marker)) return;
      view.dispatch({
        changes: { from: at + 1, to: at + 2, insert: this.checked ? " " : "x" },
        userEvent: "input.toggle",
      });
    });
    return box;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const rule = document.createElement("span");
    rule.className = "cm-rule";
    return rule;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** The language of a code block, shown where its opening fence was. */
export class LabelWidget extends WidgetType {
  readonly text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  eq(other: LabelWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const label = document.createElement("span");
    label.className = "cm-code-label";
    label.textContent = this.text;
    return label;
  }
  ignoreEvent(): boolean {
    return false;
  }
}
