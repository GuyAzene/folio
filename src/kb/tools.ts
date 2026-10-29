import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import { checkId, LibraryError, type LibraryStore } from "../library/store.ts";
import type { Knowledge } from "./knowledge.ts";
import type { KnowledgeStore } from "./store.ts";

const MAX_READ = 5;
const READ_BUDGET = 16_000;

/**
 * The tutor's tools over a course's reviewed knowledge: find (short hits with handles), read
 * (whole sections within a budget) and follow relations (handles only). Scope is enforced here:
 * a course chat reads its own course and the courses the student added to it (read on every
 * call); a library chat names one course per call.
 */
export function knowledgeTools(
  knowledge: KnowledgeStore,
  library: LibraryStore,
  courseId: string | null,
  added: () => string[] = () => [],
): AgentTool[] {
  const wide = courseId === null;
  const courseKey: Record<string, TSchema> = {
    courseId: wide
      ? Type.String({ description: "The course to search, from the course list." })
      : Type.Optional(
          Type.String({
            description:
              "Another course the student added to this chat. Omit for this chat's course.",
          }),
        ),
  };
  const object = (properties: Record<string, TSchema>) =>
    Type.Object(properties, { additionalProperties: false });

  async function scope(requested: unknown) {
    let id = courseId ?? requested;
    if (courseId && requested !== undefined && requested !== courseId) {
      if (!added().includes(requested as string))
        throw new LibraryError(
          "That course is not part of this chat. The student can add it with the + button.",
        );
      id = requested;
    }
    checkId(id);
    const course = await library.course(id).catch(() => {
      throw new LibraryError("That course is not in your library.");
    });
    const published = await knowledge.knowledge(course.id);
    const index = knowledge.index(course.id);
    if (!published || !index)
      throw new LibraryError(
        `${course.name} has no studied material yet. Read its pages with read_page instead, and say the answer comes from the raw pages.`,
      );
    const titles = new Map(
      (await library.listDocuments({ courseId: course.id })).map((document) => [
        document.id,
        document.title,
      ]),
    );
    return {
      course,
      published,
      index,
      sessions: published.sessions.map((session) => session.slug),
      titles,
    };
  }

  const search: AgentTool = {
    name: "search_course",
    label: "Search the course",
    description:
      "Search the course's study notes: what Folio wrote from studying its lectures and recitations, by topic, citing the slides (the student calls these study notes; they are not the student's own notes). Returns up to 8 short hits with section handles; read the ones you need with read_sections. Search in the course's language too (Hebrew terms work).",
    parameters: object({
      ...courseKey,
      query: Type.String({ description: "Words to search for." }),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { query?: unknown; courseId?: unknown };
      if (typeof input.query !== "string" || !input.query.trim())
        throw new LibraryError("search_course needs a query.");
      const { course, index, sessions, titles } = await scope(input.courseId);
      const hits = index.search(input.query, sessions);
      const pages = hits.length < 3 ? index.searchPages(input.query, sessions, 3) : [];
      const lines = [
        hits.length
          ? hits
              .map(
                (hit) =>
                  `[${hit.handle}] ${hit.title} (${hit.session}, ${pageWord(hit.pages)})\n  ${hit.snippet}`,
              )
              .join("\n")
          : `No reviewed section of ${course.name} matched. Try other words, the Hebrew term, or a broader topic.`,
        ...(pages.length
          ? [
              "Unreviewed page text that matched (verify with read_page before teaching from it):",
              ...pages.map(
                (page) =>
                  `- ${titles.get(page.documentId) ?? page.session}, page ${page.page}: ${page.snippet}`,
              ),
            ]
          : []),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { hits: hits.map((hit) => hit.handle) },
      };
    },
  };

  const read: AgentTool = {
    name: "read_sections",
    label: "Read course sections",
    description: `Read up to ${MAX_READ} whole sections of the course's study notes by handle, with how to cite each one. A topic's handle from the topic map reads all of that topic's sections.`,
    parameters: object({
      ...courseKey,
      handles: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_READ }),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { handles?: unknown; courseId?: unknown };
      if (
        !Array.isArray(input.handles) ||
        !input.handles.length ||
        input.handles.some((handle) => typeof handle !== "string")
      )
        throw new LibraryError("read_sections needs one or more handles from search_course.");
      const { index, sessions, titles, published } = await scope(input.courseId);
      const requested = (input.handles as string[]).slice(0, MAX_READ);
      const blocks = index.read(withTopics(requested, published, sessions), sessions);
      let used = 0;
      const parts: string[] = [];
      const sources: { documentId: string; title: string; page: number }[] = [];
      for (const block of blocks) {
        const title = titles.get(block.documentId) ?? block.session;
        const pages = [...new Set(block.locators.map((locator) => locator.page))];
        const text = `[${block.handle}] ${block.title}\nCite as: (${title}, ${pageWord(pages)})\n\n${block.body}`;
        if (used + text.length > READ_BUDGET && parts.length) {
          parts.push(
            `[Budget reached: ${blocks.length - parts.length} more section(s) not shown. Read them in another call.]`,
          );
          break;
        }
        used += text.length;
        parts.push(text);
        for (const page of pages) sources.push({ documentId: block.documentId, title, page });
      }
      const missing = requested.filter(
        (handle) =>
          !blocks.some(
            (block) =>
              block.handle === handle ||
              published.pages.some(
                (page) =>
                  page.slug === handle && page.blocks.some((item) => item.handle === block.handle),
              ),
          ),
      );
      if (missing.length)
        parts.push(
          `Not found in this course: ${missing.join(", ")}. Use handles from search_course.`,
        );
      return {
        content: [{ type: "text", text: parts.join("\n\n---\n\n") }],
        details: { sources, handles: blocks.map((block) => block.handle) },
      };
    },
  };

  const related: AgentTool = {
    name: "related_sections",
    label: "Find related sections",
    description:
      "List sections related to one section: the same page, its prerequisites, and topics that use it. Returns handles only.",
    parameters: object({ ...courseKey, handle: Type.String() }),
    execute: async (_toolCallId, params) => {
      const input = params as { handle?: unknown; courseId?: unknown };
      if (typeof input.handle !== "string")
        throw new LibraryError("related_sections needs a handle.");
      const { index, sessions } = await scope(input.courseId);
      const rows = index.related(input.handle, sessions);
      return {
        content: [
          {
            type: "text",
            text: rows.length
              ? rows.map((row) => `[${row.handle}] ${row.title} (${row.relation})`).join("\n")
              : "No related sections in this course.",
          },
        ],
        details: { handles: rows.map((row) => row.handle) },
      };
    },
  };

  const topics: AgentTool = {
    name: "topic_map",
    label: "List the course's topics",
    description:
      "List the course's studied lectures and recitations in order, with the topics and sections each one covers. Use it to trace a concept through the course or connect lectures. For a long course, name one session to see all of its sections.",
    parameters: object({
      ...courseKey,
      session: Type.Optional(
        Type.String({ description: "One session's slug from the map, to list its sections." }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { courseId?: unknown; session?: unknown };
      const { published } = await scope(input.courseId);
      if (input.session !== undefined) {
        const session = published.sessions.find((candidate) => candidate.slug === input.session);
        if (!session)
          throw new LibraryError(
            "That session is not in this course's topic map. Use a session slug from topic_map.",
          );
        return {
          content: [{ type: "text", text: topicMap({ ...published, sessions: [session] }) }],
          details: { sessions: 1 },
        };
      }
      return {
        content: [{ type: "text", text: topicMap(published) }],
        details: { sessions: published.sessions.length },
      };
    },
  };

  return [search, read, related, topics];
}

/** "page 4" or "pages 4, 5", as citations are written. */
function pageWord(pages: number[]): string {
  return `${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")}`;
}

/**
 * Section handles to read, where a topic's handle from the topic map (shown alone when the map is
 * long) stands for every section of that topic in the chat's sessions.
 */
function withTopics(handles: string[], knowledge: Knowledge, sessions: string[]): string[] {
  const out = handles.flatMap((handle) => {
    const page = knowledge.pages.find((candidate) => candidate.slug === handle);
    return page
      ? page.blocks.filter((block) => sessions.includes(block.session)).map((block) => block.handle)
      : [handle];
  });
  return [...new Set(out)];
}

/**
 * The course's studied topics as an indented outline for the prompt. A long course lists topics
 * without their sections, and one too long even for that stops at a whole line and says so.
 */
export function topicMap(knowledge: Knowledge, limit = 24_000): string {
  const full = (withBlocks: boolean) =>
    knowledge.sessions
      .map((session) => {
        const pages = knowledge.pages.filter((page) =>
          page.blocks.some((block) => block.session === session.slug),
        );
        return [
          `${session.slug} · ${session.title}`,
          ...pages.flatMap((page) => [
            `  ${page.title} [${page.slug}]`,
            ...(withBlocks
              ? page.blocks
                  .filter((block) => block.session === session.slug)
                  .map((block) => `    - ${block.title} [${block.handle}]`)
              : []),
          ]),
        ].join("\n");
      })
      .join("\n");
  const detailed = full(true);
  if (detailed.length <= limit) return detailed;
  const brief = full(false);
  if (brief.length <= limit) return brief;
  const more =
    "\n[The map stops here. List one session's topics with topic_map and its session slug.]";
  const cut = brief.lastIndexOf("\n", limit - more.length);
  return `${brief.slice(0, Math.max(cut, 0))}${more}`;
}
