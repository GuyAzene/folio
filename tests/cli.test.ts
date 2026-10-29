import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { DEMO_SOURCE_VERSION } from "../src/conversation.ts";
import { DEFAULT_MODEL } from "../src/agents.ts";
import { createSessionStore } from "../src/session-store.ts";

const exec = promisify(execFile);
const temporaryHomes: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function home() {
  const path = await mkdtemp(resolve(tmpdir(), "folio-cli-"));
  temporaryHomes.push(path);
  return path;
}

function cli(args: string[], connectionHome: string) {
  return exec(process.execPath, ["src/cli.ts", ...args], {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      FOLIO_HOME: connectionHome,
      OPENAI_API_KEY: "synthetic-must-not-be-used",
    },
    timeout: 5_000,
  });
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: DEFAULT_MODEL,
    stopReason: "stop",
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

async function savedSession(path: string) {
  const store = await createSessionStore({ home: path });
  const session = await store.create({
    modelId: DEFAULT_MODEL,
    scope: { courseId: "demo", sourceVersion: DEMO_SOURCE_VERSION },
    focus: { page: 2 },
    title: "Synthetic saved conversation",
    messages: [
      { role: "user", content: "Explain synthetic BFS.", timestamp: Date.now() },
      {
        ...assistant([
          {
            type: "thinking",
            thinking: "Synthetic hidden reasoning",
            thinkingSignature: "hidden-signature",
          },
          {
            type: "toolCall",
            id: "read-synthetic",
            name: "read_demo_page",
            arguments: { courseId: "demo", page: 2 },
          },
        ]),
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "read-synthetic",
        toolName: "read_demo_page",
        content: [{ type: "text", text: "demo:synthetic-graph-lecture#page=2\nSynthetic fixture" }],
        isError: false,
        timestamp: Date.now(),
      },
      assistant([{ type: "text", text: "Synthetic saved answer about a queue." }]),
    ],
  });
  return { store, session };
}

describe("CLI process smoke checks (no provider)", () => {
  it("opens the help and synthetic page with no account or credential writes", async () => {
    const path = await home();
    expect((await cli(["--help"], path)).stdout).toContain("Continue with ChatGPT");
    expect((await cli(["--page", "1"], path)).stdout).toContain(
      "demo:synthetic-graph-lecture#page=1",
    );
    expect(await readdir(path)).toEqual([]);
  });

  it("reports signed out and refuses model requests even with an ambient API key", async () => {
    const path = await home();
    expect((await cli(["status"], path)).stdout).toContain("not connected");
    await expect(cli(["demo"], path)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Connect your ChatGPT account first"),
    });
  });

  it("rejects an invalid offline page", async () => {
    await expect(cli(["--page", "../secret"], await home())).rejects.toMatchObject({ code: 1 });
  });

  it("lists sessions offline without creating an account connection", async () => {
    const path = await home();
    expect((await cli(["sessions"], path)).stdout).toContain("No saved conversations yet");
    const { session } = await savedSession(path);
    const listed = await cli(["sessions"], path);
    expect(listed.stdout).toContain(session.id);
    expect(listed.stdout).toContain(session.title);
    expect(await readdir(path)).not.toContain("connection.json");
  });

  it("restores the latest conversation and its focus offline, hiding reasoning blocks", async () => {
    const path = await home();
    const { session } = await savedSession(path);
    const restored = await cli([], path);
    expect(restored.stdout).toContain(session.id);
    expect(restored.stdout).toContain("demo page 2");
    expect(restored.stdout).toContain("You > Explain synthetic BFS.");
    expect(restored.stdout).toContain("Folio > Synthetic saved answer");
    expect(restored.stdout).toContain("read_demo_page → demo:synthetic-graph-lecture#page=2");
    expect(restored.stdout).not.toContain("Synthetic hidden reasoning");
    expect(restored.stdout).not.toContain("hidden-signature");
    expect(await readdir(path)).not.toContain("connection.json");
  });

  it("starts another saved conversation without erasing the previous one", async () => {
    const path = await home();
    const { session } = await savedSession(path);
    const savedPath = resolve(path, "sessions", `${session.id}.json`);
    const before = await readFile(savedPath, "utf8");
    const fresh = await cli(["--new"], path);
    expect(fresh.stdout).not.toContain(session.id);
    expect(await readFile(savedPath, "utf8")).toBe(before);
    expect((await cli(["--resume", session.id], path)).stdout).toContain("Synthetic saved answer");
    await expect((await createSessionStore({ home: path })).list()).resolves.toHaveLength(2);
  });

  it("shows an interrupted run without restarting a request", async () => {
    const path = await home();
    const { session, store } = await savedSession(path);
    await store.save(
      {
        ...session,
        status: "running",
        activeRun: { id: randomUUID(), startedAt: new Date().toISOString(), pid: process.pid },
      },
      session.revision,
    );
    const restored = await cli(["resume", "--resume", session.id], path);
    expect(restored.stdout).toContain("Previous reply was interrupted");
    expect(restored.stdout).toContain("No model request was restarted");
    expect((await store.load(session.id)).status).toBe("interrupted");
    expect(await readdir(path)).not.toContain("connection.json");
  });

  it("rejects conflicting selectors and invalid saved IDs", async () => {
    const path = await home();
    await expect(cli(["--new", "--resume", randomUUID()], path)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Choose --new or --resume"),
    });
    await expect(cli(["--resume", "../outside"], path)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("UUID"),
    });
  });
});
