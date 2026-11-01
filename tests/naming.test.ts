import { describe, expect, it } from "vite-plus/test";
import { readCategories, readNaming } from "../src/library/categories.ts";
import {
  applyPattern,
  nextNumber,
  numberFromName,
  titleFromName,
  uniqueTitle,
  unknownFields,
} from "../src/library/naming.ts";

const values = {
  category: "Recitation",
  course: "Complexity",
  code: "CS 236",
  term: "Spring 2026",
  number: 3,
  name: "R03",
};

describe("file numbers", () => {
  it("come from the first number in a name, past the course code and years", () => {
    expect(numberFromName("R01.pdf")).toBe(1);
    expect(numberFromName("cs201_rec_03.pdf", "CS 201")).toBe(3);
    expect(numberFromName("Tirgul 4.pdf")).toBe(4);
    expect(numberFromName("Lecture 3 part 2.pdf")).toBe(3);
    expect(numberFromName("2026 lecture 7.pdf")).toBe(7);
    expect(numberFromName("תרגול 5.pdf")).toBe(5);
    expect(numberFromName("Syllabus 2026.pdf")).toBeNull();
    expect(numberFromName("Graph search.pdf")).toBeNull();
  });

  it("follow the highest one taken when a name gives none", () => {
    expect(nextNumber([])).toBe(1);
    expect(nextNumber([2, null, 7, undefined])).toBe(8);
  });
});

describe("naming patterns", () => {
  it("fill in each field, padding the number when asked", () => {
    expect(applyPattern("{category} {n}", values)).toBe("Recitation 3");
    expect(applyPattern("{category}_{course}_{n:2}", values)).toBe("Recitation_Complexity_03");
    expect(applyPattern("{code} · {category} {n}: {name}", values)).toBe(
      "CS 236 · Recitation 3: R03",
    );
  });

  it("leave out an empty field with the separator before it", () => {
    const bare = { ...values, code: "", term: "" };
    expect(applyPattern("{code} {category} {n}", bare)).toBe("Recitation 3");
    expect(applyPattern("{category}_{code}_{n}", bare)).toBe("Recitation_3");
    expect(applyPattern("{category} {n} ({term})", bare)).toBe("Recitation 3");
    expect(applyPattern("{category} {n}", { ...values, number: null })).toBe("Recitation");
    expect(applyPattern("{code}", bare)).toBe("R03");
  });

  it("name fields Folio doesn't know, and refuse them in config.json", () => {
    expect(unknownFields("{category} {week} {n:2} {x}")).toEqual(["week", "x"]);
    expect(readNaming({ naming: "{category} {week}" })).toEqual({
      naming: null,
      problems: [
        "library.naming: Folio has no field {week}; use {category}, {course}, {code}, {term}, {n}, {n:2} or {name}.",
      ],
    });
    expect(readNaming({ naming: "{category} {n}" }).naming).toBe("{category} {n}");
    expect(
      readCategories({
        categories: [{ id: "lab", name: "Lab", kind: "assignment", naming: "{lab}" }],
      }).problems[0],
    ).toMatch(/^library\.categories\[0\]\.naming: Folio has no field \{lab\}/);
  });

  it("give a second file of the same name a number in brackets", () => {
    expect(uniqueTitle("Recitation 1", ["Lecture 1"])).toBe("Recitation 1");
    expect(uniqueTitle("Recitation 1", ["recitation 1", "Recitation 1 (2)"])).toBe(
      "Recitation 1 (3)",
    );
  });

  it("clean a file's own name as before", () => {
    expect(titleFromName("Lecture_05 - Graph traversal.pdf")).toBe("Lecture 05 Graph traversal");
    expect(titleFromName("/folder/lec05_graph-traversal.pdf")).toBe("lec05 graph traversal");
    expect(titleFromName(".pdf")).toBe("Untitled");
  });
});
