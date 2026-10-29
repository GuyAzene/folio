import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export const DEMO_COURSE_ID = "demo";
export const DEMO_PAGE_COUNT = 2;
export const DEFAULT_DEMO_PROMPT =
  "Read page 1 of the demo course with read_demo_page, then explain directed graph reachability in a few sentences. Cite the page anchor.";

export interface DemoPage {
  readonly courseId: typeof DEMO_COURSE_ID;
  readonly documentId: "synthetic-graph-lecture";
  readonly page: number;
  readonly title: string;
  readonly anchor: string;
  readonly text: string;
}

// Disposable, invented course material. No private course files are read.
const pages: readonly DemoPage[] = Object.freeze([
  Object.freeze({
    courseId: DEMO_COURSE_ID,
    documentId: "synthetic-graph-lecture",
    page: 1,
    title: "Directed graph reachability",
    anchor: "demo:synthetic-graph-lecture#page=1",
    text: [
      "Synthetic lecture, page 1: Directed graph reachability.",
      "A directed graph G = (V, E) has vertices V and directed edges E.",
      "A directed path follows edges in their given direction. A vertex t is reachable from s when such a path goes from s to t.",
      "We allow a path of length zero, so every vertex is reachable from itself.",
      "Example: V = {A, B, C, D}; E = {(A, B), (B, C), (A, D)}. C is reachable from A via A -> B -> C. A is not reachable from C.",
    ].join("\n"),
  }),
  Object.freeze({
    courseId: DEMO_COURSE_ID,
    documentId: "synthetic-graph-lecture",
    page: 2,
    title: "Breadth-first search",
    anchor: "demo:synthetic-graph-lecture#page=2",
    text: [
      "Synthetic lecture, page 2: Breadth-first search (BFS).",
      "To find vertices reachable from s, mark s as visited and place it in a queue.",
      "While the queue is not empty, remove its first vertex u. For each outgoing edge (u, v), mark and enqueue v only if v has not been visited.",
      "BFS visits exactly the vertices reachable from s. With adjacency lists, it takes O(|V| + |E|) time and O(|V|) extra space.",
      "In the graph from page 1, BFS from A visits A first, then B and D (in either order), then C.",
    ].join("\n"),
  }),
]);

export const demoPageParameters = Type.Object(
  {
    courseId: Type.String({ description: 'The only permitted course ID is "demo".' }),
    page: Type.Integer({ minimum: 1, maximum: DEMO_PAGE_COUNT }),
  },
  { additionalProperties: false },
);

/** Application boundary: validate even when a caller bypasses model schema checks. */
export function readDemoPage(request: unknown, signal?: AbortSignal): DemoPage {
  signal?.throwIfAborted();

  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new Error("A demo page request must contain only courseId and page.");
  }
  const keys = Reflect.ownKeys(request);
  if (keys.length !== 2 || !Object.hasOwn(request, "courseId") || !Object.hasOwn(request, "page")) {
    throw new Error("A demo page request must contain only courseId and page.");
  }

  const { courseId, page } = request as { courseId: unknown; page: unknown };
  if (courseId !== DEMO_COURSE_ID) {
    throw new Error('Source scope denied: only the synthetic course "demo" is available.');
  }
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > DEMO_PAGE_COUNT) {
    throw new Error(
      `Source scope denied: demo page must be an integer from 1 to ${DEMO_PAGE_COUNT}.`,
    );
  }

  signal?.throwIfAborted();
  return pages[page - 1]!;
}

export const demoPageTool: AgentTool<typeof demoPageParameters, DemoPage> = {
  name: "read_demo_page",
  label: "Read synthetic lecture page",
  description:
    'Read an immutable synthetic lecture page from course "demo". Page 1 defines directed graph reachability; page 2 describes BFS. Returns a source anchor to cite. No filesystem access is available.',
  parameters: demoPageParameters,
  execute: async (_toolCallId, params, signal) => {
    const page = readDemoPage(params, signal);
    return {
      content: [{ type: "text", text: `${page.anchor}\n${page.title}\n\n${page.text}` }],
      details: page,
    };
  },
};
