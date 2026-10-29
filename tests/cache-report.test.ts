import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vite-plus/test";
import { cacheTable, requestsOf, requestTable } from "../src/cache-report.ts";

function reply(input: number, cacheRead: number, cacheWrite = 0): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "A reply." }],
    stopReason: "stop",
    api: "openai-responses",
    provider: "openai",
    model: "synthetic-model",
    timestamp: 0,
    usage: {
      input,
      output: 10,
      cacheRead,
      cacheWrite,
      totalTokens: input + cacheRead + cacheWrite + 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AgentMessage;
}

describe("cache report", () => {
  it("counts every request's whole input, since Pi reports input without the cached part", () => {
    const messages = [
      { role: "user", content: "Question", timestamp: 0 } as AgentMessage,
      reply(1000, 0),
      reply(200, 1800),
    ];
    expect(requestsOf(messages)).toEqual([
      { input: 1000, cached: 0 },
      { input: 2000, cached: 1800 },
    ]);
  });

  it("shows each chat's share from cache, and leaves first requests out of 'Later'", () => {
    const table = cacheTable([
      { id: "a", title: "Graphs", requests: requestsOf([reply(1000, 0), reply(200, 1800)]) },
      { id: "b", title: "Empty", requests: [] },
    ]);
    const [header, graphs, all] = table.split("\n");
    expect(header).toMatch(/Chat\s+Requests\s+Input tokens\s+From cache\s+Later/);
    expect(graphs).toMatch(/^Graphs\s+2\s+3,000\s+60%\s+90%$/);
    expect(all).toMatch(/^All chats\s+2\s+3,000\s+60%\s+90%$/);
    expect(table).not.toContain("Empty");
    expect(cacheTable([])).toBe("No saved replies yet.");
  });

  it("lists one chat request by request", () => {
    const text = requestTable({
      id: "a",
      title: "Graphs",
      requests: requestsOf([reply(200, 1800)]),
    });
    expect(text).toBe("Graphs\n  1      2,000 in      1,800 cached   90%");
  });
});
