import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  citationLink,
  linkFirstMention,
  matchNote,
  mentionsOf,
  noteCitations,
  noteFacts,
  noteHeadings,
  noteLinks,
  notePreview,
  noteTags,
} from "../src/library/note-meta.ts";
import { CourseNotes } from "../src/library/notes.ts";
import { LibraryError, LibraryStore } from "../src/library/store.ts";
import { NoteConflictError } from "../src/notes.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const NOTE = [
  "# Graph traversal",
  "",
  "BFS visits **vertices** in layers. See [[Shortest paths]] and [[topic:bfs|the topic]].",
  "",
  "## Proof",
  "",
  "```python",
  "# not a heading #notatag [[Not a link]]",
  "```",
  "",
  "Uses `#nottag` inline. #graphs #exam/week1 #Graphs #3 #גרפים",
].join("\n");

describe("note facts", () => {
  it("reads tags, links and headings outside code", () => {
    expect(noteTags(NOTE)).toEqual(["graphs", "exam/week1", "גרפים"]);
    expect(noteLinks(NOTE)).toEqual(["Shortest paths"]);
    expect(noteHeadings(NOTE)).toEqual([{ level: 2, text: "Proof", line: 4 }]);
  });

  it("previews the text after the title as plain words", () => {
    expect(notePreview(NOTE)).toMatch(
      /^BFS visits vertices in layers\. See Shortest paths and the topic\. Proof/,
    );
    expect(notePreview("# Only a title\n")).toBe("");
  });

  it("finds the pages a note cites", () => {
    const lecture = randomUUID();
    const content = [
      "# Notes",
      `From ${citationLink(lecture, 4, "Lecture 2 · p. 4")} and ${citationLink(lecture, 2, "p. 2")}.`,
      "[[page:not-an-id#3|nothing]]",
    ].join("\n");
    expect(noteCitations(content)).toEqual([{ documentId: lecture, pages: [2, 4] }]);
    expect(noteFacts(content).cites).toEqual([lecture]);
    expect(citationLink(lecture, 1, "A [tricky] | title")).toBe(
      `[[page:${lecture}#1|A tricky title]]`,
    );
  });
});

describe("mentions", () => {
  const other = [
    "# Exam review",
    "Redo the graph traversal questions.",
    "Read [[Graph traversal]] again.",
    "Graph traversals are not this note; `graph traversal` in code neither.",
  ].join("\n");

  it("separates linked lines from plain mentions of the title", () => {
    const found = mentionsOf(other, "Graph traversal");
    expect(found.linked).toEqual([{ line: 2, text: "Read Graph traversal again." }]);
    expect(found.unlinked.map((mention) => mention.line)).toEqual([1]);
  });

  it("links the first plain mention, keeping how it was written", () => {
    expect(linkFirstMention(other, "Graph traversal")).toBe(
      other.replace("the graph traversal", "the [[Graph traversal|graph traversal]]"),
    );
    expect(linkFirstMention("# T\nSee Heaps here.", "Heaps")).toBe("# T\nSee [[Heaps]] here.");
    expect(linkFirstMention("# Heaps\nNothing.", "Heaps")).toBeNull();
  });
});

describe("note search", () => {
  it("matches every word after Hebrew and case folding, titles first", () => {
    expect(matchNote("# גרפים\nאלגוריתם בגרפים", "גרפים", "בגרף")).not.toBeNull();
    expect(matchNote(NOTE, "Graph traversal", "bfs layers")?.snippet).toMatch(/BFS visits/);
    expect(matchNote(NOTE, "Graph traversal", "bfs heaps")).toBeNull();
    const title = matchNote("# Heaps\nbody", "Heaps", "heaps")!;
    const body = matchNote("# Other\nheaps here", "Other", "heaps")!;
    expect(title.score).toBeGreaterThan(body.score);
  });
});

describe("course notes search and links", () => {
  async function setup() {
    const home = await mkdtemp(resolve(tmpdir(), "folio-note-meta-test-"));
    homes.push(home);
    const library = await LibraryStore.open({ home: resolve(home, "data") });
    const notes = new CourseNotes(library);
    const course = await library.createCourse({ name: "Algorithms" });
    const elsewhere = await library.createCourse({ name: "Private course" });
    const target = await notes.create(course.id, "Heaps", "A heap is a tree.");
    const source = await notes.create(course.id, "Week 3", "Today: heaps and priority queues.");
    const hidden = await notes.create(elsewhere.id, "Other course", "Heaps everywhere.");
    return { notes, course, target, source, hidden };
  }

  it("searches one course or all of them", async () => {
    const { notes, course, target, source, hidden } = await setup();
    expect((await notes.search("heaps", course.id)).map((hit) => hit.note.id)).toEqual([
      target.id,
      source.id,
    ]);
    expect((await notes.search("heaps")).map((hit) => hit.note.id)).toContain(hidden.id);
  });

  it("lists mentions only within the course and links one against its revision", async () => {
    const { notes, target, source, hidden } = await setup();
    const mentions = await notes.mentions(target.id);
    expect(mentions.map((entry) => entry.note.id)).toEqual([source.id]);
    await expect(notes.linkMention(source.id, target.id, "stale")).rejects.toBeInstanceOf(
      NoteConflictError,
    );
    await expect(notes.linkMention(hidden.id, target.id, hidden.revision)).rejects.toBeInstanceOf(
      LibraryError,
    );
    const linked = await notes.linkMention(source.id, target.id, source.revision);
    expect(linked.content).toContain("Today: [[Heaps|heaps]] and priority queues.");
    expect((await notes.mentions(target.id))[0]!.linked).toHaveLength(1);
  });
});
