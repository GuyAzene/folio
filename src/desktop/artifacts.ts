import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { VISUAL_FONT, visualColors } from "../visual.ts";
import { originOf } from "./hardening.ts";

/**
 * The host for the tutor's interactive demos. Each demo is a whole HTML document served from
 * `folio-artifact://<hash>/` into a frame sandboxed to scripts alone: an opaque origin that
 * cannot reach Folio's page, its storage or the app, under a content policy of its own with no
 * network at all. The only scripts besides the demo's own come from `folio-artifact://lib/`, a
 * fixed list of files bundled with Folio.
 */

export const ARTIFACT_SCHEME = "folio-artifact";
/** A demo larger than this is refused. */
export const MAX_ARTIFACT = 200_000;
const REGISTRY_BYTES = 64 * 1024 * 1024;

/** Libraries a demo may load, by the path it asks for; nothing else is served. */
const require = createRequire(import.meta.url);
const LIBRARIES: Record<string, { file: string; type: string }> = {
  "katex/katex.min.js": { file: "katex/dist/katex.min.js", type: "text/javascript" },
  "katex/katex.min.css": { file: "katex/dist/katex.min.css", type: "text/css" },
  "pele/pele.js": { file: "pele/global", type: "text/javascript" },
};
const KATEX_FONT = /^katex\/fonts\/(KaTeX_[A-Za-z0-9-]+\.woff2)$/;

/** The base32 of a SHA-256: 52 letters and digits, short enough for a host name. */
export function artifactHost(document: string): string {
  const digest = createHash("sha256").update(document).digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export const ARTIFACT_URL = /^folio-artifact:\/\/([a-z2-7]{52})\/(?:#.*)?$/;

/**
 * Runs before the demo's own code. It sizes the frame to its content, reports errors, applies
 * Folio's theme, and talks to the page only through the port the page hands it: every message
 * is checked on the other side. The demo sees one small `folio` object; asking a follow-up only
 * fills in the student's composer, never sends.
 */
const BOOTSTRAP = `(() => {
  "use strict";
  let port = null;
  const waiting = [];
  const send = (message) => (port ? port.postMessage(message) : waiting.push(message));
  addEventListener("message", (event) => {
    if (port || event.source !== parent || !event.ports || !event.ports[0]) return;
    event.stopImmediatePropagation();
    port = event.ports[0];
    port.onmessage = (incoming) => {
      const message = incoming.data || {};
      if (message.type === "ping") port.postMessage({ type: "pong" });
      else if (message.type === "theme" && (message.theme === "light" || message.theme === "dark"))
        document.documentElement.dataset.theme = message.theme;
    };
    for (const message of waiting.splice(0)) port.postMessage(message);
  }, true);
  const theme = /theme=(dark|light)/.exec(location.hash);
  document.documentElement.dataset.theme = theme ? theme[1] : "light";
  addEventListener("error", (event) => send({ type: "error", message: String(event.message || "Error").slice(0, 300) }));
  addEventListener("unhandledrejection", (event) => send({ type: "error", message: String(event.reason).slice(0, 300) }));
  let last = 0;
  const measure = () => {
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height !== last) send({ type: "resize", height: (last = height) });
  };
  new ResizeObserver(measure).observe(document.documentElement);
  addEventListener("load", measure);
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) delete window[name];
  Object.defineProperty(window, "folio", {
    value: Object.freeze({ ask: (text) => send({ type: "ask", text: String(text).slice(0, 1000) }) }),
  });
})();`;

/** Folio's look for a demo: its fonts' fallbacks and colors, light and dark. */
const THEME = `:root{color-scheme:light;${visualColors("light")};${VISUAL_FONT}}
:root[data-theme=dark]{color-scheme:dark;${visualColors("dark")}}
html,body{margin:0;background:var(--folio-bg);color:var(--folio-text);font:15px/1.5 var(--folio-font)}
body{padding:16px;overflow-wrap:anywhere}
*{box-sizing:border-box}
button,input,select,textarea{font:inherit;color:inherit}`;

/** The served document: Folio's head first, then the demo, whole or as a fragment. */
export function artifactDocument(source: string): string {
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${THEME}</style><script>${BOOTSTRAP}</script>`;
  if (/^\s*(?:<!doctype html[^>]*>\s*)?<html[\s>]/i.test(source)) {
    const withHead = source.replace(/<head(\s[^>]*)?>/i, (open) => `${open}${head}`);
    return withHead === source
      ? source.replace(/<html[^>]*>/i, (open) => `${open}<head>${head}</head>`)
      : withHead;
  }
  return `<!doctype html><html dir="auto"><head>${head}</head><body>${source}</body></html>`;
}

/** The content policy every demo runs under, whatever it says about itself. */
export function artifactPolicy(rendererOrigin: string): string {
  const lib = `${ARTIFACT_SCHEME}://lib`;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${lib}`,
    `style-src 'unsafe-inline' ${lib}`,
    `font-src data: ${lib}`,
    "img-src data: blob:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${rendererOrigin}`,
    "sandbox allow-scripts",
  ].join("; ");
}

const PERMISSIONS =
  "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=(), clipboard-read=(), clipboard-write=()";

/** Demos the page asked to show, by host, least recently used first out. */
export class ArtifactRegistry {
  readonly #documents = new Map<string, string>();
  #bytes = 0;

  /** Registers a demo's source and returns the URL its frame loads. */
  register(source: string): string {
    if (source.length > MAX_ARTIFACT) throw new Error("That demo is too large to show.");
    const document = artifactDocument(source);
    const host = artifactHost(document);
    const known = this.#documents.get(host);
    if (known !== undefined) this.#documents.delete(host);
    else this.#bytes += document.length;
    this.#documents.set(host, document);
    while (this.#bytes > REGISTRY_BYTES && this.#documents.size > 1) {
      const [oldest, text] = this.#documents.entries().next().value!;
      this.#documents.delete(oldest);
      this.#bytes -= text.length;
    }
    return `${ARTIFACT_SCHEME}://${host}/`;
  }

  get(host: string): string | undefined {
    return this.#documents.get(host);
  }
}

/**
 * Answers a `folio-artifact:` request. A demo's document goes only to Folio's own page, which
 * frames it; a library file goes only to a demo (an opaque, "null" origin). Paths are looked up,
 * never joined, so nothing else on disk can be named.
 */
export async function artifactResponse(
  request: { url: string; initiatorOrigin?: string },
  registry: ArtifactRegistry,
  rendererOrigin: string,
): Promise<Response> {
  const refuse = (status: number) => new Response(null, { status });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return refuse(400);
  }
  const initiator = request.initiatorOrigin;
  if (url.host === "lib") {
    // A demo's frame has an opaque origin, reported as "null".
    if (initiator !== "null" && initiator !== (null as unknown)) return refuse(403);
    const path = decodeURIComponent(url.pathname.slice(1));
    const font = KATEX_FONT.exec(path);
    const entry = font
      ? { file: `katex/dist/fonts/${font[1]}`, type: "font/woff2" }
      : Object.hasOwn(LIBRARIES, path)
        ? LIBRARIES[path]!
        : undefined;
    if (!entry) return refuse(404);
    const body = await Promise.resolve()
      .then(() => readFile(require.resolve(entry.file)))
      .catch(() => null);
    if (!body) return refuse(404);
    return new Response(body, {
      headers: {
        "Content-Type": entry.type,
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  }
  if (!initiator || originOf(initiator) !== rendererOrigin) return refuse(403);
  if (url.pathname !== "/") return refuse(404);
  const document = registry.get(url.host);
  if (document === undefined) return refuse(404);
  return new Response(document, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": artifactPolicy(rendererOrigin),
      "Permissions-Policy": PERMISSIONS,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}
