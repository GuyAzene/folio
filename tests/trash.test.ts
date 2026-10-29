import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { KnowledgeStore } from "../src/kb/store.ts";
import { CourseNotes } from "../src/library/notes.ts";
import { Removal } from "../src/library/removal.ts";
import { LibraryStore } from "../src/library/store.ts";
import { Trash } from "../src/library/trash.ts";
import { createSessionStore } from "../src/session-store.ts";
import { bundle } from "./fixtures/draft-bundle.ts";
import { SYNTHETIC_LECTURE, syntheticPdf } from "./fixtures/synthetic-pdf.ts";

// Synthetic courses, files and chats in a temporary Folio home; nothing real is touched.
const homes: string[] = [];
const stores: KnowledgeStore[] = [];

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** What is busy can change during a test: the stores read it when asked. */
interface Busy {
  /** Each request to stop studying, and a gate the stop waits on before it resolves. */
  stops: unknown[];
  gate?: Promise<void>;
  replying: string[];
}

async function setup(busy: Busy = { stops: [], replying: [] }) {
  const home = await mkdtemp(resolve(tmpdir(), "folio-trash-test-"));
  homes.push(home);
  const library = await LibraryStore.open({ home });
  const notes = new CourseNotes(library);
  const sessions = await createSessionStore({ home });
  const knowledge = await KnowledgeStore.open(library);
  stores.push(knowledge);
  const discarded: string[] = [];
  const trash = new Trash(home, {
    discard: async (path) => {
      discarded.push(path);
      await rm(path, { recursive: true, force: true });
    },
  });
  const removal = new Removal({
    library,
    notes,
    sessions,
    trash,
    knowledge,
    async stopStudying(scope) {
      busy.stops.push(scope);
      await busy.gate;
    },
    async releaseChats(ids) {
      if (ids.some((id) => busy.replying.includes(id)))
        throw new Error("Folio is still replying in that chat. Stop the reply first.");
    },
  });
  const course = await library.createCourse({ name: "Algorithms" });
  const pdf = async (name: string) => {
    const path = resolve(home, name);
    await writeFile(path, syntheticPdf([[name], ...SYNTHETIC_LECTURE]));
    return (await library.importFile(course.id, path)).document;
  };
  return { home, library, notes, sessions, knowledge, trash, removal, course, pdf, discarded };
}

describe("Folio's Trash", () => {
  it("moves a file out of the course and back, original intact", async () => {
    const { library, removal, trash, course, pdf } = await setup();
    const lecture = await pdf("Lecture 1.pdf");
    const entry = await removal.removeDocument(lecture.id);
    expect(await library.listDocuments({ courseId: course.id })).toEqual([]);
    expect((await trash.list()).map((item) => [item.kind, item.title])).toEqual([
      ["document", "Lecture 1"],
    ]);
    await removal.restore(entry.id);
    // The original comes back byte for byte: its hash still verifies.
    expect((await library.readOriginal(lecture.id)).document.sha256).toBe(lecture.sha256);
    expect(await trash.list()).toEqual([]);
  });

  it("takes a studied file's notes out of the course, and brings them back with it", async () => {
    const { removal, knowledge, course, pdf } = await setup();
    const one = await pdf("Lecture 1.pdf");
    const two = await pdf("Lecture 2.pdf");
    await knowledge.publish(bundle(course.id, one.id, "alg-L01"));
    await knowledge.publish(bundle(course.id, two.id, "alg-L02"));
    const blocks = async () =>
      (await knowledge.knowledge(course.id))!.pages.flatMap((page) =>
        page.blocks.map((block) => block.session),
      );
    expect(await blocks()).toHaveLength(4);

    const entry = await removal.removeDocument(one.id);
    const without = (await knowledge.knowledge(course.id))!;
    expect(without.sessions.map((session) => session.slug)).toEqual(["alg-L02"]);
    expect(await blocks()).toEqual(["alg-L02", "alg-L02"]);
    expect(entry.knowledge).toMatchObject({ courseId: course.id, documentIds: [one.id] });

    await removal.restore(entry.id);
    const back = (await knowledge.knowledge(course.id))!;
    expect(back.sessions.map((session) => session.slug)).toEqual(["alg-L01", "alg-L02"]);
    expect((await blocks()).sort()).toEqual(["alg-L01", "alg-L01", "alg-L02", "alg-L02"]);
    // Search finds the restored notes again.
    expect(
      knowledge.index(course.id)!.search("why is every vertex enqueued once", ["alg-L01"])[0]
        ?.handle,
    ).toBe("alg-bfs-marking-alg-l01");
  });

  it("empties a course's study notes when its only studied file goes, and refills them", async () => {
    const { removal, knowledge, course, pdf } = await setup();
    const lecture = await pdf("Lecture 1.pdf");
    await knowledge.publish(bundle(course.id, lecture.id, "alg-L01"));
    const entry = await removal.removeDocument(lecture.id);
    expect(await knowledge.knowledge(course.id)).toMatchObject({ sessions: [], pages: [] });
    await removal.restore(entry.id);
    expect((await knowledge.knowledge(course.id))!.pages.length).toBeGreaterThan(0);
  });

  it("stops studying a file before it moves, and keeps a chat that is replying", async () => {
    const busy: Busy = { stops: [], replying: [] };
    const { removal, library, sessions, course, pdf } = await setup(busy);
    const lecture = await pdf("Lecture 1.pdf");
    const chat = await sessions.create({
      modelId: "gpt-6.1-sol",
      scope: { courseId: course.id, library: 1 },
      focus: null,
    });
    busy.replying.push(chat.id);
    let stopped!: () => void;
    busy.gate = new Promise((done) => (stopped = done));
    const removing = removal.removeDocument(lecture.id);
    await new Promise((settle) => setTimeout(settle, 20));
    // Nothing moves while the study is still stopping.
    expect(await library.listDocuments()).toHaveLength(1);
    stopped();
    await removing;
    expect(busy.stops).toEqual([{ documentIds: [lecture.id] }]);
    expect(await library.listDocuments()).toHaveLength(0);
    await expect(removal.removeChat(chat.id)).rejects.toThrow("still replying");
    expect(await sessions.list()).toHaveLength(1);
    busy.replying.length = 0;
    await removal.removeCourse(course.id);
    expect(busy.stops.at(-1)).toEqual({ courseId: course.id });
  });

  it("moves a note with Folio's pending edit for it, and a chat, and restores both", async () => {
    const { removal, notes, sessions, course } = await setup();
    const note = await notes.create(course.id, "My summary", "Some text.");
    const chat = await sessions.create({
      modelId: "gpt-6.1-sol",
      scope: { courseId: course.id, library: 1 },
      focus: null,
    });
    await notes.propose(course.id, chat.id, { noteId: note.id, text: "A suggested line." });

    const noteEntry = await removal.removeNote(note.id);
    expect(noteEntry.paths).toHaveLength(2);
    expect(await notes.list(course.id)).toEqual([]);
    expect(await notes.listProposals(course.id)).toEqual([]);
    const chatEntry = await removal.removeChat(chat.id);
    expect(await sessions.list()).toEqual([]);

    await removal.restore(noteEntry.id);
    await removal.restore(chatEntry.id);
    expect((await notes.list(course.id)).map((item) => item.title)).toEqual(["My summary"]);
    expect((await notes.listProposals(course.id)).map((item) => item.state)).toEqual(["pending"]);
    expect((await sessions.list()).map((summary) => summary.id)).toEqual([chat.id]);
  });

  it("moves a whole course with its files, notes, chats and study notes, and restores it", async () => {
    const { library, removal, notes, sessions, knowledge, trash, course, pdf } = await setup();
    const lecture = await pdf("Lecture 1.pdf");
    await notes.create(course.id, "My summary");
    const chat = await sessions.create({
      modelId: "gpt-6.1-sol",
      scope: { courseId: course.id, library: 1 },
      focus: null,
    });
    await knowledge.publish(bundle(course.id, lecture.id, "alg-L01"));

    const entry = await removal.removeCourse(course.id);
    expect(entry.contents).toEqual({ documents: 1, notes: 1, chats: 1 });
    expect(await library.listCourses()).toEqual([]);
    expect(await library.listDocuments()).toEqual([]);
    expect(await sessions.list()).toEqual([]);

    await library.createCourse({ name: "Other" });
    await removal.restore(entry.id);
    expect((await library.listCourses()).map((item) => item.name).sort()).toEqual([
      "Algorithms",
      "Other",
    ]);
    expect((await library.listDocuments({ courseId: course.id })).map((d) => d.id)).toEqual([
      lecture.id,
    ]);
    expect((await sessions.list()).map((summary) => summary.id)).toEqual([chat.id]);
    expect((await knowledge.knowledge(course.id))!.sessions).toHaveLength(1);
    expect(await trash.list()).toEqual([]);
  });

  it("asks for the course first when a file's course is in the Trash too", async () => {
    const { removal, course, pdf } = await setup();
    const lecture = await pdf("Lecture 1.pdf");
    const file = await removal.removeDocument(lecture.id);
    const whole = await removal.removeCourse(course.id);
    await expect(removal.restore(file.id)).rejects.toThrow("Restore the course first");
    await removal.restore(whole.id);
    await expect(removal.restore(file.id)).resolves.toBeTruthy();
  });

  it("deletes into the Mac's Trash by name, and on its own after 30 days", async () => {
    const { removal, trash, pdf, discarded } = await setup();
    const one = await removal.removeDocument((await pdf("Lecture 1.pdf")).id);
    const two = await removal.removeDocument((await pdf("Lecture 2.pdf")).id);
    await trash.discard(one.id);
    expect(discarded.map((path) => path.split("/").at(-1))).toEqual(["Folio – Lecture 1"]);
    expect(await trash.purge(Date.parse(two.removedAt) + 29 * 86_400_000)).toBe(0);
    expect(await trash.purge(Date.parse(two.removedAt) + 31 * 86_400_000)).toBe(1);
    expect(await trash.list()).toEqual([]);
  });

  it("refuses to move or restore anything outside Folio's own data", async () => {
    const { home, trash } = await setup();
    await expect(
      trash.put({
        kind: "document",
        title: "x",
        courseId: null,
        courseName: null,
        paths: [resolve(home, "..")],
      }),
    ).rejects.toThrow("Only Folio's own files");
    // An edited record pointing elsewhere is ignored rather than followed.
    const folder = resolve(home, "trash", "forged");
    await mkdir(folder, { recursive: true });
    await writeFile(
      resolve(folder, "entry.json"),
      JSON.stringify({ version: 1, id: "forged", paths: ["../outside"], removedAt: "" }),
    );
    expect(await trash.list()).toEqual([]);
  });
});
