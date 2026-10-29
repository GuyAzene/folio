import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Conversation } from "../src/conversation.ts";
import { createSessionStore } from "../src/session-store.ts";

const homes: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it("recovers a killed process without losing accepted input or replaying work", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "folio-killed-session-"));
  homes.push(home);
  const child = spawn(
    process.execPath,
    [resolve(import.meta.dirname, "fixtures/session-worker.ts")],
    {
      cwd: resolve(import.meta.dirname, ".."),
      env: { ...process.env, FOLIO_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  let diagnostics = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const id = await new Promise<string>((resolveId, reject) => {
    let stdout = "";
    const timeout = setTimeout(
      () => reject(new Error(`Worker checkpoint timed out: ${diagnostics}`)),
      5_000,
    );
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`Worker exited early: ${diagnostics}`));
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!stdout.includes("\n")) return;
      clearTimeout(timeout);
      resolveId((JSON.parse(stdout.split("\n")[0]!) as { id: string }).id);
    });
  });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const path = resolve(home, "sessions", `${id}.json`);
  const before = JSON.parse(await readFile(path, "utf8"));
  expect(before.status).toBe("running");
  expect(before.partialAssistant.content[0].text).toContain("saved partial");

  // Simulate the lease's elapsed stale interval after SIGKILL. No wall-clock
  // sleep is needed; the writer process is actually dead.
  const old = new Date(Date.now() - 30_000);
  await utimes(`${path}.run.lock`, old, old);
  const catalog = createModels();
  catalog.setProvider(openaiProvider());
  let requests = 0;
  const conversation = await Conversation.open({
    store: await createSessionStore({ home }),
    id,
    resolveModel: (modelId) => catalog.getModel("openai", modelId)!,
    streamFn: () => {
      requests++;
      throw new Error("Recovery must not send any request");
    },
  });
  try {
    expect(requests).toBe(0);
    const saved = conversation.snapshot;
    expect(saved.status).toBe("interrupted");
    expect(saved.focus?.page).toBe(2);
    expect(saved.activeRun).toBeUndefined();
    expect(
      saved.messages.some(
        (message) =>
          message.role === "user" && message.content === "Synthetic question before process death.",
      ),
    ).toBe(true);
    expect(saved.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(JSON.stringify(saved.messages)).toContain("A saved partial explanation.");
    expect(JSON.parse(await readFile(path, "utf8")).status).toBe("interrupted");
  } finally {
    await conversation.close();
  }
});
