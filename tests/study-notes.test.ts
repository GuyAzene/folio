import { describe, expect, it } from "vite-plus/test";
import { studyNotesView } from "../src/desktop/study-notes.ts";
import type { Knowledge, KnowledgeBlock, KnowledgePage } from "../src/kb/knowledge.ts";

// Synthetic knowledge; no course material.
const block = (handle: string, pages: number[], session = "alg-L01"): KnowledgeBlock => ({
  id: handle,
  handle,
  title: handle,
  body: `Body of ${handle} with $x^2$.`,
  locators: pages.map((page, index) => ({ page, region: `p${page}.r${index}`, location: "" })),
  keywords_en: [],
  keywords_he: [],
  aliases: [],
  questions: ["Why?"],
  claims: [],
  interpretations: [],
  gaps: [],
  session,
  sourceId: session,
  documentId: session === "alg-L01" ? "doc-1" : "doc-2",
});

const page = (
  slug: string,
  introducedIn: string,
  prerequisites: string[],
  blocks: KnowledgeBlock[],
): KnowledgePage => ({
  slug,
  title: slug.replace("alg-", ""),
  type: "concept",
  introducedIn,
  prerequisites,
  intuition: "",
  blocks,
});

const knowledge: Knowledge = {
  version: 1,
  courseId: "course",
  prefix: "alg",
  sessions: [
    {
      slug: "alg-L01",
      type: "lecture",
      title: "Graph traversal",
      documentId: "doc-1",
      sha256: "0".repeat(64),
      covers: "Graphs and BFS.",
      workedExamples: [{ title: "A run", page: 3, slug: "run" }],
      worthRemembering: [],
      openThreads: [],
      pairedWith: [],
      newConcepts: [],
      ledger: [
        { region: "p1.r1", page: 1, kind: "text", state: "gap", blocks: [], reason: "Logistics." },
        { region: "p1.r2", page: 1, kind: "text", state: "gap", blocks: [], reason: "Logistics." },
        { region: "p4.r1", page: 4, kind: "image", state: "gap", blocks: [], reason: "" },
        { region: "p2.r1", page: 2, kind: "text", state: "represented", blocks: [], reason: "" },
      ],
      sourcePages: [{ page: 1, text: "raw text that is not shown" }],
      studiedAt: "2026-10-28T09:00:00.000Z",
      jobId: "job",
    },
    {
      slug: "alg-R01",
      type: "recitation",
      title: "BFS examples",
      documentId: "doc-2",
      sha256: "0".repeat(64),
      covers: "",
      workedExamples: [],
      worthRemembering: [],
      openThreads: [],
      pairedWith: [],
      newConcepts: [],
      ledger: [],
      sourcePages: [],
      studiedAt: "2026-10-28T09:00:00.000Z",
      jobId: "job",
    },
  ],
  pages: [
    page("alg-graphs", "alg-L01", [], [block("alg-graph-definition", [2, 1, 2])]),
    page("alg-bfs", "alg-L01", ["alg-graphs", "alg-queues"], [block("alg-bfs-marking", [3])]),
    page("alg-bfs-tree", "alg-R01", ["alg-bfs"], [block("alg-parents", [2], "alg-R01")]),
  ],
};

describe("study notes view", () => {
  const view = studyNotesView(knowledge, {
    courseId: "course",
    generation: 3,
    publishedAt: "2026-10-28T10:00:00.000Z",
    jobId: "job",
    summary: "",
  });

  it("lists each session's topics, never what the ledger recorded", () => {
    expect(view.generation).toBe(3);
    expect(view.sessions.map((session) => [session.slug, session.topics])).toEqual([
      ["alg-L01", ["alg-graphs", "alg-bfs"]],
      ["alg-R01", ["alg-bfs-tree"]],
    ]);
    expect(view.sessions[0]!.workedExamples).toEqual([{ title: "A run", page: 3 }]);
    // The raw page text and the coverage ledger are not part of what the student reads.
    expect(JSON.stringify(view)).not.toContain("raw text that is not shown");
    expect(JSON.stringify(view)).not.toContain("Logistics.");
  });

  it("links prerequisites the course has and the topics that build on each", () => {
    const bfs = view.topics.find((topic) => topic.slug === "alg-bfs")!;
    expect(bfs.prerequisites).toEqual([{ slug: "alg-graphs", title: "graphs" }]);
    expect(bfs.usedBy).toEqual([{ slug: "alg-bfs-tree", title: "bfs-tree" }]);
  });

  it("cites each section's slide pages once, in order, from the document it came from", () => {
    const [definition] = view.topics[0]!.sections;
    expect(definition).toMatchObject({ pages: [1, 2], documentId: "doc-1", questions: ["Why?"] });
    expect(view.topics[2]!.sections[0]).toMatchObject({ documentId: "doc-2", session: "alg-R01" });
  });
});
