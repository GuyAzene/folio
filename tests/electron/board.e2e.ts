/// <reference lib="dom" />
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { LibraryStore } from "../../src/library/store.ts";
import { launch, type Running } from "./app.ts";
import { LONG, seedLongNames } from "./seed.ts";

/**
 * The assignments board in a real window: an assignment file becomes a card when Folio starts,
 * the card's status menu moves it (the keyboard's way to do what dragging does), and the card
 * opens the sheet where finished work is kept. Run with `vp run test:electron`.
 */

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

void describe("the assignments board", () => {
  void it("shows an assignment file as a card, moves it by its menu, and opens it", async () => {
    const seeded = await seedLongNames(() => ({ view: "assignments" }));
    const app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    await page.getByRole("button", { name: LONG.assignment, exact: true }).waitFor();
    await page.getByRole("button", { name: `Move ${LONG.assignment}` }).click();
    await page.getByRole("menuitem", { name: "Doing" }).click();
    const library = await LibraryStore.open({ home: seeded.home });
    for (let waited = 0; waited < 5_000; waited += 100) {
      if ((await library.listAssignments())[0]?.status === "doing") break;
      await page.waitForTimeout(100);
    }
    const [record] = await library.listAssignments();
    assert.equal(record?.status, "doing");
    assert.equal(record?.documents.statement, seeded.assignmentId);
    await page.getByRole("button", { name: LONG.assignment, exact: true }).click();
    await page.getByRole("button", { name: "Add what you handed in" }).waitFor();
  });
});
