import type { Api, AssistantMessage, Context, Model, ToolChoice } from "@earendil-works/pi-ai";
import { DROPPED } from "../dropped.ts";
import type { CompleteFn, ModelReply, ModelRequest } from "./models.ts";

/** What the adapter needs from Pi: one stateless completion per request. */
export interface PiModels {
  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: {
      maxTokens?: number;
      reasoning?: "low" | "medium" | "high";
      signal?: AbortSignal;
      toolChoice?: ToolChoice;
    },
  ): Promise<AssistantMessage>;
}

/** How long to wait before sending a dropped request again: one entry per extra try. */
const RETRY_AFTER = [2_000, 8_000];

/**
 * Sends ingestion requests through Pi with the student's own sign-in. Each request is stateless
 * and carries its page images inline, which the ChatGPT plan route requires. An expected answer
 * becomes a strict tool the model must call: the provider constrains its arguments to the
 * schema while they are written (verified on the ChatGPT plan, 2026-10-28).
 *
 * A request whose connection drops is sent again, a couple of times, before the step fails:
 * Pi retries a request that fails before its answer starts, but not one cut off on the way.
 * Requests are stateless, so sending one again is safe; what the dropped tries used still counts.
 */
export function piComplete(
  models: () => Promise<PiModels>,
  resolveModel: (id: string) => Model<Api>,
  retryAfter: readonly number[] = RETRY_AFTER,
): CompleteFn {
  function send(request: ModelRequest): Promise<AssistantMessage> {
    const model = resolveModel(request.model);
    const forced = request.answer ? forcedTool(model) : undefined;
    return models().then((pi) =>
      pi.completeSimple(
        model,
        {
          systemPrompt: request.system,
          messages: [{ role: "user", content: request.content, timestamp: Date.now() }],
          ...(request.answer
            ? {
                tools: [
                  {
                    name: request.answer.name,
                    description: request.answer.description,
                    parameters: request.answer.schema,
                    // "prefer": strict where the provider supports it, a plain tool elsewhere.
                    constrainedSampling: { type: "json_schema", strict: "prefer" },
                  },
                ],
              }
            : {}),
        },
        {
          maxTokens: request.maxTokens,
          reasoning: forced?.thinks === false ? undefined : request.reasoning,
          signal: request.signal,
          ...(forced ? { toolChoice: forced.choice } : {}),
        },
      ),
    );
  }

  return async (request) => {
    const used = { input: 0, output: 0 };
    for (let tries = 0; ; tries++) {
      const wait = request.signal?.aborted ? undefined : retryAfter[tries];
      let reply: AssistantMessage;
      try {
        reply = await send(request);
      } catch (error) {
        // A connection can also drop before Pi has a reply to report it in.
        if (wait === undefined || !(error instanceof Error) || !DROPPED.test(error.message))
          throw error;
        await pause(wait, request.signal);
        continue;
      }
      used.input += reply.usage.input;
      used.output += reply.usage.output;
      const dropped = reply.stopReason === "error" && DROPPED.test(reply.errorMessage ?? "");
      if (!dropped || wait === undefined) return answerOf(reply, used, request.answer?.name);
      await pause(wait, request.signal);
      if (request.signal?.aborted) return answerOf(reply, used, request.answer?.name);
    }
  };
}

/**
 * How each API makes calling the answer tool mandatory. Pi's type lists "auto" and "none"; the
 * Responses and Chat Completions APIs also take "required" (verified on the ChatGPT plan), and
 * Anthropic and Gemini call it "any". Anthropic refuses a forced tool while the model thinks, so
 * those requests go without thinking.
 */
export function forcedTool(model: Model<Api>): { choice: ToolChoice; thinks: boolean } {
  if (model.api === "anthropic-messages") return { choice: "any" as ToolChoice, thinks: false };
  if (model.api === "google-generative-ai") return { choice: "any" as ToolChoice, thinks: true };
  return { choice: "required" as ToolChoice, thinks: true };
}

function answerOf(
  reply: AssistantMessage,
  used: { input: number; output: number },
  answer: string | undefined,
): ModelReply {
  const calls = reply.content.filter((block) => block.type === "toolCall" && block.name === answer);
  return {
    // Arguments Pi could not read as JSON stay in the text, so the repair fallback can try.
    text: reply.content
      .map((block) =>
        block.type === "text"
          ? block.text
          : block.type === "toolCall" && block.argumentsError
            ? `\n${block.argumentsError}\n`
            : "",
      )
      .join(""),
    stopReason: reply.stopReason,
    usage: used,
    error: reply.errorMessage,
    answers: calls.flatMap((block) =>
      // A call whose arguments were not valid JSON comes back as {}; its text is in the error.
      block.type === "toolCall" && !block.argumentsError ? [block.arguments] : [],
    ),
  };
}

/** Waits, or stops waiting as soon as the request is cancelled. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
}
