import { describe, expect, it } from "vite-plus/test";
import {
  frameNavigationDecision,
  originOf,
  permissionDecision,
  requestDecision,
  trustedSender,
} from "../src/desktop/hardening.ts";

const APP = "folio://app";

describe("origins", () => {
  it("names Folio's own schemes by host, where Node's parser would say null", () => {
    expect(new URL("folio://app/index.html").origin).toBe("null");
    expect(originOf("folio://app/index.html")).toBe(APP);
    expect(originOf("folio://other/x")).toBe("folio://other");
    expect(originOf("http://127.0.0.1:5173/app/main.ts")).toBe("http://127.0.0.1:5173");
    for (const opaque of ["about:blank", "data:text/html,hi", "not a url", ""])
      expect(originOf(opaque)).toBe("null");
  });
});

describe("permissions", () => {
  const ask = (permission: string, isMainFrame = true, origin = APP) =>
    permissionDecision({ permission, isMainFrame, origin, rendererOrigin: APP });

  it("lets Folio's own page copy, and nothing else", () => {
    expect(ask("clipboard-sanitized-write")).toBe(true);
    for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "hid"])
      expect(ask(permission)).toBe(false);
  });

  it("gives frames inside the page and other origins nothing", () => {
    expect(ask("clipboard-sanitized-write", false)).toBe(false);
    expect(ask("clipboard-sanitized-write", true, "null")).toBe(false);
    expect(ask("clipboard-sanitized-write", true, "https://example.com")).toBe(false);
  });
});

describe("navigation and network", () => {
  it("lets a frame in Folio's page load one demo, and nothing else", () => {
    const demo = `folio-artifact://${"a".repeat(52)}/`;
    const go = (
      url: string,
      overrides: Partial<Parameters<typeof frameNavigationDecision>[0]> = {},
    ) =>
      frameNavigationDecision({
        isMainFrame: false,
        url,
        parentIsMain: true,
        currentUrl: "about:blank",
        ...overrides,
      });
    expect(go(demo)).toBe(true);
    expect(go(`${demo}#theme=dark`)).toBe(true);
    expect(go(demo, { currentUrl: "" })).toBe(true);
    // A demo never moves on, nests a frame of its own, or loads anything but a demo.
    expect(go(demo, { currentUrl: `folio-artifact://${"b".repeat(52)}/` })).toBe(false);
    expect(go(demo, { parentIsMain: false })).toBe(false);
    expect(go("https://example.com")).toBe(false);
    expect(go("folio://app/index.html")).toBe(false);
    expect(go("folio-artifact://lib/katex/katex.min.js")).toBe(false);
    expect(go(`folio-artifact://${"a".repeat(52)}/other`)).toBe(false);
    expect(go("about:blank")).toBe(false);
    expect(go("folio://app/index.html", { isMainFrame: true })).toBe(true);
  });

  it("refuses the network, except the development server while developing", () => {
    const dev = "http://127.0.0.1:5173";
    expect(requestDecision({ url: "https://example.com/x.png", devOrigin: null })).toBe(false);
    expect(requestDecision({ url: "wss://example.com/socket", devOrigin: null })).toBe(false);
    expect(requestDecision({ url: "http://127.0.0.1:5173/x", devOrigin: null })).toBe(false);
    expect(requestDecision({ url: "http://127.0.0.1:5173/x", devOrigin: dev })).toBe(true);
    expect(requestDecision({ url: "ws://127.0.0.1:5173/", devOrigin: dev })).toBe(true);
    expect(requestDecision({ url: "http://127.0.0.1:9999/x", devOrigin: dev })).toBe(false);
    expect(requestDecision({ url: "folio://app/index.html", devOrigin: null })).toBe(true);
    expect(requestDecision({ url: "file:///tmp/x", devOrigin: null })).toBe(true);
  });
});

describe("who may call the app", () => {
  const sender = (overrides: Partial<Parameters<typeof trustedSender>[0]>) =>
    trustedSender({
      fromWindow: true,
      isMainFrame: true,
      origin: APP,
      rendererOrigin: APP,
      ...overrides,
    });

  it("is Folio's own page only: the window's main frame, at Folio's origin", () => {
    expect(sender({})).toBe(true);
    expect(sender({ isMainFrame: false })).toBe(false);
    expect(sender({ fromWindow: false })).toBe(false);
    expect(sender({ origin: "null" })).toBe(false);
    expect(sender({ origin: undefined })).toBe(false);
    expect(sender({ origin: "folio-artifact://abc" })).toBe(false);
  });
});
