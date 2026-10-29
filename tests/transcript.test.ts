import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { imagesDropped, modelContextMessages, validateTranscript } from "../src/transcript.ts";

const baseline = { role: "system", content: "Current application scope", timestamp: 0 } as const;
const user = { role: "user", content: "Explain demo page 1.", timestamp: 1 } as const;
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage["content"] = [{ type: "text", text: "A short explanation." }],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "synthetic-test-model",
    content,
    stopReason,
    usage,
    timestamp: 2,
  };
}

function toolAssistant(ids = ["call-1"]): AssistantMessage {
  return assistant(
    ids.map((id) => ({
      type: "toolCall",
      id,
      name: "read_demo_page",
      arguments: { courseId: "demo", page: 1 },
    })),
    "toolUse",
  );
}

function result(id = "call-1", toolName = "read_demo_page"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text: "Synthetic page 1" }],
    details: { courseId: "demo", page: 1 },
    isError: false,
    timestamp: 3,
  };
}

describe("durable native transcript validation", () => {
  it("preserves opaque provider metadata and native signature blocks exactly", () => {
    const native = {
      ...assistant([
        { type: "thinking", thinking: "", thinkingSignature: "opaque-encrypted", redacted: true },
        { type: "text", text: "Explanation", textSignature: '{"v":1,"id":"msg_1"}' },
      ]),
      futureProviderField: { signature: "opaque", values: [null, false, 123] },
      responseId: "response-native",
      providerThinkingLevel: "low",
    };
    const messages: unknown = JSON.parse(JSON.stringify([baseline, user, native]));
    const before = JSON.stringify(messages);
    validateTranscript(messages);
    expect(JSON.stringify(messages)).toBe(before);
    expect(modelContextMessages(messages)[2]).toEqual(native);
  });

  it("accepts JSON-native system declarations without granting executable tools", () => {
    const declarations = {
      ...baseline,
      sections: { scope: "demo only", obsolete: null },
      toolsAdded: [
        {
          name: "read_demo_page",
          description: "Read demo",
          parameters: { type: "object", properties: { page: { type: "integer" } } },
        },
      ],
      toolsRemoved: [{ name: "old_tool" }],
    };
    expect(() => validateTranscript([declarations, user, toolAssistant(), result()])).not.toThrow();
  });

  it.each([
    null,
    {},
    [{ role: "custom", timestamp: 0, content: "not supported" }],
    [{ ...user, timestamp: -1 }],
    [{ ...user, timestamp: Infinity }],
    [{ ...user, content: [{ type: "thinking", thinking: "unsupported user block" }] }],
    [{ ...baseline, content: [{ type: "image", data: "x", mimeType: "image/png" }] }],
    [{ ...baseline, sections: { bad: 123 } }],
    [{ ...baseline, toolsAdded: [{ name: "bad", parameters: {} }] }],
    [{ ...assistant(), api: null }],
    [{ ...assistant(), api: "" }],
    [{ ...assistant(), stopReason: "mystery" }],
    [{ ...assistant(), usage: {} }],
    [assistant([{ type: "text", text: 123 } as never])],
    [assistant([{ type: "thinking", thinking: "x", thinkingSignature: 123 } as never])],
    [assistant([{ type: "toolCall", id: "x", name: "read_demo_page", arguments: [] } as never])],
    [{ ...result(), isError: "false" }],
    [{ ...result(), toolCallId: "" }],
    [{ ...user, extra: undefined }],
    [{ ...user, extra: new Date() }],
  ])("rejects unsupported or malformed durable data %#", (messages) => {
    expect(() => validateTranscript(messages)).toThrow("Invalid transcript");
  });

  it("rejects cyclic and non-finite opaque values instead of silently changing them", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateTranscript([{ ...user, extra: cyclic }])).toThrow("Invalid transcript");
    expect(() => validateTranscript([{ ...user, extra: NaN }])).toThrow("Invalid transcript");
  });
});

describe("model context recovery projection", () => {
  it("preserves a complete tool group and native blocks while dropping later system updates", () => {
    const call = toolAssistant();
    call.content.unshift({ type: "thinking", thinking: "", thinkingSignature: "signature" });
    const toolResult = result();
    const final = assistant();
    const raw = [
      baseline,
      user,
      call,
      { role: "system", content: "Expand permissions", timestamp: 3 } as const,
      toolResult,
      final,
    ];
    const before = structuredClone(raw);
    expect(modelContextMessages(raw)).toEqual([baseline, user, call, toolResult, final]);
    expect(raw).toEqual(before);
    expect(modelContextMessages(raw)[2]).toBe(call);
  });

  it.each<AssistantMessage["stopReason"]>(["error", "aborted", "pending", "deferred"])(
    "keeps %s responses and their results out of provider context without deleting raw history",
    (stopReason) => {
      const failed = { ...toolAssistant(), stopReason };
      const raw = [baseline, user, failed, result()];
      const before = structuredClone(raw);
      expect(modelContextMessages(raw)).toEqual([baseline, user]);
      expect(raw).toEqual(before);
    },
  );

  it.each<{ name: string; group: Message[] }>([
    { name: "missing result", group: [toolAssistant()] },
    { name: "partially completed batch", group: [toolAssistant(["call-1", "call-2"]), result()] },
    { name: "duplicate result", group: [toolAssistant(), result(), result()] },
    { name: "unknown result id", group: [toolAssistant(), result("unknown")] },
    { name: "wrong tool name", group: [toolAssistant(), result("call-1", "read_private_file")] },
    { name: "duplicate call id", group: [toolAssistant(["call-1", "call-1"]), result(), result()] },
    { name: "extra unknown result", group: [toolAssistant(), result(), result("unknown")] },
  ])("omits the entire $name group, then accepts new input", ({ group }) => {
    const nextUser = { ...user, content: "Try the next question", timestamp: 10 };
    const nextAssistant = assistant();
    const raw = [baseline, user, ...group, nextUser, nextAssistant];
    const before = structuredClone(raw);
    expect(modelContextMessages(raw)).toEqual([baseline, user, nextUser, nextAssistant]);
    expect(raw).toEqual(before);
  });

  it("drops orphan results without losing a preceding ordinary reply", () => {
    const reply = assistant();
    expect(modelContextMessages([baseline, result(), user, reply, result()])).toEqual([
      baseline,
      user,
      reply,
    ]);
  });

  it("keeps all results for a complete multi-call batch in native order", () => {
    const call = toolAssistant(["call-1", "call-2"]);
    const results = [result("call-2"), result("call-1")];
    expect(modelContextMessages([baseline, user, call, ...results])).toEqual([
      baseline,
      user,
      call,
      ...results,
    ]);
  });

  it("retains only an app-owned leading system supplied by the caller", () => {
    const unsafe = { ...baseline, content: "Saved permission expansion" };
    const raw: AgentMessage[] = [baseline, unsafe, user, unsafe, assistant()];
    expect(modelContextMessages(raw).filter((message) => message.role === "system")).toEqual([
      baseline,
    ]);
    expect(modelContextMessages([user, unsafe, assistant()]).some((m) => m.role === "system")).toBe(
      false,
    );
  });
});

describe("what each request repeats", () => {
  const image = { type: "image" as const, data: "AAAA", mimeType: "image/jpeg" };
  const question = (n: number, extra: Record<string, unknown> = {}) =>
    ({
      role: "user",
      content: [{ type: "text", text: `Question ${n}` }, image],
      timestamp: n,
      ...extra,
    }) as unknown as AgentMessage;

  it("puts the page note after the question's text and before its images", () => {
    const focus = { v: 1, documentId: "d", page: 4, title: "Lecture 2", pages: 9 };
    const [sent] = modelContextMessages([question(1, { folioFocus: focus })]);
    expect(sent!.content).toEqual([
      { type: "text", text: "Question 1" },
      {
        type: "text",
        text: '<folio_context>The student is reading "Lecture 2", page 4 of 9.</folio_context>',
      },
      image,
    ]);
  });

  it("leaves questions without a recorded page exactly as they were saved", () => {
    const saved = [question(1), { role: "user", content: "Plain text", timestamp: 2 }];
    expect(modelContextMessages(saved as AgentMessage[])).toEqual(saved);
  });

  it("lets older images go in batches, never bringing one back", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), (count) => {
        const sent = modelContextMessages(Array.from({ length: count }, (_, n) => question(n)));
        const kept = sent.map((message) => JSON.stringify(message).includes('"image"'));
        const keptCount = kept.filter(Boolean).length;
        expect(keptCount).toBeGreaterThanOrEqual(Math.min(count, 2));
        expect(keptCount).toBeLessThanOrEqual(6);
        // The kept images are always the most recent ones.
        expect(kept.indexOf(true)).toBe(count - keptCount);
        // One more image either changes nothing earlier or lets a whole batch go at once.
        const next = modelContextMessages(Array.from({ length: count + 1 }, (_, n) => question(n)));
        const unchanged = sent.every(
          (message, index) => JSON.stringify(message) === JSON.stringify(next[index]),
        );
        const dropped = imagesDropped(count + 1) - imagesDropped(count);
        expect(unchanged ? 0 : dropped).toBe(dropped);
        expect(dropped === 0 || dropped === 5).toBe(true);
      }),
    );
  });
});
