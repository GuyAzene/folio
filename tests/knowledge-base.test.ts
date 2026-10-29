import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { bundle } from "./fixtures/draft-bundle.ts";
import { matchQuery, normalizeText, strippedForms } from "../src/kb/normalize.ts";
import { KnowledgeStore } from "../src/kb/store.ts";
import { knowledgeTools, topicMap } from "../src/kb/tools.ts";
import { LibraryStore } from "../src/library/store.ts";

const homes: string[] = [];
const stores: KnowledgeStore[] = [];

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function setup() {
  const home = await mkdtemp(resolve(tmpdir(), "folio-kb-test-"));
  homes.push(home);
  const library = await LibraryStore.open({ home });
  const course = await library.createCourse({ name: "Algorithms" });
  const store = await KnowledgeStore.open(library);
  stores.push(store);
  return { home, library, store, course };
}

describe("search normalization", () => {
  it("strips niqqud and acronym quotes, folds final letters, and strips attached prefixes", () => {
    expect(normalizeText('בְּרֵאשִׁית ת"א צ׳יפס')).toBe("בראשית תא ציפס");
    expect(normalizeText("ספרים")).toBe("ספרימ");
    expect(strippedForms("ובבית מלך")).toEqual(["בבית", "בית"]);
    expect(matchQuery('BFS" OR NEAR(x')).toBe('"bfs" OR "or" OR "near"');
  });
});

describe("knowledge base", () => {
  it("publishes a generation with readable wiki pages and a scoped bilingual index", async () => {
    const { store, course } = await setup();
    const info = await store.publish(
      bundle(course.id, "00000000-0000-4000-8000-0000000000aa", "alg-L01"),
    );
    expect(info.generation).toBe(1);
    const knowledge = await store.knowledge(course.id);
    expect(knowledge?.pages.map((page) => page.slug)).toEqual(["alg-bfs", "alg-graphs"]);

    const index = store.index(course.id)!;
    expect(index.search("why is every vertex enqueued once", ["alg-L01"])[0]?.handle).toBe(
      "alg-bfs-marking-alg-l01",
    );
    // Hebrew with an attached prefix and niqqud finds the block that keeps the bare term.
    expect(index.search("בַּתּוֹר", ["alg-L01"])[0]?.handle).toBe("alg-bfs-marking-alg-l01");
    expect(index.search("וְהַגְּרָף", ["alg-L01"])[0]?.handle).toBe("alg-graph-definition-alg-l01");
    expect(index.search("queue", ["alg-L02"])).toEqual([]);
    expect(
      index
        .read(["alg-bfs-marking-alg-l01", "alg-missing"], ["alg-L01"])
        .map((block) => block.handle),
    ).toEqual(["alg-bfs-marking-alg-l01"]);
    expect(index.related("alg-bfs-marking-alg-l01", ["alg-L01"])).toEqual([
      {
        relation: "prerequisite",
        handle: "alg-graph-definition-alg-l01",
        title: "Graphs › Definition",
      },
    ]);
    expect(index.searchPages("vertices edges", ["alg-L01"])[0]).toMatchObject({ page: 1 });
  });

  it("re-studying a session replaces its own blocks, and rollback restores the earlier version", async () => {
    const { store, course } = await setup();
    const documentId = "00000000-0000-4000-8000-0000000000aa";
    await store.publish(bundle(course.id, documentId, "alg-L01"));
    await store.publish(bundle(course.id, "00000000-0000-4000-8000-0000000000bb", "alg-R01"));
    await store.publish(bundle(course.id, documentId, "alg-L01", { extra: " Revised wording." }));
    const knowledge = (await store.knowledge(course.id))!;
    const bfs = knowledge.pages.find((page) => page.slug === "alg-bfs")!;
    expect(bfs.blocks.map((block) => block.session).sort()).toEqual(["alg-L01", "alg-R01"]);
    expect(bfs.blocks.find((block) => block.session === "alg-L01")?.body).toContain(
      "Revised wording.",
    );
    expect(store.current(course.id)?.generation).toBe(3);
    expect(store.rollback(course.id).generation).toBe(2);
    expect(
      (await store.knowledge(course.id))!.pages.find((page) => page.slug === "alg-bfs")!.blocks[0]!
        .body,
    ).not.toContain("Revised");
  });

  it("publishes two studies of one course that finish together, one after the other", async () => {
    const { store, course } = await setup();
    const [first, second] = await Promise.all([
      store.publish(bundle(course.id, "00000000-0000-4000-8000-0000000000aa", "alg-L01")),
      store.publish(bundle(course.id, "00000000-0000-4000-8000-0000000000bb", "alg-R01")),
    ]);
    expect([first.generation, second.generation]).toEqual([1, 2]);
    expect((await store.knowledge(course.id))!.sessions.map((session) => session.slug)).toEqual([
      "alg-L01",
      "alg-R01",
    ]);
  });

  it("publishes a draft that reuses one block id on several pages, each block with its own handle", async () => {
    const { store, course } = await setup();
    const draft = bundle(course.id, "00000000-0000-4000-8000-0000000000aa", "alg-L01");
    const pages = draft.documents[0]!.draft.pages;
    const block = pages[1]!.blocks[0]!;
    // A model reused "definition" on every page, twice on one of them.
    pages[0]!.blocks = [
      { ...block, id: "definition" },
      { ...block, id: "definition", title: "Again" },
    ];
    pages[1]!.blocks = [{ ...block, id: "definition" }];
    pages.push({
      ...pages[1]!,
      slug: "trees",
      title: "Trees",
      blocks: [{ ...block, id: "definition" }],
    });
    await store.publish(draft);
    const handles = (await store.knowledge(course.id))!.pages.flatMap((page) =>
      page.blocks.map((item) => item.handle),
    );
    expect(handles).toHaveLength(4);
    expect(new Set(handles).size).toBe(4);
  });

  it("lists the studied lectures and their topics, for tracing and connecting", async () => {
    const { library, store, course } = await setup();
    await store.publish(bundle(course.id, "00000000-0000-4000-8000-0000000000aa", "alg-L01"));
    await store.publish(bundle(course.id, "00000000-0000-4000-8000-0000000000bb", "alg-L02"));
    const map = knowledgeTools(store, library, course.id).find(
      (tool) => tool.name === "topic_map",
    )!;
    const result = await map.execute("call_1", {});
    const text = (result.content[0] as { text: string }).text;
    expect(text.indexOf("alg-L01")).toBeLessThan(text.indexOf("alg-L02"));
    expect(text).toContain("Breadth-first search [alg-bfs]");

    // One session alone, as a long course's map points to.
    const one = await map.execute("call_2", { session: "alg-L02" });
    const oneText = (one.content[0] as { text: string }).text;
    expect(oneText).toContain("alg-L02");
    expect(oneText).not.toContain("alg-L01");
    await expect(map.execute("call_3", { session: "alg-L99" })).rejects.toThrow(
      "not in this course's topic map",
    );
  });

  it("reads a topic's sections by the topic's handle, and cuts a long map at a whole line", async () => {
    const { library, store, course } = await setup();
    await store.publish(bundle(course.id, "00000000-0000-4000-8000-0000000000aa", "alg-L01"));
    const read = knowledgeTools(store, library, course.id).find(
      (tool) => tool.name === "read_sections",
    )!;
    const result = await read.execute("call_1", { handles: ["alg-bfs"] });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("[alg-bfs-marking-alg-l01]");
    expect(text).not.toContain("Not found");
    expect(text).toMatch(/Cite as: \(.*, pages? \d/);

    // A long course lists topics without sections, and a longer one stops at a whole line.
    await store.publish(bundle(course.id, "00000000-0000-4000-8000-0000000000bb", "alg-L02"));
    const knowledge = (await store.knowledge(course.id))!;
    const detailed = topicMap(knowledge);
    const brief = topicMap(knowledge, detailed.length - 1);
    expect(brief).toContain("[alg-bfs]");
    expect(brief).not.toContain("[alg-bfs-marking-alg-l01]");
    const cut = topicMap(knowledge, brief.length - 1);
    expect(cut.length).toBeLessThanOrEqual(brief.length - 1);
    expect(cut).toContain("[The map stops here.");
    const kept = cut.slice(0, cut.indexOf("\n[The map stops here."));
    expect(kept.length).toBeGreaterThan(0);
    expect(brief.startsWith(`${kept}\n`)).toBe(true);
  });

  it("refuses to publish unaccounted regions unless the student accepts them as gaps", async () => {
    const { store, course } = await setup();
    const documentId = "00000000-0000-4000-8000-0000000000aa";
    const draft = bundle(course.id, documentId, "alg-L01", { unaccounted: true });
    await expect(store.publish(draft)).rejects.toThrow("still unaccounted");
    expect(store.current(course.id)).toBeNull();
    await store.publish(draft, [{ documentId, region: "p1.r9", note: "A logo." }]);
    const session = (await store.knowledge(course.id))!.sessions[0]!;
    expect(session.ledger.find((entry) => entry.region === "p1.r9")).toMatchObject({
      state: "gap",
    });
  });

  it("writes Obsidian-readable pages with region locators and recovers from an interrupted publish", async () => {
    const { home, library, store, course } = await setup();
    await store.publish(bundle(course.id, "00000000-0000-4000-8000-0000000000aa", "alg-L01"));
    const generation = resolve(library.courseDirectory(course.id), "kb", "generations", "1");
    const page = await readFile(resolve(generation, "wiki", "concepts", "alg-bfs.md"), "utf8");
    expect(page).toContain("used_by: []");
    // A prerequisite the course has no page for is not linked.
    const bfs = await readFile(resolve(generation, "wiki", "concepts", "alg-bfs.md"), "utf8");
    expect(bfs).toContain('prerequisites: ["alg-graphs"]');
    expect(page).toContain('region: "p2.r2"');
    expect(page).toContain("<!-- study-rag: alg-bfs-marking-alg-l01 -->");

    // Simulate a crash mid-publish: a staging folder and a 'publishing' row.
    store.close();
    stores.splice(0);
    await mkdir(resolve(library.courseDirectory(course.id), "kb", "staging-crash"), {
      recursive: true,
    });
    const db = new DatabaseSync(resolve(library.root, "kb.sqlite"));
    db.prepare(
      "INSERT INTO generations (course_id, generation, status, created_at, job_id, summary) VALUES (?, 2, 'publishing', ?, NULL, '')",
    ).run(course.id, new Date().toISOString());
    db.close();
    await writeFile(resolve(home, "marker"), "");
    const reopened = await KnowledgeStore.open(library);
    stores.push(reopened);
    expect(reopened.current(course.id)?.generation).toBe(1);
    expect(await readdir(resolve(library.courseDirectory(course.id), "kb"))).toEqual([
      "generations",
    ]);
    expect(reopened.history(course.id).map((item) => item.generation)).toEqual([1]);
  });
});
