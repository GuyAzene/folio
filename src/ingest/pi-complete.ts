import type { Api, AssistantMessage, Context, Model, ToolChoice } from "@earendil-works/pi-ai";
import type { CompleteFn } from "./models.ts";

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

/**
 * Sends ingestion requests through Pi with the student's own sign-in. Each request is stateless
 * and carries its page images inline, which the ChatGPT plan route requires. An expected answer
 * becomes a strict tool the model must call: the provider constrains its arguments to the
 * schema while they are written (verified on the ChatGPT plan, 2026-10-28).
 */
export function piComplete(
  models: () => Promise<PiModels>,
  resolveModel: (id: string) => Model<Api>,
): CompleteFn {
  return async (request) => {
    const reply = await (
      await models()
    ).completeSimple(
      resolveModel(request.model),
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
        reasoning: request.reasoning,
        signal: request.signal,
        // Pi's type lists "auto" and "none"; the Responses API also takes "required", which
        // makes calling the tool mandatory (verified on the ChatGPT plan).
        ...(request.answer ? { toolChoice: "required" as ToolChoice } : {}),
      },
    );
    const calls = reply.content.filter(
      (block) => block.type === "toolCall" && block.name === request.answer?.name,
    );
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
      usage: { input: reply.usage.input, output: reply.usage.output },
      error: reply.errorMessage,
      answers: calls.flatMap((block) =>
        // A call whose arguments were not valid JSON comes back as {}; its text is in the error.
        block.type === "toolCall" && !block.argumentsError ? [block.arguments] : [],
      ),
    };
  };
}
