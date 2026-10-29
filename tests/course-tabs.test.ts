import { describe, expect, it } from "vite-plus/test";
import type { DocumentRole } from "../src/desktop/api.ts";
import { COURSE_TABS, courseTab, MATERIAL_SECTIONS } from "../app/lib/course-tabs.ts";
import { searchScore, shortTitle } from "../app/lib/titles.ts";

describe("course tabs", () => {
  it("keeps today's tabs as saved", () => {
    for (const { tab } of COURSE_TABS) expect(courseTab(tab)).toBe(tab);
  });

  it("opens the per-role tabs saved before 2026-10-29 at Materials", () => {
    for (const old of ["lectures", "recitations", "assignments", "files"])
      expect(courseTab(old)).toBe("materials");
  });

  it("opens anything unknown at Materials", () => {
    for (const value of [undefined, null, "", "practice", 3, { tab: "notes" }])
      expect(courseTab(value)).toBe("materials");
  });

  it("files every document role in exactly one Materials section", () => {
    const roles: DocumentRole[] = ["lecture", "recitation", "assignment", "solution", "asset"];
    for (const role of roles)
      expect(MATERIAL_SECTIONS.filter((section) => section.roles.includes(role))).toHaveLength(1);
  });
});

describe("short titles", () => {
  it("drop the course name a title starts with, where the course is already shown", () => {
    expect(shortTitle("Automata Theory Lecture 1", "Automata Theory")).toBe("Lecture 1");
    expect(shortTitle("automata theory - Recitation 1", "Automata Theory")).toBe("Recitation 1");
    expect(shortTitle("Algorithms: HW 2", "Algorithms")).toBe("HW 2");
  });

  it("keep the title when it doesn't start with the course name, or nothing would be left", () => {
    expect(shortTitle("Lecture 1 Finite automata", "Automata")).toBe("Lecture 1 Finite automata");
    expect(shortTitle("Algorithms", "Algorithms")).toBe("Algorithms");
    expect(shortTitle("Lecture 3", undefined)).toBe("Lecture 3");
  });
});

describe("searching the + menu", () => {
  const value =
    "Automata Theory Recitation 1 Automata Theory CS 236 0f8b2c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

  it("matches every typed word, in any order", () => {
    expect(searchScore(value, "recit")).toBeGreaterThan(0);
    expect(searchScore(value, "1 recitation")).toBeGreaterThan(0);
    expect(searchScore(value, "236")).toBeGreaterThan(0);
    expect(searchScore(value, "lecture")).toBe(0);
  });

  it("matches a number only as a whole number", () => {
    expect(
      searchScore("Lecture 2 Regular languages Computational Models CS 230", "lecture 2"),
    ).toBeGreaterThan(0);
    expect(searchScore("Lecture 1 Graph traversal Algorithms CS 201", "lecture 2")).toBe(0);
  });

  it("does not match letters scattered through a title, or the ID", () => {
    expect(searchScore("Recitation 1 BFS examples Algorithms", "comp")).toBe(0);
    expect(searchScore(value, "0f8b")).toBe(0);
  });

  it("ranks a match at the start of a word above one inside it", () => {
    expect(searchScore(value, "theory")).toBeGreaterThan(searchScore(value, "heory"));
  });
});
