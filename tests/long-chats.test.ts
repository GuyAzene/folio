import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Conversation } from "../src/conversation.ts";
import { createSessionStore, type SessionStore } from "../src/session-store.ts";
import { modelContextMessages, stubOf } from "../src/transcript.ts";
import { chatView } from "../src/desktop/view.ts";

// Synthetic chats only. A small context makes a chat "long" after a few questions.
const model: Model<Api> = {
  id: "synthetic-model",
  name: "Synthetic model",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://synthetic.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1024,
};
const homes: string[] = [];
const conversations: Conversation[] = [];

afterEach(async () => {
  await Promise.allSettled(conversations.splice(0).map((chat) => chat.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
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

function reply(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
  });
  return stream;
}

const isSummary = (context: TranscriptContext) =>
  JSON.stringify(context.messages[0]).includes("You are summarizing");

/** Each question reads a long synthetic page, then answers; summary requests get a summary. */
function tutor(
  requests: TranscriptContext[],
  summary: (context: TranscriptContext) => AssistantMessage | "fail" = () =>
    assistant([{ type: "text", text: "The student is reading graph search, page by page." }]),
): StreamFn {
  return (_model, context) => {
    requests.push(structuredClone(context));
    if (isSummary(context)) {
      const answer = summary(context);
      if (answer === "fail") throw new Error("Synthetic outage");
      return reply(answer);
    }
    const last = context.messages.at(-1)!;
    return reply(
      last.role === "user"
        ? assistant(
            [
              {
                type: "toolCall",
                id: `call_${requests.length}`,
                name: "read_long",
                arguments: { page: requests.length },
              },
            ],
            "toolUse",
          )
        : assistant([{ type: "text", text: "Answered from the page." }]),
    );
  };
}

/** A tool that reads a synthetic page of `repeats` sentences. */
function readLong(repeats: number): AgentTool {
  return {
    name: "read_long",
    label: "Read a long page",
    description: "Read a long synthetic page.",
    parameters: Type.Object({ page: Type.Integer() }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const page = (params as { page: number }).page;
      return {
        content: [
          {
            type: "text",
            text: `Page ${page}. ${"Synthetic text about graphs. ".repeat(repeats)}`,
          },
        ],
        details: { title: "Synthetic lecture", page },
      };
    },
  };
}

async function open(
  streamFn: StreamFn,
  id?: string,
  repeats = 160,
): Promise<{ chat: Conversation; store: SessionStore }> {
  const home = homes[0] ?? (await mkdtemp(resolve(tmpdir(), "folio-long-chat-test-")));
  if (!homes.length) homes.push(home);
  const store = await createSessionStore({ home });
  const chat = await Conversation.open({
    store,
    ...(id
      ? { id, allowedKinds: ["course"] }
      : { newSession: true, kind: "course", courseId: "00000000-0000-4000-8000-0000000000c1" }),
    courseRuntime: async () => ({
      tools: [readLong(repeats)],
      prompt: async () => "Synthetic course prompt.",
      checkFocus: async () => ({ title: "Synthetic lecture", pages: 9 }),
    }),
    streamFn,
    resolveModel: () => model,
    modelId: model.id,
  });
  conversations.push(chat);
  return { chat, store };
}

/** How many requests did not simply repeat the one before and add to it. */
function breaks(requests: TranscriptContext[]): number {
  let count = 0;
  for (let index = 1; index < requests.length; index++) {
    const before = requests[index - 1]!.messages;
    const now = requests[index]!.messages;
    if (JSON.stringify(now.slice(0, before.length)) !== JSON.stringify(before)) count++;
  }
  return count;
}

// Each of these runs dozens of saved turns, which takes a few seconds when the suite runs at once.
describe("long chats", { timeout: 30_000 }, () => {
  it("shorten earlier tool results in batches, only ever moving forward", async () => {
    const requests: TranscriptContext[] = [];
    const { chat } = await open(
      tutor(requests, () => assistant([{ type: "text", text: "Summary." }])),
    );
    for (let question = 1; question <= 12; question++) await chat.send(`Question ${question}`);
    const tutoring = requests.filter((request) => !isSummary(request));
    const marks = chat.snapshot.messages.flatMap((message) =>
      message.role === "user" && "folioTrim" in message
        ? [(message as { folioTrim: { stubBefore: number } }).folioTrim.stubBefore]
        : [],
    );
    expect(marks.length).toBeGreaterThan(0);
    expect(marks).toEqual([...marks].sort((a, b) => a - b));
    expect(new Set(marks).size).toBe(marks.length);
    // A cut changes earlier messages once; between cuts every request repeats the one before.
    expect(breaks(tutoring)).toBeLessThanOrEqual(marks.length + 1);
    const last = JSON.stringify(tutoring.at(-1)!.messages);
    expect(last).toContain("An earlier read_long result");
    // The last questions' results always reach the model whole.
    expect(last).toContain(`Page ${requests.length - 1}.`);
  });

  it("summarize a chat that is long even so, once, and reopen without asking again", async () => {
    const requests: TranscriptContext[] = [];
    const { chat, store } = await open(tutor(requests), undefined, 600);
    for (let question = 1; question <= 30; question++) await chat.send(`Question ${question}`);
    const summaries = requests.filter(isSummary);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    // The summary request never sees Folio's tools.
    expect(JSON.stringify(summaries[0]!.messages[0])).not.toContain("read_long");
    const saved = chat.snapshot.messages;
    const summary = saved.findIndex((message) => "folioSummary" in message);
    expect(summary).toBeGreaterThan(0);
    expect(saved[summary + 1]).toMatchObject({ role: "user" });
    expect(
      (saved[summary] as unknown as { folioSummary: { covers: number } }).folioSummary.covers,
    ).toBe(summary);
    // The model sees the summary instead of what it covers; every saved message stays.
    const projected = modelContextMessages(saved);
    expect(JSON.stringify(projected)).not.toContain('Question 1"');
    expect(JSON.stringify(projected)).toContain("<folio_summary>");
    // One request per summary saved, and every question kept.
    const savedSummaries = saved.filter((message) => "folioSummary" in message).length;
    expect(summaries.length).toBe(savedSummaries);
    expect(saved.filter((message) => message.role === "user").length).toBe(30 + savedSummaries);
    // Shown as a divider, not as a question.
    expect(
      chatView(chat.snapshot).messages.filter((message) => message.kind === "summary").length,
    ).toBe(saved.filter((message) => "folioSummary" in message).length);
    const id = chat.snapshot.id;
    await chat.close();
    const before = requests.length;
    const reopened = await open(tutor(requests), id, 600);
    expect(modelContextMessages(reopened.chat.snapshot.messages)).toEqual(projected);
    expect(requests.length).toBe(before);
    void store;
  });

  it("go on without a summary when it fails, and keep the chat as it was when stopped", async () => {
    const requests: TranscriptContext[] = [];
    const { chat } = await open(
      tutor(requests, () => "fail"),
      undefined,
      600,
    );
    for (let question = 1; question <= 30; question++) await chat.send(`Question ${question}`);
    expect(requests.some(isSummary)).toBe(true);
    expect(chat.snapshot.messages.some((message) => "folioSummary" in message)).toBe(false);
    expect(chat.snapshot.status).toBe("idle");

    const stopping: TranscriptContext[] = [];
    let stop: () => void = () => undefined;
    const second = await open(
      tutor(stopping, () => {
        stop();
        return assistant([{ type: "text", text: "Too late." }]);
      }),
      undefined,
      600,
    );
    stop = () => second.chat.cancel();
    let sent = 0;
    while (!stopping.some(isSummary) && sent < 30) await second.chat.send(`Question ${++sent}`);
    expect(second.chat.snapshot.messages.some((message) => "folioSummary" in message)).toBe(false);
    expect(second.chat.snapshot.status).toBe("interrupted");
  });

  it("say what an earlier result was when they shorten it", () => {
    expect(stubOf({ toolName: "read_page", details: { title: "Lecture 2", page: 4 } })).toBe(
      '[An earlier read_page result ("Lecture 2", page 4) is not sent again; call the tool again if you need its text.]',
    );
    expect(stubOf({ toolName: "read_sections", details: { handles: ["a-1", "b-2"] } })).toContain(
      "(sections a-1, b-2)",
    );
    const visual = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "v1",
          name: "show_visual",
          arguments: { source: "<svg><title>Two states</title></svg>" },
        },
      ],
      stopReason: "toolUse",
      timestamp: 0,
    } as unknown as AgentMessage;
    const result = {
      role: "toolResult",
      toolCallId: "v1",
      toolName: "show_visual",
      content: [{ type: "text", text: "Shown." }],
      isError: false,
      timestamp: 0,
    } as unknown as AgentMessage;
    const later = {
      role: "user",
      content: "Next",
      timestamp: 0,
      folioTrim: { v: 1, stubBefore: 3 },
    };
    const sent = JSON.stringify(
      modelContextMessages([
        { role: "user", content: "Show", timestamp: 0 } as AgentMessage,
        visual,
        result,
        later as AgentMessage,
      ]),
    );
    expect(sent).toContain("[A visual shown earlier: Two states.]");
    expect(sent).not.toContain("<svg>");
  });
});
