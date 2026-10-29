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
