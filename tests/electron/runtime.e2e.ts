import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { SYNTHETIC_LECTURE, syntheticPdf } from "../fixtures/synthetic-pdf.ts";
import { launch, type Running } from "./app.ts";
import { seedHome } from "./seed.ts";

/**
 * What Folio's main process loads from disk while it runs, in the app these checks run against.
 * A packaged Folio.app reads it from its archive, and its native canvas from beside it, so a file
 * packaging leaves out fails here. Run with `vp run test:electron`; nothing here talks to a model.
 */

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

void describe("Folio's main process", () => {
  void it("renders a PDF page with the pdf.js, pdf.js data and canvas it ships", async () => {
    const seeded = await seedHome("A synthetic reply.");
    const app = await launch(seeded.home);
    running.push(app);
    const pdf = [...syntheticPdf(SYNTHETIC_LECTURE)];
    // As src/ingest/pages.ts renders: no font faces, pdf.js's own fonts, CMaps and decoders.
    const rendered = await app.app.evaluate(async ({ app: electron }, bytes) => {
      const { readdirSync } = process.getBuiltinModule("node:fs");
      const { createRequire } = process.getBuiltinModule("node:module");
      const path = process.getBuiltinModule("node:path");
      // Code evaluated here cannot import(), but Node can require an ES module.
      const require = createRequire(path.join(electron.getAppPath(), "package.json"));
      const { createCanvas } = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
      const pdfjs =
        require("pdfjs-dist/legacy/build/pdf.mjs") as typeof import("pdfjs-dist/legacy/build/pdf.mjs");
      const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(bytes),
        disableFontFace: true,
        useSystemFonts: false,
        verbosity: 0,
        standardFontDataUrl: `${path.join(root, "standard_fonts")}/`,
        cMapUrl: `${path.join(root, "cmaps")}/`,
        wasmUrl: `${path.join(root, "wasm")}/`,
      }).promise;
      try {
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
        const target = canvas as unknown as Parameters<typeof page.render>[0]["canvas"];
        await page.render({ canvas: target, viewport }).promise;
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
        let ink = 0;
        for (let index = 0; index < pixels.data.length; index += 4)
          if ((pixels.data[index + 3] ?? 0) > 0 && (pixels.data[index] ?? 255) < 128) ink++;
        return {
          appPath: electron.getAppPath(),
          data: ["standard_fonts", "cmaps", "wasm"].map(
            (dir) => readdirSync(path.join(root, dir)).length,
          ),
          pages: doc.numPages,
          png: (await canvas.encode("png")).byteLength,
          ink,
        };
      } finally {
        await doc.loadingTask.destroy();
      }
    }, pdf);
    assert.equal(rendered.pages, SYNTHETIC_LECTURE.length);
    assert.ok(rendered.png > 0);
    assert.ok(
      rendered.data.every((files) => files > 0),
      `pdf.js data: ${rendered.data.join(", ")}`,
    );
    // The page's text was drawn, not left blank.
    assert.ok(rendered.ink > 100, `Only ${rendered.ink} dark pixels on ${rendered.appPath}.`);
  });
});
