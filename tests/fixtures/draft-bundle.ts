import type { DocumentDraft, DraftBundle } from "../../src/ingest/pipeline.ts";
import type { AuthorDraft } from "../../src/ingest/prompts.ts";

// A synthetic study draft for one session, for knowledge-base and Trash tests; no course material.

export function authorDraft(session: string, extra = ""): AuthorDraft {
  return {
    session: {
      title: `Session ${session}`,
      covers: "Graph search.",
      worked_examples: [],
      worth_remembering: [],
      open_threads: [],
    },
    pages: [
      {
        slug: "bfs",
        title: "Breadth-first search",
        type: "concept",
        prerequisites: ["graphs", "Queues and stacks"],
        intuition: "Ripples spreading from a stone.",
        similar_to: [],
        blocks: [
          {
            id: `bfs-marking-${session.toLowerCase()}`,
            kind: "explanation",
            restates: "",
            title: "Marking on enqueue",
            body: `Each vertex is marked visited when it enters the queue (התור), so it is enqueued once.${extra}`,
            locators: [{ page: 2, region: "p2.r2", location: "middle" }],
            keywords_en: ["BFS", "queue"],
            keywords_he: ["סריקה לרוחב", "תור"],
            aliases: ["breadth first"],
            questions: ["Why is each vertex enqueued at most once?"],
            claims: [],
            interpretations: [],
            gaps: [],
          },
        ],
      },
      {
        slug: "graphs",
        title: "Graphs",
        type: "concept",
        prerequisites: [],
        intuition: "Dots and lines.",
        similar_to: [],
        blocks: [
          {
            id: `graph-definition-${session.toLowerCase()}`,
            kind: "explanation",
            restates: "",
            title: "Definition",
            body: "A graph is a set of vertices joined by edges (קשתות).",
            locators: [{ page: 1, region: "p1.r1", location: "top" }],
            keywords_en: ["graph", "vertex", "edge"],
            keywords_he: ["גרף", "קשת"],
            aliases: [],
            questions: [],
            claims: [],
            interpretations: [],
            gaps: [],
          },
        ],
      },
    ],
    omitted: [],
    gaps: [],
  };
}

export function bundle(
  courseId: string,
  documentId: string,
  slug: string,
  options: { unaccounted?: boolean; extra?: string } = {},
): DraftBundle {
  const document: DocumentDraft = {
    documentId,
    sha256: "0".repeat(64),
    session: {
      prefix: "alg",
      slug,
      type: slug.includes("-R") ? "recitation" : "lecture",
      sourceId: slug,
      sourcePath: `documents/${documentId}/original.pdf`,
      date: "2026-10-27",
      pairedWith: [],
    },
    brief: { title: slug, outline: [], notation: [], terms: [] },
    inventory: {
      version: 1,
      sha256: "0".repeat(64),
      pages: [
        {
          page: 1,
          width: 612,
          height: 792,
          textLayer: "ok",
          characters: 40,
          regions: [
            {
              id: "p1.r1",
              page: 1,
              kind: "text",
              box: [0, 0, 1, 1],
              text: "A graph is a set of vertices and edges",
              direction: "ltr",
              numbers: [],
            },
          ],
        },
      ],
    },
    regions: {},
    draft: authorDraft(slug, options.extra),
    ledger: [
      { region: "p1.r1", page: 1, kind: "text", state: "represented", blocks: [], reason: "" },
      ...(options.unaccounted
        ? [
            {
              region: "p1.r9",
              page: 1,
              kind: "text" as const,
              state: "unaccounted" as const,
              blocks: [],
              reason: "not cited",
            },
          ]
        : []),
    ],
    verdicts: {},
    exceptions: [],
    models: {
      provider: "openai",
      brief: "x",
      reader: "x",
      escalation: "x",
      author: "x",
      reviewer: "x",
    },
    promptVersion: 1,
  };
  return {
    version: 1,
    jobId: "00000000-0000-4000-8000-000000000001",
    courseId,
    createdAt: "2026-10-27T20:00:00.000Z",
    documents: [document],
  };
}
