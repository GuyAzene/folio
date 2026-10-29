import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { chatTitle } from "../src/chat-title.ts";
import { createCourseRuntimes } from "../src/library/course-tools.ts";
import { CourseNotes, noteTitle, ProposalStaleError } from "../src/library/notes.ts";
import { LibraryError, LibraryStore } from "../src/library/store.ts";
import { NoteConflictError } from "../src/notes.ts";

const homes: string[] = [];

async function setup() {
  const home = await mkdtemp(resolve(tmpdir(), "folio-notes-test-"));
  homes.push(home);
  const library = await LibraryStore.open({ home: resolve(home, "data") });
  const notes = new CourseNotes(library);
  const course = await library.createCourse({ name: "Algorithms" });
  const other = await library.createCourse({ name: "Private course" });
  const note = await notes.create(course.id, "Graph traversal", "BFS visits vertices in layers.");
  const file = resolve(library.courseDirectory(course.id), "notes", `${note.id}.md`);
  return { library, notes, course, other, note, file, chatId: randomUUID() };
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe("course notes", () => {
  it("keeps titled Markdown notes per course and lists them", async () => {
    const { notes, course, other, note, file } = await setup();
    expect(await readFile(file, "utf8")).toBe(
      "# Graph traversal\n\nBFS visits vertices in layers.\n",
    );
    expect(note).toMatchObject({ courseId: course.id, title: "Graph traversal" });
    expect((await notes.list(course.id)).map((n) => n.id)).toEqual([note.id]);
    expect(await notes.list(other.id)).toEqual([]);
    expect(noteTitle("\n\n## Heaps\nbody")).toBe("Heaps");
    expect(noteTitle("")).toBe("Untitled note");
  });

  it("saves against a revision and preserves edits made in another app", async () => {
    const { notes, note, file } = await setup();
    const saved = await notes.save(note.id, "# Graph traversal\n\nMine\n", note.revision);
    await expect(notes.save(note.id, "Stale tab", note.revision)).rejects.toBeInstanceOf(
      NoteConflictError,
    );
    const external = "# Graph traversal\n\nEdited in Obsidian\n";
    await writeFile(file, external);
    await expect(notes.save(note.id, "Overwrite", saved.revision)).rejects.toBeInstanceOf(
      NoteConflictError,
    );
    expect(await readFile(file, "utf8")).toBe(external);
    // Appending adds below whatever is there now.
    await notes.append(note.id, "> Quoted passage\n> (Lecture 1, p.2)");
    expect(await readFile(file, "utf8")).toBe(
      `${external}\n> Quoted passage\n> (Lecture 1, p.2)\n`,
    );
  });
});

describe("note proposals", () => {
  it("writes nothing when proposed, and keeps the edit only on the drafted version", async () => {
    const { notes, course, note, file, chatId } = await setup();
    const before = await readFile(file, "utf8");
    const proposal = await notes.propose(course.id, chatId, {
      noteId: note.id,
      find: "in layers",
      text: "in layers, nearest first",
      reason: "Clarify the order.",
    });
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await notes.stale(proposal)).toBe(false);
    const kept = await notes.resolve(proposal.id, "keep");
    expect(kept).toMatchObject({ state: "kept", resultNoteId: note.id });
    expect(await readFile(file, "utf8")).toBe(
      "# Graph traversal\n\nBFS visits vertices in layers, nearest first.\n",
    );
    await expect(notes.resolve(proposal.id, "discard")).rejects.toThrow("already resolved");
  });

  it("refuses to keep a stale draft and lets the student insert it below instead", async () => {
    const { notes, course, note, file, chatId } = await setup();
    const proposal = await notes.propose(course.id, chatId, {
      noteId: note.id,
      text: "## Running time\nO(V + E)",
    });
    const external = "# Graph traversal\n\nRewritten by the student\n";
    await writeFile(file, external);
    expect(await notes.stale(proposal)).toBe(true);
    await expect(notes.resolve(proposal.id, "keep")).rejects.toBeInstanceOf(ProposalStaleError);
    expect(await readFile(file, "utf8")).toBe(external);
    expect((await notes.proposal(proposal.id)).state).toBe("pending");
    const inserted = await notes.resolve(proposal.id, "insert");
    expect(inserted.state).toBe("inserted");
    expect(await readFile(file, "utf8")).toBe(`${external}\n## Running time\nO(V + E)\n`);
  });

  it("creates a proposed new note only when kept, and discards without writing", async () => {
    const { notes, course, chatId } = await setup();
    const fresh = await notes.propose(course.id, chatId, { title: "Heaps", text: "A heap is…" });
    const discarded = await notes.propose(course.id, chatId, { title: "Tries", text: "…" });
    expect(await notes.list(course.id)).toHaveLength(1);
    const kept = await notes.resolve(fresh.id, "keep");
    expect((await notes.read(kept.resultNoteId!)).content).toBe("# Heaps\n\nA heap is…\n");
    expect((await notes.resolve(discarded.id, "discard")).state).toBe("discarded");
    expect((await notes.list(course.id)).map((n) => n.title).sort()).toEqual([
      "Graph traversal",
      "Heaps",
    ]);
  });

  it("rejects passages that are missing or ambiguous, and notes from other courses", async () => {
    const { notes, course, other, note, chatId } = await setup();
    await expect(
      notes.propose(course.id, chatId, { noteId: note.id, find: "DFS", text: "x" }),
    ).rejects.toThrow("exactly once");
    await notes.append(note.id, "BFS again.");
    await expect(
      notes.propose(course.id, chatId, { noteId: note.id, find: "BFS", text: "x" }),
    ).rejects.toThrow("exactly once");
    await expect(
      notes.propose(other.id, chatId, { noteId: note.id, text: "x" }),
    ).rejects.toBeInstanceOf(LibraryError);
  });
});

describe("note tools", () => {
  it("keep the student's notes with their own course when another course is added", async () => {
    const { library, notes, course, other, chatId } = await setup();
    const runtime = await createCourseRuntimes(library, { notes })(course.id, chatId, () => ({
      courses: [other.id],
      documents: [],
    }));
    const tool = (name: string) => runtime.tools.find((candidate) => candidate.name === name)!;
    const elsewhere = await notes.create(other.id, "Private");
    await expect(tool("read_note").execute("call_1", { noteId: elsewhere.id })).rejects.toThrow(
      "not part of this chat",
    );
    await expect(tool("list_notes").execute("call_2", { courseId: other.id })).rejects.toThrow(
      "accepts only",
    );
  });

  it("lets a course chat write notes in its own course, refusing stale and ambiguous edits", async () => {
    const { library, notes, course, other, note, chatId } = await setup();
    let changes = 0;
    const runtimes = createCourseRuntimes(library, { notes, changed: () => changes++ });
    const tools = (await runtimes(course.id, chatId)).tools;
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    expect(tools.map((candidate) => candidate.name)).not.toContain("propose_note_edit");

    const reading = await tool("read_note").execute("call_1", { noteId: note.id });
    const text = (reading.content[0] as { text: string }).text;
    expect(text).toContain("not course material");
    const revision = (reading.details as { revision: string }).revision;
    expect(text).toContain(`Revision: ${revision}`);

    // A passage replaced from the revision read.
    const current = await notes.read(note.id);
    const passage = current.content
      .split("\n")
      .find((line) => line.trim() && !line.startsWith("#"))!;
    const edit = await tool("edit_note").execute("call_2", {
      noteId: note.id,
      revision,
      find: passage,
      text: "A queue is first in, first out.",
    });
    const change = (edit.details as { noteEdit: { before: string; after: string } }).noteEdit;
    expect(change.before).toBe(revision);
    expect((await notes.read(note.id)).content).toContain("A queue is first in, first out.");
    expect(changes).toBe(1);

    // The same revision again is stale; a missing or repeated passage is refused.
    await expect(
      tool("edit_note").execute("call_3", { noteId: note.id, revision, text: "More." }),
    ).rejects.toThrow("changed since you read it");
    await expect(
      tool("edit_note").execute("call_4", {
        noteId: note.id,
        revision: change.after,
        find: "not in the note",
        text: "x",
      }),
    ).rejects.toThrow("not in the note");
    await notes.save(
      note.id,
      `${(await notes.read(note.id)).content}\nzebra\nzebra\n`,
      change.after,
    );
    const latest = (await notes.read(note.id)).revision;
    await expect(
      tool("edit_note").execute("call_5", {
        noteId: note.id,
        revision: latest,
        find: "zebra",
        text: "x",
      }),
    ).rejects.toThrow("appears 2 times");

    // A new note, a duplicate title refused, and a rename that links follow.
    const created = await tool("create_note").execute("call_6", {
      title: "Queues",
      text: `See [[${note.title}]].`,
    });
    const queues = (created.details as { noteEdit: { noteId: string; before: null } }).noteEdit;
    expect(queues.before).toBeNull();
    await expect(
      tool("create_note").execute("call_7", { title: "queues", text: "Again" }),
    ).rejects.toThrow("already exists");
    await tool("rename_note").execute("call_8", {
      noteId: note.id,
      revision: latest,
      title: "BFS notes",
    });
    expect((await notes.read(note.id)).title).toBe("BFS notes");
    expect((await notes.read(queues.noteId)).content).toContain("See [[BFS notes]].");

    // Another course's notes are out of reach.
    const elsewhere = await notes.create(other.id, "Private");
    await expect(tool("read_note").execute("call_9", { noteId: elsewhere.id })).rejects.toThrow(
      "not part of this chat",
    );
    await expect(
      tool("edit_note").execute("call_10", {
        noteId: elsewhere.id,
        revision: elsewhere.revision,
        text: "x",
      }),
    ).rejects.toThrow("not part of this chat");
    await expect(
      tool("read_note").execute("call_11", { noteId: note.id, path: "../../x" } as never),
    ).rejects.toThrow("accepts only");
  });

  it("keeps each version the tutor replaced, and brings one back as a new version", async () => {
    const { notes, note } = await setup();
    const first = await notes.read(note.id);
    const tutor = { kind: "tutor" as const, chatId: "00000000-0000-4000-8000-000000000099" };
    const edited = await notes.save(
      note.id,
      `${first.content}\nTutor line.\n`,
      first.revision,
      tutor,
    );
    // Two quick saves by the student keep one version between them.
    const mine = await notes.save(note.id, `${edited.content}Mine.\n`, edited.revision);
    await notes.save(note.id, `${mine.content}Mine again.\n`, mine.revision);
    const history = await notes.history(note.id);
    expect(history.map((entry) => entry.author.kind)).toEqual(["student", "tutor"]);
    expect(history[1]!.revision).toBe(first.revision);
    const now = await notes.read(note.id);
    const restored = await notes.restore(note.id, first.revision, now.revision);
    expect(restored.content).toBe(first.content);
    await expect(notes.restore(note.id, first.revision, now.revision)).rejects.toThrow();
    expect((await notes.history(note.id))[0]!.revision).toBe(now.revision);
  });
});

describe("chat titles", () => {
  it("names a quoted chat by its passage, without Markdown quote marks", () => {
    expect(
      chatTitle("> BFS visits vertices\n> in layers\n> (Lecture 1, p.2)\n\nExplain this."),
    ).toBe("BFS visits vertices in layers");
    expect(chatTitle("  What is   a heap? ")).toBe("What is a heap?");
  });
});
