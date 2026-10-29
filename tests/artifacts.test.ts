import { describe, expect, it } from "vite-plus/test";
import {
  artifactDocument,
  artifactHost,
  artifactPolicy,
  ArtifactRegistry,
  artifactResponse,
  MAX_ARTIFACT,
} from "../src/desktop/artifacts.ts";

const APP = "folio://app";
const DEMO =
  '<button id="go">Step</button><script>document.getElementById("go").onclick = () => {};</script>';

describe("the demo host", () => {
  it("names each demo by its content, in a host name short enough to be one", () => {
    const host = artifactHost(artifactDocument(DEMO));
    expect(host).toMatch(/^[a-z2-7]{52}$/);
    expect(artifactHost(artifactDocument(DEMO))).toBe(host);
    expect(artifactHost(artifactDocument(`${DEMO} `))).not.toBe(host);
  });

  it("puts Folio's head before the demo, whether it is a fragment or a whole page", () => {
    const fragment = artifactDocument(DEMO);
    expect(fragment).toMatch(/^<!doctype html><html dir="auto"><head><meta charset="utf-8">/);
    expect(fragment.indexOf('Object.defineProperty(window, "folio"')).toBeLessThan(
      fragment.indexOf(DEMO),
    );
    const page = artifactDocument(
      "<!doctype html><html><head><title>T</title></head><body>x</body></html>",
    );
    expect(page.indexOf("<script>")).toBeLessThan(page.indexOf("<title>"));
    const headless = artifactDocument("<html><body>x</body></html>");
    expect(headless).toContain("<html><head><meta charset");
  });

  it("serves a demo only to Folio's page, with a policy that allows no network", async () => {
    const registry = new ArtifactRegistry();
    const url = registry.register(DEMO);
    expect(url).toMatch(/^folio-artifact:\/\/[a-z2-7]{52}\/$/);
    const served = await artifactResponse({ url, initiatorOrigin: APP }, registry, APP);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Security-Policy")).toBe(artifactPolicy(APP));
    expect(artifactPolicy(APP)).toContain("connect-src 'none'");
    expect(artifactPolicy(APP)).toContain("sandbox allow-scripts");
    expect(artifactPolicy(APP)).toContain("frame-ancestors folio://app");
    expect(artifactPolicy(APP)).not.toContain("allow-same-origin");
    expect(served.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(await served.text()).toContain(DEMO);
    for (const initiator of [undefined, "null", "https://example.com", "folio-artifact://lib"])
      expect(
        (await artifactResponse({ url, initiatorOrigin: initiator }, registry, APP)).status,
        String(initiator),
      ).toBe(403);
    expect(
      (await artifactResponse({ url: `${url}other`, initiatorOrigin: APP }, registry, APP)).status,
    ).toBe(404);
    const unknown = `folio-artifact://${"a".repeat(52)}/`;
    expect(
      (await artifactResponse({ url: unknown, initiatorOrigin: APP }, registry, APP)).status,
    ).toBe(404);
  });

  it("serves its fixed libraries to demos only, and never a path it was not given", async () => {
    const registry = new ArtifactRegistry();
    const lib = (path: string, initiatorOrigin = "null") =>
      artifactResponse({ url: `folio-artifact://lib/${path}`, initiatorOrigin }, registry, APP);
    const katex = await lib("katex/katex.min.js");
    expect(katex.status).toBe(200);
    expect(katex.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await lib("katex/fonts/KaTeX_Main-Regular.woff2")).status).toBe(200);
    expect((await lib("pele/pele.js")).status).toBe(200);
    expect((await lib("katex/katex.min.js", APP)).status).toBe(403);
    // Dot segments are resolved before the lookup, so they can only name a listed file.
    expect((await lib("katex/fonts/../katex.min.js")).status).toBe(200);
    for (const path of [
      "../package.json",
      "%2e%2e/package.json",
      "katex/../../package.json",
      "katex/fonts/../../../package.json",
      "katex/dist/katex.min.js",
      "dompurify/dist/purify.min.js",
    ])
      expect((await lib(path)).status, path).toBe(404);
  });

  it("refuses a demo too large to show, and forgets old demos past its budget", () => {
    const registry = new ArtifactRegistry();
    expect(() => registry.register("x".repeat(MAX_ARTIFACT + 1))).toThrow("too large");
    const first = registry.register(DEMO);
    const host = new URL(first).host;
    for (let index = 0; index < 400; index++)
      registry.register(`<p>${index}</p>${"y".repeat(190_000)}`);
    expect(registry.get(host)).toBeUndefined();
  });
});
