import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { buildInventory, buildPageInventory, extractNumbers } from "../src/ingest/inventory.ts";
import {
  closeSource,
  openSource,
  pageText,
  renderCrop,
  renderPage,
  textLayerHealth,
  type SourceDocument,
} from "../src/ingest/pages.ts";
import type { Box, PageInventory, SourceInventory } from "../src/ingest/types.ts";
import { SYMBOL, syntheticSlides } from "./fixtures/synthetic-slides.ts";

const DECK = syntheticSlides([
  // 1. Text: a title, two columns and a block with mixed fonts.
  {
    texts: [
      { x: 60, y: 70, size: 28, text: "Synthetic Lecture 2: Graphs" },
      { x: 60, y: 140, text: "A graph has vertices and edges." },
      { x: 60, y: 166, text: "BFS runs in O(V + E) time." },
      { x: 400, y: 140, text: "Pi is about 3.14 and" },
      { x: 400, y: 166, text: "a set has 2^n subsets." },
      { x: 60, y: 300, text: "Indices x_1 and x_2 satisfy x_1 <= x_2." },
      {
        x: 60,
        y: 326,
        runs: [
          { text: "Bounds: a " },
          { text: SYMBOL.lessEqual, font: "symbol" },
          { text: " b and " },
          { text: SYMBOL.sum, font: "symbol" },
          { text: " over q0" },
        ],
      },
    ],
  },
  // 2. Visuals: background, a rule, a bullet, an automaton, a picture and a framed text box.
  {
    shapes: [
      { kind: "rect", x: 0, y: 0, width: 720, height: 540, fill: 0.95 },
      { kind: "line", from: [36, 100], to: [684, 100], width: 0.5 },
      { kind: "arrow", from: [90, 270], to: [120, 270] },
      { kind: "circle", center: [150, 270], radius: 30 },
      { kind: "arrow", from: [180, 270], to: [300, 270] },
      { kind: "circle", center: [330, 270], radius: 30 },
      { kind: "circle", center: [330, 270], radius: 25 },
      { kind: "rect", x: 60, y: 416, width: 5, height: 5, fill: 0 },
      { kind: "rect", x: 60, y: 460, width: 300, height: 40 },
      // A frame drawn around the picture is part of the picture.
      { kind: "rect", x: 450, y: 180, width: 200, height: 150 },
    ],
    images: [{ x: 450, y: 180, width: 200, height: 150 }],
    texts: [
      { x: 60, y: 70, size: 28, text: "Automaton and picture" },
      { x: 140, y: 276, text: "q0" },
      { x: 236, y: 262, size: 14, text: "a" },
      { x: 320, y: 276, text: "q1" },
      { x: 450, y: 360, size: 14, text: "Figure 1: a gradient" },
      { x: 75, y: 422, text: "Notes follow the picture." },
      { x: 70, y: 486, size: 14, text: "A framed definition." },
    ],
  },
  // 3. A slide exported as a picture.
  { images: [{ x: 0, y: 0, width: 720, height: 540, pixels: [64, 48] }] },
  // 4. Right to left: Hebrew in visual order, as many producers write it.
  {
    texts: [
      { x: 500, y: 70, size: 28, runs: [{ text: "שלום עולם", font: "hebrew" }] },
      { x: 560, y: 140, runs: [{ text: "גרף", font: "hebrew" }] },
      { x: 505, y: 140, runs: [{ text: "מכוון", font: "hebrew" }] },
      { x: 440, y: 166, runs: [{ text: "זמן ריצה 2026", font: "hebrew" }] },
      { x: 60, y: 140, runs: [{ text: "צד שמאל", font: "hebrew" }] },
    ],
  },
  // 5. A rotated page with a cropped picture.
  {
    rotate: 90,
    images: [{ x: 300, y: 100, width: 200, height: 150, clip: [300, 100, 100, 75] }],
    texts: [{ x: 60, y: 70, text: "Rotated page" }],
  },
  // 6. A device outline with a mark in its middle, far from the outline's edges.
  {
    shapes: [
      { kind: "line", from: [100, 100], to: [400, 100] },
      { kind: "line", from: [400, 100], to: [400, 250] },
      { kind: "line", from: [400, 250], to: [100, 250] },
      { kind: "line", from: [100, 250], to: [100, 100] },
      { kind: "circle", center: [250, 175], radius: 12 },
    ],
  },
]);
const SHA = createHash("sha256").update(DECK).digest("hex");

let inventory: SourceInventory;
let doc: SourceDocument;

beforeAll(async () => {
  inventory = await buildInventory(DECK, SHA);
  doc = await openSource(DECK);
});

afterAll(async () => {
  await closeSource(doc);
});

const page = (number: number): PageInventory => inventory.pages[number - 1]!;
const summary = (inventoryPage: PageInventory) =>
  inventoryPage.regions.map(({ id, kind, text }) => ({ id, kind, text }));

function pngSize(png: Uint8Array): { width: number; height: number } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function contains(outer: Box, inner: Box): boolean {
  return (
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
  );
}

describe("region inventory", () => {
  it("covers every page with version 1 and the source hash", () => {
    expect(inventory.version).toBe(1);
    expect(inventory.sha256).toBe(SHA);
    expect(inventory.pages.map((p) => [p.page, p.width, p.height])).toEqual([
      [1, 720, 540],
      [2, 720, 540],
      [3, 720, 540],
      [4, 720, 540],
      [5, 540, 720],
      [6, 720, 540],
    ]);
  });

  it("groups text into blocks in reading order, lines joined with newlines", () => {
    expect(summary(page(1))).toEqual([
      { id: "p1.r1", kind: "text", text: "Synthetic Lecture 2: Graphs" },
      {
        id: "p1.r2",
        kind: "text",
        text: "A graph has vertices and edges.\nBFS runs in O(V + E) time.",
      },
      { id: "p1.r3", kind: "text", text: "Pi is about 3.14 and\na set has 2^n subsets." },
      {
        id: "p1.r4",
        kind: "text",
        text: "Indices x_1 and x_2 satisfy x_1 <= x_2.\nBounds: a ≤ b and ∑ over q0",
      },
    ]);
    const [title, left, right] = page(1).regions;
    // The baseline is at 70; the box runs from the font's ascent to its descent.
    expect(title!.box[0]).toBe(60);
    expect(title!.box[1]).toBeGreaterThan(70 - 28);
    expect(title!.box[1]).toBeLessThan(70 - 0.6 * 28);
    expect(title!.box[3]).toBeGreaterThan(70);
    expect(title!.box[3]).toBeLessThan(70 + 0.4 * 28);
    expect(left!.box[2]).toBeLessThan(right!.box[0]);
    expect(page(1).regions.every((region) => region.direction === "ltr")).toBe(true);
    expect(page(1).textLayer).toBe("ok");
    expect(page(1).characters).toBe(
      "Synthetic Lecture 2: Graphs".replace(/ /g, "").length +
        [
          "A graph has vertices and edges.",
          "BFS runs in O(V + E) time.",
          "Pi is about 3.14 and",
          "a set has 2^n subsets.",
          "Indices x_1 and x_2 satisfy x_1 <= x_2.",
          "Bounds: a ≤ b and ∑ over q0",
        ]
          .join("")
          .replace(/ /g, "").length,
    );
  });

  it("extracts numbers and math-like tokens from each region", () => {
    expect(page(1).regions.map((region) => region.numbers)).toEqual([
      ["2"],
      ["O(V + E)"],
      ["3.14", "2^n"],
      ["x_1", "x_2", "<=", "≤", "∑", "q0"],
    ]);
    expect(extractNumbers("T(n) = 2T(n/2) + n, so T(n) = Θ(n log n) for n ≥ 1.")).toEqual([
      "T(n)",
      "2T(n/2)",
      "Θ(n log n)",
      "≥",
      "1",
    ]);
    expect(extractNumbers("p = 0.05, 1,000 runs, 50% hit, at 10:30, a_{i+1} -> λ, -3")).toEqual([
      "0.05",
      "1,000",
      "50%",
      "10:30",
      "a_{i+1}",
      "->",
      "λ",
      "-3",
    ]);
    expect(extractNumbers("a well-known co-author, no math here")).toEqual([]);
  });

  it("finds an embedded picture with its box", () => {
    const images = page(2).regions.filter((region) => region.kind === "image");
    expect(images).toEqual([
      {
        id: "p2.r2",
        page: 2,
        kind: "image",
        box: [450, 180, 650, 330],
        text: "",
        direction: null,
        numbers: [],
      },
    ]);
  });

  it("clusters vector shapes into one drawing with its labels and skips page furniture", () => {
    expect(summary(page(2))).toEqual([
      { id: "p2.r1", kind: "text", text: "Automaton and picture" },
      { id: "p2.r2", kind: "image", text: "" },
      { id: "p2.r3", kind: "drawing", text: "a\nq0\nq1" },
      { id: "p2.r4", kind: "text", text: "Figure 1: a gradient" },
      { id: "p2.r5", kind: "text", text: "Notes follow the picture." },
      { id: "p2.r6", kind: "text", text: "A framed definition." },
    ]);
    const drawing = page(2).regions[2]!;
    // The start arrow, both states and the transition, without the background or the rule.
    expect(contains(drawing.box, [90, 240, 360, 300])).toBe(true);
    expect(contains([84, 234, 366, 306], drawing.box)).toBe(true);
    expect(drawing).toMatchObject({ direction: "ltr", numbers: ["q0", "q1"] });
  });

  it("joins a cluster drawn inside another's outline", () => {
    expect(page(6).regions).toEqual([
      expect.objectContaining({ id: "p6.r1", kind: "drawing", text: "", direction: null }),
    ]);
    expect(page(6).regions[0]!.box).toEqual([100, 100, 400, 250]);
    expect(page(6).textLayer).toBe("empty");
  });

  it("marks a picture-only page empty and lists the picture", () => {
    expect(page(3)).toMatchObject({ textLayer: "empty", characters: 0 });
    expect(page(3).regions).toEqual([
      expect.objectContaining({ id: "p3.r1", kind: "image", box: [0, 0, 720, 540] }),
    ]);
  });

  it("orders a right-to-left page from the right and keeps Hebrew in logical order", () => {
    expect(page(4).regions.map(({ id, text, direction }) => ({ id, text, direction }))).toEqual([
      { id: "p4.r1", text: "שלום עולם", direction: "rtl" },
      { id: "p4.r2", text: "גרף מכוון\nזמן ריצה 2026", direction: "rtl" },
      { id: "p4.r3", text: "צד שמאל", direction: "rtl" },
    ]);
    expect(page(4).regions[1]!.numbers).toEqual(["2026"]);
    expect(page(4).textLayer).toBe("ok");
  });

  it("uses rotated page coordinates and keeps only the visible part of a cropped picture", () => {
    const [first, second] = page(5).regions;
    const regions = [first!, second!];
    const image = regions.find((region) => region.kind === "image")!;
    const text = regions.find((region) => region.kind === "text")!;
    expect(page(5).regions).toHaveLength(2);
    // The clip is 100 x 75 points on the unrotated page, so 75 wide and 100 tall here.
    expect(image.box[2] - image.box[0]).toBeCloseTo(75, 1);
    expect(image.box[3] - image.box[1]).toBeCloseTo(100, 1);
    expect(text.text).toBe("Rotated page");
    expect(text.box[3] - text.box[1]).toBeGreaterThan(text.box[2] - text.box[0]);
    for (const region of regions) expect(contains([0, 0, 540, 720], region.box)).toBe(true);
  });

  it("is deterministic and numbers regions in reading order", async () => {
    const again = await buildInventory(DECK, SHA);
    expect(JSON.stringify(again)).toBe(JSON.stringify(inventory));
    expect(await buildPageInventory(doc, 2)).toEqual(page(2));
    for (const inventoryPage of inventory.pages) {
      inventoryPage.regions.forEach((region, index) => {
        expect(region.id).toBe(`p${inventoryPage.page}.r${index + 1}`);
        expect(region.page).toBe(inventoryPage.page);
      });
      const tops = inventoryPage.regions.map((region) => region.box[1]);
      for (let index = 1; index < tops.length; index++)
        expect(tops[index]! - tops[index - 1]!).toBeGreaterThan(-8.01);
    }
  });

  it("rejects a hash that does not match the bytes", async () => {
    await expect(buildInventory(DECK, "0".repeat(64))).rejects.toThrow(/hash/);
  });
});

describe("page preparation", () => {
  it("reads positioned text items with direction, size and line ends", async () => {
    const items = await pageText(doc, 1);
    const title = items.find((item) => item.str === "Synthetic Lecture 2: Graphs")!;
    expect(title).toMatchObject({ dir: "ltr", size: 28, horizontal: true, origin: [60, 70] });
    expect(title.box[0]).toBe(60);
    expect(title.box[2]).toBeCloseTo(60 + title.width, 5);
    expect(items.some((item) => item.hasEOL)).toBe(true);
    const hebrew = (await pageText(doc, 4)).find((item) => item.str === "שלום עולם")!;
    expect(hebrew).toMatchObject({ dir: "rtl", size: 28 });
  });

  it("renders a page as a PNG capped at the long edge", async () => {
    const rendered = await renderPage(doc, 1);
    expect(rendered).toMatchObject({ width: 1568, height: 1176 });
    expect(rendered.scale).toBeCloseTo(1568 / 720, 5);
    expect(pngSize(rendered.png)).toEqual({ width: 1568, height: 1176 });

    const small = await renderPage(doc, 5, { maxEdge: 800 });
    expect(small).toMatchObject({ width: 600, height: 800 });
    expect(pngSize(small.png)).toEqual({ width: 600, height: 800 });
  });

  it("renders one region as a closer PNG", async () => {
    const drawing = page(2).regions.find((region) => region.kind === "drawing")!;
    const crop = await renderCrop(doc, 2, drawing.box, { padding: 4 });
    expect(crop.box).toEqual([
      drawing.box[0] - 4,
      drawing.box[1] - 4,
      drawing.box[2] + 4,
      drawing.box[3] + 4,
    ]);
    expect(Math.max(crop.width, crop.height)).toBeLessThanOrEqual(1568);
    expect(crop.scale).toBeGreaterThan(1568 / 720);
    expect(pngSize(crop.png)).toEqual({ width: crop.width, height: crop.height });
    expect(crop.width).toBe(Math.round((crop.box[2] - crop.box[0]) * crop.scale));

    // A tiny region is capped at about 400 DPI, and the crop stays on the page.
    const corner = await renderCrop(doc, 2, [0, 0, 20, 10]);
    expect(corner.box).toEqual([0, 0, 28, 18]);
    expect(corner.scale).toBeCloseTo(400 / 72, 5);
    await expect(renderCrop(doc, 2, [800, 600, 900, 700])).rejects.toThrow(RangeError);
  });

  it("scores the text layer's health", () => {
    const items = (...strings: string[]) => strings.map((str) => ({ str }));
    expect(textLayerHealth(items("Breadth-first search", "visits vertices"))).toBe("ok");
    expect(textLayerHealth(items())).toBe("empty");
    expect(textLayerHealth(items("12", " "))).toBe("empty");
    expect(textLayerHealth(items("Graph \ufffd search"))).toBe("suspect");
    expect(textLayerHealth(items("\ue001\ue002\ue003 text"))).toBe("suspect");
    expect(textLayerHealth(items("Graph\u0003search"))).toBe("suspect");
    // A Wingdings or Symbol bullet maps to one private-use character; that alone is fine.
    expect(textLayerHealth(items("\uf0b7", "Bullet point text"))).toBe("ok");
    // Final letters only end Hebrew words; at the start of words they mean reversed text.
    expect(textLayerHealth(items("שלום עולם", "מכוון גרף"))).toBe("ok");
    expect(textLayerHealth(items("םולש םלוע", "ןווכמ"))).toBe("suspect");
  });
});
