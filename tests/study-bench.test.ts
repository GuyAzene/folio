import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { buildInventory } from "../src/ingest/inventory.ts";
import type { CompleteFn, ModelRequest } from "../src/ingest/models.ts";
import { closeSource, openSource, renderPage } from "../src/ingest/pages.ts";
import { AUTHOR_SYSTEM, READER_SYSTEM, type AuthorDraft } from "../src/ingest/prompts.ts";
import type { SourceInventory } from "../src/ingest/types.ts";
import {
  compareRuns,
  fakeStudyModel,
  fold,
  holds,
  omitPlantedBlocks,
  runBench,
  runName,
  scoreFacts,
  withOmissions,
  type BenchRun,
} from "../scripts/study-bench.ts";
import { studyDecks, type PlantedFact, type StudyDeck } from "./fixtures/study-decks.ts";
import { syntheticSlides } from "./fixtures/synthetic-slides.ts";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), "folio-bench-test-"));
  homes.push(path);
  return path;
}

const inventoryOf = (pdf: Uint8Array) =>
  buildInventory(pdf, createHash("sha256").update(pdf).digest("hex"));

/** The RGBA pixel at (x, y) of a PNG. */
async function pixel(png: Uint8Array, x: number, y: number): Promise<number[]> {
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return [...context.getImageData(x, y, 1, 1).data];
}

describe("synthetic slides", () => {
  it("embeds a PNG with its transparency, and keeps invisible text out of the picture", async () => {
    // Left half red, right half transparent.
    const canvas = createCanvas(40, 20);
    const context = canvas.getContext("2d");
    context.fillStyle = "rgb(255, 0, 0)";
    context.fillRect(0, 0, 20, 20);
    const pdf = syntheticSlides([
      {
        images: [{ x: 100, y: 100, width: 200, height: 100, png: canvas.encodeSync("png") }],
        texts: [
          { x: 100, y: 300, size: 40, text: "HIDDEN", invisible: true },
          // Drawn after the invisible text: the render mode must not carry over.
          { x: 100, y: 400, size: 40, text: "SHOWN" },
        ],
      },
    ]);
    const doc = await openSource(pdf);
    try {
      const { png } = await renderPage(doc, 1, { maxEdge: 720 });
      expect((await pixel(png, 150, 150)).slice(0, 3)).toEqual([255, 0, 0]);
      expect((await pixel(png, 250, 150)).slice(0, 3)).toEqual([255, 255, 255]);
      // Inside the H of "HIDDEN" nothing is drawn; inside the S of "SHOWN" the glyph is.
      const dark = async (x0: number, y0: number) => {
        let darkest = 255;
        for (let x = x0; x < x0 + 20; x += 2)
          for (let y = y0; y < y0 + 25; y += 2)
            darkest = Math.min(darkest, (await pixel(png, x, y))[0]!);
        return darkest;
      };
      expect(await dark(102, 272)).toBe(255);
      expect(await dark(102, 372)).toBeLessThan(100);
    } finally {
      await closeSource(doc);
    }
    const [page] = (await inventoryOf(pdf)).pages;
    expect(page!.regions.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "image", text: "" },
      { kind: "text", text: "HIDDEN" },
      { kind: "text", text: "SHOWN" },
    ]);
  });

  it("refuses a PNG it cannot embed rather than drawing it wrong", () => {
    const png = Uint8Array.from(createCanvas(4, 4).encodeSync("png"));
    png[24] = 16; // bit depth
    expect(() =>
      syntheticSlides([{ images: [{ x: 0, y: 0, width: 10, height: 10, png }] }]),
    ).toThrow(/8-bit RGB or RGBA/);
  });
});

describe("benchmark decks", () => {
  let decks: StudyDeck[];
  const inventories = new Map<string, SourceInventory>();
  const pageText = (deck: string, page: number) =>
    inventories
      .get(deck)!
      .pages[page - 1]!.regions.map((region) => region.text)
      .join("\n");

  beforeAll(async () => {
    decks = studyDecks();
    for (const deck of decks) inventories.set(deck.name, await inventoryOf(deck.pdf));
  });

  it("has three lectures, each fact on a page it has", () => {
    expect(decks.map((deck) => [deck.name, deck.title])).toEqual([
      ["hebrew", "Lecture 1 Kestrel queues"],
      ["math", "Lecture 2 Varnel bounds"],
      ["arrows", "Lecture 3 Pipeline diagrams"],
    ]);
    for (const deck of decks) {
      const pages = inventories.get(deck.name)!.pages.length;
      for (const fact of deck.facts) expect(fact.page).toBeLessThanOrEqual(pages);
      expect(new Set(deck.facts.map((fact) => fact.id)).size).toBe(deck.facts.length);
    }
  });

  it("puts each fact in the text layer, except those only a picture or an arrow shows", () => {
    const inText = decks.flatMap((deck) =>
      deck.facts
        .filter((fact) => fact.must.every((value) => holds(pageText(deck.name, fact.page), value)))
        .map((fact) => fact.id),
    );
    const all = decks.flatMap((deck) => deck.facts.map((fact) => fact.id));
    expect(all.filter((id) => !inText.includes(id))).toEqual([
      "window-in-picture",
      "flow-direction",
      "chart-peak",
    ]);
  });

  it("never shows a fact's wrong values anywhere in the deck's text", () => {
    for (const deck of decks) {
      const text = inventories
        .get(deck.name)!
        .pages.flatMap((page) => page.regions.map((region) => region.text))
        .join("\n");
      for (const fact of deck.facts)
        expect(
          fact.wrong.filter((value) => holds(text, value)),
          fact.id,
        ).toEqual([]);
    }
  });

  it("gives Hebrew pictures their words, and math its own characters, in the text layer", () => {
    const hebrew = inventories.get("hebrew")!.pages[1]!.regions;
    expect(hebrew.map((region) => region.kind)).toContain("image");
    expect(hebrew.map((region) => region.text)).toContain("תור Kestrel מחזיק לכל היותר 48 משימות");
    expect(pageText("hebrew", 3)).toContain("מקדם דעיכה 0.85");
    expect(pageText("math", 2)).toContain("T(n) ≤ 3n + 11");
    expect(pageText("math", 2)).toContain("∑ wi = 64");
    expect(pageText("math", 3)).toContain("𝑀𝐿 = 128");
    expect(pageText("math", 3)).toContain("𝑥1 + 𝑥2 = 19");
    expect(pageText("arrows", 2)).toContain("Grebe → Tern");
  });
});

describe("benchmark scoring", () => {
  it("compares notation as the notes may write it", () => {
    expect(fold("𝑥₁ + 𝑥₂ = 19")).toBe("x1+x2=19");
    expect(fold("$x_1 + x_2 = 19$")).toBe("x1+x2=19");
    expect(fold("T(n) \\le 3n + 11")).toBe("t(n)≤3n+11");
    expect(fold("T(n) <= 3n+11")).toBe("t(n)≤3n+11");
    expect(fold("Parse -> Plan → Emit")).toBe("parse→plan→emit");
    expect(fold("$\\sum w_i$ is 64")).toBe("∑wi is 64");
    expect(fold("ﬁnal  Varnel\nconstant")).toBe("final varnel constant");
  });

  it("never finds a number inside a longer one", () => {
    expect(holds("bars of 57 42 23", "57")).toBe(true);
    expect(holds("bars of 57 42 23", "42")).toBe(true);
    expect(holds("in 1957", "57")).toBe(false);
    expect(holds("0.85 decay", "85")).toBe(false);
    expect(holds("2.75 exactly", "2.7")).toBe(false);
    expect(holds("ends at 57.", "57")).toBe(true);
    expect(holds("anything", "")).toBe(false);
  });

  const block = (id: string, page: number, body: string): AuthorDraft["pages"][0]["blocks"][0] => ({
    id,
    title: id,
    body,
    locators: [{ page, region: `p${page}.r1`, location: "" }],
    keywords_en: [],
    keywords_he: [],
    aliases: [],
    questions: [],
    claims: [],
    interpretations: [],
  });
  const draft = (blocks: AuthorDraft["pages"][0]["blocks"]): AuthorDraft => ({
    session: {
      title: "",
      covers: "",
      worked_examples: [],
      worth_remembering: [],
      open_threads: [],
    },
    pages: [{ slug: "t", title: "T", type: "concept", prerequisites: [], intuition: "", blocks }],
    omitted: [],
  });
  const FACTS: PlantedFact[] = [
    { id: "capacity", page: 2, must: ["kestrel", "48"], wrong: ["84"] },
    { id: "wait", page: 2, must: ["250"], wrong: ["520"] },
    { id: "decay", page: 3, must: ["0.85"], wrong: ["0.58"] },
  ];

  it("finds a fact only in blocks citing its page, and its wrong values there", () => {
    const notes = draft([
      block("queues", 2, "A Kestrel queue holds at most 48 tasks."),
      // Right value, wrong page: it does not count for page 3.
      block("elsewhere", 4, "Decay factor 0.85."),
      block("decay", 3, "The decay factor is 0.58."),
    ]);
    expect(scoreFacts(notes, FACTS, ["wait"])).toEqual([
      { id: "capacity", page: 2, found: true, wrong: [], omitted: false },
      { id: "wait", page: 2, found: false, wrong: [], omitted: true },
      { id: "decay", page: 3, found: false, wrong: ["0.58"], omitted: false },
    ]);
  });

  it("removes planted blocks, naming every fact that went with them", () => {
    const notes = draft([
      block("both", 2, "Kestrel holds 48 tasks and waits 250 ms."),
      block("decay", 3, "Decay 0.85."),
      block("other", 3, "Nothing planted."),
    ]);
    const one = omitPlantedBlocks(notes, FACTS, 1);
    expect(one.omitted).toEqual(["capacity", "wait"]);
    expect(one.draft.pages[0]!.blocks.map((item) => item.id)).toEqual(["decay", "other"]);
    expect(omitPlantedBlocks(notes, FACTS, 2).omitted).toEqual(["capacity", "wait", "decay"]);
    expect(omitPlantedBlocks(notes, FACTS, 0)).toEqual({ draft: notes, omitted: [] });
  });

  it("takes planted blocks out of a deck's first draft only", async () => {
    const deck: StudyDeck = {
      name: "hebrew",
      title: "Lecture 1 Kestrel queues",
      pdf: new Uint8Array(),
      facts: FACTS,
    };
    const written = draft([
      block("queues", 2, "Kestrel holds 48 tasks."),
      block("decay", 3, "0.85"),
    ]);
    const complete: CompleteFn = async () => ({
      text: "",
      answers: [structuredClone(written)],
      stopReason: "toolUse",
      usage: { input: 1, output: 1 },
    });
    const omitted = new Map<string, string[]>();
    const wrapped = withOmissions(complete, [deck], 1, omitted);
    const request = (system: string, text: string): ModelRequest => ({
      model: "m",
      system: `${system}\n\nGive the result as the arguments of one call to the submit tool.`,
      content: [{ type: "text", text }],
      maxTokens: 1,
    });
    const blocks = async (system: string, text: string) =>
      ((await wrapped(request(system, text))).answers![0] as AuthorDraft).pages[0]!.blocks.map(
        (item) => item.id,
      );
    expect(await blocks(READER_SYSTEM, `Session: ben-L01, lecture "${deck.title}".`)).toEqual([
      "queues",
      "decay",
    ]);
    expect(await blocks(AUTHOR_SYSTEM, `Session: ben-L01, lecture "${deck.title}".`)).toEqual([
      "decay",
    ]);
    expect(omitted.get("hebrew")).toEqual(["capacity"]);
    // A revision, and a second first draft of the same deck, are left alone.
    expect(
      await blocks(
        AUTHOR_SYSTEM,
        `Session: ben-L01, lecture "${deck.title}". Your previous draft:`,
      ),
    ).toEqual(["queues", "decay"]);
    expect(await blocks(AUTHOR_SYSTEM, `Session: ben-L01, lecture "${deck.title}".`)).toEqual([
      "queues",
      "decay",
    ]);
  });

  it("names a saved run by its commit and what sets it apart", () => {
    expect(runName({ commit: "abc1234", dirty: false, model: "chatgpt", omit: 0 })).toBe("abc1234");
    expect(runName({ commit: "abc1234", dirty: true, model: "fake", omit: 2 })).toBe(
      "abc1234-dirty-fake-omit2",
    );
  });
});

describe("benchmark run, offline", () => {
  it(
    "studies every deck with the real pipeline and scores what the notes kept",
    { timeout: 60_000 },
    async () => {
      const decks = await runBench({
        home: await home(),
        complete: fakeStudyModel(),
        decks: studyDecks(),
      });
      expect(decks.map((deck) => [deck.deck, deck.status])).toEqual([
        ["hebrew", "done"],
        ["math", "done"],
        ["arrows", "done"],
      ]);
      // The offline model reads text layers, not pixels or arrows: those facts are missed.
      expect(
        decks.flatMap((deck) => deck.facts.filter((fact) => !fact.found).map((fact) => fact.id)),
      ).toEqual(["window-in-picture", "flow-direction", "chart-peak"]);
      expect(decks.flatMap((deck) => deck.facts.flatMap((fact) => fact.wrong))).toEqual([]);
      expect(decks.map((deck) => [deck.fallbacks, deck.disputes, deck.unaccounted])).toEqual([
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ]);
      const hebrew = decks[0]!.timings!;
      expect(hebrew.title).toBe("Lecture 1 Kestrel queues");
      expect(hebrew.steps.map((row) => row.step)).toEqual(
        expect.arrayContaining(["prepare", "brief", "reader", "escalation", "author", "reviewer"]),
      );
      expect(hebrew.steps.find((row) => row.step === "escalation")!.nodes).toBe(3);
      expect(hebrew.wall.calls).toBeGreaterThan(0);
    },
  );

  it("brings back the planted blocks taken out of a first draft", { timeout: 60_000 }, async () => {
    const math = studyDecks().filter((deck) => deck.name === "math");
    const plain = await runBench({ home: await home(), complete: fakeStudyModel(), decks: math });
    const omitted = await runBench({
      home: await home(),
      complete: fakeStudyModel(),
      decks: math,
      omit: 1,
    });
    const [deck] = omitted;
    expect(deck!.facts.filter((fact) => fact.omitted).map((fact) => fact.id)).toEqual([
      "bound",
      "weights-sum",
    ]);
    expect(deck!.facts.every((fact) => fact.found)).toBe(true);
    // The check finds the uncited regions, and one round of patches cites them again. The
    // removed page's footer is not among them: other pages' blocks still carry its words.
    expect(deck!.timings!.steps.map((row) => row.step)).toEqual(
      expect.arrayContaining(["fix", "recheck"]),
    );
    expect(deck!.timings!.steps.map((row) => row.step)).not.toContain("revision");
    expect(deck).toMatchObject({ discrepancies: 3, fixed: 3, fallbacks: 0 });
    expect(plain[0]).toMatchObject({ discrepancies: 0, fixed: 0 });

    const run = (decks: typeof plain, omit: number): BenchRun => ({
      version: 1,
      commit: "abc1234",
      dirty: false,
      createdAt: "2026-10-30T00:00:00.000Z",
      model: "fake",
      omit,
      decks,
    });
    const table = compareRuns(run(plain, 0), run(omitted, 1), ["before", "after"]).split("\n");
    expect(table[0]).toMatch(/^ +before +after +change$/);
    expect(table).toContain("math (done / done)");
    expect(table).toContainEqual(expect.stringMatching(/^ {2}facts found \(of 5\) +5 +5$/));
    expect(table).toContainEqual(expect.stringMatching(/^ {2}omissions injected +– +2$/));
    expect(table).toContainEqual(expect.stringMatching(/^ {2}omissions brought back +– +2$/));
    expect(table).toContainEqual(expect.stringMatching(/^ {2}discrepancies found +0 +3 +\+3$/));
    expect(table).toContainEqual(expect.stringMatching(/^ {2}discrepancies fixed +0 +3 +\+3$/));
    // A fix and a recheck, and a close-up of the uncited region first.
    expect(table).toContainEqual(expect.stringMatching(/^ {2}model calls +\d+ +\d+ +\+3$/));
  });
});
