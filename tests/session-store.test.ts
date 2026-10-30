import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createSessionStore,
  SessionBusyError,
  SessionConflictError,
  SessionFormatError,
} from "../src/session-store.ts";

const run = promisify(execFile);
const homes: string[] = [];
const input = {
  modelId: "synthetic-model",
  title: "Synthetic graph lesson",
  scope: { courseId: "demo" as const, sourceVersion: "sha256:synthetic-v1" },
  focus: { page: 1 },
};

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "folio-sessions-test-"));
  homes.push(home);
  return home;
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function assistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "Synthetic reasoning",
        thinkingSignature: "opaque-synthetic-signature",
      },
      {
        type: "toolCall",
        id: "synthetic-call",
        name: "read_demo_page",
        arguments: { courseId: "demo", page: 1 },
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "synthetic-model",
    responseId: "synthetic-response",
    providerThinkingLevel: "low",
    thinkingLevel: "low",
    stopReason: "toolUse",
    timestamp: 1,
    usage: {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("private versioned session snapshots", () => {
  it("round trips native Pi blocks, source version, focus and partial state across a new process", async () => {
    const home = await temporaryHome();
    const store = await createSessionStore({ home });
    const messages: AgentMessage[] = [
      {
        role: "system",
        content: "Synthetic tutor",
        sections: { scope: "demo only" },
        timestamp: 1,
      },
      { role: "user", content: [{ type: "text", text: "Explain this page." }], timestamp: 2 },
      assistant(),
      {
        role: "toolResult",
        toolCallId: "synthetic-call",
        toolName: "read_demo_page",
        content: [{ type: "text", text: "Synthetic page" }],
        details: { anchor: "demo:synthetic#page=1" },
        isError: false,
        timestamp: 3,
      },
    ];
    const initial = await store.create({ ...input, messages });
    const saved = await store.save(
      {
        ...initial,
        focus: { page: 2 },
        status: "interrupted",
        partialAssistant: { ...assistant(), stopReason: "pending" },
      },
      initial.revision,
    );
    const program = `import {createSessionStore} from ${JSON.stringify(new URL("../src/session-store.ts", import.meta.url).href)}; const s=await createSessionStore({home:${JSON.stringify(home)}}); process.stdout.write(JSON.stringify(await s.load(${JSON.stringify(saved.id)})));`;
    const child = await run(process.execPath, ["--input-type=module", "--eval", program]);
    expect(JSON.parse(child.stdout)).toEqual(JSON.parse(JSON.stringify(saved)));
    expect(saved.messages).toEqual(messages);
    expect(saved.revision).toBe(2);
    expect(saved.focus?.page).toBe(2);
    expect(saved.scope).toEqual(input.scope);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(resolve(store.directory, `${saved.id}.json`))).mode & 0o777).toBe(0o600);
    expect(await readdir(store.directory)).toEqual([`${saved.id}.json`]);
  });

  it("lists recent summaries without exposing messages and skips preserved unreadable sessions", async () => {
    const store = await createSessionStore({ home: await temporaryHome() });
    const first = await store.create(input);
    const second = await store.create({ ...input, title: "Another lesson" });
    const firstSaved = await store.save(
      { ...first, title: "Most recently changed" },
      first.revision,
    );
    const file = resolve(store.directory, `${second.id}.json`);
    await writeFile(file, "{synthetic-corrupt-json", "utf8");
    expect(await store.list()).toEqual([
      {
        id: firstSaved.id,
        title: firstSaved.title,
        createdAt: firstSaved.createdAt,
        updatedAt: firstSaved.updatedAt,
        provider: "openai",
        modelId: firstSaved.modelId,
        status: "idle",
        revision: 2,
        scope: firstSaved.scope,
        focus: firstSaved.focus,
        messageCount: 0,
      },
    ]);
    expect(await store.latest()).toEqual(firstSaved);
    expect(await store.listUnavailable()).toEqual([
      { id: second.id, error: expect.stringContaining("Unreadable") },
    ]);
    expect(await readFile(file, "utf8")).toBe("{synthetic-corrupt-json");
  });

  it("keeps the provider a chat started on, and preserves a file from a provider it doesn't know", async () => {
    const store = await createSessionStore({ home: await temporaryHome() });
    const plan = await store.create(input);
    expect(plan.provider).toBe("openai");
    const keyed = await store.create({
      ...input,
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
    });
    expect((await store.load(keyed.id)).provider).toBe("openrouter");
    await expect(store.save({ ...keyed, provider: "anthropic" }, keyed.revision)).rejects.toThrow(
      "immutable",
    );
    const file = resolve(store.directory, `${keyed.id}.json`);
    const later = JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), provider: "xai" });
    await writeFile(file, later, "utf8");
    await expect(store.load(keyed.id)).rejects.toThrow("Invalid Folio session data");
    expect(await readFile(file, "utf8")).toBe(later);
  });

  it("rejects competing revision writes and leaves the winning snapshot intact", async () => {
    const home = await temporaryHome();
    const a = await createSessionStore({ home });
    const b = await createSessionStore({ home });
    const initial = await a.create(input);
    const stale = await b.load(initial.id);
    const saved = await a.save({ ...initial, title: "Saved by first controller" }, 1);
    await expect(b.save({ ...stale, title: "Stale writer" }, 1)).rejects.toBeInstanceOf(
      SessionConflictError,
    );
    expect(await b.load(initial.id)).toEqual(saved);
  });

  it("detects manual edits even when the numeric revision is unchanged or summaries are refreshed", async () => {
    const store = await createSessionStore({ home: await temporaryHome() });
    const initial = await store.create(input);
    const file = resolve(store.directory, `${initial.id}.json`);
    const externallyEdited = JSON.stringify({ ...initial, title: "Edited outside Folio" });
    await writeFile(file, externallyEdited);
    expect((await store.list())[0]?.title).toBe("Edited outside Folio");
    await expect(
      store.save({ ...initial, title: "Stale proposed title" }, 1),
    ).rejects.toBeInstanceOf(SessionConflictError);
    expect(await readFile(file, "utf8")).toBe(externallyEdited);
  });

  it("does not let a newer preview read authorize saving an older snapshot of the same revision", async () => {
    const store = await createSessionStore({ home: await temporaryHome() });
    const created = await store.create(input);
    const old = await store.load(created.id);
    const file = resolve(store.directory, `${created.id}.json`);
    const externallyEdited = JSON.stringify({ ...old, title: "External edit before preview" });
    await writeFile(file, externallyEdited);
    const fresh = await store.load(created.id);

    await expect(store.save({ ...old, focus: { page: 2 } }, old.revision)).rejects.toBeInstanceOf(
      SessionConflictError,
    );
    expect(await readFile(file, "utf8")).toBe(externallyEdited);
    const saved = await store.save({ ...fresh, focus: { page: 2 } }, fresh.revision);
    expect(saved.title).toBe("External edit before preview");
    expect(saved.focus?.page).toBe(2);
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw).toEqual(JSON.parse(JSON.stringify(saved)));
    expect(Object.getOwnPropertySymbols(raw)).toHaveLength(0);
    expect(Object.keys(raw).sort()).toEqual(Object.keys(created).sort());
  });

  it("holds one writer for an entire conversation and rejects another process until release", async () => {
    const home = await temporaryHome();
    const store = await createSessionStore({ home });
    const initial = await store.create(input);
    const lease = await store.lockSession(initial.id);
    const other = await createSessionStore({ home });
    const stale = await other.load(initial.id);
    await expect(other.save(stale, stale.revision)).rejects.toBeInstanceOf(SessionBusyError);
    const script = `import{createSessionStore,SessionBusyError}from ${JSON.stringify(new URL("../src/session-store.ts", import.meta.url).href)}; const s=await createSessionStore({home:${JSON.stringify(home)}});try{const release=await s.lockSession(${JSON.stringify(initial.id)});await release();process.exitCode=2;}catch(e){if(!(e instanceof SessionBusyError))throw e;}`;
    await run(process.execPath, ["--input-type=module", "--eval", script]);
    const saved = await store.save({ ...initial, title: "Held writer" }, 1, lease);
    await lease();
    await expect(store.save(saved, saved.revision, lease)).rejects.toBeInstanceOf(SessionBusyError);
    await expect(
      other.lockSession(initial.id).then((release) => release()),
    ).resolves.toBeUndefined();
  });

  it("recovers stale run and operation locks left by stopped processes", async () => {
    const store = await createSessionStore({ home: await temporaryHome() });
    const initial = await store.create(input);
    const old = new Date(Date.now() - 60_000);
    for (const kind of ["run", "write"]) {
      const path = resolve(store.directory, `${initial.id}.json.${kind}.lock`);
      await mkdir(path);
      await utimes(path, old, old);
    }
    expect((await store.save(initial, 1)).revision).toBe(2);
  });

  it.each(["schema", "runtime", "role"])(
    "preserves an incompatible %s file without replacing it",
    async (kind) => {
      const store = await createSessionStore({ home: await temporaryHome() });
      const initial = await store.create(input);
      const changed =
        kind === "schema"
          ? { ...initial, version: 42 }
          : kind === "runtime"
            ? { ...initial, runtime: { ...initial.runtime, version: "99.0.0" } }
            : {
                ...initial,
                messages: [{ role: "unexpected", content: "synthetic", timestamp: 1 }],
              };
      const file = resolve(store.directory, `${initial.id}.json`);
      const originalBytes = JSON.stringify(changed);
      await writeFile(file, originalBytes);
      await expect(store.load(initial.id)).rejects.toBeInstanceOf(SessionFormatError);
      await expect(store.save(initial, 1)).rejects.toBeInstanceOf(SessionFormatError);
      expect(await readFile(file, "utf8")).toBe(originalBytes);
    },
  );

  it("keeps source identity immutable and validates persisted running state", async () => {
    const store = await createSessionStore({ home: await temporaryHome() });
    const initial = await store.create(input);
    await expect(
      store.save({ ...initial, scope: { courseId: "demo", sourceVersion: "different-source" } }, 1),
    ).rejects.toBeInstanceOf(SessionConflictError);
    await expect(
      store.save({ ...initial, modelId: "a-different-model" }, 1),
    ).rejects.toBeInstanceOf(SessionConflictError);
    await expect(store.save({ ...initial, status: "running" }, 1)).rejects.toBeInstanceOf(
      SessionFormatError,
    );
    const activeRun = { id: randomUUID(), startedAt: new Date().toISOString(), pid: process.pid };
    const running = await store.save({ ...initial, status: "running", activeRun }, 1);
    expect((await store.load(initial.id)).activeRun).toEqual(activeRun);
    expect(running.status).toBe("running");
  });

  it("rejects repository storage, path traversal and symbolic links without changing their targets", async () => {
    await expect(
      createSessionStore({ home: resolve(".synthetic-session-data") }),
    ).rejects.toBeInstanceOf(SessionFormatError);
    const home = await temporaryHome();
    const link = resolve(home, "linked-home");
    await symlink(home, link);
    await expect(createSessionStore({ home: link })).rejects.toBeInstanceOf(SessionFormatError);
    const store = await createSessionStore({ home });
    await expect(store.load("../../synthetic")).rejects.toBeInstanceOf(SessionFormatError);
    const initial = await store.create(input);
    const target = resolve(home, "synthetic-target.json");
    await writeFile(target, "untouched synthetic target");
    const file = resolve(store.directory, `${initial.id}.json`);
    await rm(file);
    await symlink(target, file);
    await expect(store.load(initial.id)).rejects.toBeInstanceOf(SessionFormatError);
    await expect(store.save(initial, 1)).rejects.toBeInstanceOf(SessionFormatError);
    expect(await readFile(target, "utf8")).toBe("untouched synthetic target");
  });
});
