/// <reference lib="dom" />
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { LibraryStore } from "../../src/library/store.ts";
import { launch, type Running } from "./app.ts";
import { seedLongNames } from "./seed.ts";

/**
 * Typing a due date in a real window: a year typed digit by digit saves once, as the whole year,
 * and keeps the day and month; a role change made right after it is saved too.
 * Run with `vp run test:electron`; nothing here talks to a model.
 */

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

async function stored(home: string, id: string): Promise<{ dueAt: string; role: string }> {
  return JSON.parse(
    await readFile(resolve(home, "library/documents", id, "document.json"), "utf8"),
  ) as { dueAt: string; role: string };
}

void describe("due dates", () => {
  void it("save the whole year typed, keeping the day and month, and a role change after it", async () => {
    // The course's Materials list the assignment file with its card's due date.
    const seeded = await seedLongNames((ids) => ({
      view: "course",
      courseId: ids.courseId,
      tab: "materials",
    }));
    const before = new Date((await stored(seeded.home, seeded.assignmentId)).dueAt);
    const app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    const year = page.locator('[data-segment="year"]').first();
    await year.waitFor();
    await year.click();
    for (const key of ["2", "0", "3", "1"]) await page.keyboard.press(key);
    await page.keyboard.press("Tab");
    // Right away, before the date has finished saving, the role changes too.
    // Lectures, recitations, then assignments: the assignment's role menu is the last one.
    await page.getByRole("combobox", { name: "Role" }).last().click();
    await page.getByRole("option", { name: "Official solution" }).click();
    await page.waitForTimeout(800);
    const after = await stored(seeded.home, seeded.assignmentId);
    const [record] = await (await LibraryStore.open({ home: seeded.home })).listAssignments();
    const due = new Date(record!.dueAt!);
    assert.equal(due.getFullYear(), 2031);
    assert.equal(due.getMonth(), before.getMonth());
    assert.equal(due.getDate(), before.getDate());
    assert.equal(after.role, "solution");
  });
});
