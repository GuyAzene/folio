import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { chatView } from "../src/desktop/view.ts";
import { createRuntimes } from "../src/library/course-tools.ts";
import { LibraryStore } from "../src/library/store.ts";
import {
  hostedSearch,
  queryProblem,
  webSearchTool,
  type SearchFn,
} from "../src/library/web-search.ts";
import type { SessionRecord } from "../src/session-store.ts";

// Synthetic queries and pages only; no request leaves the test.

const model = {
  id: "gpt-6.1-terra",
  api: "openai-responses",
  provider: "openai",
} as Model<Api>;

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function answer(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("web search", () => {
  it("sends only the query, adds the hosted tool, and keeps what Pi would drop", async () => {
    const seen: { context?: TranscriptContext; payload?: unknown } = {};
    const streamFn: StreamFn = async (_model, context, options) => {
      seen.context = context;
      seen.payload = await options?.onPayload?.(
        { model: model.id, tools: [], include: ["reasoning.encrypted_content"] },
        _model,
      );
      for (const event of [
        {
          type: "response.output_item.done",
          item: {
            type: "web_search_call",
            action: {
              sources: [
                { url: "https://example.org/bfs" },
                { url: "http://insecure.example.com/page" },
              ],
            },
          },
        },
        {
          type: "response.output_text.annotation.added",
          annotation: {
            type: "url_citation",
            url: "https://example.com/paper?utm_source=openai",
            title: "A paper",
          },
        },
      ])
        await options?.onProviderStreamEvent?.(event as never, _model);
      const stream = createAssistantMessageEventStream();
      const message = answer(
        "BFS dates from 1959 ([example.com](https://example.com/paper?utm_source=openai)).",
      );
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    };
    const result = await hostedSearch(streamFn, model)("history of breadth-first search");
    expect(JSON.stringify(seen.context!.messages)).toContain("history of breadth-first search");
    // Folio's fixed instruction and the query: nothing from the chat, the course or the notes.
    expect(seen.context!.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(JSON.stringify(seen.context!.messages[0])).toContain("Search the web for the query");
    expect(seen.payload).toMatchObject({
      tools: [{ type: "web_search" }],
      include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
    });
    // What the answer cites comes first, with its title; other pages the search opened follow.
    expect(result.sources).toEqual([
      { url: "https://example.com/paper", title: "A paper" },
      { url: "https://example.org/bfs", title: "example.org" },
    ]);
    expect(result.answer).not.toContain("utm_source");
  });

  it("refuses queries with private details or a pasted passage", () => {
    expect(queryProblem("Dijkstra 1959 paper")).toBeNull();
    expect(queryProblem("x".repeat(201))).toContain("under 200");
    expect(queryProblem("ask student@example.com")).toContain("email");
    expect(queryProblem("call +972 50 123 4567")).toContain("phone");
    expect(queryProblem("student 123456789 grades")).toContain("ID");
  });

  it("searches at most three times a reply, never while the student turned it off", async () => {
    const search = vi.fn<SearchFn>(async (query) => ({ query, answer: "Found.", sources: [] }));
    const budget = { allowed: true, used: 0 };
    const tool = webSearchTool(search, budget);
    for (let index = 0; index < 3; index++)
      await tool.execute(`call_${index}`, { query: "graph search history" });
    await expect(tool.execute("call_4", { query: "more" })).rejects.toThrow("already searched 3");
    budget.used = 0;
    budget.allowed = false;
    await expect(tool.execute("call_5", { query: "more" })).rejects.toThrow(
      "turned web search off",
    );
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("is part of course and library chats, its budget reset by each question", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "folio-web-test-"));
    homes.push(home);
    const library = await LibraryStore.open({ home });
    const course = await library.createCourse({ name: "Algorithms" });
    const search = vi.fn<SearchFn>(async (query) => ({ query, answer: "Found.", sources: [] }));
    const runtimes = createRuntimes(library, { search });
    const chat = await runtimes.course(course.id, "00000000-0000-4000-8000-0000000000c1");
    const tool = chat.tools.find((candidate) => candidate.name === "search_web")!;
    expect(await chat.prompt()).toContain("You can search the web with search_web.");
    chat.beforeSend!({ webSearch: false });
    await expect(tool.execute("call_1", { query: "graph history" })).rejects.toThrow("off");
    chat.beforeSend!({ webSearch: true });
    await tool.execute("call_2", { query: "graph history" });
    expect(search).toHaveBeenCalledOnce();
    const plain = createRuntimes(library);
    expect(await (await plain.library("00000000-0000-4000-8000-0000000000c2")).prompt()).toContain(
      "or the web",
    );
  });

  it("lists a reply's web sources apart from course sources when the chat reopens", () => {
    const record = {
      id: "00000000-0000-4000-8000-0000000000c3",
      scope: { courseId: "00000000-0000-4000-8000-0000000000c4", library: 1 },
      title: "Synthetic",
      status: "idle",
      modelId: "gpt-6.1-sol",
      focus: null,
      updatedAt: new Date().toISOString(),
      messages: [
        { role: "user", content: "More depth please.", timestamp: 0 },
        {
          ...answer(""),
          content: [
            { type: "toolCall", id: "s1", name: "search_web", arguments: { query: "bfs history" } },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "s1",
          toolName: "search_web",
          content: [{ type: "text", text: "From the web." }],
          details: {
            v: 1,
            query: "bfs history",
            sources: [{ url: "https://example.org/a", title: "A" }],
          },
          isError: false,
          timestamp: 0,
        },
        answer("It dates from 1959 ([A](https://example.org/a))."),
      ],
    } as unknown as SessionRecord;
    const view = chatView(record);
    const reply = view.messages.find((message) => message.role === "assistant")!;
    expect(reply.webSources).toEqual([{ url: "https://example.org/a", title: "A" }]);
    expect(reply.steps?.map((step) => step.label)).toEqual(["Searched the web: bfs history"]);
    expect(reply.sources ?? []).toEqual([]);
  });
});
