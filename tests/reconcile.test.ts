import { describe, expect, it } from "vite-plus/test";
import { contentTokens, missingNumbers, tokenRecall } from "../src/ingest/reconcile.ts";

describe("matching a reading against a slide's text layer", () => {
  it("reads a PDF's math-italic letters, ligatures and direction marks as plain text", () => {
    expect(tokenRecall("L(𝑀𝐿) = { ⟨𝑀⟩ : 𝑀 accepts }", "L(ML) = { <M> : M accepts }")).toBe(1);
    expect(tokenRecall("deﬁnition of a regular language", "definition of a regular language")).toBe(
      1,
    );
    expect(tokenRecall("\u200Fהגדרה\u200F של שפה רגולרית", "הגדרה של שפה רגולרית")).toBe(1);
  });

  it("counts letters, not UTF-16 units, so 𝑀𝐿 is as short as ML", () => {
    expect(contentTokens("𝑀𝐿 accepts")).toEqual(contentTokens("ML accepts"));
    expect([...contentTokens("𝑀𝐿 accepts")]).toEqual(["accepts"]);
  });

  it("finds subscripted and math-italic symbols written plainly", () => {
    expect(missingNumbers(["𝑥₁", "≤"], "x1 ≤ y")).toEqual([]);
    expect(missingNumbers(["O(V + E)"], "runs in O(V+E) time")).toEqual([]);
    expect(missingNumbers(["2^n"], "grows like n squared")).toEqual(["2^n"]);
  });

  it("reads LaTeX as the symbols the slide prints", () => {
    expect(missingNumbers(["≤", "x1", "∑"], "$x_{1} \\le y$ and $\\sum_{i} a_i$")).toEqual([]);
    expect(missingNumbers(["O(V + E)"], "runs in $O(V+E)$")).toEqual([]);
    expect(missingNumbers(["2^n"], "there are $2^{n}$ subsets")).toEqual([]);
    expect(
      missingNumbers(["ℕ", "∅"], "$f: \\mathbb{N} \\to \\mathbb{N}$, and $L = \\emptyset$"),
    ).toEqual([]);
    expect(
      tokenRecall(
        "L = { w : w has an even number of 1s }",
        "$L = \\{ w : w \\text{ has an even number of } 1s \\}$",
      ),
    ).toBe(1);
    // A symbol the reading really left out is still noticed.
    expect(missingNumbers(["≥"], "$x \\le y$")).toEqual(["≥"]);
  });

  it("still notices a word the reading left out", () => {
    expect(
      tokenRecall("Each vertex is marked when enqueued", "Each vertex is marked"),
    ).toBeLessThan(1);
  });
});
