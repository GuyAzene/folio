import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { scanFolder } from "../src/library/scan.ts";
import { guessRole, LibraryError } from "../src/library/store.ts";
import { parseCourseDetails, syllabusText } from "../src/library/syllabus.ts";
import { syntheticPdf } from "./fixtures/synthetic-pdf.ts";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe("folder scan", () => {
  it("lists PDFs and Markdown with guessed roles, skipping hidden files and links", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "folio-scan-test-"));
    homes.push(home);
    const root = resolve(home, "Algorithms");
    await mkdir(resolve(root, "Lectures"), { recursive: true });
    await mkdir(resolve(root, ".obsidian"));
    for (const name of ["Lectures/lec10.pdf", "Lectures/lec2.pdf", "hw1.pdf", "notes.md"])
      await writeFile(resolve(root, name), "%PDF-synthetic");
    await writeFile(resolve(root, "Syllabus 2026.pdf"), "%PDF-synthetic");
    await writeFile(resolve(root, "photo.jpg"), "jpeg");
    await writeFile(resolve(root, ".obsidian", "workspace.md"), "hidden");
    await symlink(resolve(root, "hw1.pdf"), resolve(root, "linked.pdf"));

    const scan = await scanFolder(root);
    expect(scan.folderName).toBe("Algorithms");
    expect(scan.files.map((file) => [file.name, file.role])).toEqual([
      ["hw1.pdf", "assignment"],
      ["Lectures/lec2.pdf", "lecture"],
      ["Lectures/lec10.pdf", "lecture"],
      ["notes.md", "asset"],
      ["Syllabus 2026.pdf", "asset"],
    ]);
    expect(scan.skipped).toBe(1);
    expect(scan.truncated).toBe(false);
    await expect(scanFolder(resolve(root, "hw1.pdf"))).rejects.toBeInstanceOf(LibraryError);
  });
});

describe("syllabus reading", () => {
  it("takes the opening pages' text and only well-formed details from the reply", async () => {
    const text = await syllabusText(
      syntheticPdf([["CS 202 Data Structures", "Fall 2026"], ["Grading"]]),
      "pdf",
    );
    expect(text).toContain("CS 202 Data Structures");
    expect(text).toContain("Grading");

    expect(
      parseCourseDetails(
        'Here you go: {"name": "  Data Structures ", "code": "CS 202", "term": "Fall 2026"}',
      ),
    ).toEqual({ name: "Data Structures", code: "CS 202", term: "Fall 2026" });
    expect(parseCourseDetails('{"name": 4, "code": ["x"]}')).toBeNull();
    expect(parseCourseDetails("No JSON here")).toBeNull();
    expect(parseCourseDetails(`{"name": "${"x".repeat(200)}"}`)!.name).toHaveLength(80);
    expect(guessRole("Syllabus_CS202.pdf", "pdf")).toBe("asset");
  });
});
