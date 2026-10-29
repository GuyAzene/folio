/// <reference lib="dom" />
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { launch, recordExternalLinks, type Running } from "./app.ts";
import { reply, seedHome } from "./seed.ts";

/**
 * A reply that searched the web, in a real window: its sources are listed apart from the
 * course's, and one opens in the system browser, never in Folio.
 * Run with `vp run test:electron`; nothing here talks to a model or the web.
 */

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

const SEARCHED: AgentMessage[] = [
  {
    ...reply(""),
    content: [
      { type: "toolCall", id: "s1", name: "search_web", arguments: { query: "bfs history" } },
    ],
    stopReason: "toolUse",
  } as AgentMessage,
  {
    role: "toolResult",
    toolCallId: "s1",
    toolName: "search_web",
    content: [{ type: "text", text: "From the web, not the course." }],
    details: {
      v: 1,
      query: "bfs history",
      sources: [{ url: "https://example.org/bfs-history", title: "A history of graph search" }],
    },
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage,
  reply("It was first published in 1959 ([example.org](https://example.org/bfs-history))."),
];

void describe("web search in a chat", () => {
  void it("lists the sources apart from the course's, opening them outside Folio", async () => {
    const seeded = await seedHome("", "chat", undefined, SEARCHED);
    const app = await launch(seeded.home);
    running.push(app);
    const { app: electron, page } = app;
    const opened = await recordExternalLinks(electron);
    await page.getByText("From the web").waitFor();
    await page.getByRole("link", { name: /A history of graph search/ }).click();
    await page.waitForTimeout(300);
    assert.deepEqual(await opened(), ["https://example.org/bfs-history"]);
    assert.equal(electron.windows().length, 1);
  });
});
