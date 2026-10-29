import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { closePdf, openPdf, pdfPageText } from "../src/library/pdf.ts";
import {
  guessRole,
  LibraryConflictError,
  LibraryError,
  LibraryIntegrityError,
  LibraryStore,
  titleFromName,
} from "../src/library/store.ts";
import { SYNTHETIC_LECTURE, syntheticPdf } from "./fixtures/synthetic-pdf.ts";

const homes: string[] = [];

async function setup(): Promise<{ store: LibraryStore; home: string; pdf: string }> {
  const home = await mkdtemp(resolve(tmpdir(), "folio-library-test-"));
  homes.push(home);
  const pdf = resolve(home, "lec01_graph-traversal.pdf");
  await writeFile(pdf, syntheticPdf(SYNTHETIC_LECTURE));
  return { store: await LibraryStore.open({ home: resolve(home, "data") }), home, pdf };
}

afterEach(async () => {
  for (const home of homes.splice(0)) {
    // Imported originals are read-only; make them removable before cleanup.
    await rm(home, { recursive: true, force: true }).catch(async () => {
      await chmod(home, 0o700);
      await rm(home, { recursive: true, force: true });
    });
  }
});

describe("course library", () => {
  it("copies a PDF in read-only, counts pages, guesses role and title, and reuses duplicates", async () => {
    const { store, pdf } = await setup();
    const course = await store.createCourse({
      name: "Algorithms",
      code: "CS 201",
      term: "Spring 2026",
    });
    expect(course).toMatchObject({ name: "Algorithms", color: "graphite", revision: 1 });

    const { document, duplicate } = await store.importFile(course.id, pdf);
    expect(duplicate).toBe(false);
    expect(document).toMatchObject({
      courseId: course.id,
      title: "lec01 graph traversal",
      role: "lecture",
      kind: "pdf",
      pages: 3,
      originalName: "lec01_graph-traversal.pdf",
    });
    const original = resolve(store.root, "documents", document.id, "original.pdf");
    expect((await stat(original)).mode & 0o777).toBe(0o400);
    const { data } = await store.readOriginal(document.id);
    expect(Buffer.from(data).equals(await readFile(pdf))).toBe(true);

    const again = await store.importFile(course.id, pdf);
    expect(again).toEqual({ document, duplicate: true });
    expect(await store.listDocuments({ courseId: course.id })).toHaveLength(1);

    const other = await store.createCourse({ name: "Computational Models" });
    expect(other.color).toBe("blue");
    expect((await store.importFile(other.id, pdf)).duplicate).toBe(false);
    expect(await store.listDocuments()).toHaveLength(2);
  });

  it("extracts page text for Folio to read", async () => {
    const { store, pdf } = await setup();
    const course = await store.createCourse({ name: "Algorithms" });
    const { document } = await store.importFile(course.id, pdf);
    const reader = await openPdf((await store.readOriginal(document.id)).data);
    try {
      expect(await pdfPageText(reader, 2)).toContain("enqueued at most once");
    } finally {
      await closePdf(reader);
    }
  });

  it("refuses to open an original whose bytes changed after import", async () => {
    const { store, pdf } = await setup();
    const course = await store.createCourse({ name: "Algorithms" });
    const { document } = await store.importFile(course.id, pdf);
    const original = resolve(store.root, "documents", document.id, "original.pdf");
    await chmod(original, 0o600);
    await writeFile(original, syntheticPdf([["Tampered page"]]));
    await expect(store.readOriginal(document.id)).rejects.toBeInstanceOf(LibraryIntegrityError);
  });

  it("rejects stale revisions and edits made outside Folio instead of overwriting them", async () => {
    const { store } = await setup();
    const course = await store.createCourse({ name: "Algorithms" });
    const renamed = await store.updateCourse(course.id, { name: "Algorithms I" }, 1);
    expect(renamed).toMatchObject({ name: "Algorithms I", revision: 2 });
    await expect(store.updateCourse(course.id, { name: "Stale" }, 1)).rejects.toBeInstanceOf(
      LibraryConflictError,
    );

    await store.course(course.id);
    const file = resolve(store.root, "courses", course.id, "course.json");
    const external = { ...JSON.parse(await readFile(file, "utf8")), name: "Edited in Finder" };
    await writeFile(file, JSON.stringify(external));
    await expect(store.updateCourse(course.id, { color: "red" }, 2)).rejects.toBeInstanceOf(
      LibraryConflictError,
    );
    expect(JSON.parse(await readFile(file, "utf8")).name).toBe("Edited in Finder");
  });

  it("moves and reclassifies documents with revision checks", async () => {
    const { store, pdf } = await setup();
    const first = await store.createCourse({ name: "Algorithms" });
    const second = await store.createCourse({ name: "Data Structures" });
    const { document } = await store.importFile(first.id, pdf);
    const moved = await store.updateDocument(
      document.id,
      { courseId: second.id, role: "recitation", title: "Recitation 1" },
      1,
    );
    expect(moved).toMatchObject({ courseId: second.id, role: "recitation", revision: 2 });
    await expect(
      store.updateDocument(document.id, { role: "notes" as never }, 2),
    ).rejects.toBeInstanceOf(LibraryError);
    await expect(store.updateDocument(document.id, { title: "x" }, 1)).rejects.toBeInstanceOf(
      LibraryConflictError,
    );
  });

  it("rejects unsupported, disguised and linked files and path traversal", async () => {
    const { store, home, pdf } = await setup();
    const course = await store.createCourse({ name: "Algorithms" });
    const text = resolve(home, "notes.txt");
    await writeFile(text, "plain text");
    await expect(store.importFile(course.id, text)).rejects.toThrow("PDF and Markdown");
    const fake = resolve(home, "fake.pdf");
    await writeFile(fake, "not a pdf");
    await expect(store.importFile(course.id, fake)).rejects.toThrow("not a PDF");
    const link = resolve(home, "link.pdf");
    await symlink(pdf, link);
    await expect(store.importFile(course.id, link)).rejects.toThrow("not a regular file");
    await expect(store.course("../../etc")).rejects.toBeInstanceOf(LibraryError);
    await expect(store.readOriginal("../courses")).rejects.toBeInstanceOf(LibraryError);
    await expect(store.createCourse({ name: "  " })).rejects.toThrow("name");
  });

  it("imports Markdown as UTF-8 and guesses roles from common file names", async () => {
    const { store, home } = await setup();
    const course = await store.createCourse({ name: "Algorithms" });
    const markdown = resolve(home, "recitation_3.md");
    await writeFile(markdown, "# Recitation 3\n\nSynthetic.");
    const { document } = await store.importFile(course.id, markdown);
    expect(document).toMatchObject({ kind: "markdown", pages: null, role: "recitation" });
    expect(guessRole("HW3_solution.pdf", "pdf")).toBe("solution");
    expect(guessRole("hw3.pdf", "pdf")).toBe("assignment");
    expect(guessRole("Tirgul 4.pdf", "pdf")).toBe("recitation");
    expect(guessRole("syllabus.md", "markdown")).toBe("asset");
    expect(titleFromName("Lecture_05 - Graph traversal.pdf")).toBe("Lecture 05 Graph traversal");
  });
});
