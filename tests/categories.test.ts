import { describe, expect, it } from "vite-plus/test";
import {
  categoryId,
  categoryOf,
  DEFAULT_CATEGORIES,
  guessCategory,
  hasWord,
  readCategories,
} from "../src/library/categories.ts";
import { readConfig } from "../src/config.ts";
import { modelCatalog } from "../src/connections.ts";

describe("categories", () => {
  it("find a category's words in file names the way students name them", () => {
    expect(hasWord("R01.pdf", "R")).toBe(true);
    expect(hasWord("Recursion.pdf", "R")).toBe(false);
    expect(hasWord("lec05_graphs.pdf", "lec")).toBe(true);
    expect(hasWord("Lectures week 2.pdf", "lecture")).toBe(true);
    expect(hasWord("recursion.pdf", "rec")).toBe(false);
    expect(hasWord("hw 3.pdf", "hw")).toBe(true);
    expect(hasWord("hw.pdf", "hw")).toBe(false);
    expect(hasWord("problemset4.pdf", "problem set")).toBe(true);
    expect(hasWord("בתרגול 3.pdf", "תרגול")).toBe(true);
  });

  it("guess like Folio always has, with a solution or a syllabus winning over other words", () => {
    const guess = (name: string, kind: "pdf" | "markdown" = "pdf") =>
      guessCategory(name, kind, DEFAULT_CATEGORIES).id;
    expect(guess("HW3_solution.pdf")).toBe("solution");
    expect(guess("hw3.pdf")).toBe("assignment");
    expect(guess("Tirgul 4.pdf")).toBe("recitation");
    expect(guess("R02.pdf")).toBe("recitation");
    expect(guess("Syllabus with lecture plan.pdf")).toBe("asset");
    expect(guess("week 3.pdf")).toBe("lecture");
    expect(guess("notes.md", "markdown")).toBe("asset");
  });

  it("show a file under the first category of its role when its own is gone", () => {
    const custom = [
      { ...DEFAULT_CATEGORIES[1]!, id: "tirgul", name: "Tirgul", plural: "Tirgulim" },
      ...DEFAULT_CATEGORIES.filter((category) => category.kind !== "recitation"),
    ];
    expect(categoryOf({ role: "recitation", category: "recitation" }, custom).id).toBe("tirgul");
    expect(categoryOf({ role: "recitation" }, custom).id).toBe("tirgul");
    // A category whose kind no longer matches the file's role is not the file's.
    expect(categoryOf({ role: "lecture", category: "tirgul" }, custom).id).toBe("lecture");
  });

  it("read config.json's list, reporting entries Folio can't use and keeping the rest", () => {
    const { categories, problems } = readCategories({
      categories: [
        { id: "lecture", name: "Lecture", kind: "lecture", match: ["lec"] },
        { id: "Lab", name: "Lab", kind: "assignment" },
        { id: "lab", name: "Lab", kind: "practice" },
        { id: "lecture", name: "Again", kind: "lecture" },
      ],
    });
    expect(categories.map((category) => [category.id, category.plural])).toEqual([
      ["lecture", "Lectures"],
    ]);
    expect(problems).toEqual([
      'library.categories[1].id: use lowercase letters, digits and dashes, such as "lab".',
      'library.categories[2].kind: use one of "lecture", "recitation", "assignment", "solution", "asset".',
      'library.categories[3].id: "lecture" is used twice.',
    ]);
    expect(readCategories({ categories: [] }).categories).toHaveLength(5);
  });

  it("come from config.json beside the models, and default to today's five", () => {
    const catalog = modelCatalog();
    expect(readConfig(catalog, undefined).categories.map((category) => category.id)).toEqual([
      "lecture",
      "recitation",
      "assignment",
      "solution",
      "asset",
    ]);
    const state = readConfig(catalog, {
      version: 1,
      library: { categories: [{ id: "lab", name: "Lab", kind: "assignment", match: ["lab"] }] },
    });
    expect(state.categories).toEqual([
      { id: "lab", name: "Lab", plural: "Labs", kind: "assignment", match: ["lab"], naming: null },
    ]);
    expect(state.problems).toEqual([]);
  });

  it("make a new category's id from its name, unlike the others", () => {
    expect(categoryId("Lab Reports", [])).toBe("lab-reports");
    expect(categoryId("Lab", ["lab"])).toBe("lab-2");
    expect(categoryId("תרגילים", [])).toBe("category");
  });
});
