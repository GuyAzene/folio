import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { buildInventory } from "../src/ingest/inventory.ts";
import { closeSource, openSource, pageText } from "../src/ingest/pages.ts";
import { syllabusText } from "../src/library/syllabus.ts";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pageTextWithin } from "../src/library/course-tools.ts";
import { fontEmphasis, pageFontEmphasis, pdfPageText } from "../src/library/pdf.ts";
import { syntheticPdf, type SyntheticLine, type SyntheticRun } from "./fixtures/synthetic-pdf.ts";

const run = (font: string) => (text: string) => ({ text, font });
const regular = run("Helvetica");
const bold = run("Helvetica-Bold");
const italic = run("Helvetica-Oblique");
const both = run("Helvetica-BoldOblique");

/** A synthetic assignment whose emphasis is set in its fonts, as a word processor writes it. */
const ASSIGNMENT: SyntheticLine[][] = [
  [
    [regular("Question 1. Prove that the algorithm "), bold("always terminates"), regular(".")],
    [italic("Hint:"), regular(" use induction on "), both("the number of calls"), regular(".")],
    [bold("Due "), both("Sunday"), bold(" at noon")],
    [
      regular("Let "),
      run("LMMathItalic10-Regular")("x"),
      regular(" and "),
      run("CMMI10")("y"),
      regular(" be odd."),
    ],
    [bold("Part one"), regular(" "), bold("continues")],
    "Compute 2 * 3 by hand.",
    // Names pdf.js itself doesn't read a style from: a subset font, and Adobe's short "It".
    [
      run("ABCDEF+Calibri-Bold")("Calibri bold"),
      regular(" and "),
      run("MinionPro-It")("Minion italic"),
    ],
  ],
  [[bold("A bold line that")], [bold("wraps onto the next")]],
  // A printed backslash before an asterisk, or before a mark, could read as escaping it.
  [[regular("Type \\* or C:\\temp\\"), bold("now")]],
];

/** The same words, all in Helvetica. */
const PLAIN = ASSIGNMENT.map((lines) =>
  lines.map((line) =>
    typeof line === "string" ? line : line.map((part: SyntheticRun) => part.text).join(""),
  ),
);

async function textOf(
  data: Uint8Array,
  page: number,
  options: { fontNames?: boolean; emphasis?: boolean } = {},
): Promise<string> {
  const doc = await openSource(data, { fontNames: options.fontNames ?? false });
  try {
    return await pdfPageText(doc, page, { emphasis: options.emphasis ?? false });
  } finally {
    await closeSource(doc);
  }
}

describe("bold and italic from a PDF's fonts", () => {
  it("names the style a font's own name gives", () => {
    const style = (name: string) => {
      const { bold, italic } = fontEmphasis(name);
      return bold && italic ? "bold italic" : bold ? "bold" : italic ? "italic" : "plain";
    };
    expect(
      Object.fromEntries(
        [
          "ABCDEF+Calibri-Bold",
          "BCDEEE+Calibri-Italic",
          "Calibri-BoldItalic",
          "Arial,BoldItalic",
          "TimesNewRomanPS-BoldItalicMT",
          "Helvetica-Oblique",
          "MinionPro-It",
          "MinionPro-SemiboldIt",
          "LMRoman10-Bold",
          "CMBX10",
          "CMTI10",
          "CMBXTI10",
          "Calibri",
          "Calibri-Light",
          "ArialMT",
        ].map((name) => [name, style(name)]),
      ),
    ).toEqual({
      "ABCDEF+Calibri-Bold": "bold",
      "BCDEEE+Calibri-Italic": "italic",
      "Calibri-BoldItalic": "bold italic",
      "Arial,BoldItalic": "bold italic",
      "TimesNewRomanPS-BoldItalicMT": "bold italic",
      "Helvetica-Oblique": "italic",
      "MinionPro-It": "italic",
      "MinionPro-SemiboldIt": "bold italic",
      "LMRoman10-Bold": "bold",
      CMBX10: "bold",
      CMTI10: "italic",
      CMBXTI10: "bold italic",
      Calibri: "plain",
      "Calibri-Light": "plain",
      ArialMT: "plain",
    });
  });

  it("leaves math and symbol fonts alone, whose italics are math letters", () => {
    for (const name of [
      "ABCDEF+CambriaMath",
      "Cambria Math",
      "LMMathItalic10-Regular",
      "STIXTwoMath-Regular",
      "CMMI10",
      "CMMIB10",
      "CMSY10",
      "MSBM10",
      "Symbol",
      "Wingdings-Regular",
    ])
      expect(fontEmphasis(name), name).toEqual({ bold: false, italic: false });
  });

  it("marks exactly the runs a page sets in bold and italic", async () => {
    const data = syntheticPdf(ASSIGNMENT);
    expect(await textOf(data, 1, { fontNames: true, emphasis: true })).toBe(
      [
        // Part of a line: only the last words are bold, and the period after them is not.
        "Question 1. Prove that the algorithm **always terminates**.",
        "*Hint:* use induction on ***the number of calls***.",
        // Bold italic inside bold nests rather than closing and reopening.
        "**Due *Sunday* at noon**",
        // Math letters are italic in their fonts, not emphasis.
        "Let x and y be odd.",
        // Neighbouring bold runs join across a plain space.
        "**Part one continues**",
        // A printed asterisk can't be taken for a mark.
        "Compute 2 \\* 3 by hand.",
        "**Calibri bold** and *Minion italic*",
      ].join("\n"),
    );
    // Each line closes its own marks.
    expect(await textOf(data, 2, { fontNames: true, emphasis: true })).toBe(
      "**A bold line that**\n**wraps onto the next**",
    );
    // Only those backslashes double; a path's keep their meaning.
    expect(await textOf(data, 3, { fontNames: true, emphasis: true })).toBe(
      "Type \\\\\\* or C:\\temp\\\\**now**",
    );
  });

  it("reads a font pdf.js can't load as plain, and still marks the rest", async () => {
    const object = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>";
    const pages = [[[italic("Not a font"), regular(" then "), bold("bold")]]];
    // The same length keeps the file's offsets right.
    const broken = new TextEncoder().encode(
      new TextDecoder()
        .decode(syntheticPdf(pages))
        .split(object)
        .join("(not a font)".padEnd(object.length)),
    );
    expect(await textOf(broken, 1, { fontNames: true, emphasis: true })).toBe(
      "Not a font then **bold**",
    );
  });

  it("gives up on fonts that don't arrive, and stops when the read is cancelled", async () => {
    /** A page whose layout sets font f1, which never arrives, and whose f2 failed to load. */
    const stalled = {
      commonObjs: {
        has: (id: string) => id === "f2",
        get: (id: string, settled?: (data: unknown) => void) => (settled ? null : `${id} failed`),
      },
      getOperatorList: async () => ({ fnArray: [OPS.setFont], argsArray: [["f1", 14]] }),
    } as unknown as PDFPageProxy;
    expect(await pageFontEmphasis(stalled, ["f1", "f2"], { wait: 20 })).toEqual(
      new Map([
        ["f1", { bold: false, italic: false }],
        ["f2", { bold: false, italic: false }],
      ]),
    );
    const cancel = new AbortController();
    const reading = pageFontEmphasis(stalled, ["f1"], { signal: cancel.signal });
    cancel.abort(new Error("The student stopped the reply"));
    await expect(reading).rejects.toThrow("The student stopped the reply");
    await expect(pageFontEmphasis(stalled, ["f1"], { signal: cancel.signal })).rejects.toThrow(
      "The student stopped the reply",
    );
  });

  it("cuts a long marked page at a line's end, where its marks have closed", () => {
    const lines = Array.from({ length: 40 }, (_, n) => `**Line ${n} is bold** and *this italic*`);
    const text = lines.join("\n");
    // A limit inside the eleventh line's bold.
    const cut = pageTextWithin(text, lines.slice(0, 10).join("\n").length + 4);
    expect(cut).toBe(`${lines.slice(0, 10).join("\n")}\n[Page text truncated]`);
    expect(pageTextWithin(text, text.length)).toBe(text);
    // Only a first line longer than the limit is cut inside it.
    expect(pageTextWithin("**one long line**", 6)).toBe("**one \n[Page text truncated]");
  });

  it("marks nothing in a document opened without font names", async () => {
    const data = syntheticPdf(ASSIGNMENT);
    expect(await textOf(data, 1, { emphasis: true })).toBe(
      (await textOf(syntheticPdf(PLAIN), 1)).replaceAll("*", "\\*"),
    );
  });

  it("keeps the text ingestion, study notes and search use exactly as it was", async () => {
    const styled = syntheticPdf(ASSIGNMENT);
    const plain = syntheticPdf(PLAIN);
    for (const page of [1, 2, 3]) {
      // Without the option, even a document opened with font names reads as plain text.
      expect(await textOf(styled, page, { fontNames: true })).toBe(await textOf(plain, page));
      expect(await textOf(styled, page)).toBe(await textOf(plain, page));
    }
    expect(await textOf(styled, 1)).toContain("Compute 2 * 3 by hand.");
    expect(await syllabusText(styled, "pdf")).toBe(await syllabusText(plain, "pdf"));

    // The positioned text layer ingestion builds its inventory from.
    const layer = async (data: Uint8Array) => {
      const doc = await openSource(data);
      try {
        return (await pageText(doc, 1)).map((item) => item.str).join("");
      } finally {
        await closeSource(doc);
      }
    };
    expect(await layer(styled)).toBe(await layer(plain));
    const regions = async (data: Uint8Array) => {
      const sha256 = createHash("sha256").update(data).digest("hex");
      const inventory = await buildInventory(data, sha256);
      return inventory.pages.map((page) => page.regions.map((region) => region.text));
    };
    const stored = await regions(styled);
    expect(stored).toEqual(await regions(plain));
    expect(JSON.stringify(stored)).not.toContain("**");
  });
});
