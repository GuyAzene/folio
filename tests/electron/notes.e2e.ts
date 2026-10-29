/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_MODEL } from "../../src/agents.ts";
import { CourseNotes } from "../../src/library/notes.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { createSessionStore } from "../../src/session-store.ts";
import { launch, type Running } from "./app.ts";
import { reply } from "./seed.ts";

/**
 * Notes the tutor writes, in a real window: a link in the read view opens the note it names,
 * and Undo on the tutor's change card brings back the version before it.
 * Run with `vp run test:electron`; nothing here talks to a model.
 */

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

async function seed(open: (ids: { linking: string; chat: string }) => unknown) {
  const home = await mkdtemp(resolve(tmpdir(), "folio-e2e-home-"));
  const library = await LibraryStore.open({ home });
  const course = await library.createCourse({ name: "Automata Theory" });
  const notes = new CourseNotes(library);
  const target = await notes.create(course.id, "Graph search", "Before the tutor.");
  const linking = await notes.create(course.id, "Queues", "See [[Graph search]] for more.");
  const edited = await notes.save(
    target.id,
    `${target.content}\nAdded by the tutor.\n`,
    target.revision,
    { kind: "tutor", chatId: "00000000-0000-4000-8000-0000000000c1" },
  );
  const sessions = await createSessionStore({ home });
  const chat = await sessions.create({
    modelId: DEFAULT_MODEL,
    scope: { courseId: course.id, library: 1 },
    focus: null,
    title: "Synthetic chat",
    messages: [
      { role: "user", content: "Add a line to my note.", timestamp: Date.now() } as AgentMessage,
      {
        ...reply(""),
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "edit_note",
            arguments: { noteId: target.id, revision: target.revision, text: "Added." },
          },
        ],
        stopReason: "toolUse",
      } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "edit_note",
        content: [{ type: "text", text: 'Edited the note "Graph search".' }],
        details: {
          noteEdit: {
            v: 1,
            action: "edited",
            noteId: target.id,
            title: "Graph search",
            before: target.revision,
            after: edited.revision,
          },
        },
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage,
      reply("Done: I added a line to Graph search."),
    ],
  });
  await writeFile(
    resolve(home, "workspace.json"),
    JSON.stringify({
      version: 1,
      tabs: [{ id: "tab-1", location: open({ linking: linking.id, chat: chat.id }) }],
      active: "tab-1",
    }),
  );
  return { home, notes, target };
}

void describe("notes the tutor writes", () => {
  void it("open the note a link in the read view names", async () => {
    const seeded = await seed(({ linking }) => ({ view: "note", noteId: linking }));
    const app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    await page.getByRole("radio", { name: "Read" }).click();
    const link = page.locator('article a[href^="#wikilink:"]');
    await link.waitFor();
    assert.equal(await link.textContent(), "Graph search");
    await link.click();
    await page.getByText("Before the tutor.").waitFor();
  });

  void it("undo the tutor's change from the chat, bringing back the version before it", async () => {
    const seeded = await seed(({ chat }) => ({ view: "chat", chatId: chat, courseId: null }));
    const app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    await page.getByRole("button", { name: "Undo" }).click();
    for (let waited = 0; waited < 5_000; waited += 100) {
      if ((await seeded.notes.read(seeded.target.id)).content === seeded.target.content) break;
      await page.waitForTimeout(100);
    }
    assert.equal((await seeded.notes.read(seeded.target.id)).content, seeded.target.content);
    // The change it undid is kept too.
    assert.ok((await seeded.notes.history(seeded.target.id)).length >= 2);
  });
});
