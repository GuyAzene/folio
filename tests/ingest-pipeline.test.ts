import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { JobView } from "../src/desktop/api.ts";
import { DEFAULT_ROLES, studyRoles } from "../src/config.ts";
import { renderDraft } from "../src/ingest/draft.ts";
import {
  computeLedger,
  coursePrefix,
  cacheKey,
  fairLimiter,
  fixParts,
  gateRegion,
  topicPlan,
  hash,
  IngestRunner,
  PUBLISH_FAILED,
  settleDisputes,
  withFallbacks,
  type DraftBundle,
  type IngestOptions,
  type PreparedSource,
} from "../src/ingest/pipeline.ts";
import type { ModelReply, ModelRequest } from "../src/ingest/models.ts";
import type { AuthorDraft, ReadRegion } from "../src/ingest/prompts.ts";
import type { PageInventory, Region, SourceInventory } from "../src/ingest/types.ts";
import { JobStore } from "../src/jobs/store.ts";
import { LibraryStore } from "../src/library/store.ts";
import { SYNTHETIC_LECTURE, syntheticPdf } from "./fixtures/synthetic-pdf.ts";

const homes: string[] = [];
const stores: JobStore[] = [];

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** Two pages: a definition and a footer, then a diagram with labels. Synthetic only. */
const INVENTORY: SourceInventory = {
  version: 1,
  sha256: "",
  pages: [
    {
      page: 1,
      width: 612,
      height: 792,
      textLayer: "ok",
      characters: 120,
      regions: [
        {
          id: "p1.r1",
          page: 1,
          kind: "text",
          box: [72, 60, 400, 80],
          text: "Breadth-first search",
          direction: "ltr",
          numbers: [],
        },
        {
          id: "p1.r2",
          page: 1,
          kind: "text",
          box: [72, 90, 520, 130],
          text: "Each vertex is marked visited when it enters the queue. The running time is O(V + E).",
          direction: "ltr",
          numbers: ["O(V + E)"],
        },
        {
          id: "p1.r3",
          page: 1,
          kind: "text",
          box: [72, 740, 120, 760],
          text: "1",
          direction: "ltr",
          numbers: ["1"],
        },
      ],
    },
    {
      page: 2,
      width: 612,
      height: 792,
      textLayer: "ok",
      characters: 10,
      regions: [
        {
          id: "p2.r1",
          page: 2,
          kind: "drawing",
          box: [100, 100, 400, 300],
          text: "q0 q1 a",
          direction: "ltr",
          numbers: [],
        },
      ],
    },
  ],
};

const fakeSource = (): PreparedSource => ({
  inventory: structuredClone(INVENTORY),
  render: async () => new Uint8Array([137, 80, 78, 71]),
  crop: async () => new Uint8Array([137, 80, 78, 71]),
  close: async () => undefined,
});

function draft(complete: boolean): AuthorDraft {
  return {
    session: {
      title: "Graph traversal",
      covers: "BFS and a tiny automaton.",
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
        intuition: "Think of ripples spreading out from a stone.",
        similar_to: [],
        blocks: [
          {
            id: "bfs-marking",
            kind: "explanation",
            restates: "",
            title: "Marking on enqueue",
            body: "Breadth-first search marks each vertex visited when it enters the queue, so the running time is O(V + E).",
            locators: [
              { page: 1, region: "p1.r1", location: "title" },
              { page: 1, region: "p1.r2", location: "middle" },
              ...(complete ? [{ page: 2, region: "p2.r1", location: "diagram" }] : []),
            ],
            keywords_en: ["BFS", "queue", "visited"],
            keywords_he: ["סריקה לרוחב"],
            aliases: ["breadth first"],
            questions: ["Why is each vertex enqueued once?"],
            claims: [
              { text: "Each vertex is marked visited when it enters the queue.", region: "p1.r2" },
            ],
            interpretations: [],
            gaps: [],
          },
        ],
      },
    ],
    omitted: [{ region: "p1.r3", reason: "page_number", note: "" }],
    gaps: [],
  };
}

/**
 * A fake model: readers echo the text layer, the author forgets the diagram, and the fixer adds
 * a block for it, rewords any claim the checker disputes and writes in any fact it missed.
 * `stubborn` makes the fixer return nothing; `doubt` makes the checker dispute every claim,
 * `doubtOnce` only the author's own; `failWriting` cuts the author off until it is switched
 * back; `paraphrase` cites everything from the start but words the BFS block so differently
 * from the slide that few of its words carry over. The checker finds each region's text in the
 * block citing it; with `missingFact` it also finds the running time in no block, and with
 * `restated` it finds the forgotten diagram already explained in the BFS block.
 */
function fakeModels(
  options: {
    stubborn?: boolean;
    doubt?: boolean;
    doubtOnce?: boolean;
    failWriting?: boolean;
    failFix?: boolean;
    paraphrase?: boolean;
    missingFact?: boolean;
    restated?: boolean;
    topics?: boolean;
    slowPage2?: boolean;
    slowTopic?: string;
  } = {},
) {
  const events: string[] = [];
  const calls: { system: string; model: string; schema: boolean }[] = [];
  const reply = (value: unknown): ModelReply => ({
    text: JSON.stringify(value),
    stopReason: "stop",
    usage: { input: 100, output: 50 },
  });
  const complete = vi.fn(async (request: ModelRequest): Promise<ModelReply> => {
    calls.push({
      system: request.system.slice(0, 40),
      model: request.model,
      schema:
        request.answer?.name === "submit" &&
        "properties" in request.answer.schema &&
        request.system.includes("call to the submit tool"),
    });
    const all = request.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    if (request.system.startsWith("You plan the study"))
      return reply({
        title: "Graph traversal",
        covers: "Breadth-first search and a small automaton.",
        outline: options.topics
          ? [
              { title: "Marking", pages: [1] },
              { title: "Automata", pages: [2] },
              { title: "Diagrams", pages: [2] },
            ]
          : [{ title: "BFS", pages: [1] }],
        notation: [{ symbol: "V", meaning: "vertices" }],
        terms: [
          { english: "breadth-first search", hebrew: "סריקה לרוחב", meaning: "layered search" },
        ],
      });
    if (request.system.startsWith("You read a lecture page")) {
      // Readers take a moment, so documents studied together overlap as they do for real.
      const second = all.includes("Page 2");
      await new Promise((done) => setTimeout(done, options.slowPage2 && second ? 150 : 20));
      if (second) events.push("read page 2");
      const pages = INVENTORY.pages.filter((page) => all.includes(`Page ${page.page}`));
      return reply({
        pages: pages.map((page) => ({
          page: page.page,
          regions: page.regions.map((region) => ({
            id: region.id,
            type: region.kind === "drawing" ? "diagram" : "text",
            content: region.text,
            claims: [],
            // The automaton's arrows go unread, which earns it a close-up.
            flags: region.kind === "drawing" ? ["arrows"] : [],
            confidence: "sure",
          })),
          missed: [],
          new_terms: [],
          unresolved_symbols: [],
        })),
      });
    }
    if (request.system.startsWith("You re-read hard regions"))
      return reply({
        regions: [
          {
            id: "p2.r1",
            type: "diagram",
            content: "Automaton with states q0 and q1.",
            claims: [{ text: "q0 goes to q1 on a.", basis: "transcribed" }],
            nodes: ["q0", "q1"],
            edges: [{ from: "q0", to: "q1", label: "a" }],
            unreadable: "",
          },
        ],
      });
    if (request.system.startsWith("You write a reviewed study wiki")) {
      if (options.failWriting)
        return { text: '{"session":', stopReason: "length", usage: { input: 1, output: 1 } };
      if (options.paraphrase) {
        const reworded = draft(true);
        Object.assign(reworded.pages[0]!.blocks[0]!, {
          title: "Ripples",
          body: "Nodes get flagged on insertion, so the cost is linear in the size of the graph.",
          keywords_en: ["BFS"],
          aliases: [],
        });
        return reply(reworded);
      }
      return reply(draft(false));
    }
    if (request.system.startsWith("You write the study wiki for one topic")) {
      const topic = /Your topic: "([^"]+)"/.exec(all)![1]!;
      events.push(`write ${topic}`);
      if (options.slowTopic === topic) await new Promise((done) => setTimeout(done, 150));
      events.push(`wrote ${topic}`);
      if (topic === "Marking") return reply(draft(false));
      const automaton = {
        ...structuredClone(draft(false).pages[0]!.blocks[0]!),
        title: "A two-state automaton",
        body: "The slide draws q0 going to q1 on a.",
        locators: [{ page: 2, region: "p2.r1", location: "diagram" }],
        claims: [{ text: "q0 goes to q1 on a.", region: "p2.r1" }],
      };
      const session = { ...draft(false).session, title: "", covers: "" };
      return reply(
        topic === "Automata"
          ? {
              session: {
                ...session,
                worked_examples: [{ title: "Two states", page: 2, slug: "bfs" }],
              },
              pages: [{ ...draft(false).pages[0]!, blocks: [automaton] }],
              omitted: [],
            }
          : { session, pages: [], omitted: [] },
      );
    }
    if (request.system.startsWith("You correct specific discrepancies")) {
      if (options.failFix)
        return {
          text: "",
          stopReason: "error",
          usage: { input: 1, output: 0 },
          error: "Invalid request: the answer could not be produced",
        };
      if (options.stubborn) return reply({ patches: [] });
      const found = [...all.matchAll(/^\[(d\d+)\] (\w+) · (\S+)/gm)].map((match) => ({
        id: match[1]!,
        kind: match[2]!,
        region: match[3]!,
      }));
      const patches: unknown[] = [];
      const uncited = found.filter((item) => item.kind === "uncited");
      if (uncited.length)
        patches.push({
          op: "add_block",
          fixes: uncited.map((item) => item.id),
          topic: "bfs",
          after: "bfs-marking",
          block: {
            id: "bfs-automaton",
            kind: "example",
            restates: "",
            title: "A two-state automaton",
            body: "The slide draws q0 going to q1 on a.",
            locators: uncited.map((item) => ({
              page: Number(item.region.slice(1, item.region.indexOf("."))),
              region: item.region,
              location: "diagram",
            })),
            keywords_en: ["automaton"],
            keywords_he: [],
            aliases: [],
            questions: [],
            claims: uncited.map((item) => ({ text: "q0 goes to q1 on a.", region: item.region })),
            interpretations: [],
          },
        });
      const doubted = found.filter((item) => item.kind === "contradicted");
      const missing = found.filter((item) => item.kind === "missing");
      if (doubted.length || missing.length) {
        const block = structuredClone(draft(false).pages[0]!.blocks[0]!);
        if (doubted.length)
          block.claims = [
            { text: "Each vertex is marked visited as it enters the queue.", region: "p1.r2" },
          ];
        if (missing.length) {
          block.body += " BFS takes time linear in the size of the graph.";
          block.claims.push({ text: "BFS runs in O(V + E) time.", region: "p1.r2" });
        }
        patches.push({
          op: "replace_block",
          fixes: [...doubted, ...missing].map((item) => item.id),
          block_id: block.id,
          block,
        });
      }
      return reply({ patches });
    }
    if (request.system.startsWith("You independently check study notes"))
      events.push(`check ${[...all.matchAll(/^Page (\d+)/gm)].map((match) => match[1]).join(",")}`);
    if (request.system.startsWith("You independently check")) {
      const checked = [...all.matchAll(/\[(c[0-9a-f]+)\] \(\S+\) (.*)/g)];
      const listed = [
        ...all.matchAll(
          /^- (p\d+\.r\d+) \[\w+\](?: "([^"]*)")? · (?:cited by ([\w-]+)|not cited)/gm,
        ),
      ];
      return reply({
        // A recheck asks about claims only.
        ...(request.system.startsWith("You independently check study notes")
          ? {
              coverage: listed.map(([, region, words, cited]) => ({
                region,
                legible: true,
                note: "",
                facts: [
                  {
                    fact: words ?? "",
                    block: cited ?? (options.restated && region === "p2.r1" ? "bfs-marking" : ""),
                  },
                  ...(options.missingFact && region === "p1.r2"
                    ? [{ fact: "The running time is O(V + E).", block: "" }]
                    : []),
                ],
              })),
            }
          : {}),
        verdicts: checked.map(([, claim, text]) =>
          options.doubt ||
          (options.doubtOnce && text === "Each vertex is marked visited when it enters the queue.")
            ? { claim, verdict: "contradicted", note: "The page says it is marked when dequeued." }
            : { claim, verdict: "supported", note: "" },
        ),
      });
    }
    throw new Error(`Unexpected request: ${request.system.slice(0, 60)}`);
  });
  return { complete, calls, events };
}

async function setup(
  complete = fakeModels().complete,
  publish?: (bundle: DraftBundle) => Promise<number>,
  extra: Partial<IngestOptions> = {},
) {
  const home = await mkdtemp(resolve(tmpdir(), "folio-ingest-test-"));
  homes.push(home);
  const library = await LibraryStore.open({ home });
  const store = await JobStore.open(home);
  stores.push(store);
  const course = await library.createCourse({ name: "Algorithms", code: "CS 201" });
  const pdf = resolve(home, "Lecture 1 Graph traversal.pdf");
  await writeFile(pdf, syntheticPdf(SYNTHETIC_LECTURE));
  const lecture = (await library.importFile(course.id, pdf)).document;
  const homework = resolve(home, "hw1.pdf");
  await writeFile(homework, syntheticPdf([["Homework 1"]]));
  const assignment = (await library.importFile(course.id, homework)).document;
  const events: JobView[] = [];
  const published: DraftBundle[] = [];
  const removed: string[] = [];
  const runner = new IngestRunner({
    store,
    library,
    complete,
    prepare: async () => fakeSource(),
    emit: (job) => events.push(job),
    publish:
      publish ??
      (async (bundle) => {
        published.push(bundle);
        return published.length;
      }),
    removed: (id) => removed.push(id),
    ...extra,
  });
  const finished = (id: string) =>
    vi.waitFor(
      () => {
        const status = store.job(id).status;
        expect(["done", "waiting", "failed", "stopped"]).toContain(status);
      },
      { timeout: 5000 },
    );
  return {
    home,
    library,
    store,
    runner,
    course,
    lecture,
    assignment,
    events,
    published,
    removed,
    finished,
  };
}

describe("ingestion pipeline", () => {
  it("reads, escalates, writes once, fixes what the check found and publishes with every region accounted for", async () => {
    const models = fakeModels();
    const { store, runner, course, lecture, published, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(published).toHaveLength(1);
    expect(store.nodes(job.id).find((node) => node.role === "publish")?.task).toBe(
      "Added to Algorithms as version 1",
    );

    const [document] = published[0]!.documents;
    expect(document!.ledger.map((entry) => [entry.region, entry.state])).toEqual([
      ["p1.r1", "represented"],
      ["p1.r2", "represented"],
      ["p1.r3", "omitted"],
      ["p2.r1", "described"],
    ]);
    expect(document!.regions["p2.r1"]).toMatchObject({
      escalated: true,
      content: expect.stringContaining("q0 -> q1"),
    });
    expect(document!.exceptions.map((exception) => exception.kind)).toEqual(["visual_only"]);

    const files = renderDraft(document!.draft, document!.session);
    const page = files.find((file) => file.path === "concepts/alg-bfs.md")!.content;
    expect(page).toContain('slug: "alg-bfs"');
    expect(page).toContain('region: "p1.r2"');
    expect(page).toContain("<!-- study-rag: bfs-marking -->");
    const session = files.find((file) => file.path === "lectures/alg-L01.md")!.content;
    expect(session).toContain("## What this session covers");

    const roles = store.nodes(job.id).map((node) => node.role);
    for (const role of [
      "run",
      "document",
      "prepare",
      "brief",
      "reader",
      "escalation",
      "author",
      "reviewer",
      "fix",
      "recheck",
      "ledger",
      "publish",
    ])
      expect(roles).toContain(role);
    // The author wrote once. One fix round added the diagram it forgot, as a block of its own,
    // and only that block's claim was checked again.
    expect(models.calls.filter((call) => call.system.startsWith("You write"))).toHaveLength(1);
    expect(store.nodes(job.id).filter((node) => node.role === "fix")).toEqual([
      expect.objectContaining({
        title: "Fix · round 1",
        attempt: 1,
        outcome: { discrepancies: 1, fixed: 1 },
      }),
    ]);
    expect(store.nodes(job.id).find((node) => node.title === "Rechecks")?.task).toBe(
      "Check 1 corrected claim against the page images",
    );
    expect(document!.draft.pages[0]!.blocks.map((block) => block.id)).toEqual([
      "bfs-marking",
      "bfs-automaton",
    ]);
    expect(document!.draft.pages[0]!.blocks[0]).toEqual(draft(false).pages[0]!.blocks[0]);
    expect(models.calls.find((call) => call.system.startsWith("You read"))?.model).toBe(
      "gpt-6.1-sol",
    );
    expect(store.coverage(job.id).every((cell) => cell.state === "represented")).toBe(true);
    // The document records what it produced, in counts the Jobs page can show.
    expect(store.nodes(job.id).find((node) => node.role === "document")?.outcome).toEqual({
      pages: 2,
      figures: 1,
      topics: 1,
      sections: 2,
      claims: 2,
      disagreements: 0,
      uncovered: 0,
      discrepancies: 1,
      fixed: 1,
    });
    // Every structured request asks for its answer as a strict tool call with the step's schema.
    expect(models.calls.every((call) => call.schema)).toBe(true);
  });

  it("runs each step on the model set for it, through that model's own connection", async () => {
    const models = fakeModels();
    let roles = studyRoles({
      ...DEFAULT_ROLES,
      reader: "chatgpt/gpt-6.1-sol",
      writer: "openrouter/deepseek/deepseek-v4-pro",
      checker: "anthropic/claude-sonnet-5-5",
      rechecker: "google/gemini-3.8-flash",
    });
    const { store, runner, course, lecture, finished } = await setup(models.complete, undefined, {
      roles: () => roles,
    });
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    const used = (start: string) =>
      new Set(
        models.calls.filter((call) => call.system.startsWith(start)).map((call) => call.model),
      );
    // A ChatGPT model keeps its bare ID, as every study before named it.
    expect(used("You read a lecture page")).toEqual(new Set(["gpt-6.1-sol"]));
    // The writer also corrects what the check found.
    expect(used("You write")).toEqual(new Set(["openrouter/deepseek/deepseek-v4-pro"]));
    expect(used("You correct")).toEqual(new Set(["openrouter/deepseek/deepseek-v4-pro"]));
    expect(used("You independently check")).toEqual(
      new Set(["anthropic/claude-sonnet-5-5", "google/gemini-3.8-flash"]),
    );
    const providers = (role: string) =>
      new Set(
        store
          .nodes(job.id)
          // Each step's own node; the group above a role's steps names no provider.
          .filter((node) => node.role === role && node.provider)
          .map((node) => node.provider),
      );
    expect(providers("reader")).toEqual(new Set(["openai"]));
    expect(providers("author")).toEqual(new Set(["openrouter"]));
    expect(providers("reviewer")).toEqual(new Set(["anthropic"]));
    expect(providers("recheck")).toEqual(new Set(["google"]));
    // A change in Settings applies to the next study.
    roles = studyRoles(DEFAULT_ROLES);
    models.calls.length = 0;
    const again = await runner.start(course.id, [lecture.id]);
    await finished(again.id);
    expect(used("You write")).toEqual(new Set(["gpt-6.1-sol"]));
  });

  it("keeps each document's close-ups under its own reader when two are read at once", async () => {
    const { home, library, store, runner, course, lecture, finished } = await setup();
    const pdf = resolve(home, "Lecture 2 Depth-first search.pdf");
    await writeFile(pdf, syntheticPdf([["Depth-first search"], ["Stacks and recursion"]]));
    const second = (await library.importFile(course.id, pdf)).document;
    const job = await runner.start(course.id, [lecture.id, second.id]);
    await finished(job.id);
    const nodes = store.nodes(job.id);
    // One careful reader per page, two pages each.
    const readers = nodes.filter((node) => node.role === "reader" && node.title !== "Readers");
    expect(readers.map((reader) => reader.title)).toEqual(["Page 1", "Page 2", "Page 1", "Page 2"]);
    // Both documents escalate the same page number; each close-up hangs under its own reader.
    for (const reader of readers.filter((node) => node.title === "Page 2"))
      expect(
        nodes.filter((node) => node.role === "escalation" && node.parentId === reader.id),
      ).toHaveLength(1);
  });

  it("keeps replies it could not use, per step, until the job is dismissed", async () => {
    const { store, course, lecture } = await setup();
    const job = store.createJob({ courseId: course.id, documentIds: [lecture.id], title: "x" });
    const node = store.addNode(job.id, {
      parentId: null,
      role: "reader",
      title: "Pages 1–3",
      task: "",
    });
    store.recordRejection(node.id, { attempt: 1, problem: "at /pages bad", reply: "{}" });
    expect(store.rejections(job.id)).toEqual([
      expect.objectContaining({
        nodeId: node.id,
        attempt: 1,
        problem: "at /pages bad",
        reply: "{}",
      }),
    ]);
    store.deleteJob(job.id);
    expect(store.rejections(job.id)).toEqual([]);
  });

  it("gives a resumed step a fresh clock and drops its old failure note", async () => {
    const { store, course, lecture } = await setup();
    const job = store.createJob({ courseId: course.id, documentIds: [lecture.id], title: "x" });
    const node = store.addNode(job.id, { parentId: null, role: "brief", title: "Brief", task: "" });
    store.setNode(node.id, { status: "running" });
    store.setNode(node.id, { status: "failed", note: "The reply did not match." });
    const failed = store.node(node.id);
    await new Promise((done) => setTimeout(done, 5));
    const resumed = store.setNode(node.id, { status: "running" });
    expect(resumed.note).toBeNull();
    expect(resumed.endedAt).toBeNull();
    expect(resumed.startedAt! > failed.startedAt!).toBe(true);
  });

  it("resumes from checkpoints without paying for finished steps again", async () => {
    const options = { failWriting: true };
    const models = fakeModels(options);
    const { store, runner, course, lecture, published, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("failed");
    const pages = store.view(job.id).pages;
    const reads = () => models.calls.filter((call) => !call.system.startsWith("You write")).length;
    const readsBefore = reads();

    options.failWriting = false;
    runner.resume(job.id);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(published).toHaveLength(1);
    // The brief, readers and close-ups ran once; only writing and checking ran again.
    expect(
      models.calls
        .slice(readsBefore)
        .filter((call) => /^You (plan|read|re-read)/.test(call.system)),
    ).toEqual([]);
    expect(reads()).toBeGreaterThan(readsBefore);
    // Page counts are rebuilt, not added to the first run's.
    expect(store.view(job.id).pages).toBe(pages);
    expect(() => runner.resume(job.id)).toThrow("already finished");
  });

  it("records a failed publish on its own node, and Resume publishes without asking again", async () => {
    const models = fakeModels();
    let refuse = true;
    const published: DraftBundle[] = [];
    const { store, runner, course, lecture, finished } = await setup(
      models.complete,
      async (bundle) => {
        if (refuse) throw new Error("UNIQUE constraint failed: blocks.handle");
        published.push(bundle);
        return published.length;
      },
    );
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("failed");
    const nodes = store.nodes(job.id);
    expect(nodes.find((node) => node.role === "publish")).toMatchObject({
      status: "failed",
      note: "UNIQUE constraint failed: blocks.handle",
    });
    expect(nodes.find((node) => node.role === "run")?.note).toBe(
      `${PUBLISH_FAILED} UNIQUE constraint failed: blocks.handle`,
    );
    expect(nodes.find((node) => node.role === "document")?.status).toBe("done");

    const calls = models.calls.length;
    refuse = false;
    runner.resume(job.id);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(published).toHaveLength(1);
    expect(models.calls).toHaveLength(calls);
    expect(
      store
        .nodes(job.id)
        .filter((node) => node.role === "publish")
        .at(-1),
    ).toMatchObject({
      status: "done",
      task: "Added to Algorithms as version 1",
    });
  });

  it("stops fixing once a round changes nothing, writes up from the slide what it still missed, and keeps doubts for the tutor", async () => {
    const models = fakeModels({ stubborn: true, doubt: true });
    const { store, runner, course, lecture, published, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    // The fixer returned nothing, so a second round would only ask the same again.
    expect(models.calls.filter((call) => call.system.startsWith("You write"))).toHaveLength(1);
    expect(models.calls.filter((call) => call.system.startsWith("You correct"))).toHaveLength(1);
    expect(
      store
        .nodes(job.id)
        .filter((node) => node.role === "fix")
        .map((node) => [node.title, node.outcome]),
    ).toEqual([["Fix · round 1", { discrepancies: 2, fixed: 0 }]]);
    const [document] = published[0]!.documents;
    // Nothing is left as a gap: the diagram the author kept missing is written up from the slide.
    expect(document!.ledger.map((entry) => entry.state)).not.toContain("gap");
    expect(document!.ledger.find((entry) => entry.region === "p2.r1")?.state).toBe("described");
    const blocks = document!.draft.pages.flatMap((page) => page.blocks);
    expect(blocks.find((block) => block.unreviewed)).toMatchObject({
      title: "Also on page 2",
      body: expect.stringContaining("Automaton with states q0 and q1."),
      locators: [{ page: 2, region: "p2.r1", location: "as on the slide" }],
    });
    // The doubted claim is kept for the tutor, never written into what the student reads.
    const marking = blocks.find((block) => block.id === "bfs-marking")!;
    expect(marking.body).not.toContain("Not confirmed");
    expect(marking.disputed).toEqual([
      {
        text: "Each vertex is marked visited when it enters the queue.",
        note: "The slide says otherwise: The page says it is marked when dequeued.",
      },
    ]);
    expect(store.nodes(job.id).find((node) => node.role === "document")?.outcome).toMatchObject({
      uncovered: 1,
      disagreements: 1,
      discrepancies: 2,
      fixed: 0,
    });
  });

  it("rewords a claim the page contradicts in its own block, and checks only that claim again", async () => {
    const models = fakeModels({ doubtOnce: true });
    const { store, runner, course, lecture, published, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(models.calls.filter((call) => call.system.startsWith("You write"))).toHaveLength(1);
    const rechecks = store.nodes(job.id).filter((node) => node.role === "recheck");
    // One group and one batch: the reworded claim and the diagram's new one, nothing else.
    expect(rechecks.find((node) => node.title === "Rechecks")?.task).toBe(
      "Check 2 corrected claims against the page images",
    );
    const [document] = published[0]!.documents;
    const marking = document!.draft.pages[0]!.blocks.find((block) => block.id === "bfs-marking")!;
    expect(marking.claims).toEqual([
      { text: "Each vertex is marked visited as it enters the queue.", region: "p1.r2" },
    ]);
    expect(marking.disputed).toBeUndefined();
    expect(Object.values(document!.verdicts).map((verdict) => verdict.verdict)).toEqual([
      "supported",
      "supported",
    ]);
  });

  it("leaves notes alone that teach every fact of a slide in their own words", async () => {
    const models = fakeModels({ paraphrase: true });
    const { store, runner, course, lecture, published, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(models.calls.filter((call) => call.system.startsWith("You write"))).toHaveLength(1);
    expect(models.calls.filter((call) => call.system.startsWith("You correct"))).toHaveLength(0);
    const [document] = published[0]!.documents;
    // Few of the slide's words reach the block, which is recorded but is not a reason to act.
    expect(document!.ledger.find((entry) => entry.region === "p1.r2")).toMatchObject({
      state: "represented",
      reason: expect.stringMatching(/^cited \(\d+% of its words reach the cited blocks/),
    });
    expect(
      document!.draft.pages.flatMap((page) => page.blocks).some((block) => block.unreviewed),
    ).toBe(false);
    expect(document!.coverage?.["p1.r2"]?.facts).toEqual([
      {
        fact: "Each vertex is marked visited when it enters the queue. The running time is O(V + E).",
        block: "bfs-marking",
      },
    ]);
  });

  it("does not send back a Hebrew slide explained in English", async () => {
    const models = fakeModels({ paraphrase: true });
    const inventory = structuredClone(INVENTORY);
    inventory.pages[0]!.regions[1]!.text = "כל צומת מסומן כשהוא נכנס לתור. זמן הריצה הוא O(V + E).";
    const { store, runner, course, lecture, published, finished } = await setup(
      models.complete,
      undefined,
      { prepare: async () => ({ ...fakeSource(), inventory }) },
    );
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(models.calls.filter((call) => call.system.startsWith("You correct"))).toHaveLength(0);
    const [document] = published[0]!.documents;
    expect(document!.ledger.find((entry) => entry.region === "p1.r2")?.state).toBe("represented");
    expect(
      document!.draft.pages.flatMap((page) => page.blocks).some((block) => block.unreviewed),
    ).toBe(false);
  });

  it("writes a fact no block carries into the block that cites its region", async () => {
    const models = fakeModels({ missingFact: true });
    const { store, runner, course, lecture, published, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(models.calls.filter((call) => call.system.startsWith("You write"))).toHaveLength(1);
    expect(models.calls.filter((call) => call.system.startsWith("You correct"))).toHaveLength(1);
    const checkers = store.nodes(job.id).filter((node) => node.title === "Reviewers");
    expect(checkers[0]?.outcome).toMatchObject({ claims: 1, regions: 3, discrepancies: 2 });
    const [document] = published[0]!.documents;
    const blocks = document!.draft.pages.flatMap((page) => page.blocks);
    expect(blocks.find((block) => block.id === "bfs-marking")?.body).toContain(
      "linear in the size",
    );
    expect(blocks.some((block) => block.unreviewed)).toBe(false);
    expect(store.nodes(job.id).find((node) => node.role === "document")?.outcome).toMatchObject({
      discrepancies: 2,
      fixed: 2,
      uncovered: 0,
    });
  });

  it("writes up from the slide a fact the fixer would not add", async () => {
    const models = fakeModels({ missingFact: true, stubborn: true });
    const { store, runner, course, lecture, published, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    const [document] = published[0]!.documents;
    const fallbacks = document!.draft.pages
      .flatMap((page) => page.blocks)
      .filter((block) => block.unreviewed);
    expect(fallbacks.map((block) => block.locators[0]!.region)).toEqual(["p1.r2", "p2.r1"]);
    expect(fallbacks[0]!.body).toBe(
      "Also on this slide: Each vertex is marked visited when it enters the queue. The running time is O(V + E).",
    );
    expect(store.nodes(job.id).find((node) => node.role === "document")?.outcome).toMatchObject({
      uncovered: 2,
    });
  });

  it("cites a region already explained elsewhere instead of fixing it", async () => {
    const models = fakeModels({ restated: true });
    const { store, runner, course, lecture, published, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(models.calls.filter((call) => call.system.startsWith("You correct"))).toHaveLength(0);
    const [document] = published[0]!.documents;
    expect(document!.draft.pages[0]!.blocks[0]!.locators.at(-1)).toEqual({
      page: 2,
      region: "p2.r1",
      location: "restated",
    });
    expect(document!.ledger.find((entry) => entry.region === "p2.r1")?.state).toBe("described");
  });

  it("looks closer at a region the checker could not make out, before fixing", async () => {
    const models = fakeModels();
    const asked: string[][] = [];
    const complete = vi.fn(async (request: ModelRequest): Promise<ModelReply> => {
      const all = request.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      if (request.system.startsWith("You re-read hard regions")) {
        const ids = [...all.matchAll(/Region (p\d+\.r\d+)/g)].map((match) => match[1]!);
        asked.push(ids);
        if (!ids.includes("p1.r2")) return models.complete(request);
        return {
          text: JSON.stringify({
            regions: ids.map((id) => ({
              id,
              type: "text",
              content: "Each vertex is marked visited when it enters the queue.",
              claims: [],
              nodes: [],
              edges: [],
              unreadable: "",
            })),
          }),
          stopReason: "stop",
          usage: { input: 1, output: 1 },
        };
      }
      const reply = await models.complete(request);
      if (!request.system.startsWith("You independently check study notes")) return reply;
      const answer = JSON.parse(reply.text) as {
        coverage: { region: string; legible: boolean; note: string }[];
      };
      for (const entry of answer.coverage)
        if (entry.region === "p1.r2") Object.assign(entry, { legible: false, note: "blurred" });
      return { ...reply, text: JSON.stringify(answer) };
    });
    const { store, runner, course, lecture, finished } = await setup(complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(asked).toContainEqual(["p1.r2"]);
    expect(
      store.nodes(job.id).find((node) => node.role === "escalation" && node.pages[0] === 1),
    ).toMatchObject({
      title: "Page 1 close-up · round 1",
      task: "Re-read 1 hard region: the checker could not read it",
    });
  });

  it("writes a text region every revision missed from the slide's own words, so it counts as covered", () => {
    const regions = Object.fromEntries(
      INVENTORY.pages.flatMap((page) =>
        page.regions.map((region) => [
          region.id,
          {
            id: region.id,
            type: "text",
            content: region.text,
            claims: [],
            flags: [],
            escalated: false,
            unreadable: "",
          },
        ]),
      ),
    ) as Parameters<typeof computeLedger>[1];
    const forgetful = draft(true);
    forgetful.pages[0]!.blocks[0]!.locators = forgetful.pages[0]!.blocks[0]!.locators.filter(
      (locator) => locator.region !== "p1.r2",
    );
    const before = computeLedger(INVENTORY, regions, forgetful);
    expect(before.find((entry) => entry.region === "p1.r2")?.state).toBe("unaccounted");
    const filled = withFallbacks(forgetful, before, INVENTORY, regions, "Graph traversal");
    const after = computeLedger(INVENTORY, regions, filled);
    expect(after.find((entry) => entry.region === "p1.r2")?.state).toBe("represented");
    expect(filled.pages[0]!.blocks.at(-1)).toMatchObject({
      body: "Also on this slide: Each vertex is marked visited when it enters the queue. The running time is O(V + E).",
      unreviewed: true,
    });
  });

  it("takes out a sentence the slide contradicts", () => {
    const base = draft(true);
    base.pages[0]!.blocks[0]!.body =
      "Each vertex is marked visited when it enters the queue. So the running time is O(V + E).";
    const settled = settleDisputes(base, {
      c1: {
        claim: "c1",
        verdict: "contradicted",
        note: "Marked when dequeued.",
        region: "p1.r2",
        text: "Each vertex is marked visited when it enters the queue.",
      },
    });
    expect(settled.pages[0]!.blocks[0]!.body).toBe("So the running time is O(V + E).");
    expect(settled.pages[0]!.blocks[0]!.claims).toEqual([]);
  });

  it("retires an earlier failed run once the same documents are studied, and dismisses jobs", async () => {
    const options = { failWriting: true };
    const { runner, store, course, lecture, removed, finished } = await setup(
      fakeModels(options).complete,
    );
    const failed = await runner.start(course.id, [lecture.id]);
    await finished(failed.id);
    expect(store.job(failed.id).status).toBe("failed");

    options.failWriting = false;
    const again = await runner.start(course.id, [lecture.id]);
    await finished(again.id);
    expect(store.job(again.id).status).toBe("done");
    expect(removed).toEqual([failed.id]);
    expect(store.jobs().map((job) => job.id)).toEqual([again.id]);

    runner.dismiss(again.id);
    expect(store.jobs()).toEqual([]);
  });

  it("keeps one document's failure from stopping the other, and publishes what finished", async () => {
    const models = fakeModels();
    const { home, library, store, course, lecture } = await setup(models.complete);
    const pdf = resolve(home, "Lecture 2 Depth-first search.pdf");
    await writeFile(pdf, syntheticPdf([["Depth-first search"], ["Stacks"]]));
    const broken = (await library.importFile(course.id, pdf)).document;
    // The second lecture has seven pages (three reader batches); its readers' replies are cut off.
    const brokenSource = (): PreparedSource => {
      let closed = false;
      const used = async () => {
        if (closed) throw new Error("source used after it was closed");
        return new Uint8Array([137, 80, 78, 71]);
      };
      return {
        inventory: {
          version: 1,
          sha256: broken.sha256,
          pages: Array.from({ length: 7 }, (_, index) => ({
            page: index + 1,
            width: 612,
            height: 792,
            textLayer: "ok" as const,
            characters: 20,
            regions: [
              {
                id: `p${index + 1}.r1`,
                page: index + 1,
                kind: "text" as const,
                box: [72, 60, 400, 80] as [number, number, number, number],
                text: `BROKEN page ${index + 1}`,
                direction: "ltr" as const,
                numbers: [],
              },
            ],
          })),
        },
        render: used,
        crop: used,
        close: async () => {
          closed = true;
        },
      };
    };
    const complete = vi.fn(async (request: ModelRequest): Promise<ModelReply> => {
      const all = request.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      if (request.system.startsWith("You read a lecture page") && all.includes("BROKEN"))
        return { text: '{"pages":', stopReason: "length", usage: { input: 1, output: 1 } };
      return models.complete(request);
    });
    const published: DraftBundle[] = [];
    const runner = new IngestRunner({
      store,
      library,
      complete,
      prepare: async (_data, sha256) => (sha256 === broken.sha256 ? brokenSource() : fakeSource()),
      emit: () => {},
      publish: async (bundle) => (published.push(bundle), published.length),
    });
    const job = await runner.start(course.id, [lecture.id, broken.id]);
    await vi.waitFor(() => expect(["failed", "done"]).toContain(store.job(job.id).status), {
      timeout: 5000,
    });
    expect(store.job(job.id).status).toBe("failed");
    expect(published.map((bundle) => bundle.documents.map((d) => d.documentId))).toEqual([
      [lecture.id],
    ]);
    const nodes = store.nodes(job.id);
    expect(nodes.find((node) => node.title === broken.title)).toMatchObject({
      status: "failed",
      note: expect.stringContaining("cut off"),
    });
    expect(nodes.find((node) => node.title === lecture.title)?.status).toBe("done");
    // Siblings of the failed reader were called off, not crashed on a closed source.
    expect(nodes.some((node) => node.note?.includes("closed"))).toBe(false);
  });

  it("lets documents studied together take turns for model requests", async () => {
    const limit = fairLimiter(2);
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const request = (name: string) =>
      limit(name[0]!, () => {
        started.push(name);
        return new Promise<void>((done) => gates.set(name, done));
      });
    // Lecture A queues all its pages first; lecture B's arrive just after.
    const all = ["A1", "A2", "A3", "A4", "A5", "B1", "B2"].map(request);
    await Promise.resolve();
    expect(started).toEqual(["A1", "A2"]);
    for (const name of ["A1", "A2", "A3", "B1", "A4", "B2", "A5"]) {
      gates.get(name)?.();
      await new Promise((tick) => setTimeout(tick, 0));
    }
    await Promise.all(all);
    // B starts long before A's last page; first come, first served would make it wait for all of A.
    expect(started).toEqual(["A1", "A2", "A3", "B1", "A4", "B2", "A5"]);
  });

  it("hashes step inputs the same whatever order their keys were filled in", () => {
    expect(hash({ "p2.r1": { content: "a", type: "x" }, "p1.r1": [1, { b: 2, a: 1 }] })).toBe(
      hash({ "p1.r1": [1, { a: 1, b: 2 }], "p2.r1": { type: "x", content: "a" } }),
    );
    expect(hash({ list: [1, 2] })).not.toBe(hash({ list: [2, 1] }));
  });

  it("refuses homework and other non-teaching documents", async () => {
    const { runner, course, assignment } = await setup();
    await expect(runner.start(course.id, [assignment.id])).rejects.toThrow(
      "Only lectures and recitations",
    );
  });

  it("never accepts a cut-off reply, and pauses at the plan's usage limit", async () => {
    const truncated = vi.fn(async (): Promise<ModelReply> => ({
      text: '{"title":',
      stopReason: "length",
      usage: { input: 1, output: 1 },
    }));
    const first = await setup(truncated);
    const job = await first.runner.start(first.course.id, [first.lecture.id]);
    await first.finished(job.id);
    expect(first.store.job(job.id).status).toBe("failed");
    expect(first.store.nodes(job.id).find((node) => node.role === "brief")?.note).toContain(
      "cut off",
    );

    const limited = vi.fn(async (): Promise<ModelReply> => ({
      text: "",
      stopReason: "error",
      usage: { input: 0, output: 0 },
      error: "subscription_sharing_usage_limit_exceeded",
    }));
    const second = await setup(limited);
    const paused = await second.runner.start(second.course.id, [second.lecture.id]);
    await second.finished(paused.id);
    expect(second.store.job(paused.id).status).toBe("waiting");
    expect(second.store.nodes(paused.id).find((node) => node.role === "run")?.note).toContain(
      "usage limit",
    );
  });

  it("leaves regions unaccounted when nothing cites, omits or explains them", () => {
    const ledger = computeLedger(INVENTORY, {}, { ...draft(false), omitted: [] });
    expect(ledger.find((entry) => entry.region === "p1.r3")?.state).toBe("unaccounted");
    expect(ledger.find((entry) => entry.region === "p2.r1")?.state).toBe("unaccounted");
    expect(coursePrefix("Computational Models")).toBe("cm");
    expect(coursePrefix("Algorithms")).toBe("alg");
  });
});

describe("looking closer only where needed", () => {
  const page = (textLayer: PageInventory["textLayer"] = "ok"): PageInventory => ({
    page: 4,
    width: 612,
    height: 792,
    textLayer,
    characters: 200,
    regions: [],
  });
  const region = (kind: Region["kind"], text: string, numbers: string[] = []): Region => ({
    id: "p4.r1",
    page: 4,
    kind,
    box: [0, 0, 100, 100],
    text,
    direction: "ltr",
    numbers,
  });
  const reading = (content: string, extra: Partial<ReadRegion> = {}): ReadRegion => ({
    id: "p4.r1",
    type: "text",
    content,
    claims: [],
    flags: [],
    confidence: "sure",
    ...extra,
  });
  const definition = "A queue serves vertices in the order they were discovered.";
  const automaton =
    "Automaton: q0 -> q1 on input a, q1 -> q2 on input b, q2 is the accepting state drawn with a double circle.";

  it("re-reads a region only for a reason it can name", () => {
    const cases: [string, Parameters<typeof gateRegion>, string | null | RegExp][] = [
      ["a faithful reading", [page(), region("text", definition), reading(definition), null], null],
      [
        "a page the reader lost",
        [page(), region("text", definition), reading(definition), "the reader skipped this page"],
        "the reader skipped this page",
      ],
      [
        "a skipped region",
        [page(), region("text", definition), undefined, null],
        "the reader skipped this region",
      ],
      [
        "handwriting",
        [page(), region("text", definition), reading(definition, { flags: ["handwriting"] }), null],
        "flagged as hard: handwriting",
      ],
      [
        "a footer",
        [page("empty"), region("text", "3"), reading("3", { type: "header_footer" }), null],
        null,
      ],
      [
        "no text layer, read from the image",
        [page("empty"), region("text", ""), reading(definition), null],
        null,
      ],
      [
        "a picture read in a few words",
        [page(), region("image", ""), reading("A photo of a router.", { type: "diagram" }), null],
        "image read in only a few words",
      ],
      [
        "a picture read in full",
        [
          page(),
          region("image", ""),
          reading("A network: two routers joined by a link, each with three hosts attached.", {
            type: "diagram",
          }),
          null,
        ],
        null,
      ],
      [
        "a guess",
        [page(), region("text", definition), reading(definition, { confidence: "unsure" }), null],
        "the reader was unsure",
      ],
      [
        "dropped words",
        [page(), region("text", definition), reading("A queue serves vertices."), null],
        /dropped words \(kept \d+%\)/,
      ],
      [
        "a missing bound",
        [
          page(),
          region("text", "BFS runs in O(V + E) time", ["O(V + E)"]),
          reading("BFS runs in linear time"),
          null,
        ],
        /numbers or symbols missing: O\(V \+ E\)/,
      ],
      [
        "math italic read plainly",
        [
          page(),
          region("text", "𝑀 accepts 𝑤 iff the run ends in an accepting state"),
          reading("M accepts w iff the run ends in an accepting state"),
          null,
        ],
        null,
      ],
      [
        "a drawing read in full",
        [
          page(),
          region("drawing", "q0 q1 q2 a b"),
          reading(automaton, { type: "diagram", flags: ["arrows"] }),
          null,
        ],
        null,
      ],
      [
        "a drawing with no hard parts",
        [page(), region("drawing", "q0 q1"), reading("Two states.", { type: "diagram" }), null],
        null,
      ],
      [
        "a small automaton in symbols",
        [
          page(),
          region("drawing", "q0 q1 a b"),
          reading("q0 -> q1 on a, q1 -> q0 on b, q1 accepting", {
            type: "diagram",
            flags: ["arrows"],
          }),
          null,
        ],
        null,
      ],
      [
        "arrows not written out",
        [
          page(),
          region("drawing", "q0 q1"),
          reading("Two states joined by edges.", { type: "diagram", flags: ["arrows"] }),
          null,
        ],
        /no arrow written out/,
      ],
      [
        "a chart with no values",
        [
          page(),
          region("drawing", "Runtime"),
          reading(
            "Runtime grows as the input grows, faster for the naive version than for the tuned one.",
            { type: "chart", flags: ["chart"] },
          ),
          null,
        ],
        /no values read/,
      ],
      [
        "a short reading of small text",
        [
          page(),
          region("drawing", "Legend"),
          reading("Legend: small print.", { type: "diagram", flags: ["small_text"] }),
          null,
        ],
        /the reading is short/,
      ],
    ];
    for (const [name, args, expected] of cases)
      if (expected instanceof RegExp) expect(gateRegion(...args), name).toMatch(expected);
      else expect(gateRegion(...args), name).toBe(expected);
  });

  it("re-reads the hard regions of one page together, in one request per page", async () => {
    const models = fakeModels();
    // Page 2 gains a photo with no words, and a third page holds one more.
    const inventory = structuredClone(INVENTORY);
    inventory.pages[1]!.regions.push({
      ...inventory.pages[1]!.regions[0]!,
      id: "p2.r2",
      kind: "image",
      text: "",
    });
    inventory.pages.push({
      ...structuredClone(inventory.pages[1]!),
      page: 3,
      regions: [
        { ...inventory.pages[1]!.regions[0]!, id: "p3.r1", page: 3, kind: "image", text: "" },
      ],
    });
    const asked: string[][] = [];
    const complete = vi.fn(async (request: ModelRequest): Promise<ModelReply> => {
      if (!request.system.startsWith("You re-read hard regions")) return models.complete(request);
      const all = request.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      const ids = [...all.matchAll(/Region (p\d+\.r\d+)/g)].map((match) => match[1]!);
      asked.push(ids);
      return {
        text: JSON.stringify({
          regions: ids.map((id) => ({
            id,
            type: "diagram",
            content: `A close look at ${id}: q0 -> q1.`,
            claims: [],
            nodes: [],
            edges: [],
            unreadable: "",
          })),
        }),
        stopReason: "stop",
        usage: { input: 100, output: 50 },
      };
    });
    const { store, runner, course, lecture, finished } = await setup(complete, undefined, {
      prepare: async () => ({ ...fakeSource(), inventory }),
    });
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    // Pages are re-read side by side, so they may finish in either order.
    expect(asked.map((ids) => ids.toSorted().join(" ")).toSorted()).toEqual([
      "p2.r1 p2.r2",
      "p3.r1",
    ]);
    expect(
      store
        .nodes(job.id)
        .filter((node) => node.role === "escalation")
        .map((node) => node.title)
        .toSorted(),
    ).toEqual(["Page 2 close-up", "Page 3 close-up"]);
  });

  for (const concurrency of [1, 2])
    it(`keeps at most ${concurrency} request${concurrency === 1 ? "" : "s"} in flight, close-ups and writing included`, async () => {
      const models = fakeModels();
      let inFlight = 0;
      let most = 0;
      const complete = vi.fn(async (request: ModelRequest): Promise<ModelReply> => {
        most = Math.max(most, ++inFlight);
        try {
          await new Promise((done) => setTimeout(done, 5));
          return await models.complete(request);
        } finally {
          inFlight--;
        }
      });
      const { home, library, store, runner, course, lecture, finished } = await setup(
        complete,
        undefined,
        { concurrency },
      );
      const pdf = resolve(home, "Lecture 2 Depth-first search.pdf");
      await writeFile(pdf, syntheticPdf([["Depth-first search"], ["Stacks and recursion"]]));
      const second = (await library.importFile(course.id, pdf)).document;
      const job = await runner.start(course.id, [lecture.id, second.id]);
      await finished(job.id);
      expect(store.job(job.id).status).toBe("done");
      expect(models.calls.some((call) => call.system.startsWith("You re-read hard regions"))).toBe(
        true,
      );
      expect(most).toBe(concurrency);
    });

  it("sends every request about a document with that document's own cache key", async () => {
    const models = fakeModels();
    const keys: (string | undefined)[] = [];
    const complete = vi.fn(async (request: ModelRequest) => {
      keys.push(request.cacheKey);
      return models.complete(request);
    });
    const { home, library, runner, course, lecture, finished } = await setup(complete);
    const pdf = resolve(home, "Lecture 2 Depth-first search.pdf");
    await writeFile(pdf, syntheticPdf([["Depth-first search"], ["Stacks and recursion"]]));
    const second = (await library.importFile(course.id, pdf)).document;
    const job = await runner.start(course.id, [lecture.id, second.id]);
    await finished(job.id);
    expect(new Set(keys)).toEqual(new Set([cacheKey(lecture), cacheKey(second)]));
    expect(cacheKey(lecture)).toMatch(/^folio-[0-9a-f]{32}$/);
  });
});

describe("careful readers and writers side by side", () => {
  it("asks each step for its own model and effort: judgment on 6.1 Sol at high, pages at medium, rechecks on Terra", async () => {
    const models = fakeModels({ doubtOnce: true, missingFact: true });
    const steps = new Map<string, string>();
    const complete = vi.fn(async (request: ModelRequest) => {
      const step = /^You ([\w-]+ [\w-]+ [\w-]+)/.exec(request.system)![1]!;
      steps.set(step, `${request.model} ${request.reasoning}`);
      return models.complete(request);
    });
    const { store, runner, course, lecture, finished } = await setup(complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(Object.fromEntries(steps)).toEqual({
      "plan the study": "gpt-6.1-sol high",
      "read a lecture": "gpt-6.1-sol medium",
      "re-read hard regions": "gpt-6.1-sol high",
      "write a reviewed": "gpt-6.1-sol high",
      "independently check study": "gpt-6.1-sol high",
      "correct specific discrepancies": "gpt-6.1-sol high",
      "independently check claims": "gpt-6.1-terra medium",
    });
  });

  it("writes each topic as soon as its pages are read, and merges the topics into one draft", async () => {
    const models = fakeModels({ topics: true, slowPage2: true });
    const { store, runner, course, lecture, published, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    // Marking's page was read first, so its writer started while page 2 was still being read.
    expect(models.events.indexOf("write Marking")).toBeLessThan(
      models.events.indexOf("read page 2"),
    );
    expect(
      store
        .nodes(job.id)
        .filter((node) => node.role === "author")
        .map((node) => node.title)
        .toSorted(),
    ).toEqual(["Topic · Automata", "Topic · Diagrams", "Topic · Marking"]);
    expect(models.calls.filter((call) => call.system.startsWith("You write a"))).toHaveLength(0);
    const [document] = published[0]!.documents;
    // Two writers chose the same topic and the same block name: one page, two blocks.
    expect(document!.draft.pages.map((page) => page.slug)).toEqual(["bfs"]);
    expect(document!.draft.pages[0]!.blocks.map((block) => block.id)).toEqual([
      "bfs-marking",
      "bfs-marking-2",
    ]);
    expect(document!.draft.session).toMatchObject({
      title: "Graph traversal",
      covers: "Breadth-first search and a small automaton.",
      worked_examples: [{ title: "Two states", page: 2, slug: "bfs" }],
    });
    expect(document!.ledger.find((entry) => entry.region === "p2.r1")?.state).toBe("described");
    expect(models.calls.filter((call) => call.system.startsWith("You correct"))).toHaveLength(0);
  });

  it("gives a page the outline left out to the topic of the nearest page", () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({
      ...INVENTORY.pages[0]!,
      page: index + 1,
    }));
    const brief = {
      title: "Shortest paths",
      outline: [
        { title: "Dijkstra", pages: [1, 2, 9] },
        { title: "Bellman-Ford", pages: [5] },
      ],
      notation: [],
      terms: [],
    };
    expect(topicPlan(brief, { ...INVENTORY, pages })).toEqual([
      { title: "Dijkstra", pages: [1, 2, 3] },
      { title: "Bellman-Ford", pages: [4, 5, 6] },
    ]);
    expect(topicPlan({ ...brief, outline: [] }, { ...INVENTORY, pages })).toEqual([
      { title: "Shortest paths", pages: [1, 2, 3, 4, 5, 6] },
    ]);
  });

  it("lets a waiting writer go before pages still waiting to be read", async () => {
    const limit = fairLimiter(1);
    const started: string[] = [];
    let release!: () => void;
    const first = limit("lecture", () => new Promise<void>((done) => (release = done)));
    const later = [
      limit("lecture", async () => void started.push("read 2")),
      limit("lecture", async () => void started.push("read 3")),
      limit("lecture", async () => void started.push("write"), 2),
      limit("lecture", async () => void started.push("check"), 1),
    ];
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await Promise.all([first, ...later]);
    expect(started).toEqual(["write", "check", "read 2", "read 3"]);
  });
});

describe("planning beside reading", () => {
  it("starts reading before the plan is made, and writes two topics side by side", async () => {
    const models = fakeModels();
    let planned!: () => void;
    const plan = new Promise<void>((done) => (planned = done));
    const order: string[] = [];
    const complete = vi.fn(async (request: ModelRequest): Promise<ModelReply> => {
      if (request.system.startsWith("You plan the study")) {
        await plan;
        order.push("plan");
        const reply = await models.complete(request);
        const brief = JSON.parse(reply.text) as { outline: { title: string; pages: number[] }[] };
        brief.outline = [
          { title: "Marking", pages: [1] },
          { title: "Automata", pages: [2] },
        ];
        return { ...reply, text: JSON.stringify(brief) };
      }
      if (request.system.startsWith("You read a lecture page")) {
        order.push("read");
        if (order.filter((item) => item === "read").length === 2) planned();
      }
      if (request.system.startsWith("You write the study wiki for one topic")) order.push("write");
      return models.complete(request);
    });
    const fake = fakeModels({ topics: true });
    const writers = vi.fn(async (request: ModelRequest) =>
      request.system.startsWith("You write the study wiki for one topic")
        ? fake.complete(request)
        : complete(request),
    );
    const { store, runner, course, lecture, finished } = await setup(writers);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(order.slice(0, 3)).toEqual(["read", "read", "plan"]);
    expect(
      store
        .nodes(job.id)
        .filter((node) => node.role === "author")
        .map((node) => node.title)
        .toSorted(),
    ).toEqual(["Topic · Automata", "Topic · Marking"]);
  });
});

describe("fixing in parts", () => {
  const item = (id: string, page: number, blocks: string[] = []) => ({
    id,
    kind: "missing" as const,
    region: `p${page}.r1`,
    page,
    blocks,
    detail: "",
  });

  it("sends a few discrepancies per request, in page order, keeping a block's in one part", () => {
    const parts = fixParts(
      [
        item("d1", 9),
        item("d2", 1, ["bfs-marking"]),
        item("d3", 2),
        item("d4", 3),
        item("d5", 4, ["bfs-marking"]),
        item("d6", 5),
        item("d7", 6),
      ],
      3,
    );
    expect(parts.map((part) => part.map((entry) => entry.id))).toEqual([
      ["d2", "d3", "d4", "d5"],
      ["d6", "d7", "d1"],
    ]);
  });

  it("writes up from the slide what a failed fix would have fixed, and still publishes", async () => {
    const models = fakeModels({ failFix: true });
    const { store, runner, course, lecture, published, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(store.nodes(job.id).find((node) => node.role === "fix")).toMatchObject({
      status: "done",
      note: expect.stringContaining("written up from the slides instead"),
    });
    const [document] = published[0]!.documents;
    expect(
      document!.draft.pages.flatMap((page) => page.blocks).find((block) => block.unreviewed),
    ).toMatchObject({ locators: [{ region: "p2.r1" }] });
  });
});

describe("checking while writing", () => {
  it("checks a slide once every topic on it is written, while other topics are still being written", async () => {
    const models = fakeModels({ topics: true, slowTopic: "Diagrams" });
    const { store, runner, course, lecture, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    const at = (event: string) => models.events.indexOf(event);
    // Slide 1 is Marking's alone; slide 2 is shared by Automata and the slow Diagrams.
    expect(at("check 1")).toBeGreaterThan(-1);
    expect(at("check 1")).toBeLessThan(at("wrote Diagrams"));
    expect(at("check 2")).toBeGreaterThan(at("wrote Diagrams"));
    // One check group for the document, with the whole lecture's totals.
    const groups = store.nodes(job.id).filter((node) => node.title === "Reviewers");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.outcome).toMatchObject({ regions: 3 });
  });
});

describe("a refused correction", () => {
  it("is kept with the reason it was refused", async () => {
    const models = fakeModels();
    const complete = vi.fn(async (request: ModelRequest): Promise<ModelReply> => {
      if (!request.system.startsWith("You correct specific discrepancies"))
        return models.complete(request);
      // A correction that drops a slide the section cited breaks the rules and is refused.
      const block = structuredClone(draft(false).pages[0]!.blocks[0]!);
      block.locators = block.locators.filter((locator) => locator.region !== "p1.r1");
      const all = request.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      const ids = [...all.matchAll(/^\[(d\d+)\]/gm)].map((match) => match[1]!);
      return {
        text: JSON.stringify({
          patches: [{ op: "replace_block", fixes: ids, block_id: block.id, block }],
        }),
        stopReason: "stop",
        usage: { input: 1, output: 1 },
      };
    });
    const { store, runner, course, lecture, finished } = await setup(complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(store.rejections(job.id)).toContainEqual(
      expect.objectContaining({
        problem: expect.stringMatching(/^Correction refused: /),
        reply: expect.stringContaining('"op":"replace_block"'),
      }),
    );
  });
});
