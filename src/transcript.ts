import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

type JsonRecord = Record<string, unknown>;
const stopReasons = new Set([
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
]);
const excludedStops = new Set(["pending", "error", "aborted", "deferred"]);

function invalid(reason: string): never {
  throw new Error(`Invalid transcript: ${reason}.`);
}

function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

// Durable records are JSON, not serialized Agent instances. Unknown JSON fields
// remain intact so provider signatures and release-specific metadata survive.
function validateJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 128) invalid("JSON nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !isRecord(value)) invalid("expected JSON values");
  if (ancestors.has(value)) invalid("cyclic JSON");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) validateJson(entry, ancestors, depth + 1);
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalid("symbol JSON property");
      validateJson(value[key], ancestors, depth + 1);
    }
  }
  ancestors.delete(value);
}

function requireString(value: unknown, label: string, nonempty = false): void {
  if (typeof value !== "string" || (nonempty && value.length === 0)) invalid(label);
}

function requireNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(label);
}

function optionalString(record: JsonRecord, key: string): void {
  if (Object.hasOwn(record, key)) requireString(record[key], key);
}

function validateUsage(value: unknown): void {
  if (!isRecord(value)) invalid("usage object");
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    requireNumber(value[key], `usage.${key}`);
  }
  for (const key of ["cacheWrite1h", "reasoning"]) {
    if (Object.hasOwn(value, key)) requireNumber(value[key], `usage.${key}`);
  }
  if (!isRecord(value.cost)) invalid("usage.cost object");
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
    requireNumber(value.cost[key], `usage.cost.${key}`);
  }
}

function validateContent(content: unknown, allowed: ReadonlySet<string>): void {
  if (!Array.isArray(content)) invalid("content array");
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string" || !allowed.has(block.type)) {
      invalid("content block type");
    }
    if (block.type === "text") {
      requireString(block.text, "text block");
      optionalString(block, "textSignature");
    } else if (block.type === "image") {
      requireString(block.data, "image data");
      requireString(block.mimeType, "image mimeType", true);
    } else if (block.type === "thinking") {
      requireString(block.thinking, "thinking block");
      optionalString(block, "thinkingSignature");
      if (Object.hasOwn(block, "redacted") && typeof block.redacted !== "boolean") {
        invalid("thinking.redacted boolean");
      }
    } else if (block.type === "toolCall") {
      requireString(block.id, "tool call id", true);
      requireString(block.name, "tool call name", true);
      if (!isRecord(block.arguments)) invalid("tool call arguments object");
      for (const key of ["thoughtSignature", "namespace", "argumentsError"]) {
        optionalString(block, key);
      }
    }
  }
}

const textBlocks = new Set(["text"]);
const inputBlocks = new Set(["text", "image"]);
const assistantBlocks = new Set(["text", "thinking", "toolCall"]);

/** Validate parsed JSON without normalizing or removing native provider fields. */
export function validateTranscript(messages: unknown): asserts messages is AgentMessage[] {
  if (!Array.isArray(messages)) invalid("messages array");
  validateJson(messages);
  for (const message of messages) {
    if (!isRecord(message)) invalid("message object");
    requireNumber(message.timestamp, "message timestamp");
    if (message.role === "system" || message.role === "user") {
      if (typeof message.content !== "string") {
        validateContent(message.content, message.role === "system" ? textBlocks : inputBlocks);
      }
      if (message.role === "system") {
        if (Object.hasOwn(message, "sections")) {
          if (!isRecord(message.sections)) invalid("system sections object");
          for (const value of Object.values(message.sections)) {
            if (value !== null && typeof value !== "string") invalid("system section value");
          }
        }
        for (const key of ["toolsAdded", "toolsRemoved"]) {
          if (!Object.hasOwn(message, key)) continue;
          if (!Array.isArray(message[key])) invalid(`system ${key} array`);
          for (const tool of message[key]) {
            if (!isRecord(tool)) invalid("system tool declaration");
            requireString(tool.name, "system tool name", true);
            if (key === "toolsAdded") {
              requireString(tool.description, "system tool description");
              if (!isRecord(tool.parameters)) invalid("system tool parameters object");
            }
          }
        }
      }
    } else if (message.role === "assistant") {
      validateContent(message.content, assistantBlocks);
      for (const key of ["api", "provider", "model"]) requireString(message[key], key, true);
      if (typeof message.stopReason !== "string" || !stopReasons.has(message.stopReason)) {
        invalid("assistant stopReason");
      }
      validateUsage(message.usage);
      for (const key of [
        "responseModel",
        "responseId",
        "providerThinkingLevel",
        "thinkingLevel",
        "errorMessage",
        "rawStopReason",
      ]) {
        optionalString(message, key);
      }
      if (Object.hasOwn(message, "endTurn") && typeof message.endTurn !== "boolean") {
        invalid("assistant endTurn boolean");
      }
    } else if (message.role === "toolResult") {
      validateContent(message.content, inputBlocks);
      requireString(message.toolCallId, "tool result id", true);
      requireString(message.toolName, "tool result name", true);
      if (typeof message.isError !== "boolean") invalid("tool result isError boolean");
      if (Object.hasOwn(message, "usage")) validateUsage(message.usage);
    } else {
      invalid("unsupported message role");
    }
    if (Object.hasOwn(message, "durationMs")) requireNumber(message.durationMs, "durationMs");
  }
}

/**
 * Project raw history into coherent provider context. The caller must replace
 * the first system message with the current application-owned prompt/tools.
 * Persisted system updates never enter this projection. No calls execute here.
 */
export function modelContextMessages(saved: AgentMessage[]): Message[] {
  const messages = trimmed(saved);
  const context: Message[] = [];
  // The page the tutor was last told about; a question says so only when it changed.
  let focus = NOT_READING;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "system") {
      if (index === 0) context.push(message);
    } else if (message.role === "user") {
      context.push(withFocusNote(message, focus));
      if (Object.hasOwn(message, "folioFocus")) focus = focusKey(message);
    } else if (message.role === "assistant") {
      const toolCalls = message.content.filter((block) => block.type === "toolCall");
      const results: Extract<Message, { role: "toolResult" }>[] = [];
      let nextIndex = index + 1;
      // System deltas are transparent to call/result grouping, then discarded.
      while (nextIndex < messages.length) {
        const next = messages[nextIndex]!;
        if (next.role === "toolResult") results.push(next);
        else if (next.role !== "system") break;
        nextIndex++;
      }
      index = nextIndex - 1;
      if (excludedStops.has(message.stopReason)) continue;
      if (toolCalls.length === 0) {
        context.push(message);
        continue;
      }

      const callsById = new Map(toolCalls.map((call) => [call.id, call]));
      const resultIds = new Set<string>();
      const complete =
        callsById.size === toolCalls.length &&
        results.length === toolCalls.length &&
        results.every((result) => {
          const call = callsById.get(result.toolCallId);
          if (!call || call.name !== result.toolName || resultIds.has(result.toolCallId))
            return false;
          resultIds.add(result.toolCallId);
          return true;
        });
      if (complete) context.push(message, ...results);
    }
    // Unattached results are raw history only, never provider context.
  }
  return withRecentImages(context);
}

type FocusNote = { documentId: string; page: number; title: string; pages: number } | null;
const NOT_READING = "none";

function focusKey(message: object): string {
  const focus = (message as { folioFocus?: FocusNote }).folioFocus;
  return focus ? `${focus.documentId}:${focus.page}` : NOT_READING;
}

/**
 * A course chat's question carries the page the student had open (`folioFocus`, recorded when it
 * was sent). The tutor is told in a short note after the question's text, and only when the page
 * changed since the last question, so every earlier message reads exactly as it did before and
 * the prompt never has to mention pages. The wording is fixed: changing it changes old requests.
 */
function withFocusNote(message: Extract<Message, { role: "user" }>, previous: string): Message {
  if (!Object.hasOwn(message, "folioFocus") || focusKey(message) === previous) return message;
  const focus = (message as { folioFocus?: FocusNote }).folioFocus;
  const note = {
    type: "text" as const,
    text: focus
      ? `<folio_context>The student is reading "${focus.title}", page ${focus.page} of ${focus.pages}.</folio_context>`
      : "<folio_context>The student is not reading a document now.</folio_context>",
  };
  if (typeof message.content === "string")
    return { ...message, content: [{ type: "text", text: message.content }, note] };
  // After the question's text and what the student added, before any images.
  const at = message.content.findIndex((block) => block.type === "image");
  const content = [...message.content];
  content.splice(at === -1 ? content.length : at, 0, note);
  return { ...message, content };
}

// ── Long chats ─────────────────────────────────────────────────────────────

/**
 * Recorded on the question that moved it: tool results before `stubBefore` (an index into the
 * saved messages) reach the model as one-line notes, and visuals there as their titles. Only
 * ever moves forward, so every later request repeats the one before.
 */
export interface TrimMark {
  v: 1;
  stubBefore: number;
}

/**
 * A summary of the chat so far, written by the model when the chat neared its limit and saved
 * as a message of Folio's (not the student's) just before the question that needed it. The
 * messages it covers stay saved; the model sees the summary instead of them.
 */
export interface SummaryMark {
  v: 1;
  /** The summary's own index; everything before it is covered. */
  covers: number;
  model: string;
  createdAt: string;
}

/** The text Folio sends in place of an earlier tool result. */
export function stubOf(result: { toolName: string; details?: unknown; isError?: boolean }): string {
  const details = (result.details ?? {}) as Record<string, unknown>;
  const handles = Array.isArray(details.handles) ? (details.handles as unknown[]).join(", ") : "";
  const what =
    result.toolName === "read_page" && typeof details.title === "string"
      ? `"${details.title}", page ${String(details.page)}`
      : handles
        ? `sections ${handles}`
        : result.toolName === "read_note" && typeof details.title === "string"
          ? `the note "${details.title}"`
          : "";
  return `[An earlier ${result.toolName} result${what ? ` (${what})` : ""} is not sent again; call the tool again if you need its text.]`;
}

/**
 * The saved messages as long chats send them: from the latest summary on, with tool results
 * and visuals before the latest trim mark shortened. Pure: the same messages give the same
 * result, so a reopened chat sends what it sent before.
 */
function trimmed(messages: AgentMessage[]): AgentMessage[] {
  let stubBefore = 0;
  let summary = -1;
  messages.forEach((message, index) => {
    if (message.role !== "user") return;
    const marks = message as { folioTrim?: TrimMark; folioSummary?: SummaryMark };
    if (marks.folioTrim) stubBefore = Math.max(stubBefore, marks.folioTrim.stubBefore);
    if (marks.folioSummary) summary = index;
  });
  if (!stubBefore && summary === -1) return messages;
  const kept = messages.flatMap((message, index) => {
    // A summary replaces what came before it; the app's leading system message stays.
    if (summary !== -1 && index < summary && !(index === 0 && message.role === "system")) return [];
    if (index >= stubBefore) return [message];
    if (message.role === "toolResult")
      return [{ ...message, content: [{ type: "text" as const, text: stubOf(message) }] }];
    if (message.role === "assistant" && message.content.some((block) => block.type === "toolCall"))
      return [
        {
          ...message,
          content: message.content.map((block) =>
            block.type === "toolCall" && block.name === "show_visual"
              ? {
                  ...block,
                  arguments: {
                    source: `[A visual shown earlier: ${earlierTitle(block.arguments)}.]`,
                  },
                }
              : block,
          ),
        },
      ];
    return [message];
  });
  return kept as AgentMessage[];
}

function earlierTitle(args: unknown): string {
  const source = (args as { source?: unknown } | undefined)?.source;
  const title =
    typeof source === "string" ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] : "";
  return (
    title
      ?.replace(/<[^>]*>/g, "")
      .trim()
      .slice(0, 80) || "untitled"
  );
}

/** At most this many messages (questions or tool results) keep their images in a request. */
export const MAX_IMAGES = 6;
/** Images are dropped this many messages at a time, so most requests repeat the one before. */
const IMAGE_BATCH = 5;
const EARLIER_PAGE =
  "[A page image from earlier is not sent again; read the page again to look at it.]";
const EARLIER_OWN_IMAGE =
  "[An image the student added earlier is not sent again; ask them to add it again if you need it.]";

/**
 * How many of the first `count` messages with images send their images as text instead: none
 * up to MAX_IMAGES, then a whole batch at a time, keeping between 2 and MAX_IMAGES.
 */
export function imagesDropped(count: number): number {
  return count <= MAX_IMAGES ? 0 : IMAGE_BATCH * Math.floor((count - 2) / IMAGE_BATCH);
}

/**
 * Every request resends the whole conversation, so images would pile up turn after turn. Only
 * the most recent messages keep theirs; earlier ones say what was there. Older images are let go
 * in batches rather than one per new image, because rewriting an earlier message makes the
 * provider read everything after it again instead of reusing what it already read. The saved
 * chat keeps every image; this changes only what is sent.
 */
function withRecentImages(context: Message[]): Message[] {
  const out = [...context];
  const withImages = out.flatMap((message, index) =>
    (message.role === "user" || message.role === "toolResult") &&
    typeof message.content !== "string" &&
    message.content.some((block) => block.type === "image")
      ? [index]
      : [],
  );
  for (const index of withImages.slice(0, imagesDropped(withImages.length))) {
    const message = out[index] as Extract<Message, { role: "user" | "toolResult" }>;
    if (typeof message.content === "string") continue;
    // A question's images follow its attachments in order: pages, or the student's own images.
    const kinds = (
      (message as { folioAttachments?: { kind: string }[] }).folioAttachments ?? []
    ).filter((attachment) => attachment.kind === "page" || attachment.kind === "image");
    let image = 0;
    const content = message.content.map((block) =>
      block.type === "image"
        ? {
            type: "text" as const,
            text: kinds[image++]?.kind === "image" ? EARLIER_OWN_IMAGE : EARLIER_PAGE,
          }
        : block,
    );
    out[index] = { ...message, content } as Message;
  }
  return out;
}
