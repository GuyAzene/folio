/// <reference lib="dom" />
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import type { Page } from "playwright-core";
import type { FolioApi } from "../../src/desktop/api.ts";
import { launch, type Running } from "./app.ts";
import { seedHome } from "./seed.ts";

/**
 * A lecture and a chat side by side in a real window, across the Electron bridge: the panes, a
 * dragged width and a draft come back after a tab switch and a restart, Back closes a pane, a
 * chat reopens beside the lecture it was about, and a workspace saved before panes opens as
 * panes. Run with `vp run test:electron`; nothing here talks to a model.
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

const widths = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-pane]")].map((pane) =>
      Math.round(pane.getBoundingClientRect().width),
    ),
  );

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) {
  for (let waited = 0; waited < 6_000; waited += 100) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((ready) => setTimeout(ready, 100));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

void describe("panes", () => {
  void it("keeps a chat beside a lecture, its width and its draft through a tab switch and a restart", async () => {
    const seeded = await seedHome("", "lecture");
    let app = await launch(seeded.home);
    running.push(app);
    let { page } = app;
    await page.getByRole("button", { name: "Ask Folio" }).click();
    const box = page.getByRole("textbox", { name: "Message Folio" });
    await box.waitFor();
    assert.equal((await widths(page)).length, 2);
    await box.fill("A half-written question");

    // The chat takes more than half the window.
    const divider = (await page.getByRole("separator", { name: "Resize panes" }).boundingBox())!;
    const total = (await widths(page)).reduce((sum, width) => sum + width, 0);
    await page.mouse.move(divider.x + 2, divider.y + 200);
    await page.mouse.down();
    await page.mouse.move(divider.x - total * 0.3, divider.y + 200, { steps: 8 });
    await page.mouse.up();
    const dragged = await widths(page);
    assert.ok(dragged[1]! > dragged[0]!, `the chat should be wider: ${dragged.join(", ")}`);

    await page.keyboard.press("Meta+t");
    await page.keyboard.press("Meta+1");
    await box.waitFor();
    assert.deepEqual(await widths(page), dragged);
    assert.equal(await box.inputValue(), "A half-written question");

    // Saved with the workspace (after its short wait), and the draft on this device.
    const saved = await eventually(
      async () => JSON.parse(await readFile(resolve(seeded.home, "workspace.json"), "utf8")),
      (workspace) => workspace.version === 2 && workspace.tabs[0]?.layout?.panes?.length === 2,
      "the workspace with two panes",
    );
    assert.equal(saved.tabs.length, 2);
    await app.close();
    app = await launch(seeded.home);
    running.push(app);
    page = app.page;
    await page.getByRole("textbox", { name: "Message Folio" }).waitFor();
    const restored = await widths(page);
    assert.equal(restored.length, 2);
    assert.ok(
      Math.abs(restored[1]! - dragged[1]!) <= 2,
      `${restored.join(", ")} after ${dragged.join(", ")}`,
    );
    assert.equal(
      await page.getByRole("textbox", { name: "Message Folio" }).inputValue(),
      "A half-written question",
    );
  });

  void it("closes a pane opened beside with Back, and opens it again with Forward", async () => {
    const seeded = await seedHome("", "lecture");
    const app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    await page.getByRole("button", { name: "Ask Folio" }).click();
    await page.getByRole("textbox", { name: "Message Folio" }).waitFor();
    assert.equal((await widths(page)).length, 2);
    await page.getByRole("button", { name: "Back" }).click();
    await eventually(
      () => widths(page),
      (shown) => shown.length === 1,
      "one pane",
    );
    await page.getByRole("button", { name: "Forward" }).click();
    await eventually(
      () => widths(page),
      (shown) => shown.length === 2,
      "two panes",
    );
  });

  void it("reopens a chat beside the lecture it was about, at its page", async () => {
    const seeded = await seedHome("A synthetic reply.", "lecture");
    let app = await launch(seeded.home);
    running.push(app);
    // The chat was held beside page 2; a question asked away from it keeps that.
    await app.page.waitForFunction(() => !!window.folio);
    await app.page.evaluate(
      ({ chatId, lectureId }) => window.folio.setFocus(chatId, { documentId: lectureId, page: 2 }),
      { chatId: seeded.chatId, lectureId: seeded.lectureId },
    );
    await app.close();
    app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    await page.getByRole("button", { name: "Ask Folio" }).waitFor();
    await page.keyboard.press("Meta+t");
    await page.keyboard.press("Meta+k");
    await page.keyboard.type("Synthetic chat");
    await page.getByRole("option", { name: "Synthetic chat", exact: true }).click();
    await page.getByText("A synthetic reply.").waitFor();
    await eventually(
      () => widths(page),
      (shown) => shown.length === 2,
      "the lecture beside the chat",
    );
    await page.getByText(/^2 \/ \d+$/).waitFor();
  });

  void it("opens a workspace saved before panes with the chat beside the lecture", async () => {
    const seeded = await seedHome("A synthetic reply.", "lecture");
    await writeFile(
      resolve(seeded.home, "workspace.json"),
      JSON.stringify({
        version: 1,
        tabs: [
          {
            id: "tab-1",
            location: {
              view: "document",
              documentId: seeded.lectureId,
              page: 1,
              panel: "docked",
              chatId: seeded.chatId,
              side: "chat",
            },
          },
        ],
        active: "tab-1",
      }),
    );
    const app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    await page.getByText("A synthetic reply.").waitFor();
    assert.equal((await widths(page)).length, 2);
  });
});
