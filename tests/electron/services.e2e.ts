/// <reference lib="dom" />
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FolioApi, McpView } from "../../src/desktop/api.ts";
import { startHttpServer } from "../fixtures/mcp-http.ts";
import { launch, type Running } from "./app.ts";
import { reply, seedHome } from "./seed.ts";

/**
 * The student's MCP servers in a real window, with a synthetic server: it starts with its tools,
 * its secret never reaches the window, turning it off stops it, editing mcp.json restarts it, a
 * killed one comes back, a tool's rule is saved, saved chats read their service steps, and
 * quitting leaves no process. Nothing here talks to a model or a real service.
 */

const FIXTURE = fileURLToPath(new URL("../fixtures/mcp-server.ts", import.meta.url));
const SECRET = "synthetic-secret-0123456789";

const running: Running[] = [];
const remotes: { close: () => Promise<void> }[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
  await Promise.allSettled(remotes.map((remote) => remote.close()));
});

declare global {
  interface Window {
    folio: FolioApi;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) {
  for (let waited = 0; waited < 15_000; waited += 100) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((ready) => setTimeout(ready, 100));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

/** A reply that used the synthetic server three ways: allowed, declined, and cut off. */
const USED: AgentMessage[] = [
  {
    ...reply(""),
    content: [
      { type: "toolCall", id: "m1", name: "synthetic__lookup", arguments: { query: "a" } },
      { type: "toolCall", id: "m2", name: "synthetic__lookup", arguments: { query: "b" } },
    ],
    stopReason: "toolUse",
  } as AgentMessage,
  {
    role: "toolResult",
    toolCallId: "m1",
    toolName: "synthetic__lookup",
    content: [{ type: "text", text: "From Synthetic: Found: a" }],
    details: {
      v: 1,
      mcp: { server: "synthetic", label: "Synthetic", tool: "lookup", decision: "asked" },
    },
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage,
  {
    role: "toolResult",
    toolCallId: "m2",
    toolName: "synthetic__lookup",
    content: [{ type: "text", text: "The student declined." }],
    details: {
      v: 1,
      mcp: { server: "synthetic", label: "Synthetic", tool: "lookup", decision: "declined" },
    },
    isError: true,
    timestamp: Date.now(),
  } as AgentMessage,
  reply("Found one of the two."),
];

void describe("MCP servers", () => {
  void it("runs a server, keeps its secret from the window, and stops, restarts and closes it", async () => {
    const seeded = await seedHome("", "chat", undefined, USED);
    const log = resolve(seeded.home, "calls.log");
    await writeFile(log, "");
    const mcpJson = resolve(seeded.home, "mcp.json");
    const server = (env: Record<string, string> = {}) => ({
      version: 1,
      mcpServers: {
        synthetic: {
          command: process.execPath,
          args: [FIXTURE],
          env: { FIXTURE_LOG: log, SYNTHETIC_TOKEN: SECRET, ...env },
          folio: { label: "Synthetic" },
        },
      },
    });
    await writeFile(mcpJson, JSON.stringify(server()));
    const app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    await page.waitForFunction(() => !!window.folio);
    const servers = () => page.evaluate(() => window.folio.mcpServers());
    const pids = async () =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter((line) => line.startsWith("start "))
        .map((line) => Number(line.slice(6)));
    const status = (view: McpView) => view.servers[0]?.status;

    const ready = await eventually(servers, (view) => status(view) === "ready", "the server");
    assert.ok(ready.servers[0]!.tools.some((tool) => tool.name === "lookup"));
    assert.deepEqual(ready.servers[0]!.env, ["FIXTURE_LOG", "SYNTHETIC_TOKEN"]);
    assert.ok(!JSON.stringify(ready).includes(SECRET));

    // The / menu offers the server's prompts while it runs.
    const box = page.getByRole("textbox", { name: "Message Folio" });
    await box.click();
    await box.pressSequentially("/syn");
    await page.getByRole("option", { name: /\/synthetic:exam_prep/ }).waitFor();
    await box.fill("");

    // A saved reply's service steps.
    await page.getByRole("button", { name: /Worked through 2 steps/ }).click();
    await page.getByText("Used Synthetic · lookup").waitFor();
    await page.getByText("You declined Synthetic · lookup").waitFor();

    // Settings: the server, its tools and a rule, and no secret anywhere on the page.
    await page.keyboard.press("Meta+,");
    await page.getByRole("button", { name: "MCP servers" }).click();
    await page
      .getByRole("button", { name: /Synthetic/ })
      .first()
      .click();
    await page.getByText("SYNTHETIC_TOKEN").first().waitFor();
    assert.ok(!(await page.evaluate(() => document.body.innerText)).includes(SECRET));
    await page.getByRole("group", { name: "When lookup runs" }).getByText("Allow").click();
    await eventually(
      async () => JSON.parse(await readFile(mcpJson, "utf8")),
      (saved) => saved.mcpServers.synthetic.folio?.tools?.lookup === "allow",
      "the rule in mcp.json",
    );

    // Off stops it; on starts another.
    const [first] = await pids();
    await page.evaluate(() => window.folio.setMcpServerOn("synthetic", false));
    await eventually(
      async () => alive(first!),
      (on) => !on,
      "the server to stop",
    );
    await page.evaluate(() => window.folio.setMcpServerOn("synthetic", true));
    await eventually(servers, (view) => status(view) === "ready", "the server again");

    // Editing mcp.json by hand restarts it.
    const before = (await pids()).length;
    const edited = JSON.parse(await readFile(mcpJson, "utf8"));
    edited.mcpServers.synthetic.env.EXTRA = "1";
    await writeFile(mcpJson, JSON.stringify(edited));
    await eventually(pids, (list) => list.length === before + 1, "a restart after the edit");
    await eventually(servers, (view) => status(view) === "ready", "the edited server");

    // A server killed from outside comes back.
    const killed = (await pids()).at(-1)!;
    process.kill(killed, "SIGKILL");
    await eventually(pids, (list) => list.length === before + 2, "a restart after the kill");
    await eventually(servers, (view) => status(view) === "ready", "the server after the kill");

    // Quitting closes it.
    const last = (await pids()).at(-1)!;
    await app.close();
    await eventually(
      async () => alive(last),
      (on) => !on,
      "the server to close with Folio",
    );
  });

  void it("reaches a remote server with its token, which never reaches the window", async () => {
    const seeded = await seedHome("");
    const remote = await startHttpServer(SECRET);
    remotes.push(remote);
    await writeFile(
      resolve(seeded.home, "mcp.json"),
      JSON.stringify({
        version: 1,
        mcpServers: {
          remote: {
            type: "http",
            url: remote.url,
            headers: { Authorization: `Bearer ${SECRET}` },
            folio: { label: "Remote", enabled: true },
          },
        },
      }),
    );
    const app = await launch(seeded.home);
    running.push(app);
    const { page } = app;
    await page.waitForFunction(() => !!window.folio);
    const ready = await eventually(
      () => page.evaluate(() => window.folio.mcpServers()),
      (view) => ["ready", "failed", "stopped"].includes(view.servers[0]?.status ?? ""),
      "the remote server",
    );
    assert.equal(ready.servers[0]!.status, "ready", ready.servers[0]!.error ?? "");
    assert.ok(ready.servers[0]!.tools.some((tool) => tool.name === "lookup"));
    assert.ok(remote.headers.every((headers) => headers.authorization === `Bearer ${SECRET}`));
    assert.ok(!JSON.stringify(ready).includes(SECRET));
  });
});
