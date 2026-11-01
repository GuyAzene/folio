import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Knowledge } from "../src/kb/knowledge.ts";
import { DEFAULT_CATEGORIES, type Category } from "../src/library/categories.ts";
import { LibraryOperations } from "../src/library/operations.ts";
import { LibraryStore } from "../src/library/store.ts";
import { SYNTHETIC_LECTURE, syntheticPdf } from "./fixtures/synthetic-pdf.ts";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true }).catch(async () => {
      await chmod(home, 0o700);
      await rm(home, { recursive: true, force: true });
    });
  }
});

/** Operations over a real library, with studying and study notes recorded instead of run. */
async function setup() {
  const home = await mkdtemp(resolve(tmpdir(), "folio-operations-test-"));
  homes.push(home);
  const library = await LibraryStore.open({ home: resolve(home, "data") });
  const studiedIds = new Set<string>();
  const log: string[] = [];
  let categories: Category[] = structuredClone([...DEFAULT_CATEGORIES]);
  let naming: string | null = null;
  const operations = new LibraryOperations({
    library,
    categories: () => categories,
    async saveCategories(next) {
      categories = structuredClone(next);
      log.push(`categories ${next.map((category) => category.id).join(",")}`);
    },
    naming: () => naming,
    async saveNaming(pattern) {
      naming = pattern;
    },
    knowledge: {
      knowledge: async () =>
        ({
          sessions: [...studiedIds].map((documentId) => ({ documentId })),
        }) as unknown as Knowledge,
      async revise(courseId, _change, summary) {
        log.push(`revise ${courseId}: ${summary}`);
      },
    },
    async withdraw(id) {
      log.push(`withdraw ${id}`);
    },
    studySoon(courseId, ids) {
      if (ids.length) log.push(`study ${courseId}: ${ids.join(",")}`);
    },
    syncAssignments: () => log.push("assignments"),
    changed: () => log.push("changed"),
  });
  // Each file has its own text, so no two are the same file to Folio.
  const file = async (name: string) => {
    const path = resolve(home, name);
    await writeFile(path, syntheticPdf([[name], ...SYNTHETIC_LECTURE.slice(1)]));
    return path;
  };
  const note = async (name: string) => {
    const path = resolve(home, name);
    await writeFile(path, "# Syllabus\n\nWeekly lectures and recitations.\n");
    return path;
  };
  return { library, operations, studiedIds, log, file, note };
}

describe("library operations", () => {
  it("import files, queue new lectures for study and report each file that failed", async () => {
    const { operations, log, file, note } = await setup();
    const course = await operations.createCourse({ name: "Algorithms" });
    const results = await operations.importFiles(course.id, [
      await file("Lecture 1.pdf"),
      await note("Syllabus.md"),
      resolve(tmpdir(), "folio-missing-file.pdf"),
    ]);
    expect(results.map((result) => ("error" in result ? "failed" : result.document.role))).toEqual([
      "lecture",
      "asset",
      "failed",
    ]);
    const lecture = results[0]!;
    if ("error" in lecture) throw new Error("expected a document");
    expect(log).toEqual([
      "changed",
      "changed",
      `study ${course.id}: ${lecture.document.id}`,
      "assignments",
    ]);
  });

  it("rename a studied lecture without studying it again or touching its study notes", async () => {
    const { library, operations, studiedIds, log, file } = await setup();
    const course = await operations.createCourse({ name: "Algorithms" });
    const { document } = await library.importFile(course.id, await file("R01.pdf"));
    studiedIds.add(document.id);
    log.length = 0;
    const renamed = await operations.updateDocument(
      document.id,
      { title: "  Recitation 1  " },
      document.revision,
    );
    expect(renamed.title).toBe("Recitation 1");
    expect(log).toEqual(["changed"]);
  });

  it("take a lecture that stops being studied out of the study notes, and study one that starts", async () => {
    const { library, operations, studiedIds, log, file } = await setup();
    const course = await operations.createCourse({ name: "Algorithms" });
    const { document } = await library.importFile(course.id, await file("Lecture 2.pdf"));
    studiedIds.add(document.id);
    log.length = 0;
    const homework = await operations.updateDocument(
      document.id,
      { role: "assignment" },
      document.revision,
    );
    expect(log).toEqual([
      `withdraw ${document.id}`,
      `revise ${course.id}: Lecture 2 is no longer studied`,
      "assignments",
      "changed",
    ]);
    studiedIds.clear();
    log.length = 0;
    await operations.updateDocument(document.id, { role: "lecture" }, homework.revision);
    expect(log).toEqual([`study ${course.id}: ${document.id}`, "changed"]);
  });

  it("move a studied lecture to another course: out of the old course's notes, studied in the new", async () => {
    const { library, operations, studiedIds, log, file } = await setup();
    const from = await operations.createCourse({ name: "Algorithms" });
    const to = await operations.createCourse({ name: "Complexity" });
    const { document } = await library.importFile(from.id, await file("Lecture 3.pdf"));
    studiedIds.add(document.id);
    log.length = 0;
    await operations.updateDocument(document.id, { courseId: to.id }, document.revision);
    expect(log).toEqual([
      `withdraw ${document.id}`,
      `revise ${from.id}: Lecture 3 is no longer studied`,
      `study ${to.id}: ${document.id}`,
      "changed",
    ]);
  });

  it("rename a course and change its details, refusing a stale revision", async () => {
    const { operations } = await setup();
    const course = await operations.createCourse({ name: "Algorithms", code: "CS 201" });
    const renamed = await operations.updateCourse(
      course.id,
      { name: "Design of Algorithms", term: "Fall 2026", color: "teal" },
      course.revision,
    );
    expect(renamed).toMatchObject({
      name: "Design of Algorithms",
      code: "CS 201",
      term: "Fall 2026",
      color: "teal",
      revision: 2,
    });
    await expect(
      operations.updateCourse(course.id, { name: "Old" }, course.revision),
    ).rejects.toThrow();
  });
});

describe("categories", () => {
  const lab: Category = {
    id: "lab",
    name: "Lab",
    plural: "Labs",
    kind: "assignment",
    match: ["lab"],
    naming: null,
  };

  it("file new files by the words in their names, R01 among recitations", async () => {
    const { operations, file } = await setup();
    await operations.setCategories([...DEFAULT_CATEGORIES, lab]);
    const course = await operations.createCourse({ name: "Complexity" });
    const results = await operations.importFiles(course.id, [
      await file("R01.pdf"),
      await file("lab_3.pdf"),
      await file("HW3_sol.pdf"),
      await file("week 2.pdf"),
    ]);
    expect(
      results.map((result) =>
        "error" in result ? result.error : [result.document.category, result.document.role],
      ),
    ).toEqual([
      ["recitation", "recitation"],
      ["lab", "assignment"],
      ["solution", "solution"],
      ["lecture", "lecture"],
    ]);
  });

  it("move a file between categories of one kind without touching its study notes", async () => {
    const { library, operations, studiedIds, log, file } = await setup();
    await operations.setCategories([
      ...DEFAULT_CATEGORIES,
      { ...lab, id: "workshop", name: "Workshop", plural: "Workshops", kind: "lecture" },
    ]);
    const course = await operations.createCourse({ name: "Complexity" });
    const { document } = await library.importFile(course.id, await file("Lecture 4.pdf"));
    studiedIds.add(document.id);
    log.length = 0;
    const moved = await operations.updateDocument(
      document.id,
      { category: "workshop" },
      document.revision,
    );
    expect(moved).toMatchObject({ category: "workshop", role: "lecture" });
    expect(log).toEqual(["changed"]);
    // A role alone picks the first category of that kind.
    const homework = await operations.updateDocument(
      document.id,
      { role: "assignment" },
      moved.revision,
    );
    expect(homework.category).toBe("assignment");
    await expect(
      operations.updateDocument(document.id, { category: "missing" }, homework.revision),
    ).rejects.toThrow("Unknown category.");
  });

  it("rename a category in use, but refuse to remove it or change its kind", async () => {
    const { library, operations, file } = await setup();
    const course = await operations.createCourse({ name: "Complexity" });
    await library.importFile(course.id, await file("R01.pdf"), { role: "recitation" });
    const renamed = DEFAULT_CATEGORIES.map((category) =>
      category.id === "recitation" ? { ...category, name: "Tirgul", plural: "Tirgulim" } : category,
    );
    await operations.setCategories(renamed);
    await expect(
      operations.setCategories(renamed.filter((category) => category.id !== "recitation")),
    ).rejects.toThrow("1 file is in Tirgulim. Move them to another category first.");
    await expect(
      operations.setCategories(
        renamed.map((category) =>
          category.id === "recitation" ? { ...category, kind: "asset" as const } : category,
        ),
      ),
    ).rejects.toThrow("1 file is in Tirgulim");
    // An unused category goes freely.
    await operations.setCategories(renamed.filter((category) => category.id !== "solution"));
  });
});

describe("numbers and names from a pattern", () => {
  it("number new files from their names, or the next in their category, keeping their names", async () => {
    const { operations, file } = await setup();
    const course = await operations.createCourse({ name: "Complexity", code: "CS 236" });
    const results = await operations.importFiles(course.id, [
      await file("CS236_R02.pdf"),
      await file("Recitation notes.pdf"),
      await file("lec_2026_4.pdf"),
    ]);
    expect(
      results.map((result) =>
        "error" in result ? result.error : [result.document.title, result.document.number],
      ),
    ).toEqual([
      ["CS236 R02", 2],
      ["Recitation notes", 3],
      ["lec 2026 4", 4],
    ]);
  });

  it("name new files by their category's pattern, unless a name was chosen", async () => {
    const { operations, file } = await setup();
    await operations.setCategories(
      DEFAULT_CATEGORIES.map((category) =>
        category.id === "recitation" ? { ...category, naming: "{category} {n}" } : category,
      ),
    );
    await operations.setNaming("{code} {category} {n:2}");
    const course = await operations.createCourse({ name: "Complexity" });
    const results = await operations.importFiles(course.id, [
      await file("R01.pdf"),
      await file("R1 again.pdf"),
      await file("lec3.pdf"),
      { path: await file("R05.pdf"), title: "Midterm review" },
    ]);
    expect(
      results.map((result) =>
        "error" in result ? result.error : [result.document.title, result.document.named],
      ),
    ).toEqual([
      ["Recitation 1", "pattern"],
      ["Recitation 1 (2)", "pattern"],
      // The course has no code, so the field and its space are left out.
      ["Lecture 03", "pattern"],
      ["Midterm review", "own"],
    ]);
  });

  it("follow a new number, category or course name, until renamed by hand", async () => {
    const { library, operations, file } = await setup();
    await operations.setNaming("{course} {category} {n}");
    const course = await operations.createCourse({ name: "Complexity" });
    const [imported] = await operations.importFiles(course.id, [await file("R01.pdf")]);
    if (!imported || "error" in imported) throw new Error("expected a document");
    expect(imported.document.title).toBe("Complexity Recitation 1");
    const renumbered = await operations.updateDocument(
      imported.document.id,
      { number: 4 },
      imported.document.revision,
    );
    expect(renumbered.title).toBe("Complexity Recitation 4");
    await operations.updateCourse(course.id, { name: "Computability" }, course.revision);
    expect((await library.document(imported.document.id)).title).toBe("Computability Recitation 4");
    const own = await operations.updateDocument(
      imported.document.id,
      { title: "The halting problem" },
      (await library.document(imported.document.id)).revision,
    );
    expect(own.named).toBe("own");
    await operations.updateDocument(imported.document.id, { number: 5 }, own.revision);
    expect((await library.document(imported.document.id)).title).toBe("The halting problem");
  });

  it("rename existing files to the pattern only when asked, and undo it", async () => {
    const { library, operations, file } = await setup();
    const course = await operations.createCourse({ name: "Complexity" });
    await operations.importFiles(course.id, [await file("R01.pdf"), await file("R02.pdf")]);
    await operations.setNaming("{category} {n}");
    // Files that came in before the pattern keep their names.
    const titles = async () =>
      (await library.listDocuments({ courseId: course.id })).map((document) => document.title);
    expect(await titles()).toEqual(["R01", "R02"]);
    const planned = await operations.renames({ courseId: course.id, categoryId: "recitation" });
    expect(planned.map((rename) => [rename.title, rename.next])).toEqual([
      ["R01", "Recitation 1"],
      ["R02", "Recitation 2"],
    ]);
    const done = await operations.applyNaming({ courseId: course.id });
    expect(await titles()).toEqual(["Recitation 1", "Recitation 2"]);
    // One renamed by hand since keeps its new name when the rest are put back.
    const first = (await library.listDocuments({ courseId: course.id }))[0]!;
    await operations.updateDocument(first.id, { title: "Turing machines" }, first.revision);
    expect(await operations.undoNaming(done)).toBe(1);
    expect((await titles()).sort()).toEqual(["R02", "Turing machines"]);
  });

  it("number every file from before numbers once, by name and then in order", async () => {
    const { library, operations, file } = await setup();
    const course = await library.createCourse({ name: "Algorithms", code: "CS 201" });
    for (const name of ["Graph search.pdf", "CS201 Lecture 3.pdf", "Shortest paths.pdf"])
      await library.importFile(course.id, await file(name));
    expect(await operations.numberAll()).toBe(3);
    const numbers = (await library.listDocuments({ courseId: course.id })).map((document) => [
      document.title,
      document.number,
    ]);
    expect(numbers).toEqual([
      ["CS201 Lecture 3", 3],
      ["Graph search", 4],
      ["Shortest paths", 5],
    ]);
    expect(await operations.numberAll()).toBe(0);
  });
});
