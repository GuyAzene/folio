import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_MODEL } from "../../src/agents.ts";
import { KnowledgeStore } from "../../src/kb/store.ts";
import { CourseNotes } from "../../src/library/notes.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { createSessionStore } from "../../src/session-store.ts";
import { bundle } from "../fixtures/draft-bundle.ts";
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
/**
 * A reply that shows each visual through `show_visual`, as a saved chat stores it: a short text,
 * the call, and its accepted result.
 */
export function visualTurns(sources: string[]): AgentMessage[] {
  return sources.flatMap((source, index) => [
    {
      ...reply(`Visual ${index + 1}:`),
      content: [
        { type: "text", text: `Visual ${index + 1}:` },
        { type: "toolCall", id: `call_${index + 1}`, name: "show_visual", arguments: { source } },
      ],
      stopReason: "toolUse",
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: `call_${index + 1}`,
      toolName: "show_visual",
      content: [{ type: "text", text: "Shown to the student." }],
      isError: false,
      timestamp: Date.now(),
    } as AgentMessage,
  ]);
}

export async function seedHome(
  replyText: string,
  open: "chat" | "lecture" | "note" = "chat",
  noteText = "A synthetic note.",
  /** The saved reply's messages, in place of one reply of `replyText`. */
  replyMessages?: AgentMessage[],
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
      ...(replyMessages ?? [reply(replyText)]),
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

export interface SeededLong {
  home: string;
  courseId: string;
  lectureId: string;
  recitationId: string;
  assignmentId: string;
  chatId: string;
  noteId: string;
}

/** Long synthetic names, in English and Hebrew, for checking that nothing overflows. */
export const LONG = {
  course: "Computational Complexity and Efficient Computation — סיבוכיות חישובית",
  lecture: "Complexity Theory Lecture 2 — Polynomial-Time Reductions and the Cook–Levin Theorem",
  recitation: "תרגול 2 בסיבוכיות: רדוקציות פולינומיות, שלמות NP ומשפט קוק–לוין עם דוגמאות",
  assignment: "Homework 3: Reductions between SAT, 3-COLOR and Hamiltonian Path (הגשה בזוגות)",
  note: "Notes on polynomial-time reductions, NP-completeness and everything around them",
};

/**
 * A course whose names are all long, with a studied lecture and recitation, an assignment with a
 * due date, a note, and a saved chat whose reply has a wide table and long words. Folio opens on
 * the place `open` returns for the seeded ids.
 */
export async function seedLongNames(
  open: (seeded: Omit<SeededLong, "home">) => unknown,
): Promise<SeededLong> {
  const home = await mkdtemp(resolve(tmpdir(), "folio-e2e-home-"));
  const library = await LibraryStore.open({ home });
  const course = await library.createCourse({ name: LONG.course, code: "CS 236343" });
  const documents: Record<"lecture" | "recitation" | "assignment", string> = {
    lecture: "",
    recitation: "",
    assignment: "",
  };
  for (const [index, role] of (["lecture", "recitation", "assignment"] as const).entries()) {
    const pdf = resolve(home, `${role}.pdf`);
    await writeFile(
      pdf,
      syntheticPdf([[`Synthetic ${role} ${index + 1}`, ...SYNTHETIC_LECTURE[0]!]]),
    );
    const imported = (await library.importFile(course.id, pdf, { role })).document;
    const updated = await library.updateDocument(
      imported.id,
      {
        title: LONG[role],
        ...(role === "assignment"
          ? { dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }
          : {}),
      },
      imported.revision,
    );
    documents[role] = updated.id;
  }
  const knowledge = await KnowledgeStore.open(library);
  await knowledge.publish(bundle(course.id, documents.lecture, "alg-L02"));
  await knowledge.publish(bundle(course.id, documents.recitation, "alg-R02"));
  const note = await new CourseNotes(library).create(course.id, LONG.note, "A synthetic note.");
  const sessions = await createSessionStore({ home });
  const wide = [
    "| Problem | Reduction | Certificate | Verifier time | Notes |",
    "| --- | --- | --- | --- | --- |",
    "| 3-SAT | from SAT by splitting long clauses | a satisfying assignment | linear in the formula | הערה ארוכה על הרדוקציה |",
    "| 3-COLOR | from 3-SAT with variable and clause gadgets | a colouring | linear in the edges | another long remark here |",
  ].join("\n");
  const chat = await sessions.create({
    modelId: DEFAULT_MODEL,
    scope: { courseId: course.id, library: 1 },
    focus: null,
    title: "Why polynomial-time reductions compose, and what that means for NP-completeness",
    messages: [
      {
        role: "user",
        content: `Explain https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/break/at/all and ${LONG.recitation}`,
        timestamp: Date.now(),
      } as AgentMessage,
      reply(
        `Here is a comparison:\n\n${wide}\n\nAntidisestablishmentarianism-style long words still wrap at their own breaks.`,
      ),
    ],
  });
  const ids = {
    courseId: course.id,
    lectureId: documents.lecture,
    recitationId: documents.recitation,
    assignmentId: documents.assignment,
    chatId: chat.id,
    noteId: note.id,
  };
  await writeFile(
    resolve(home, "workspace.json"),
    JSON.stringify({ version: 1, tabs: [{ id: "tab-1", location: open(ids) }], active: "tab-1" }),
  );
  return { home, ...ids };
}
