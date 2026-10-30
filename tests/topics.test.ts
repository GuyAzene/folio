import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { studyNotesView } from "../src/desktop/study-notes.ts";
import { IngestRunner } from "../src/ingest/pipeline.ts";
import { JobStore } from "../src/jobs/store.ts";
import {
  mergeDraft,
  emptyKnowledge,
  upgradeKnowledge,
  withoutDocuments,
  type Knowledge,
} from "../src/kb/knowledge.ts";
import { KnowledgeStore } from "../src/kb/store.ts";
import { knowledgeTools } from "../src/kb/tools.ts";
import {
  finishKnowledge,
  topicInventory,
  topicProblems,
  type Relation,
  type TopicModel,
} from "../src/kb/topics.ts";
import { LibraryStore } from "../src/library/store.ts";
import { bundle } from "./fixtures/draft-bundle.ts";

// Synthetic sessions only: a lecture and a recitation that both teach breadth-first search.

const homes: string[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
  closers.splice(0).forEach((close) => close());
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const LECTURE = "00000000-0000-4000-8000-0000000000aa";
const RECITATION = "00000000-0000-4000-8000-0000000000bb";

/** The recitation calls BFS by another slug, a Hebrew title and an alias. */
function recitation(courseId: string) {
  const made = bundle(courseId, RECITATION, "alg-R01");
  const page = made.documents[0]!.draft.pages[0]!;
  page.slug = "breadth-first";
  page.title = "סריקה לרוחב";
  page.blocks[0]!.aliases = ["BFS"];
  page.blocks[0]!.kind = "example";
  return made;
}

/** A judge that answers every pair the same way, recording what it was asked. */
function judge(relation: () => Relation) {
  const asked: string[][] = [];
  const model: TopicModel = {
    judge: async (_knowledge, pairs) => {
      asked.push(pairs.map((pair) => `${pair.topic}|${pair.other}`));
      return pairs.map((pair) => ({ ...pair, relation: relation() }));
    },
    overview: async (knowledge, slugs) =>
      slugs.map((slug) => {
        const page = knowledge.pages.find((candidate) => candidate.slug === slug)!;
        return {
          slug,
          text: `${page.title} is taught in more than one session.`,
          handles: page.blocks.map((block) => block.handle),
        };
      }),
  };
  return { model, asked };
}

async function setup(model?: TopicModel) {
  const home = await mkdtemp(resolve(tmpdir(), "folio-topics-test-"));
  homes.push(home);
  const library = await LibraryStore.open({ home });
  const course = await library.createCourse({ name: "Algorithms" });
  const store = await KnowledgeStore.open(library, model ? { topics: model } : {});
  closers.push(() => store.close());
  return { home, library, course, store };
}

describe("shared topics", () => {
  it("merge a lecture's and a recitation's topic, named differently and in Hebrew, into one", async () => {
    const { model, asked } = judge(() => "same");
    const { library, course, store } = await setup(model);
    await store.publish(bundle(course.id, LECTURE, "alg-L01"));
    await store.publish(recitation(course.id));
    expect(asked.flat()).toContain("alg-breadth-first|alg-bfs");
    const knowledge = (await store.knowledge(course.id))!;
    const bfs = knowledge.pages.find((page) => page.slug === "alg-bfs")!;
    expect(bfs.blocks.map((block) => block.session).sort()).toEqual(["alg-L01", "alg-R01"]);
    expect(knowledge.pages.some((page) => page.slug === "alg-breadth-first")).toBe(false);
    expect(knowledge.redirects).toEqual({ "alg-breadth-first": "alg-bfs" });
    expect(bfs.overview?.text).toContain("taught in more than one session");
    // An old link to the merged topic still reads its sections.
    const read = knowledgeTools(store, library, course.id).find(
      (tool) => tool.name === "read_sections",
    )!;
    const text = (
      (await read.execute("call_1", { handles: ["alg-breadth-first"] })).content[0] as {
        text: string;
      }
    ).text;
    expect(text).toContain("Marking on enqueue");
    expect(text).not.toContain("Not found");
    // Each document's anchor page points at the shared topic.
    const view = studyNotesView(knowledge, store.current(course.id)!);
    expect(view.sessions.map((session) => [session.slug, session.topics])).toEqual([
      ["alg-L01", ["alg-graphs", "alg-bfs"]],
      ["alg-R01", ["alg-graphs", "alg-bfs"]],
    ]);
    const topic = view.topics.find((candidate) => candidate.slug === "alg-bfs")!;
    expect(topic.taughtIn.map((place) => place.session)).toEqual(["alg-L01", "alg-R01"]);
    // An explanation from the lecture comes before the recitation's example.
    expect(topic.sections.map((section) => [section.kind, section.session])).toEqual([
      ["explanation", "alg-L01"],
      ["example", "alg-R01"],
    ]);
  });

  it("keep related topics apart, linked both ways, and publish anyway when the judge fails", async () => {
    let mode: "related" | "fail" = "related";
    const { model } = judge(() => {
      if (mode === "fail") throw new Error("No connection.");
      return "related";
    });
    const { course, store } = await setup(model);
    await store.publish(bundle(course.id, LECTURE, "alg-L01"));
    await store.publish(recitation(course.id));
    const knowledge = (await store.knowledge(course.id))!;
    const linked = (slug: string) =>
      knowledge.pages.find((page) => page.slug === slug)!.related?.map((link) => link.slug);
    expect(linked("alg-bfs")).toContain("alg-breadth-first");
    expect(linked("alg-breadth-first")).toContain("alg-bfs");
    mode = "fail";
    const failing = recitation(course.id);
    failing.documents[0]!.documentId = "00000000-0000-4000-8000-0000000000cc";
    failing.documents[0]!.session.slug = "alg-R02";
    failing.documents[0]!.draft.pages[0]!.slug = "bfs-again";
    await expect(store.publish(failing)).resolves.toMatchObject({ generation: 3 });
  });

  it("fold a section that restates a definition into it, with both sources' pages", () => {
    const lecture = bundle("course", LECTURE, "alg-L01");
    lecture.documents[0]!.draft.pages[1]!.blocks[0]!.kind = "definition";
    const first = mergeDraft(emptyKnowledge("course", "alg"), lecture);
    const definition = first.pages.find((page) => page.slug === "alg-graphs")!.blocks[0]!;
    const again = bundle("course", RECITATION, "alg-R01");
    again.documents[0]!.draft.pages[1]!.blocks[0]!.restates = definition.handle;
    const knowledge = mergeDraft(first, again);
    const view = studyNotesView(knowledge, {
      courseId: "course",
      generation: 2,
      publishedAt: "2026-10-29T00:00:00.000Z",
      jobId: null,
      summary: "",
    });
    const graphs = view.topics.find((topic) => topic.slug === "alg-graphs")!;
    expect(graphs.sections).toHaveLength(1);
    expect(graphs.sections[0]!.kind).toBe("definition");
    expect(graphs.sections[0]!.alsoIn.map((other) => other.documentId)).toEqual([RECITATION]);
  });

  it("show the author the course's topics, and narrow a long list to what the lecture is about", () => {
    const knowledge = mergeDraft(
      emptyKnowledge("course", "alg"),
      bundle("course", LECTURE, "alg-L01"),
    );
    const inventory = topicInventory(knowledge);
    expect(inventory).toContain(
      "bfs · Breadth-first search · סריקה לרוחב, תור · aka breadth first",
    );
    expect(inventory).toContain("taught in alg-L01");
    const narrowed = topicInventory(knowledge, ["graphs"], 80);
    expect(narrowed).toContain("graphs · Graphs");
    expect(narrowed).not.toContain("Breadth-first");
  });

  it("keep a few links per topic, its parts and wholes first", () => {
    const knowledge = mergeDraft(
      emptyKnowledge("course", "alg"),
      bundle("course", LECTURE, "alg-L01"),
    );
    const many: Knowledge = structuredClone(knowledge);
    const extra = Array.from({ length: 6 }, (_, index) => ({
      ...structuredClone(many.pages[0]!),
      slug: `alg-extra-${index}`,
      blocks: [],
    }));
    many.pages.push(
      ...extra.map((page, index) => ({
        ...page,
        blocks: [{ ...structuredClone(knowledge.pages[0]!.blocks[0]!), handle: `extra-${index}` }],
      })),
    );
    const bfs = many.pages.find((page) => page.slug === "alg-bfs")!;
    bfs.related = [
      ...extra.slice(0, 5).map((page) => ({ slug: page.slug, relation: "related" as const })),
      { slug: "alg-extra-5", relation: "part_of" as const },
    ];
    const links = finishKnowledge(many).pages.find((page) => page.slug === "alg-bfs")!.related!;
    expect(links).toHaveLength(4);
    expect(links[0]).toEqual({ slug: "alg-extra-5", relation: "part_of" });
  });

  it("refuse a version whose blocks belong to no session or whose links point nowhere", () => {
    const knowledge = mergeDraft(
      emptyKnowledge("course", "alg"),
      bundle("course", LECTURE, "alg-L01"),
    );
    const broken: Knowledge = structuredClone(knowledge);
    broken.pages[0]!.blocks[0]!.session = "alg-L99";
    broken.redirects = { "alg-old": "alg-gone" };
    expect(topicProblems(broken).join(" ")).toMatch(/belongs to no session.*redirect from alg-old/);
    expect(topicProblems(knowledge)).toEqual([]);
  });

  it("read a version 1 generation as today's, so rollback crosses versions", async () => {
    const { library, course, store } = await setup();
    await store.publish(bundle(course.id, LECTURE, "alg-L01"));
    // The first generation, as Folio wrote it before topics were shared.
    const file = resolve(library.courseDirectory(course.id), "kb/generations/1/knowledge.json");
    const stored = JSON.parse(await readFile(file, "utf8")) as Knowledge;
    stored.version = 1;
    delete stored.redirects;
    for (const session of stored.sessions) delete session.outline;
    await writeFile(file, JSON.stringify(stored));
    await store.publish(recitation(course.id));
    store.rollback(course.id);
    store.release(course.id);
    const old = (await store.knowledge(course.id))!;
    expect(old.version).toBe(2);
    expect(old.sessions[0]!.outline?.map((row) => row.topic)).toEqual(["alg-graphs", "alg-bfs"]);
    expect(() => upgradeKnowledge({ version: 7 })).toThrow("not one Folio can read");
  });
});

describe("regrouping existing notes", () => {
  it("merges topics without writing anything again, then queues each document to be restudied", async () => {
    let relation: Relation = "different";
    const { model } = judge(() => relation);
    const { home, library, course, store } = await setup(model);
    await store.publish(bundle(course.id, LECTURE, "alg-L01"));
    await store.publish(recitation(course.id));
    expect((await store.knowledge(course.id))!.pages).toHaveLength(3);
    relation = "same";
    const jobs = await JobStore.open(home);
    closers.push(() => jobs.close());
    // The two synthetic documents, as the library would describe them for a restudy.
    vi.spyOn(library, "document").mockImplementation(
      async (id: string) =>
        ({
          id,
          courseId: course.id,
          title: id === LECTURE ? "Lecture 1" : "Recitation 1",
          role: id === LECTURE ? "lecture" : "recitation",
          kind: "pdf",
        }) as never,
    );
    const complete = vi.fn(async () => {
      throw new Error("A regroup never writes study notes again.");
    });
    const runner = new IngestRunner({
      store: jobs,
      library,
      complete,
      // A restudy queued afterwards stops here, before any model is asked.
      prepare: async () => {
        throw new Error("Not read in this test.");
      },
      emit: () => undefined,
      publish: async () => 1,
      knowledge: (courseId) => store.knowledge(courseId),
      regroup: (courseId) => store.regroup(courseId),
    });
    const job = await runner.regroup(course.id);
    await vi.waitFor(() => expect(jobs.job(job.id).status).toBe("done"), { timeout: 5000 });
    const knowledge = (await store.knowledge(course.id))!;
    expect(knowledge.grouped).toBeTruthy();
    expect(knowledge.pages.map((page) => page.slug).sort()).toEqual(["alg-bfs", "alg-graphs"]);
    expect(jobs.nodes(job.id).find((node) => node.title === "Group by topic")?.task).toBe(
      "Merged “סריקה לרוחב” into “Breadth-first search”",
    );
    const restudies = jobs.jobs().filter((other) => other.origin === "restudy");
    expect(restudies.map((other) => other.documentIds[0]).sort()).toEqual(
      [LECTURE, RECITATION].sort(),
    );
    await runner.withdraw(() => true);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("a document leaving the notes", () => {
  const SECOND_LECTURE = "00000000-0000-4000-8000-0000000000cc";
  const bfsOf = (knowledge: Knowledge) => knowledge.pages.find((page) => page.slug === "alg-bfs")!;

  it("gives a topic still taught by two documents an overview of what they teach now", async () => {
    const { model } = judge(() => "same");
    const { course, store } = await setup(model);
    await store.publish(bundle(course.id, LECTURE, "alg-L01"));
    await store.publish(recitation(course.id));
    await store.publish(bundle(course.id, SECOND_LECTURE, "alg-L02"));
    expect(bfsOf((await store.knowledge(course.id))!).blocks).toHaveLength(3);
    await store.revise(
      course.id,
      (current) => withoutDocuments(current, [RECITATION]),
      "Recitation 1 moved to the Trash",
    );
    const bfs = bfsOf((await store.knowledge(course.id))!);
    expect(bfs.blocks.map((block) => block.session).sort()).toEqual(["alg-L01", "alg-L02"]);
    expect(bfs.overview).toMatchObject({
      text: expect.stringContaining("taught in more than one session"),
      handles: bfs.blocks.map((block) => block.handle),
    });
  });

  it("leaves a topic one document still teaches without an overview", async () => {
    const { model } = judge(() => "same");
    const { course, store } = await setup(model);
    await store.publish(bundle(course.id, LECTURE, "alg-L01"));
    await store.publish(recitation(course.id));
    expect(bfsOf((await store.knowledge(course.id))!).overview).toBeDefined();
    await store.revise(course.id, (current) => withoutDocuments(current, [RECITATION]), "gone");
    const bfs = bfsOf((await store.knowledge(course.id))!);
    expect(bfs.blocks.map((block) => block.session)).toEqual(["alg-L01"]);
    expect(bfs.overview).toBeUndefined();
  });

  it("still takes the document out when overviews cannot be written", async () => {
    const { model } = judge(() => "same");
    const { course, store } = await setup(model);
    await store.publish(bundle(course.id, LECTURE, "alg-L01"));
    await store.publish(recitation(course.id));
    await store.publish(bundle(course.id, SECOND_LECTURE, "alg-L02"));
    model.overview = async () => {
      throw new Error("Connection error.");
    };
    expect(
      await store.revise(course.id, (current) => withoutDocuments(current, [RECITATION]), "gone"),
    ).not.toBeNull();
    const knowledge = (await store.knowledge(course.id))!;
    expect(knowledge.sessions.map((session) => session.slug)).toEqual(["alg-L01", "alg-L02"]);
    expect(bfsOf(knowledge).overview).toBeUndefined();
  });
});
