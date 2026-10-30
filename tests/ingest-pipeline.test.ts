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
  fairLimiter,
  hash,
  IngestRunner,
  PUBLISH_FAILED,
  settleDisputes,
  withFallbacks,
  type DraftBundle,
  type PreparedSource,
} from "../src/ingest/pipeline.ts";
import type { ModelReply, ModelRequest } from "../src/ingest/models.ts";
import type { AuthorDraft } from "../src/ingest/prompts.ts";
import type { SourceInventory } from "../src/ingest/types.ts";
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
 * A fake model: readers echo the text layer, the author forgets the diagram until revised.
 * `stubborn` keeps forgetting it; `doubt` makes the checker dispute every claim; `failWriting`
 * cuts the author off until it is switched back.
 */
function fakeModels(options: { stubborn?: boolean; doubt?: boolean; failWriting?: boolean } = {}) {
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
    if (request.system.startsWith("You prepare a brief"))
      return reply({
        title: "Graph traversal",
        outline: [{ title: "BFS", pages: [1] }],
        notation: [{ symbol: "V", meaning: "vertices" }],
        terms: [
          { english: "breadth-first search", hebrew: "סריקה לרוחב", meaning: "layered search" },
        ],
      });
    if (request.system.startsWith("You read a few pages")) {
      // Readers take a moment, so documents studied together overlap as they do for real.
      await new Promise((done) => setTimeout(done, 20));
      const pages = INVENTORY.pages.filter((page) => all.includes(`Page ${page.page}`));
      return reply({
        pages: pages.map((page) => ({
          page: page.page,
          regions: page.regions.map((region) => ({
            id: region.id,
            type: region.kind === "drawing" ? "diagram" : "text",
            content: region.text,
            claims: [],
            flags: [],
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
      return reply(draft(!options.stubborn && all.includes("Your previous draft")));
    }
    if (request.system.startsWith("You independently check")) {
      const ids = [...all.matchAll(/\[(c[0-9a-f]+)\]/g)].map((match) => match[1]);
      return reply({
        verdicts: ids.map((claim) =>
          options.doubt
            ? { claim, verdict: "contradicted", note: "The page says it is marked when dequeued." }
            : { claim, verdict: "supported", note: "" },
        ),
      });
    }
    throw new Error(`Unexpected request: ${request.system.slice(0, 60)}`);
  });
  return { complete, calls };
}

async function setup(
  complete = fakeModels().complete,
  publish?: (bundle: DraftBundle) => Promise<number>,
  roles?: ConstructorParameters<typeof IngestRunner>[0]["roles"],
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
    roles,
    prepare: async () => fakeSource(),
    emit: (job) => events.push(job),
    publish:
      publish ??
      (async (bundle) => {
        published.push(bundle);
        return published.length;
      }),
    removed: (id) => removed.push(id),
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
  it("reads, escalates, revises and publishes with every region accounted for", async () => {
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
      "ledger",
      "publish",
    ])
      expect(roles).toContain(role);
    expect(
      store
        .nodes(job.id)
        .filter((node) => node.role === "author")
        .map((node) => node.attempt),
    ).toEqual([1, 2]);
    expect(models.calls.find((call) => call.system.startsWith("You read"))?.model).toBe(
      "gpt-6-luna",
    );
    expect(store.coverage(job.id).every((cell) => cell.state === "represented")).toBe(true);
    // The document records what it produced, in counts the Jobs page can show.
    expect(store.nodes(job.id).find((node) => node.role === "document")?.outcome).toEqual({
      pages: 2,
      figures: 1,
      topics: 1,
      sections: 1,
      claims: 1,
      disagreements: 0,
      uncovered: 0,
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
    });
    const { store, runner, course, lecture, finished } = await setup(
      models.complete,
      undefined,
      () => roles,
    );
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    const used = (start: string) =>
      new Set(
        models.calls.filter((call) => call.system.startsWith(start)).map((call) => call.model),
      );
    // A ChatGPT model keeps its bare ID, as every study before named it.
    expect(used("You read a few pages")).toEqual(new Set(["gpt-6.1-sol"]));
    expect(used("You write a reviewed study wiki")).toEqual(
      new Set(["openrouter/deepseek/deepseek-v4-pro"]),
    );
    expect(used("You independently check")).toEqual(new Set(["anthropic/claude-sonnet-5-5"]));
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
    // A change in Settings applies to the next study.
    roles = studyRoles(DEFAULT_ROLES);
    models.calls.length = 0;
    const again = await runner.start(course.id, [lecture.id]);
    await finished(again.id);
    expect(used("You write a reviewed study wiki")).toEqual(new Set(["gpt-6.1-sol"]));
  });

  it("keeps each document's close-ups under its own reader when two are read at once", async () => {
    const { home, library, store, runner, course, lecture, finished } = await setup();
    const pdf = resolve(home, "Lecture 2 Depth-first search.pdf");
    await writeFile(pdf, syntheticPdf([["Depth-first search"], ["Stacks and recursion"]]));
    const second = (await library.importFile(course.id, pdf)).document;
    const job = await runner.start(course.id, [lecture.id, second.id]);
    await finished(job.id);
    const nodes = store.nodes(job.id);
    const readers = nodes.filter((node) => node.role === "reader" && node.title !== "Readers");
    expect(readers).toHaveLength(2);
    // Both documents escalate the same page number; each close-up hangs under its own reader.
    for (const reader of readers)
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
        .filter((call) => /^You (prepare|read|re-read)/.test(call.system)),
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

  it("revises three times, then writes up from the slide what it still missed, and keeps doubts for the tutor", async () => {
    const models = fakeModels({ stubborn: true, doubt: true });
    const { store, runner, course, lecture, published, finished } = await setup(models.complete);
    const job = await runner.start(course.id, [lecture.id]);
    await finished(job.id);
    expect(store.job(job.id).status).toBe("done");
    expect(models.calls.filter((call) => call.system.startsWith("You write"))).toHaveLength(4);
    const authors = store.nodes(job.id).filter((node) => node.role === "author");
    expect(authors.map((node) => [node.title, node.attempt])).toEqual([
      ["Author", 1],
      ["Author · revision 1", 2],
      ["Author · revision 2", 3],
      ["Author · revision 3", 4],
    ]);
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
      if (request.system.startsWith("You read a few pages") && all.includes("BROKEN"))
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
