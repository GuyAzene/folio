import { describe, expect, it } from "vite-plus/test";
import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createDemoAgent, DEFAULT_MODEL } from "../src/agents.ts";

const catalog = createModels();
catalog.setProvider(openaiProvider());
const model = catalog.getModel("openai", DEFAULT_MODEL)!;

function message(
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

function completed(result: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: result });
  const text = result.content.find((block) => block.type === "text");
  if (text?.type === "text")
    stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: result });
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    stream.push({ type: "error", reason: result.stopReason, error: result });
  } else {
    stream.push({
      type: "done",
      reason: result.stopReason === "toolUse" ? "toolUse" : "stop",
      message: result,
    });
  }
  return stream;
}

describe("Pi agent integration (synthetic provider, no network)", () => {
  it("executes the scoped tool, streams its reply, and retains native history on the next prompt", async () => {
    const requests: TranscriptContext[] = [];
    const signature = "synthetic-provider-signature";
    const toolCall = message(
      [
        { type: "thinking", thinking: "Need the scoped page", thinkingSignature: signature },
        {
          type: "toolCall",
          id: "read-1",
          name: "read_demo_page",
          arguments: { courseId: "demo", page: 1 },
        },
      ],
      "toolUse",
    );
    const streamFn: StreamFn = (_model, context) => {
      requests.push(structuredClone(context));
      return completed(
        requests.length === 1
          ? toolCall
          : message([{ type: "text", text: "See demo:synthetic-graph-lecture#page=1." }]),
      );
    };
    const agent = createDemoAgent(model, streamFn);
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });
    await agent.prompt("Explain demo page 1.");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.some((item) => item.role === "toolResult" && !item.isError)).toBe(
      true,
    );
    expect(
      events.some(
        (event) =>
          event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
      ),
    ).toBe(true);
    expect(agent.state.isStreaming).toBe(false);
    await agent.prompt("What about a path of length zero?");
    const nativeMessage = requests[2]!.messages.find((item) => item.role === "assistant");
    expect(nativeMessage?.role === "assistant" && nativeMessage.content[0]).toEqual(
      toolCall.content[0],
    );
    expect(agent.state.messages.filter((item) => item.role === "user")).toHaveLength(2);
    agent.reset();
    expect(agent.state.messages.filter((item) => item.role !== "system")).toHaveLength(0);
    expect(agent.state.tools.map((tool) => tool.name)).toEqual(["read_demo_page"]);
  });

  it("returns an error tool result for an out-of-scope read inside the actual agent loop", async () => {
    let calls = 0;
    const agent = createDemoAgent(model, () =>
      completed(
        ++calls === 1
          ? message(
              [
                {
                  type: "toolCall",
                  id: "forbidden",
                  name: "read_demo_page",
                  arguments: { courseId: "private", page: 1 },
                },
              ],
              "toolUse",
            )
          : message([{ type: "text", text: "That course is unavailable." }]),
      ),
    );
    await agent.prompt("Read private material.");
    const result = agent.state.messages.find((item) => item.role === "toolResult");
    expect(result?.role === "toolResult" && result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Source scope denied");
  });

  it("cancels an active stream, settles, and accepts another prompt", async () => {
    let calls = 0;
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const agent = createDemoAgent(model, (_model, _context, options) => {
      if (++calls > 1) return completed(message([{ type: "text", text: "Continued." }]));
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message([]) });
      const abort = () =>
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...message([], "aborted"), errorMessage: "Cancelled" },
        });
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted) abort();
      started();
      return stream;
    });
    const run = agent.prompt("Start a reply.");
    await active;
    agent.abort();
    await run;
    await agent.waitForIdle();
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.pendingToolCalls.size).toBe(0);
    await agent.prompt("Try again.");
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("keeps provider failure visible and does not claim a successful reply", async () => {
    const agent = createDemoAgent(model, () =>
      completed({ ...message([], "error"), errorMessage: "Synthetic access denied" }),
    );
    await agent.prompt("Hello");
    expect(agent.state.errorMessage).toBe("Synthetic access denied");
    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "error" });
  });
});
