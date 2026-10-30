import { describe, expect, it } from "vite-plus/test";
import type { SourceView } from "../src/desktop/api.ts";
import { formatPages, pageRuns, runLabel } from "../app/lib/labels.ts";
import { foldSources, groupSources, readSummary } from "../app/lib/sources.ts";

const LECTURE = "00000000-0000-4000-8000-000000000011";
const RECITATION = "00000000-0000-4000-8000-000000000012";
const read = (documentId: string, title: string, pages: number[]): SourceView[] =>
  pages.map((page) => ({ documentId, title, page }));

/** A topic map's reading, in the order the tutor went: back and forth between two files. */
const WEEK = [
  ...read(LECTURE, "Lecture 2", [4, 6, 9, 10, 12, 11, 19, 20, 21, 22, 36, 35]),
  ...read(RECITATION, "Recitation 2", [28, 10, 12, 8, 9, 11]),
  ...read(LECTURE, "Lecture 2", [45, 46, 50, 51, 52, 53, 49]),
  ...read(RECITATION, "Recitation 2", [17, 18, 19]),
  ...read(LECTURE, "Lecture 2", [57]),
];

describe("page runs", () => {
  it("sorts pages and runs together the ones that follow on", () => {
    expect(pageRuns([5, 1, 2, 3, 2]).map(runLabel)).toEqual(["1–3", "5"]);
    expect(pageRuns([9, 12, 10, 11, 4]).map(runLabel)).toEqual(["4", "9–12"]);
    expect(pageRuns([])).toEqual([]);
  });

  it("keeps formatPages as it was", () => {
    expect(formatPages([8])).toBe("Page 8");
    expect(formatPages([8, 8])).toBe("Page 8");
    expect(formatPages([3, 1, 2])).toBe("Pages 1–3");
    expect(formatPages([1, 2, 5])).toBe("Pages 1–2, 5");
    expect(formatPages([4, 5])).toBe("Pages 4–5");
    expect(formatPages([])).toBe("");
  });
});

describe("a reply's sources", () => {
  it("groups pages by file, in the order each file was first read", () => {
    const groups = groupSources(WEEK);
    expect(groups.map((group) => group.title)).toEqual(["Lecture 2", "Recitation 2"]);
    expect(groups.map((group) => group.runs.map(runLabel).join(", "))).toEqual([
      "4, 6, 9–12, 19–22, 35–36, 45–46, 49–53, 57",
      "8–12, 17–19, 28",
    ]);
    expect(groups[0]!.pages).toEqual([
      4, 6, 9, 10, 11, 12, 19, 20, 21, 22, 35, 36, 45, 46, 49, 50, 51, 52, 53, 57,
    ]);
  });

  it("counts a page read twice once", () => {
    const groups = groupSources([
      ...read(LECTURE, "Lecture 2", [3, 4]),
      ...read(LECTURE, "Lecture 2", [4]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pages).toEqual([3, 4]);
  });

  it("keeps files apart when they share a title", () => {
    const groups = groupSources([
      ...read(LECTURE, "Notes", [1]),
      ...read(RECITATION, "Notes", [1]),
    ]);
    expect(groups.map((group) => group.documentId)).toEqual([LECTURE, RECITATION]);
  });

  it("folds a long reading into one line", () => {
    const groups = groupSources(WEEK);
    expect(foldSources(groups)).toBe(true);
    expect(readSummary(groups)).toBe("Read 29 pages from 2 files");
  });

  it("names the file when one gave every page", () => {
    const groups = groupSources(read(LECTURE, "Lecture 2", [1, 3, 5, 7]));
    expect(foldSources(groups)).toBe(true);
    expect(readSummary(groups)).toBe("Read 4 pages from Lecture 2");
  });

  it("shows one or two pages as they are", () => {
    expect(foldSources(groupSources(read(LECTURE, "Lecture 1", [2])))).toBe(false);
    expect(
      foldSources(
        groupSources([
          ...read(LECTURE, "Lecture 1", [2]),
          ...read(RECITATION, "Recitation 1", [5]),
        ]),
      ),
    ).toBe(false);
  });

  it("shows a long run of pages as one chip, not folded", () => {
    const groups = groupSources(read(LECTURE, "Lecture 2", [4, 5, 6, 7, 8, 9, 10, 11]));
    expect(groups[0]!.runs).toEqual([{ first: 4, last: 11 }]);
    expect(foldSources(groups)).toBe(false);
  });

  it("folds once more than three runs would show", () => {
    expect(foldSources(groupSources(read(LECTURE, "Lecture 2", [1, 3, 5])))).toBe(false);
    expect(foldSources(groupSources(read(LECTURE, "Lecture 2", [1, 3, 5, 7])))).toBe(true);
  });
});
