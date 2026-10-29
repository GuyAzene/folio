import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DEMO_SOURCE_VERSION } from "../src/conversation.ts";
import type { DesktopEvent } from "../src/desktop/api.ts";
import { ChatService } from "../src/desktop/chat-service.ts";
import { chatView } from "../src/desktop/view.ts";
import type { AttachReach } from "../src/library/attachments.ts";
import { createSessionStore, type SessionStore } from "../src/session-store.ts";

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
const services: ChatService[] = [];

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop") {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", thinkingSignature: "opaque-native", redacted: true },
      { type: "text", text },
    ],
    stopReason,
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
  } satisfies AssistantMessage;
}

/** Streams "Hello world" in two deltas, as a provider would. */
const streaming: StreamFn = () => {
  const stream = createAssistantMessageEventStream();
  const final = assistant("Hello world");
  queueMicrotask(() => {
    stream.push({ type: "start", partial: assistant("") });
    stream.push({ type: "text_start", contentIndex: 1, partial: assistant("") });
    stream.push({
      type: "text_delta",
      contentIndex: 1,
      delta: "Hello",
      partial: assistant("Hello"),
    });
    stream.push({
      type: "text_delta",
      contentIndex: 1,
      delta: " world",
      partial: assistant("Hello world"),
    });
    stream.push({ type: "text_end", contentIndex: 1, content: "Hello world", partial: final });
    stream.push({ type: "done", reason: "stop", message: final });
  });
  return stream;
};

async function setup(
  options: {
    connected?: boolean;
    streamFn?: StreamFn;
    models?: string[];
    libraryRuntime?: ConstructorParameters<typeof ChatService>[0]["libraryRuntime"];
    courseRuntime?: ConstructorParameters<typeof ChatService>[0]["courseRuntime"];
    attach?: ConstructorParameters<typeof ChatService>[0]["attach"];
  } = {},
): Promise<{ service: ChatService; store: SessionStore; events: DesktopEvent[] }> {
  const home = await mkdtemp(resolve(tmpdir(), "folio-desktop-test-"));
  homes.push(home);
  const store = await createSessionStore({ home });
  const events: DesktopEvent[] = [];
  const service = new ChatService({
    store,
    streamFn: options.streamFn ?? streaming,
    resolveModel: (id) => ({ ...model, id }),
    modelId: model.id,
    models: options.models,
    libraryRuntime: options.libraryRuntime,
    courseRuntime: options.courseRuntime,
    attach: options.attach,
    connected: async () => options.connected ?? true,
    emit: (event) => events.push(structuredClone(event)),
  });
  services.push(service);
  return { service, store, events };
}

async function settled(events: DesktopEvent[]): Promise<void> {
  await vi.waitFor(() => {
    const last = events.findLast((event) => event.type === "chat");
    expect(last?.type === "chat" && last.chat.status !== "running").toBe(true);
  });
}

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("desktop chat service", () => {
  it("creates a plain chat on first send, streams visible text, and saves the reply", async () => {
    const { service, store, events } = await setup();
    const { chatId } = await service.send({
      chatId: null,
      text: "Say hello",
      submissionId: randomUUID(),
    });
    await settled(events);

    const streamed = events.filter((event) => event.type === "stream").map((event) => event.text);
    expect(streamed).toContain("Hello world");
    const view = await service.openChat(chatId);
    expect(view.title).toBe("Say hello");
    expect(view.messages).toEqual([
      { role: "user", text: "Say hello", state: "complete" },
      {
        role: "assistant",
        text: "Hello world",
        state: "complete",
        steps: [],
        sources: [],
        proposals: [],
      },
    ]);
    // Native reasoning blocks stay in the main process; views carry visible text only.
    expect(JSON.stringify(events)).not.toContain("opaque-native");
    expect((await store.load(chatId)).scope).toEqual({ courseId: null });
    expect(events.some((event) => event.type === "chats" && event.chats[0]?.id === chatId)).toBe(
      true,
    );
  });

  it("lists only plain chats and refuses to open a course tutoring chat", async () => {
    const { service, store } = await setup();
    const demo = await store.create({
      modelId: model.id,
      scope: { courseId: "demo", sourceVersion: DEMO_SOURCE_VERSION },
      focus: { page: 1 },
    });
    const chat = await store.create({ modelId: model.id, scope: { courseId: null }, focus: null });
    expect((await service.chats()).chats.map((summary) => summary.id)).toEqual([chat.id]);
    await expect(service.openChat(demo.id)).rejects.toThrow("course tutoring chat");
    await expect(service.openChat("../../etc/passwd")).rejects.toThrow("Unknown chat");
  });

  it("does not accept a message while ChatGPT is disconnected or the input is invalid", async () => {
    const request = vi.fn(streaming);
    const offline = await setup({ connected: false, streamFn: request });
    await expect(
      offline.service.send({ chatId: null, text: "Hi", submissionId: randomUUID() }),
    ).rejects.toThrow("Connect your ChatGPT account");
    expect((await offline.service.chats()).chats).toEqual([]);

    const online = await setup({ streamFn: request });
    await expect(
      online.service.send({ chatId: null, text: "   ", submissionId: randomUUID() }),
    ).rejects.toThrow("Enter a message");
    await expect(
      online.service.send({ chatId: null, text: "Hi", submissionId: "not-a-uuid" }),
    ).rejects.toThrow("Invalid submission");
    expect(request).not.toHaveBeenCalled();
  });

  it("reports a provider failure as an event and keeps the question saved", async () => {
    const failing: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      const failed = { ...assistant("", "error"), errorMessage: "Synthetic outage" };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: failed });
        stream.push({ type: "error", reason: "error", error: failed });
      });
      return stream;
    };
    const { service, events } = await setup({ streamFn: failing });
    const { chatId } = await service.send({
      chatId: null,
      text: "Will this fail?",
      submissionId: randomUUID(),
    });
    await settled(events);
    expect(events).toContainEqual({ type: "error", chatId, message: "Synthetic outage" });
    const view = await service.openChat(chatId);
    expect(view.status).toBe("error");
    expect(view.messages[0]).toEqual({
      role: "user",
      text: "Will this fail?",
      state: "complete",
    });
    expect(view.messages[1]).toMatchObject({ state: "failed", error: "Synthetic outage" });
  });

  it("starts library chats with the chosen model and refuses models it does not offer", async () => {
    const { service, store, events } = await setup({
      models: [model.id, "second-model"],
      libraryRuntime: async () => ({
        tools: [],
        prompt: async () => "Synthetic library prompt",
        checkFocus: async () => {
          throw new Error("Library chats do not follow a page.");
        },
      }),
    });
    const { chatId } = await service.send({
      chatId: null,
      text: "Which course covers heaps?",
      submissionId: randomUUID(),
      modelId: "second-model",
    });
    await settled(events);
    const record = await store.load(chatId);
    expect(record.modelId).toBe("second-model");
    expect(record.scope).toEqual({ courseId: null, library: 1 });
    expect((await service.openChat(chatId)).kind).toBe("library");
    await expect(
      service.send({
        chatId: null,
        text: "Hello",
        submissionId: randomUUID(),
        modelId: "gpt-5.5",
      }),
    ).rejects.toThrow("not available");
  });

  it("sends what the student added with the question, and records it on their message", async () => {
    const courseId = randomUUID();
    const otherCourse = randomUUID();
    const documentId = randomUUID();
    const seen: unknown[] = [];
    const reaches: AttachReach[] = [];
    const runtime = async () => ({
      tools: [],
      prompt: async () => "Synthetic course prompt",
      checkFocus: async () => ({ title: "Synthetic lecture", pages: 3 }),
    });
    const { service, store, events } = await setup({
      streamFn: (model, context, options) => {
        seen.push(structuredClone(context.messages.at(-1)));
        return streaming(model, context, options);
      },
      courseRuntime: runtime,
      // A stand-in for the main process's checks, which tests/course-chat.test.ts covers.
      attach: async (reach, inputs) => {
        reaches.push(structuredClone(reach));
        return inputs.map((input) =>
          input.kind === "page"
            ? {
                attachment: input,
                note: `page ${input.page}`,
                image: { type: "image", data: "UEFHRQ==", mimeType: "image/jpeg" },
              }
            : input.kind === "image"
              ? {
                  attachment: { kind: "image", name: input.name, thumbnail: "VEhVTUI=" },
                  note: "their image",
                  image: { type: "image", data: "SU1BR0U=", mimeType: "image/jpeg" },
                }
              : { attachment: input, note: input.kind },
        );
      },
    });
    const { chatId } = await service.send({
      chatId: null,
      text: "Compare these.",
      submissionId: randomUUID(),
      courseId,
      attachments: [
        { kind: "page", documentId, page: 3 },
        { kind: "course", courseId: otherCourse },
        { kind: "image", name: "work.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      ],
    });
    await settled(events);
    expect(reaches[0]).toEqual({ courseId, grants: { courses: [], documents: [] } });
    // The typed text first, then what was added, then the images.
    expect(seen[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Compare these." },
        { type: "text", text: "[Added by the student: page 3; course; their image]" },
        { type: "image", data: "UEFHRQ==" },
        { type: "image", data: "SU1BR0U=" },
      ],
    });
    const view = await service.openChat(chatId);
    expect(view.messages[0]).toEqual({
      role: "user",
      text: "Compare these.",
      state: "complete",
      attachments: [
        { kind: "page", documentId, page: 3 },
        { kind: "course", courseId: otherCourse },
        { kind: "image", name: "work.png", thumbnail: "data:image/jpeg;base64,VEhVTUI=" },
      ],
    });
    expect(view.reads).toEqual({ courses: [otherCourse], documents: [] });

    // Later questions are checked with what the chat has been given, and carry nothing new.
    events.length = 0;
    await service.send({
      chatId,
      text: "And this one?",
      submissionId: randomUUID(),
      attachments: [{ kind: "document", documentId }],
    });
    await settled(events);
    expect(reaches[1]).toEqual({ courseId, grants: { courses: [otherCourse], documents: [] } });
    events.length = 0;
    await service.send({ chatId, text: "Thanks", submissionId: randomUUID() });
    await settled(events);
    expect(reaches).toHaveLength(2);
    expect(seen.at(-1)).toMatchObject({ content: "Thanks" });

    // Chats saved before the + button keep showing the page they sent.
    const record = await store.load(chatId);
    const older = chatView({
      ...record,
      messages: [
        { role: "user", content: "Old", timestamp: 0, folioPage: { documentId, page: 2 } },
      ],
    } as never);
    expect(older.messages[0]).toMatchObject({
      attachments: [{ kind: "page", documentId, page: 2 }],
    });

    // A reply stopped in the middle of reading a page does not keep "reading" forever.
    const stopped = chatView({
      ...record,
      status: "interrupted",
      messages: [
        { role: "user", content: "Read page 3", timestamp: 0 },
        {
          ...assistant("", "aborted"),
          content: [{ type: "toolCall", id: "call_1", name: "read_page", arguments: { page: 3 } }],
        },
      ],
    } as never);
    expect(stopped.messages[1]).toMatchObject({
      state: "interrupted",
      steps: [{ label: "Couldn't read page 3", state: "failed" }],
    });
  });

  it("refuses attachments it can't take, before any chat is created", async () => {
    const { service, store } = await setup({
      courseRuntime: async () => ({
        tools: [],
        prompt: async () => "Synthetic course prompt",
        checkFocus: async () => ({ title: "Synthetic lecture", pages: 3 }),
      }),
      attach: async () => {
        throw new Error("That page is not part of this chat.");
      },
    });
    const base = { chatId: null, text: "Look", submissionId: randomUUID(), courseId: randomUUID() };
    const image = { kind: "image", name: "a.png", data: new Uint8Array([1]) } as const;
    await expect(
      service.send({ ...base, attachments: [image, image, image, image, image] }),
    ).rejects.toThrow("at most 4 images");
    await expect(
      service.send({ ...base, attachments: [{ kind: "file", path: "/etc/passwd" }] as never }),
    ).rejects.toThrow("can't add that");
    await expect(
      service.send({ ...base, attachments: [{ kind: "image", name: "a", data: "AAAA" }] as never }),
    ).rejects.toThrow("Invalid image");
    await expect(
      service.send({ ...base, attachments: [{ kind: "page", documentId: randomUUID(), page: 1 }] }),
    ).rejects.toThrow("not part of this chat");
    expect(await store.list()).toEqual([]);
  });

  it("does not add anything to an older plain chat, which reads nothing", async () => {
    const { service } = await setup({ attach: async () => [] });
    await expect(
      service.send({
        chatId: null,
        text: "Hello",
        submissionId: randomUUID(),
        attachments: [{ kind: "course", courseId: randomUUID() }],
      }),
    ).rejects.toThrow("can't take attachments");
  });

  it("sends the question as typed: a quiz is asked for in words, not picked as a mode", async () => {
    const seen: unknown[] = [];
    const { service, events } = await setup({
      streamFn: (model, context, options) => {
        seen.push(context.messages.at(-1));
        return streaming(model, context, options);
      },
      courseRuntime: async () => ({
        tools: [],
        prompt: async () => "Synthetic course prompt",
        checkFocus: async () => ({ title: "Synthetic lecture", pages: 3 }),
      }),
    });
    const { chatId } = await service.send({
      chatId: null,
      text: "Quiz me on BFS, one step at a time",
      submissionId: randomUUID(),
      courseId: randomUUID(),
      // An older window may still send its picked mode; it is ignored.
      teaching: { mode: "quiz", stepByStep: true },
    } as never);
    await settled(events);
    expect(seen[0]).toMatchObject({ role: "user", content: "Quiz me on BFS, one step at a time" });
    const view = await service.openChat(chatId);
    expect(view.messages[0]).toEqual({
      role: "user",
      text: "Quiz me on BFS, one step at a time",
      state: "complete",
    });
  });
});
