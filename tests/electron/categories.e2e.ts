/// <reference lib="dom" />
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import type { FolioApi } from "../../src/desktop/api.ts";
import { launch, type Running } from "./app.ts";
import { seedHome } from "./seed.ts";

/**
 * Categories, numbers and pattern names in a real window over the Electron bridge: a category
 * renamed and a pattern set from the window land in config.json, files follow, a rename to the
 * pattern is undone, and a category in use can't go. Run with `vp run test:electron`; nothing here
 * talks to a model.
 */

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

declare global {
  interface Window {
    folio: FolioApi;
  }
}

void describe("categories and names", () => {
  void it("rename a category, name files by a pattern and undo it, and keep a category in use", async () => {
    const seeded = await seedHome("A synthetic reply.");
    const app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    await page.waitForFunction(() => !!window.folio);

    const result = await page.evaluate(async (lectureId) => {
      const api = window.folio;
      const { models } = await api.bootstrap();
      const renamed = models.categories.map((category) =>
        category.id === "lecture" ? { ...category, name: "Shiur", plural: "Shiurim" } : category,
      );
      await api.setCategories(renamed);
      let refused = "";
      await api
        .setCategories(renamed.filter((category) => category.id !== "lecture"))
        .catch((error: Error) => (refused = error.message));
      await api.setNaming("{category} {n}");
      const planned = await api.renames({});
      const done = await api.applyNaming({ documentIds: [lectureId] });
      const named = (await api.listDocuments()).find((document) => document.id === lectureId)!;
      const numbered = await api.updateDocument(lectureId, { number: 4 }, named.revision);
      const restored = await api.undoNaming([{ ...done[0]!, next: numbered.title }]);
      const after = (await api.listDocuments()).find((document) => document.id === lectureId)!;
      return { refused, planned: planned.length, named, numbered, restored, after };
    }, seeded.lectureId);

    assert.match(result.refused, /in Shiurim\. Move them to another category first\./);
    assert.ok(result.planned >= 1);
    assert.equal(result.named.title, "Shiur 1");
    assert.equal(result.named.named, "pattern");
    // A file named by the pattern follows its new number.
    assert.equal(result.numbered.title, "Shiur 4");
    assert.equal(result.restored, 1);
    assert.equal(result.after.named, "own");
    const config = JSON.parse(await readFile(resolve(seeded.home, "config.json"), "utf8"));
    assert.equal(config.library.naming, "{category} {n}");
    assert.equal(config.library.categories[0].plural, "Shiurim");
  });
});
