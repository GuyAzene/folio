import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_MODEL } from "../../src/agents.ts";
import { CourseNotes } from "../../src/library/notes.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { createSessionStore } from "../../src/session-store.ts";
import { SYNTHETIC_LECTURE, syntheticPdf } from "../fixtures/synthetic-pdf.ts";

/** A reply as a saved chat stores it; the content is synthetic. */
export function reply(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    api: "openai-responses",
    provider: "openai",
    model: DEFAULT_MODEL,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AgentMessage;
}

export interface Seeded {
  home: string;
  courseId: string;
  lectureId: string;
  chatId: string;
  noteId: string;
}

/**
 * A fresh home with one synthetic course, its lecture, and a saved course chat whose reply is
 * `replyText`. Folio opens on the place `open` names.
 */
export async function seedHome(
  replyText: string,
  open: "chat" | "lecture" | "note" = "chat",
  noteText = "A synthetic note.",
): Promise<Seeded> {
  const home = await mkdtemp(resolve(tmpdir(), "folio-e2e-home-"));
  const library = await LibraryStore.open({ home });
  const course = await library.createCourse({ name: "Automata Theory", code: "CS 236" });
  const pdf = resolve(home, "lecture.pdf");
  await writeFile(pdf, syntheticPdf(SYNTHETIC_LECTURE));
  const lecture = (await library.importFile(course.id, pdf)).document;
  const note = await new CourseNotes(library).create(course.id, "Synthetic note", noteText);
  const sessions = await createSessionStore({ home });
  const chat = await sessions.create({
    modelId: DEFAULT_MODEL,
    scope: { courseId: course.id, library: 1 },
    focus: null,
    title: "Synthetic chat",
    messages: [
      { role: "user", content: "Explain this.", timestamp: Date.now() } as AgentMessage,
      reply(replyText),
    ],
  });
  const location =
    open === "chat"
      ? { view: "chat", chatId: chat.id, courseId: course.id }
      : open === "note"
        ? { view: "note", noteId: note.id }
        : { view: "document", documentId: lecture.id, page: 1, panel: "closed", chatId: null };
  await writeFile(
    resolve(home, "workspace.json"),
    JSON.stringify({ version: 1, tabs: [{ id: "tab-1", location }], active: "tab-1" }),
  );
  return { home, courseId: course.id, lectureId: lecture.id, chatId: chat.id, noteId: note.id };
}
