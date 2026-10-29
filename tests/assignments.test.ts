import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { assignmentBadges, patchAssignment } from "../src/library/assignments.ts";
import { CourseNotes } from "../src/library/notes.ts";
import { Removal } from "../src/library/removal.ts";
import { LibraryStore } from "../src/library/store.ts";
import { Trash } from "../src/library/trash.ts";
import { createSessionStore } from "../src/session-store.ts";
import { syntheticPdf } from "./fixtures/synthetic-pdf.ts";

// Synthetic coursework only.

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function setup() {
  const home = await mkdtemp(resolve(tmpdir(), "folio-assignments-test-"));
  homes.push(home);
  const library = await LibraryStore.open({ home });
  const course = await library.createCourse({ name: "Algorithms" });
  const file = async (name: string, role?: "assignment" | "solution") => {
    const path = resolve(home, name);
    await writeFile(path, syntheticPdf([[name]]));
    return (await library.importFile(course.id, path, role ? { role } : {})).document;
  };
  return { home, library, course, file };
}

describe("assignments", () => {
  it("are records of their own, saved from the revision they were read at", async () => {
    const { library, course } = await setup();
    const reading = await library.createAssignment({
      courseId: course.id,
      title: "  Read   chapter 22 ",
      kind: "reading",
    });
    expect(reading).toMatchObject({ title: "Read chapter 22", status: "todo", kind: "reading" });
    const doing = await library.updateAssignment(reading.id, { status: "doing" }, reading.revision);
    await expect(
      library.updateAssignment(reading.id, { status: "done" }, reading.revision),
    ).rejects.toThrow("changed since");
    await expect(library.createAssignment({ courseId: course.id, title: " " })).rejects.toThrow(
      "Give it a title",
    );
    const done = await library.updateAssignment(reading.id, { status: "done" }, doing.revision);
    expect(done.finishedAt).toBeTruthy();
    expect(patchAssignment(done, { status: "doing" }).finishedAt).toBeNull();
  });

  it("are made from assignment files once, and a deleted one stays deleted", async () => {
    const { library, file } = await setup();
    await file("hw1.pdf", "assignment");
    await file("hw2.pdf", "assignment");
    await file("Lecture 1.pdf");
    const created = await library.syncAssignments();
    expect(created.map((item) => item.title).sort()).toEqual(["hw1", "hw2"]);
    expect(await library.syncAssignments()).toEqual([]);
    await rm(library.assignmentDirectory(created[0]!.id), { recursive: true });
    expect(await library.syncAssignments()).toEqual([]);
    await file("hw3.pdf", "assignment");
    expect((await library.syncAssignments()).map((item) => item.title)).toEqual(["hw3"]);
    expect(await library.listAssignments()).toHaveLength(2);
  });

  it("keep each submission as it was handed in, read-only, and move to Submitted", async () => {
    const { home, library, course } = await setup();
    const work = await library.createAssignment({ courseId: course.id, title: "Problem set 1" });
    const answer = resolve(home, "answers.pdf");
    await writeFile(answer, syntheticPdf([["My answers"]]));
    const first = await library.addAssignmentFiles(work.id, [answer], "attempt", work.revision);
    expect(first.status).toBe("submitted");
    expect(first.attempts).toHaveLength(1);
    const kept = library.assignmentFile(work.id, first.attempts[0]!.files[0]!.id);
    expect((await stat(kept)).mode & 0o777).toBe(0o400);
    await writeFile(answer, syntheticPdf([["Corrected answers"]]));
    const second = await library.addAssignmentFiles(work.id, [answer], "attempt", first.revision);
    expect(second.attempts.map((attempt) => attempt.files[0]!.sha256)).toHaveLength(2);
    expect(second.attempts[0]).toEqual(first.attempts[0]);
    const graded = await library.addAssignmentFiles(work.id, [answer], "feedback", second.revision);
    expect(graded.feedback.files).toHaveLength(1);
    expect(graded.status).toBe("submitted");
  });

  it("work out overdue, late, extended and excused from their dates", () => {
    const now = new Date("2026-11-10T12:00:00.000Z");
    const base = {
      dueAt: "2026-11-05T21:59:00.000Z",
      originalDueAt: null,
      excused: false,
      status: "doing" as const,
      attempts: [],
    };
    expect(assignmentBadges(base, now)).toMatchObject({ overdue: true, late: false });
    expect(assignmentBadges({ ...base, excused: true }, now).overdue).toBe(false);
    const late = {
      ...base,
      status: "submitted" as const,
      attempts: [{ id: "a", submittedAt: "2026-11-06T09:00:00.000Z", files: [], note: "" }],
    };
    expect(assignmentBadges(late, now)).toMatchObject({ overdue: false, late: true });
    const extended = patchAssignment(
      {
        ...base,
        version: 1,
        id: "x",
        courseId: "c",
        title: "t",
        kind: "project",
        dueHasTime: false,
        documents: { statement: null, solution: null },
        steps: [],
        topics: [],
        grade: { score: null, max: null, text: "" },
        feedback: { text: "", files: [] },
        reflection: "",
        finishedAt: null,
        createdAt: base.dueAt,
        updatedAt: base.dueAt,
        revision: 1,
      },
      { extendTo: "2026-11-12T21:59:00.000Z" },
    );
    expect(extended.originalDueAt).toBe(base.dueAt);
    expect(assignmentBadges(extended, now)).toMatchObject({ extended: true, overdue: false });
  });

  it("go to the Trash alone or with their course, and lose a file that was removed", async () => {
    const { home, library, course, file } = await setup();
    const handout = await file("hw1.pdf", "assignment");
    const [work] = await library.syncAssignments();
    const other = await library.createAssignment({ courseId: course.id, title: "Reading" });
    const removal = new Removal({
      library,
      notes: new CourseNotes(library),
      sessions: await createSessionStore({ home }),
      trash: new Trash(home),
    });
    await removal.removeDocument(handout.id);
    expect((await library.assignment(work!.id)).documents.statement).toBeNull();
    const entry = await removal.removeAssignment(other.id);
    expect(entry.kind).toBe("assignment");
    expect((await library.listAssignments()).map((item) => item.id)).toEqual([work!.id]);
    await removal.removeCourse(course.id);
    expect(await library.listAssignments()).toEqual([]);
  });
});
