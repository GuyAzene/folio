import DOMPurify from "dompurify";
import { Marked, Renderer, type Token, type Tokens } from "marked";
import {
  estimateDirection,
  hasRtl,
  numberRuns,
  writtenDirection,
  type Direction,
  type DirectionEstimate,
} from "./direction.ts";
import { BLOCK_MATH, INLINE_MATH, MATH_SPAN } from "./math-syntax.ts";
import { escapeHtml, renderTex } from "./tex.ts";

/**
 * Model output to safe HTML: Markdown with TeX math, every block given a direction Folio decided
 * (Hebrew, English or mixed), and left-to-right islands (code, math, URLs, arithmetic) isolated
 * inside right-to-left text. Math leaves the sanitizer as inert placeholders and is filled in
 * by KaTeX afterwards, so the sanitizing policy never has to allow SVG or MathML.
 */

export interface RenderOptions {
  /** The reply is still arriving: unfinished math stays as source, a short last block waits. */
  streaming?: boolean;
  /** Direction for blocks without words of their own, such as the student's question. */
  base?: Direction;
  /**
   * The student's own note rather than a model's reply, read as the note editor shows it: a
   * line break is a new line with its own direction, a line that starts in Hebrew is right to
   * left, and its HTML may show images (the page's content policy still loads only local and
   * data images, so a note cannot call out).
   */
  note?: boolean;
}

const REPLY_FORBIDS = ["style", "form", "input", "button", "img", "iframe"];
// Notes keep GitHub task boxes (disabled inputs) and images.
const NOTE_FORBIDS = ["style", "form", "button", "iframe"];

// Without a DOM (tests in Node), DOMPurify has no hooks; the app always has one.
if (DOMPurify.isSupported)
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // Links open in the system browser through the main process's window-open handler.
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });

export function renderMarkdown(text: string, options: RenderOptions = {}): string {
  return fillMath(
    DOMPurify.sanitize(markdownToHtml(text, options), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: options.note ? NOTE_FORBIDS : REPLY_FORBIDS,
    }),
  );
}

/** Markdown to unsanitized HTML with math placeholders; exported for tests. */
export function markdownToHtml(text: string, options: RenderOptions = {}): string {
  const { head, pending } = options.streaming
    ? splitPendingMath(text)
    : { head: text, pending: "" };
  const note = !!options.note;
  const tokens = markdown.lexer(head, note ? { ...markdown.defaults, breaks: true } : undefined);
  const message = verdict(estimateDirection(prose(tokens)), note);
  const last = [...tokens].reverse().find((token) => token.type !== "space");
  const tail = new WeakSet<object>();
  if (options.streaming && last) walk(last, (token) => tail.add(token));
  context = {
    current: message ?? options.base ?? "ltr",
    streaming: !!options.streaming,
    note,
    tail,
  };
  const html = markdown.parser(tokens);
  const direction = context.current;
  return pending
    ? `${html}<div class="math-pending" dir="ltr" data-after="${direction}">${escapeHtml(pending)}</div>`
    : html;
}

// ── Math ────────────────────────────────────────────────────────────────────

interface MathToken {
  type: "math" | "displayMath";
  raw: string;
  tex: string;
  display: boolean;
  open: string;
}

/**
 * The TeX rides through the sanitizer percent-encoded: DOMPurify drops any attribute whose value
 * looks like the end of a comment or markup (`-->`, `]>`, `</style`), which formulas such as
 * `E[X]>0` would otherwise trip, losing the formula.
 */
function placeholder(token: MathToken, tag: "span" | "div"): string {
  return `<${tag} class="math" dir="ltr" data-tex="${encodeURIComponent(token.tex)}" data-mode="${token.display ? "display" : "inline"}" data-open="${escapeHtml(token.open)}">${escapeHtml(token.raw)}</${tag}>`;
}

const PLACEHOLDER =
  /<(span|div) class="math" dir="ltr" data-tex="([^"]*)" data-mode="(inline|display)" data-open="([^"]*)">[^<]*<\/\1>/g;

/** Puts KaTeX's output into each placeholder that survived sanitizing, with its TeX readable again. */
export function fillMath(html: string): string {
  return html.replace(
    PLACEHOLDER,
    (match, tag: string, encoded: string, mode: string, open: string) => {
      const tex = decoded(encoded);
      return tex === null
        ? match
        : `<${tag} class="math" dir="ltr" data-tex="${escapeHtml(tex)}" data-mode="${mode}" data-open="${open}">${renderTex(tex, mode === "display")}</${tag}>`;
    },
  );
}

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * While a reply streams, math that has opened but not closed is shown as its source rather
 * than half-parsed ("נתון \[ \frac{a}{" would otherwise lose its backslashes, then jump).
 */
export function splitPendingMath(text: string): { head: string; pending: string } {
  const masked = maskCode(text);
  let at = -1;
  const consider = (index: number) => (at = at === -1 ? index : Math.min(at, index));
  for (const [open, close] of [
    ["\\[", "\\]"],
    ["\\(", "\\)"],
  ] as const) {
    const index = masked.lastIndexOf(open);
    if (index > -1 && masked.indexOf(close, index + 2) === -1) consider(index);
  }
  const dollars = [...masked.matchAll(/\$\$/g)];
  if (dollars.length % 2 === 1) consider(dollars.at(-1)!.index);
  return at === -1
    ? { head: text, pending: "" }
    : { head: text.slice(0, at), pending: text.slice(at) };
}

function maskCode(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm, blank)
    .replace(/(`+)[^`\n]*?\1/g, blank);
}

// ── Direction ───────────────────────────────────────────────────────────────

let context: { current: Direction; streaming: boolean; note: boolean; tail: WeakSet<object> } = {
  current: "ltr",
  streaming: false,
  note: false,
  tail: new WeakSet(),
};

/** Replies go by the share of Hebrew words; notes as the student wrote them. */
function verdict(estimate: DirectionEstimate, note: boolean): Direction | null {
  return note ? writtenDirection(estimate) : estimate.direction;
}

/** A block's own direction; without enough words it keeps the direction around it. */
function decide(tokens: Token[], node: object): Direction {
  const estimate = estimateDirection(prose(tokens));
  // The block still being written waits for a few words before it commits to a direction.
  if (context.streaming && context.tail.has(node) && estimate.words < 3) return context.current;
  return verdict(estimate, context.note) ?? context.current;
}

/** A paragraph's lines, split where it breaks: in a note, each line keeps its own direction. */
function lines(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]];
  for (const token of tokens)
    if (token.type === "br") out.push([]);
    else out.at(-1)!.push(token);
  return out;
}

function within<T>(direction: Direction, run: () => T): T {
  const outer = context.current;
  context.current = direction;
  try {
    return run();
  } finally {
    context.current = outer;
  }
}

/** The prose of some tokens: what direction is decided from. Code, math and URLs are left out. */
function prose(tokens: Token[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "code":
      case "codespan":
      case "math":
      case "displayMath":
      case "html":
      case "image":
      case "space":
      case "hr":
      case "br":
      case "def":
      case "checkbox":
        break;
      case "link":
        if (!bareUrl(token as Tokens.Link)) out += prose((token as Tokens.Link).tokens);
        break;
      case "list":
        for (const item of (token as Tokens.List).items) out += ` ${prose(item.tokens)}`;
        break;
      case "table": {
        const table = token as Tokens.Table;
        for (const cell of [...table.header, ...table.rows.flat()]) out += ` ${prose(cell.tokens)}`;
        break;
      }
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) out += prose(token.tokens);
        else if ("text" in token && typeof token.text === "string") out += token.text;
    }
    out += " ";
  }
  return out;
}

function walk(token: object, visit: (token: object) => void): void {
  visit(token);
  const node = token as {
    tokens?: Token[];
    items?: Tokens.ListItem[];
    header?: Tokens.TableCell[];
    rows?: Tokens.TableCell[][];
  };
  for (const child of node.tokens ?? []) walk(child, visit);
  for (const item of node.items ?? []) walk(item, visit);
  for (const cell of node.header ?? []) walk(cell, visit);
  for (const row of node.rows ?? []) for (const cell of row) walk(cell, visit);
}

function bareUrl(link: Tokens.Link): boolean {
  return link.text === link.href || /^(?:https?:\/\/|mailto:|www\.)/i.test(link.text);
}

// Arithmetic such as "3 + 4 = 7" keeps its reading order inside right-to-left text.
const NUMBER_RUN = numberRuns(String.raw`&lt;|&gt;`);

function isolateNumbers(html: string): string {
  return html.replace(NUMBER_RUN, (run) => `<span dir="ltr">${run}</span>`);
}

// An English parenthetical inside right-to-left text, such as a citation "(Lecture 3, page 4)",
// stays one left-to-right island with its own parentheses, even where the line wraps.
const LATIN_ASIDE = /\(([^()<>]*?)\)/g;

function isolateAsides(html: string): string {
  return html.replace(LATIN_ASIDE, (aside, inner: string) =>
    /\p{Script=Latin}/u.test(inner) && !hasRtl(inner) ? `<span dir="ltr">${aside}</span>` : aside,
  );
}

// ── Marked ──────────────────────────────────────────────────────────────────

const markdown = new Marked({ gfm: true, breaks: false });

markdown.use({
  extensions: [
    {
      name: "displayMath",
      level: "block",
      start: (src: string) => /^ {0,3}(?:\$\$|\\\[)/m.exec(src)?.index,
      tokenizer(src: string) {
        for (const rule of BLOCK_MATH) {
          const match = rule.pattern.exec(src);
          if (match)
            return {
              type: "displayMath",
              raw: match[0],
              tex: match[1]!.trim(),
              display: true,
              open: rule.open,
            } satisfies MathToken;
        }
        return undefined;
      },
      renderer: (token) => `${placeholder(token as unknown as MathToken, "div")}\n`,
    },
    {
      name: "math",
      level: "inline",
      start: (src: string) => /\\[([]|(?<!\\)\$/.exec(src)?.index,
      tokenizer(src: string) {
        for (const rule of INLINE_MATH) {
          const match = rule.pattern.exec(src);
          if (match)
            return {
              type: "math",
              raw: match[0],
              tex: match[1]!.trim(),
              display: rule.display,
              open: rule.open,
            } satisfies MathToken;
        }
        return undefined;
      },
      renderer: (token) => placeholder(token as unknown as MathToken, "span"),
    },
  ],
  hooks: {
    // Emphasis must not pair asterisks across a formula, as in "*see $a*b$ here*".
    emStrongMask: (src: string) => src.replace(MATH_SPAN, (span) => "a".repeat(span.length)),
  },
  renderer: {
    paragraph(token) {
      const direction = decide(token.tokens, token);
      const split = context.note ? lines(token.tokens) : [];
      if (split.length < 2)
        return `<p dir="${direction}">${within(direction, () => this.parser.parseInline(token.tokens))}</p>\n`;
      // A line without words of its own keeps the direction of the line before it.
      let previous = direction;
      const inner = split.map((line) => {
        const own = within(previous, () => decide(line, line));
        previous = own;
        return `<span class="line" dir="${own}">${within(own, () => this.parser.parseInline(line))}</span>`;
      });
      return `<p dir="${direction}">${inner.join("")}</p>\n`;
    },
    heading(token) {
      const direction = decide(token.tokens, token);
      return `<h${token.depth} dir="${direction}">${within(direction, () => this.parser.parseInline(token.tokens))}</h${token.depth}>\n`;
    },
    blockquote(token) {
      const direction = decide(token.tokens, token);
      return `<blockquote dir="${direction}">\n${within(direction, () => this.parser.parse(token.tokens))}</blockquote>\n`;
    },
    // A list has one direction, so its markers stay on one side; each item's text keeps its own.
    list(token) {
      const direction = decide(
        token.items.flatMap((item) => item.tokens),
        token,
      );
      const tag = token.ordered ? "ol" : "ul";
      const start = token.ordered && token.start !== 1 ? ` start="${Number(token.start)}"` : "";
      const items = within(direction, () =>
        token.items.map((item) => this.listitem(item)).join(""),
      );
      return `<${tag} dir="${direction}"${start}>\n${items}</${tag}>\n`;
    },
    text(token) {
      if ("tokens" in token && token.tokens) {
        // An item's own words, in a tight list: its direction may differ from the list's.
        const direction = decide(token.tokens, token);
        const inner = within(direction, () => this.parser.parseInline(token.tokens!));
        return direction === context.current ? inner : `<span dir="${direction}">${inner}</span>`;
      }
      const html = "escaped" in token && token.escaped ? token.text : escapeHtml(token.text);
      return context.current === "rtl" ? isolateNumbers(isolateAsides(html)) : html;
    },
    // A table takes its direction from its header and first column, not the first cell alone.
    table(token) {
      const direction = decide(
        [...token.header, ...token.rows.map((row) => row[0]).filter((cell) => !!cell)].flatMap(
          (cell) => cell.tokens,
        ),
        token,
      );
      return within(direction, () => {
        const cell = (cell: Tokens.TableCell) => {
          const own = decide(cell.tokens, cell);
          const tag = cell.header ? "th" : "td";
          const align = cell.align
            ? ` style="text-align:${{ left: "start", right: "end", center: "center" }[cell.align]}"`
            : "";
          const dir = own === direction ? "" : ` dir="${own}"`;
          return `<${tag}${dir}${align}>${within(own, () => this.parser.parseInline(cell.tokens))}</${tag}>`;
        };
        const head = `<tr>${token.header.map(cell).join("")}</tr>`;
        const body = token.rows.map((row) => `<tr>${row.map(cell).join("")}</tr>`).join("\n");
        return `<table dir="${direction}">\n<thead>\n${head}\n</thead>\n${body ? `<tbody>\n${body}\n</tbody>\n` : ""}</table>\n`;
      });
    },
    code(token) {
      const language = /^\S+/.exec(token.lang ?? "")?.[0];
      const text = token.text.replace(/\n$/, "");
      return `<pre dir="ltr"><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${token.escaped ? text : escapeHtml(text)}\n</code></pre>\n`;
    },
    codespan(token) {
      return `<code dir="ltr">${escapeHtml(token.text)}</code>`;
    },
    // A block of raw HTML, such as <details>, gets the direction of its words on its first
    // element, like any other block. Inline tags and comments pass through untouched.
    html(token) {
      if (!("block" in token) || !token.block) return token.text;
      const direction = estimateDirection(token.text.replace(/<[^>]*>/g, " ")).direction;
      return token.text.replace(
        /^(\s*<[A-Za-z][\w-]*)(?![^>]*\sdir=)/,
        `$1 dir="${direction ?? context.current}"`,
      );
    },
    link(token) {
      const html = Renderer.prototype.link.call(this, token);
      return bareUrl(token) ? html.replace(/^<a /, '<a dir="ltr" ') : html;
    },
  },
});
