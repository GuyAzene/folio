/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { CourseNotes } from "../../src/library/notes.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { launch, type Running } from "./app.ts";
import { seedHome } from "./seed.ts";

/**
 * The notebook in a real window: notes found by their text, a plain mention turned into a link,
 * ⌘O creating a note, a lecture's page added to the note beside it, and a reply saved to a note.
 * Run with `vp run test:electron`; nothing here talks to a model.
 */

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

/** Waits until `check` holds, reading the notes on disk. */
async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let waited = 0; waited < 6_000; waited += 100) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

void describe("the notebook", () => {
  void it("finds notes by their text, links a plain mention, and creates a note from ⌘O", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "folio-e2e-home-"));
    const library = await LibraryStore.open({ home });
    const course = await library.createCourse({ name: "Data Structures" });
    const notes = new CourseNotes(library);
    const heaps = await notes.create(course.id, "Heaps", "A heap is a tree. #trees");
    const week = await notes.create(course.id, "Week 3", "Today: heaps and priority queues.");
    await writeFile(
      resolve(home, "workspace.json"),
      JSON.stringify({ version: 1, tabs: [{ id: "tab-1", location: { view: "home" } }] }),
    );
    const app = await launch(home);
    running.push(app);
    const { page } = app;

    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await page.getByRole("textbox", { name: "Search notes" }).fill("priority");
    await page.getByText("1 result").waitFor();
    assert.equal(await page.getByRole("button", { name: "Heaps", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Clear search" }).click();

    await page.getByRole("button", { name: "Heaps", exact: true }).click();
    await page.getByRole("button", { name: /Unlinked mentions/ }).click();
    await page.getByRole("button", { name: "Link", exact: true }).click();
    await eventually(
      async () => (await notes.read(week.id)).content.includes("[[Heaps|heaps]]"),
      "the mention to become a link",
    );
    await page.getByText("Linked mentions").waitFor();

    await page.keyboard.press("Meta+o");
    await page.getByPlaceholder("Find or create a note").fill("Binary trees");
    await page.keyboard.press("Enter");
    await eventually(
      async () => (await notes.list(course.id)).some((note) => note.title === "Binary trees"),
      "the new note",
    );
    assert.ok((await notes.read(heaps.id)).content.includes("#trees"));
  });

  void it("adds the page being read to a note beside the lecture, as a link back to it", async () => {
    const seeded = await seedHome("", "lecture");
    const app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    await page.getByRole("button", { name: "Add this page to a note" }).click();
    await page.getByRole("tab", { name: "Note", selected: true }).waitFor();
    const notes = new CourseNotes(await LibraryStore.open({ home: seeded.home }));
    await eventually(
      async () =>
        (await notes.list(seeded.courseId)).some(
          (note) =>
            note.title.startsWith("Notes on") &&
            note.content.includes(`[[page:${seeded.lectureId}#1|`),
        ),
      "the cited page in a new note",
    );
  });

  void it("saves a reply to a new note, saying which chat it came from", async () => {
    const seeded = await seedHome("A vertex is marked when it enters the queue.", "chat");
    const app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    await page.getByRole("button", { name: "Save to note" }).click();
    await page.getByRole("menuitem", { name: "New note" }).click();
    const notes = new CourseNotes(await LibraryStore.open({ home: seeded.home }));
    await eventually(
      async () =>
        (await notes.list(seeded.courseId)).some(
          (note) =>
            note.content.includes("A vertex is marked when it enters the queue.") &&
            note.content.includes(`[[chat:${seeded.chatId}|`),
        ),
      "the reply in a new note",
    );
  });
});
