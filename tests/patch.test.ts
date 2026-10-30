import { describe, expect, it } from "vite-plus/test";
import {
  answered,
  applyPatches,
  discrepancies,
  missingFacts,
  withRestated,
  type Coverage,
  type Discrepancy,
} from "../src/ingest/patch.ts";
import type { LedgerEntry } from "../src/ingest/pipeline.ts";
import type { AuthorDraft, DraftBlock, Patch } from "../src/ingest/prompts.ts";

/** Synthetic notes: BFS on page 1, DFS on page 2; p2.r2 and p3.r1 are cited by nothing. */
const block = (id: string, regions: string[], claim?: string): DraftBlock => ({
  id,
  kind: "explanation",
  restates: "",
  title: id,
  body: `About ${id}.`,
  locators: regions.map((region) => ({
    page: Number(region.slice(1, region.indexOf("."))),
    region,
    location: "",
  })),
  keywords_en: [],
  keywords_he: [],
  aliases: [],
  questions: [],
  claims: claim ? [{ text: claim, region: regions.at(-1)! }] : [],
  interpretations: [],
});

const notes = (): AuthorDraft => ({
  session: {
    title: "Graphs",
    covers: "",
    worked_examples: [],
    worth_remembering: [],
    open_threads: [],
  },
  pages: [
    {
      slug: "bfs",
      title: "Breadth-first search",
      type: "concept",
      prerequisites: [],
      intuition: "",
      blocks: [
        block("bfs-marking", ["p1.r1", "p1.r2"], "A vertex is marked when it is enqueued."),
        block("bfs-cost", ["p1.r3"], "BFS runs in O(V + E)."),
      ],
    },
    {
      slug: "dfs",
      title: "Depth-first search",
      type: "concept",
      prerequisites: [],
      intuition: "",
      blocks: [block("dfs-stack", ["p2.r1"])],
    },
  ],
  omitted: [],
});

const REGIONS = new Set(["p1.r1", "p1.r2", "p1.r3", "p2.r1", "p2.r2", "p3.r1"]);
const FOUND: Discrepancy[] = [
  { id: "d1", kind: "uncited", region: "p2.r2", page: 2, blocks: [], detail: "" },
  { id: "d2", kind: "contradicted", region: "p1.r2", page: 1, blocks: ["bfs-marking"], detail: "" },
  { id: "d3", kind: "uncited", region: "p3.r1", page: 3, blocks: [], detail: "" },
];

const replace = (id: string, fixes: string[], changed: DraftBlock): Patch => ({
  op: "replace_block",
  fixes,
  block_id: id,
  block: changed,
});
const add = (topic: string, after: string, fixes: string[], added: DraftBlock): Patch => ({
  op: "add_block",
  fixes,
  topic,
  after,
  block: added,
});
const omit = (region: string, fixes: string[]): Patch => ({
  op: "omit_region",
  fixes,
  region,
  reason: "decorative",
  note: "a logo",
});

describe("patching the notes", () => {
  it("applies each kind of patch and leaves every other block exactly as it was", () => {
    const before = notes();
    const corrected = block("bfs-marking", ["p1.r1", "p1.r2"], "A vertex is marked when dequeued.");
    const result = applyPatches(
      before,
      [
        replace("bfs-marking", ["d2"], corrected),
        add("dfs", "dfs-stack", ["d1"], block("dfs-order", ["p2.r2"])),
        omit("p3.r1", ["d3"]),
      ],
      FOUND,
      REGIONS,
    );
    expect(result.rejected).toEqual([]);
    expect(result.applied).toHaveLength(3);
    const [bfs, dfs] = result.draft.pages;
    expect(bfs!.blocks[0]).toBe(corrected);
    expect(bfs!.blocks[1]).toBe(before.pages[0]!.blocks[1]);
    expect(dfs!.blocks.map((item) => item.id)).toEqual(["dfs-stack", "dfs-order"]);
    expect(dfs!.blocks[0]).toBe(before.pages[1]!.blocks[0]);
    expect(result.draft.omitted).toEqual([
      { region: "p3.r1", reason: "decorative", note: "a logo" },
    ]);
    // The draft it was given is not changed.
    expect(before).toEqual(notes());
  });

  it("lets a block that covers the subject take in a region nothing cited", () => {
    const widened = block("dfs-stack", ["p2.r1", "p2.r2"]);
    const result = applyPatches(notes(), [replace("dfs-stack", ["d1"], widened)], FOUND, REGIONS);
    expect(result.rejected).toEqual([]);
    expect(result.draft.pages[1]!.blocks[0]).toBe(widened);
  });

  it("refuses a patch that does more than fix what was found", () => {
    const cases: [Patch[], string][] = [
      [
        [replace("bfs-marking", [], block("bfs-marking", ["p1.r1", "p1.r2"]))],
        "does not name the discrepancies it fixes",
      ],
      [
        [replace("bfs-marking", ["d9"], block("bfs-marking", ["p1.r1", "p1.r2"]))],
        "does not name the discrepancies it fixes",
      ],
      [[replace("nope", ["d2"], block("nope", ["p1.r2"]))], "replaces nope, which is not a block"],
      [
        [replace("bfs-marking", ["d2"], block("bfs-renamed", ["p1.r1", "p1.r2"]))],
        "renames bfs-marking to bfs-renamed",
      ],
      [
        [replace("bfs-cost", ["d2"], block("bfs-cost", ["p1.r3"]))],
        "changes bfs-cost, which no discrepancy it fixes concerns",
      ],
      [
        [replace("bfs-marking", ["d2"], block("bfs-marking", ["p1.r2"]))],
        "would leave p1.r1 uncited",
      ],
      [
        [replace("bfs-marking", ["d2"], block("bfs-marking", ["p1.r1", "p9.r9"]))],
        "cites p9.r9, which is not a region",
      ],
      [
        [add("graphs", "", ["d1"], block("graphs-x", ["p2.r2"]))],
        "adds to graphs, which is not a topic",
      ],
      [
        [add("dfs", "bfs-marking", ["d1"], block("dfs-x", ["p2.r2"]))],
        "adds after bfs-marking, which is not in dfs",
      ],
      [
        [add("dfs", "", ["d1"], block("bfs-cost", ["p2.r2"]))],
        "adds bfs-cost, which already exists",
      ],
      [[add("dfs", "", ["d1"], block("dfs-x", ["p2.r1"]))], "does not cite p2.r2, which it fixes"],
      [[omit("p2.r1", ["d1"])], "omits p2.r1, which it does not fix"],
      [[omit("p1.r2", ["d2"])], "omits p1.r2, which it does not fix"],
    ];
    for (const [patches, problem] of cases) {
      const result = applyPatches(notes(), patches, FOUND, REGIONS);
      expect(
        result.rejected.map((item) => item.problem),
        problem,
      ).toEqual([problem]);
      expect(result.draft).toEqual(notes());
    }
  });

  it("refuses a second patch on the same block, or omitting a region a patch just cited", () => {
    const twice = applyPatches(
      notes(),
      [
        replace("bfs-marking", ["d2"], block("bfs-marking", ["p1.r1", "p1.r2"], "First.")),
        replace("bfs-marking", ["d2"], block("bfs-marking", ["p1.r1", "p1.r2"], "Second.")),
      ],
      FOUND,
      REGIONS,
    );
    expect(twice.rejected.map((item) => item.problem)).toEqual([
      "patches bfs-marking a second time",
    ]);
    expect(twice.draft.pages[0]!.blocks[0]!.claims[0]!.text).toBe("First.");
    const cited = applyPatches(
      notes(),
      [add("dfs", "", ["d1"], block("dfs-x", ["p2.r2"])), omit("p2.r2", ["d1"])],
      FOUND,
      REGIONS,
    );
    expect(cited.rejected.map((item) => item.problem)).toEqual([
      "omits p2.r2, which a block cites",
    ]);
  });
});

describe("what the check found", () => {
  it("lists regions nothing cites, doubted claims with their blocks, and citations of nothing", () => {
    const draft = notes();
    draft.pages[1]!.blocks[0]!.locators.push({ page: 2, region: "p2.r9", location: "" });
    const entry = (region: string, state: LedgerEntry["state"], blocks: string[]): LedgerEntry => ({
      region,
      page: Number(region.slice(1, region.indexOf("."))),
      kind: "text",
      state,
      blocks,
      reason: "",
    });
    const ledger = [
      entry("p1.r1", "represented", ["bfs-marking"]),
      entry("p1.r2", "unaccounted", ["bfs-marking"]),
      entry("p1.r3", "represented", ["bfs-cost"]),
      entry("p2.r1", "represented", ["dfs-stack"]),
      entry("p2.r2", "unaccounted", []),
    ];
    const verdicts = {
      c1: {
        claim: "c1",
        verdict: "contradicted" as const,
        note: "The page says dequeued.",
        region: "p1.r2",
        text: "A vertex is marked when it is enqueued.",
      },
      c2: {
        claim: "c2",
        verdict: "supported" as const,
        note: "",
        region: "p1.r3",
        text: "BFS runs in O(V + E).",
      },
      c3: {
        claim: "c3",
        verdict: "unreadable" as const,
        note: "Too small.",
        region: "p1.r3",
        text: "BFS runs in O(V + E).",
      },
    };
    expect(discrepancies(ledger, verdicts, draft)).toEqual([
      expect.objectContaining({ id: "d1", kind: "uncited", region: "p2.r2", page: 2, blocks: [] }),
      expect.objectContaining({
        id: "d2",
        kind: "contradicted",
        region: "p1.r2",
        blocks: ["bfs-marking"],
      }),
      expect.objectContaining({
        id: "d3",
        kind: "unchecked",
        region: "p1.r3",
        blocks: ["bfs-cost"],
      }),
      expect.objectContaining({
        id: "d4",
        kind: "bad_locator",
        region: "p2.r9",
        blocks: ["dfs-stack"],
      }),
    ]);
  });
});

describe("facts the notes do not carry", () => {
  const entry = (region: string, state: LedgerEntry["state"], blocks: string[]): LedgerEntry => ({
    region,
    page: Number(region.slice(1, region.indexOf("."))),
    kind: "text",
    state,
    blocks,
    reason: "",
  });
  const ledger = [
    entry("p1.r1", "represented", ["bfs-marking"]),
    entry("p1.r2", "represented", ["bfs-marking"]),
    entry("p1.r3", "represented", ["bfs-cost"]),
    entry("p2.r1", "represented", ["dfs-stack"]),
    entry("p2.r2", "unaccounted", []),
    entry("p3.r1", "unaccounted", []),
  ];
  const coverage: Coverage = {
    "p1.r2": {
      region: "p1.r2",
      legible: true,
      note: "",
      facts: [
        { fact: "A vertex is marked when enqueued.", block: "bfs-marking" },
        { fact: "Marking stops a vertex being queued twice.", block: "" },
        { fact: "The queue starts with the source.", block: "bfs-start" },
      ],
    },
    "p2.r2": {
      region: "p2.r2",
      legible: true,
      note: "",
      facts: [{ fact: "DFS visits the newest vertex first.", block: "dfs-stack" }],
    },
    "p3.r1": {
      region: "p3.r1",
      legible: true,
      note: "",
      facts: [
        { fact: "DFS can find cycles.", block: "dfs-stack" },
        { fact: "BFS finds shortest paths.", block: "" },
      ],
    },
  };

  it("counts a fact as missing when it names no block, or a block that does not exist", () => {
    expect(missingFacts(coverage, notes())).toEqual(
      new Map([
        [
          "p1.r2",
          ["Marking stops a vertex being queued twice.", "The queue starts with the source."],
        ],
        ["p3.r1", ["BFS finds shortest paths."]],
      ]),
    );
    const found = discrepancies(ledger, {}, notes(), coverage);
    expect(found.map((item) => [item.id, item.kind, item.region, item.blocks])).toEqual([
      ["d1", "uncited", "p2.r2", []],
      ["d2", "uncited", "p3.r1", []],
      ["d3", "missing", "p1.r2", ["bfs-marking"]],
    ]);
    expect(found[2]!.detail).toContain('"Marking stops a vertex being queued twice."');
  });

  it("cites a region nothing cited from the blocks that carry all of its facts, and no other", () => {
    const restated = withRestated(notes(), ledger, coverage);
    expect(restated.pages[1]!.blocks[0]!.locators).toEqual([
      { page: 2, region: "p2.r1", location: "" },
      { page: 2, region: "p2.r2", location: "restated" },
    ]);
    // p3.r1 has a fact no block carries, so it stays uncited and goes to the fixer.
    expect(
      restated.pages
        .flatMap((page) => page.blocks)
        .some((block) => block.locators.some((locator) => locator.region === "p3.r1")),
    ).toBe(false);
    expect(restated.pages[0]!.blocks).toEqual(notes().pages[0]!.blocks);
  });

  it("takes a fact as carried once a patch that writes it in is applied", () => {
    const found = discrepancies(ledger, {}, notes(), coverage);
    const widened = block(
      "bfs-marking",
      ["p1.r1", "p1.r2"],
      "Marking stops a vertex being queued twice.",
    );
    const result = applyPatches(notes(), [replace("bfs-marking", ["d3"], widened)], found, REGIONS);
    expect(result.rejected).toEqual([]);
    const next = answered(coverage, result.applied, found, notes());
    expect(missingFacts(next, result.draft).has("p1.r2")).toBe(false);
    expect(next["p1.r2"]!.facts[0]!.block).toBe("bfs-marking");
    // A missing fact is never page furniture, and an added block must cite its region.
    const refused = applyPatches(
      notes(),
      [omit("p1.r2", ["d3"]), add("bfs", "", ["d3"], block("bfs-extra", ["p1.r1"]))],
      found,
      REGIONS,
    );
    expect(refused.rejected.map((item) => item.problem)).toEqual([
      "omits p1.r2, which it does not fix",
      "does not cite p1.r2, which it fixes",
    ]);
  });

  it("forgets the facts of a region a patch omits as page furniture", () => {
    const found = discrepancies(ledger, {}, notes(), coverage);
    const result = applyPatches(notes(), [omit("p3.r1", ["d2"])], found, REGIONS);
    expect(result.rejected).toEqual([]);
    const next = answered(coverage, result.applied, found, notes());
    expect(next["p3.r1"]).toBeUndefined();
    expect(missingFacts(next, result.draft).has("p3.r1")).toBe(false);
  });
});
