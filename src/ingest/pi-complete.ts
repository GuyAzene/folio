import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ThinkingLevel,
  ToolChoice,
} from "@earendil-works/pi-ai";
import { DROPPED } from "../dropped.ts";
import type { CompleteFn, ModelReply, ModelRequest } from "./models.ts";

/** What the adapter needs from Pi: one stateless completion per request. */
export interface PiModels {
  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: {
      maxTokens?: number;
      reasoning?: ThinkingLevel;
      signal?: AbortSignal;
      toolChoice?: ToolChoice;
      sessionId?: string;
    },
  ): Promise<AssistantMessage>;
}

/** How long to wait before sending a dropped request again: one entry per extra try. */
const RETRY_AFTER = [2_000, 8_000];

/** How long to wait when the provider turns a request away for a moment (a 429). */
const BUSY_AFTER = [10_000, 30_000, 60_000];

/**
 * A rate limit that passes within a minute, unlike the plan's usage limit, which pauses the job.
 * Pi words every 429 as "You have hit your ChatGPT usage limit", adding when it resets if the
 * provider said; a reset under a minute away is the short kind.
 */
function busy(problem: string): boolean {
  if (/try again in ~[01] min/i.test(problem)) return true;
  return (
    /rate[_ ]limit|too many requests|\b429\b/i.test(problem) &&
    !/usage[_ ]limit|quota/i.test(problem)
  );
}

/**
 * Sends ingestion requests through Pi with the student's own sign-in. Each request is stateless
 * and carries its page images inline, which the ChatGPT plan route requires. An expected answer
 * becomes a strict tool the model must call: the provider constrains its arguments to the
 * schema while they are written (verified on the ChatGPT plan, 2026-10-28).
 *
 * A request whose connection drops is sent again, a couple of times, before the step fails:
 * Pi retries a request that fails before its answer starts, but not one cut off on the way.
 * A request turned away by a short rate limit waits and is sent again too. Requests are
 * stateless, so sending one again is safe; what the earlier tries used still counts.
 *
 * Every request about one document carries that document's cache key, which Pi sends as
 * `prompt_cache_key`, so the provider can reuse the instructions and pages they share.
 */
export function piComplete(
  models: () => Promise<PiModels>,
  resolveModel: (id: string) => Model<Api>,
  retryAfter: readonly number[] = RETRY_AFTER,
  busyAfter: readonly number[] = BUSY_AFTER,
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
          sessionId: request.cacheKey,
          ...(forced ? { toolChoice: forced.choice } : {}),
        },
      ),
    );
  }

  return async (request) => {
    const used = { input: 0, output: 0, cached: 0 };
    const tries = { dropped: 0, busy: 0 };
    for (;;) {
      let reply: AssistantMessage | undefined;
      let thrown: unknown;
      let problem: string;
      try {
        reply = await send(request);
        used.input += reply.usage.input;
        used.output += reply.usage.output;
        used.cached += reply.usage.cacheRead ?? 0;
        if (reply.stopReason !== "error") return answerOf(reply, used, request.answer?.name);
        problem = reply.errorMessage ?? "";
      } catch (error) {
        // A connection can also drop before Pi has a reply to report it in.
        if (!(error instanceof Error)) throw error;
        thrown = error;
        problem = error.message;
      }
      const kind = DROPPED.test(problem) ? "dropped" : busy(problem) ? "busy" : undefined;
      const wait =
        kind && !request.signal?.aborted
          ? (kind === "dropped" ? retryAfter : busyAfter)[tries[kind]++]
          : undefined;
      if (wait !== undefined) await pause(wait, request.signal);
      if (wait === undefined || request.signal?.aborted) {
        if (reply) return answerOf(reply, used, request.answer?.name);
        throw thrown;
      }
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
  used: ModelReply["usage"],
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
