import type { ImageContent, TextContent, ThinkingLevel } from "@earendil-works/pi-ai";
import { jsonrepair } from "jsonrepair";
import type { TSchema } from "typebox";
import Value from "typebox/value";

/** One request to a model on behalf of an ingestion step. */
export interface ModelRequest {
  model: string;
  system: string;
  content: (TextContent | ImageContent)[];
  maxTokens: number;
  /** How hard the model thinks, up to Pi's xhigh and max; the ChatGPT plan accepts all of them. */
  reasoning?: ThinkingLevel;
  signal?: AbortSignal;
  /** Shared by every request about one document, so the provider can reuse their common prefix. */
  cacheKey?: string;
  /**
   * The answer must arrive as a call to this tool, whose arguments the provider constrains to the
   * schema while the model writes them, so a malformed answer cannot be produced.
   */
  answer?: { name: string; description: string; schema: TSchema };
}

export interface ModelReply {
  text: string;
  /** Pi's stop reason: "stop" or "toolUse"; anything else means the reply is incomplete. */
  stopReason: string;
  /** `cached`: prompt tokens the provider served from its prompt cache, on top of `input`. */
  usage: { input: number; output: number; cached?: number };
  error?: string;
  /** The arguments of each call to the answer tool, in order. */
  answers?: unknown[];
}

/** Sends one request; the app wires it to Pi and the student's subscription, tests to a fake. */
export type CompleteFn = (request: ModelRequest) => Promise<ModelReply>;

export class ModelStepError extends Error {
  /**
   * "limit": the plan's usage limit; the job should pause rather than fail. "stopped": the
   * request was called off, by a pause or because another part of the document failed.
   */
  readonly kind: "truncated" | "invalid" | "limit" | "provider" | "stopped";

  constructor(message: string, kind: ModelStepError["kind"] = "provider") {
    super(message);
    this.kind = kind;
  }
}

export function text(value: string): TextContent {
  return { type: "text", text: value };
}

export function png(data: Uint8Array): ImageContent {
  return { type: "image", data: Buffer.from(data).toString("base64"), mimeType: "image/png" };
}

const LIMIT = /usage[_ ]limit|rate[_ ]limit|quota|429|too many requests/i;

/** A reply that was not used, kept so a failure can be inspected rather than guessed at. */
export interface RejectedReply {
  attempt: number;
  problem: string;
  reply: string;
}

/**
 * Asks for a result matching `schema`. The answer comes as a strict tool call, which the provider
 * holds to the schema as it is written; a text reply is still accepted as a fallback, with the
 * JSON found in it and repaired where possible. A cut-off reply fails the step (never accepted as
 * complete); an unusable one is rejected, kept through `onReject`, and asked for again once with
 * the exact field that was wrong. Usage of every attempt is reported. A result split into several
 * parts is combined with `merge` when the step can do that.
 */
export async function jsonCall<T>(
  complete: CompleteFn,
  request: ModelRequest,
  schema: TSchema,
  onUsage: (usage: ModelReply["usage"]) => void,
  merge?: (parts: T[]) => T,
  onReject?: (rejected: RejectedReply) => void,
): Promise<T> {
  const answer = {
    name: ANSWER_TOOL,
    description: "Submit the complete result. Its arguments are the JSON object asked for.",
    schema,
  };
  const system = `${request.system}\n\nGive the result as the arguments of one call to the ${ANSWER_TOOL} tool.`;
  let content = request.content;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await complete({ ...request, system, content, answer });
    onUsage(reply.usage);
    if (reply.stopReason === "aborted") throw new ModelStepError("Stopped.", "stopped");
    if (reply.stopReason === "error" || reply.error) {
      const message = reply.error ?? "The model request failed.";
      throw new ModelStepError(message, LIMIT.test(message) ? "limit" : "provider");
    }
    if (reply.stopReason !== "stop" && reply.stopReason !== "toolUse")
      throw new ModelStepError(
        `The reply was cut off (${reply.stopReason}); it was not accepted.`,
        "truncated",
      );
    const { values, problem } = reply.answers?.length
      ? checkValues(reply.answers, schema)
      : parseReply(reply.text, schema);
    if (values.length) return (values.length > 1 && merge ? merge(values as T[]) : values[0]) as T;
    onReject?.({
      attempt,
      problem,
      reply: reply.answers?.length ? JSON.stringify(reply.answers) : reply.text,
    });
    if (attempt === 2)
      throw new ModelStepError(
        `The reply did not match the required format: ${problem}`,
        "invalid",
      );
    content = [
      ...request.content,
      text(
        `Your previous answer could not be used: ${problem}. Send the complete answer again, with that fixed, as one ${ANSWER_TOOL} call.`,
      ),
    ];
  }
  throw new ModelStepError("Unreachable.", "invalid");
}

const ANSWER_TOOL = "submit";

/** Tool-call arguments that match the schema, or the first reason one did not. */
function checkValues(answers: unknown[], schema: TSchema): { values: unknown[]; problem: string } {
  const values: unknown[] = [];
  let problem = "";
  for (const value of answers) {
    const error = firstError(schema, value);
    if (error) problem ||= error;
    else values.push(value);
  }
  return { values, problem: problem || "the answer was empty" };
}

/** The reply's JSON objects that match the schema, or why none did. */
function parseReply(raw: string, schema: TSchema): { values: unknown[]; problem: string } {
  const values: unknown[] = [];
  let problem = "";
  for (const candidate of jsonObjects(raw)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch (error) {
      problem ||= `invalid JSON: ${(error as Error).message}`;
      continue;
    }
    const error = firstError(schema, value);
    if (error) problem ||= error;
    else values.push(value);
  }
  if (!values.length) {
    // Last resort: repair what is there (missing quotes, trailing commas, code fences…).
    try {
      const repaired: unknown = JSON.parse(jsonrepair(raw));
      if (!firstError(schema, repaired)) values.push(repaired);
    } catch {
      // Not repairable; the problem found above stands.
    }
  }
  return { values, problem: problem || "no JSON object found" };
}

/**
 * Every complete top-level JSON object in a reply, in order, read with strings and escapes
 * respected: a stray closing brace or a remark after the object no longer spoils it.
 */
export function jsonObjects(raw: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = depth > 0;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth++;
    } else if (character === "}" && depth > 0) {
      depth--;
      if (depth === 0) objects.push(raw.slice(start, index + 1));
    }
  }
  return objects;
}

/** The first place the value breaks the schema, with what it held there. */
function firstError(schema: TSchema, value: unknown): string | null {
  if (Value.Check(schema, value)) return null;
  const [error] = [...Value.Errors(schema, value)];
  if (!error) return "it does not match the required format";
  const path = error.instancePath || "/";
  const found = pointer(value, error.instancePath);
  const shown = found === undefined ? "nothing" : JSON.stringify(found);
  return `at ${path} ${error.message} (it held ${shown.length > 80 ? `${shown.slice(0, 77)}…` : shown})`;
}

function pointer(value: unknown, path: string): unknown {
  let at = value;
  for (const part of path.split("/").slice(1)) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return at;
}
