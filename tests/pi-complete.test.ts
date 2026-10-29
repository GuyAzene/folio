import { describe, expect, it, vi } from "vite-plus/test";
import { Type } from "typebox";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { piComplete, type PiModels } from "../src/ingest/pi-complete.ts";

const schema = Type.Object({ page: Type.Integer() });

function fakeModels(content: AssistantMessage["content"]) {
  const completeSimple = vi.fn(
    async (): Promise<AssistantMessage> =>
      ({
        role: "assistant",
        content,
        stopReason: "toolUse",
        usage: { input: 5, output: 2 },
      }) as unknown as AssistantMessage,
  );
  return { models: { completeSimple } as unknown as PiModels, completeSimple };
}

describe("Pi bridge", () => {
  it("sends the answer as a strict tool the model must call, and returns its arguments", async () => {
    const { models, completeSimple } = fakeModels([
      { type: "toolCall", id: "1", name: "submit", arguments: { page: 2 } },
    ]);
    const complete = piComplete(
      async () => models,
      (id) => ({ id }) as never,
    );
    const reply = await complete({
      model: "gpt-6-luna",
      system: "s",
      content: [],
      maxTokens: 10,
      answer: { name: "submit", description: "d", schema },
    });
    expect(reply.answers).toEqual([{ page: 2 }]);
    const [, context, options] = completeSimple.mock.calls[0] as unknown as [
      unknown,
      { tools: { name: string; constrainedSampling: unknown }[] },
      { toolChoice: string },
    ];
    expect(context.tools[0]).toMatchObject({
      name: "submit",
      constrainedSampling: { type: "json_schema", strict: "prefer" },
    });
    expect(options.toolChoice).toBe("required");
  });

  it("passes arguments Pi could not read on as text, for the repair fallback", async () => {
    const { models } = fakeModels([
      {
        type: "toolCall",
        id: "1",
        name: "submit",
        arguments: {},
        argumentsError: 'Invalid JSON: {"page": 2,}',
      },
    ]);
    const reply = await piComplete(
      async () => models,
      (id) => ({ id }) as never,
    )({
      model: "m",
      system: "s",
      content: [],
      maxTokens: 10,
      answer: { name: "submit", description: "d", schema },
    });
    expect(reply.answers).toEqual([]);
    expect(reply.text).toContain('{"page": 2,}');
  });
});

describe("a dropped connection", () => {
  const reply = (stopReason: string, errorMessage?: string) =>
    ({
      role: "assistant",
      content:
        stopReason === "toolUse"
          ? [{ type: "toolCall", id: "1", name: "submit", arguments: { page: 3 } }]
          : [],
      stopReason,
      errorMessage,
      usage: { input: 7, output: 3 },
    }) as unknown as AssistantMessage;
  const request = (signal?: AbortSignal) => ({
    model: "gpt-6-luna",
    system: "s",
    content: [],
    maxTokens: 10,
    answer: { name: "submit", description: "d", schema },
    signal,
  });
  const bridge = (replies: (AssistantMessage | Error)[]) => {
    const completeSimple = vi.fn(async () => {
      const next = replies.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const complete = piComplete(
      async () => ({ completeSimple }) as unknown as PiModels,
      (id) => ({ id }) as never,
      [0, 0],
    );
    return { complete, completeSimple };
  };

  it("is tried again, and what the dropped tries used still counts", async () => {
    const { complete, completeSimple } = bridge([
      reply("error", "Connection error."),
      new Error("fetch failed"),
      reply("toolUse"),
    ]);
    const answer = await complete(request());
    expect(completeSimple).toHaveBeenCalledTimes(3);
    expect(answer.answers).toEqual([{ page: 3 }]);
    expect(answer.error).toBeUndefined();
    expect(answer.usage).toEqual({ input: 14, output: 6 });
  });

  it("fails the step after a few tries, with the provider's words for the record", async () => {
    const { complete, completeSimple } = bridge([
      reply("error", "Connection error."),
      reply("error", "Connection error."),
      reply("error", "Connection error."),
    ]);
    const answer = await complete(request());
    expect(completeSimple).toHaveBeenCalledTimes(3);
    expect(answer).toMatchObject({ stopReason: "error", error: "Connection error." });
  });

  it("is not tried again when the plan's limit is reached, the answer is bad, or the student stopped", async () => {
    for (const first of [
      reply("error", "usage_limit_reached: try again later"),
      reply("error", "Invalid schema for function"),
      reply("length"),
    ]) {
      const { complete, completeSimple } = bridge([first, reply("toolUse")]);
      await complete(request());
      expect(completeSimple).toHaveBeenCalledTimes(1);
    }
    const stopped = new AbortController();
    stopped.abort();
    const { complete, completeSimple } = bridge([
      reply("error", "Connection error."),
      reply("toolUse"),
    ]);
    expect(await complete(request(stopped.signal))).toMatchObject({ error: "Connection error." });
    expect(completeSimple).toHaveBeenCalledTimes(1);
    const thrown = bridge([new Error("401 Unauthorized"), reply("toolUse")]);
    await expect(thrown.complete(request())).rejects.toThrow("401");
  });
});
