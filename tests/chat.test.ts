import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Conversation, DEMO_SOURCE_VERSION } from "../src/conversation.ts";
import {
  createSessionStore,
  SessionConflictError,
  SessionFormatError,
  type SessionStore,
} from "../src/session-store.ts";

const model: Model<Api> = {
  id: "synthetic-model",
  name: "Synthetic model",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://synthetic.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
};
const homes: string[] = [];
const conversations: Conversation[] = [];

async function temporaryStore(): Promise<SessionStore> {
  const home = await mkdtemp(resolve(tmpdir(), "folio-chat-test-"));
  homes.push(home);
  return createSessionStore({ home });
}

function reply(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function completed(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

async function open(
  store: SessionStore,
  streamFn: StreamFn,
  options: Partial<Parameters<typeof Conversation.open>[0]> = {},
): Promise<Conversation> {
  const conversation = await Conversation.open({
    store,
    streamFn,
    resolveModel: () => model,
    modelId: model.id,
    ...options,
  });
  conversations.push(conversation);
  return conversation;
}

afterEach(async () => {
  await Promise.allSettled(conversations.splice(0).map((conversation) => conversation.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("plain chat conversations", () => {
  it("sends with the app's chat prompt and no tools, then resumes history after reopening", async () => {
    const store = await temporaryStore();
    const requests: TranscriptContext[] = [];
    const streamFn: StreamFn = (_model, context) => {
      requests.push(structuredClone(context));
      return completed(reply(`Reply ${requests.length}`));
    };
    const first = await open(store, streamFn, { newSession: true, kind: "chat" });
    expect(first.kind).toBe("chat");
    expect(first.snapshot.scope).toEqual({ courseId: null });
    expect(first.snapshot.focus).toBeNull();
    await first.send("What is a heap?");
    expect(getCurrentTools(requests[0]!.messages)).toEqual([]);
    expect(JSON.stringify(requests[0]!.messages)).toContain("This is a plain chat");
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("read_demo_page");
    expect(first.snapshot.title).toBe("What is a heap?");
    const id = first.snapshot.id;
    await first.close();

    const second = await open(store, streamFn, { id, kind: "chat" });
    expect(second.resumed).toBe(true);
    await second.send("And a priority queue?");
    const roles = requests[1]!.messages.map((message) => message.role);
    expect(roles.filter((role) => role === "user")).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain("Reply 1");
    expect((await store.load(id)).messages.filter((m) => m.role === "assistant")).toHaveLength(2);
    await expect(second.setFocus(1)).rejects.toThrow("no course pages");
  });

  it("keeps plain chats and course tutoring chats apart when opened by kind", async () => {
    const store = await temporaryStore();
    const streamFn: StreamFn = () => completed(reply("ok"));
    const demo = await store.create({
      modelId: model.id,
      scope: { courseId: "demo", sourceVersion: DEMO_SOURCE_VERSION },
      focus: { page: 1 },
    });
    const chat = await store.create({ modelId: model.id, scope: { courseId: null }, focus: null });
    await expect(open(store, streamFn, { id: demo.id, kind: "chat" })).rejects.toThrow(
      "course tutoring chat",
    );
    await expect(open(store, streamFn, { id: chat.id, kind: "demo" })).rejects.toThrow(
      "plain chat",
    );
    // The CLI resumes the latest chat of either kind.
    expect((await open(store, streamFn)).kind).toBe("chat");
  });

  it("rejects invalid scope and focus pairs, and a scope change on save", async () => {
    const store = await temporaryStore();
    await expect(
      store.create({ modelId: model.id, scope: { courseId: null }, focus: { page: 1 } }),
    ).rejects.toThrow(SessionFormatError);
    await expect(
      store.create({
        modelId: model.id,
        scope: { courseId: "demo", sourceVersion: DEMO_SOURCE_VERSION },
        focus: null,
      }),
    ).rejects.toThrow(SessionFormatError);
    const chat = await store.create({ modelId: model.id, scope: { courseId: null }, focus: null });
    await expect(
      store.save(
        {
          ...chat,
          scope: { courseId: "demo", sourceVersion: DEMO_SOURCE_VERSION },
          focus: { page: 1 },
        },
        chat.revision,
      ),
    ).rejects.toThrow(SessionConflictError);
  });
});
