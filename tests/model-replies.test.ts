import { describe, expect, it, vi } from "vite-plus/test";
import { Type } from "typebox";
import { jsonCall, jsonObjects, type ModelReply, type ModelRequest } from "../src/ingest/models.ts";

const schema = Type.Object({ pages: Type.Array(Type.Object({ page: Type.Integer() })) });
const request = { model: "m", system: "s", content: [], maxTokens: 10 };
const replying = (...texts: string[]) => {
  const replies = texts.map((text): ModelReply => ({
    text,
    stopReason: "stop",
    usage: { input: 1, output: 1 },
  }));
  return vi.fn(async () => replies.shift()!);
};

describe("model replies", () => {
  it("asks for a strict submit call and takes its arguments", async () => {
    const complete = vi.fn(async (_request: ModelRequest): Promise<ModelReply> => ({
      text: "",
      stopReason: "toolUse",
      usage: { input: 1, output: 1 },
      answers: [{ pages: [{ page: 3 }] }],
    }));
    await expect(jsonCall(complete, request, schema, () => {})).resolves.toEqual({
      pages: [{ page: 3 }],
    });
    expect(complete.mock.calls[0]![0].answer?.name).toBe("submit");
  });

  it("re-asks with the exact field and value that were wrong, and keeps the rejected reply", async () => {
    const answers = [[{ pages: [{ page: "three" }] }], [{ pages: [{ page: 3 }] }]];
    const complete = vi.fn(async (_request: ModelRequest): Promise<ModelReply> => ({
      text: "",
      stopReason: "toolUse",
      usage: { input: 1, output: 1 },
      answers: answers.shift(),
    }));
    const rejected: { attempt: number; problem: string; reply: string }[] = [];
    await expect(
      jsonCall(
        complete,
        request,
        schema,
        () => {},
        undefined,
        (item) => rejected.push(item),
      ),
    ).resolves.toEqual({ pages: [{ page: 3 }] });
    expect(rejected).toEqual([
      {
        attempt: 1,
        problem: expect.stringMatching(/^at \/pages\/0\/page .*\(it held "three"\)$/),
        reply: '[{"pages":[{"page":"three"}]}]',
      },
    ]);
    const retry = complete.mock.calls[1]![0].content.at(-1);
    expect(retry?.type === "text" && retry.text).toContain("at /pages/0/page");
    expect(retry?.type === "text" && retry.text).toContain('it held "three"');
  });

  it("repairs a text reply that is not quite JSON instead of asking again", async () => {
    const complete = replying("```json\n{pages: [{page: 1,},],}\n```");
    await expect(jsonCall(complete, request, schema, () => {})).resolves.toEqual({
      pages: [{ page: 1 }],
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("finds complete objects, respecting strings and escapes", () => {
    expect(jsonObjects('{"a":"x}y","b":"q\\"}"}}')).toEqual(['{"a":"x}y","b":"q\\"}"}']);
    expect(jsonObjects('Here: {"a":1} and {"b":{"c":2}} done {')).toEqual([
      '{"a":1}',
      '{"b":{"c":2}}',
    ]);
  });

  it("accepts a reply with a stray closing brace or a remark after the JSON", async () => {
    for (const text of [
      '{"pages":[{"page":1}]}}',
      '{"pages":[{"page":1}]}\n\nNote: the set {a, b} is shown on the slide.',
      '```json\n{"pages":[{"page":1}]}\n```',
    ]) {
      const complete = replying(text);
      await expect(jsonCall(complete, request, schema, () => {})).resolves.toEqual({
        pages: [{ page: 1 }],
      });
      expect(complete).toHaveBeenCalledTimes(1);
    }
  });

  it("combines a reply split into several objects when the step can merge them", async () => {
    const text = '{"pages":[{"page":1}]}\n{"pages":[{"page":2}]}';
    const merge = (parts: { pages: { page: number }[] }[]) => ({
      pages: parts.flatMap((part) => part.pages),
    });
    await expect(jsonCall(replying(text), request, schema, () => {}, merge)).resolves.toEqual({
      pages: [{ page: 1 }, { page: 2 }],
    });
    await expect(jsonCall(replying(text), request, schema, () => {})).resolves.toEqual({
      pages: [{ page: 1 }],
    });
  });

  it("still retries once, then fails, when nothing in the reply matches", async () => {
    const complete = replying('{"pages":"none"}', "no json here");
    await expect(jsonCall(complete, request, schema, () => {})).rejects.toThrow(
      "did not match the required format: no JSON object found",
    );
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
