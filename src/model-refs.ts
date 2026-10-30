/**
 * The connections Folio can use, and the references that name a model on one of them. Shared by
 * the main process and the window; nothing here touches a credential.
 *
 * A reference is `connection/model`, such as `chatgpt/gpt-6.1-sol` or
 * `openrouter/deepseek/deepseek-v4-pro`: everything after the first slash is the model's ID.
 */
export const CONNECTIONS = [
  // The ChatGPT plan keeps Pi's `openai` provider, which saved chats name.
  { id: "chatgpt", provider: "openai", name: "ChatGPT", kind: "plan" },
  // The OpenAI API on a key is a provider of its own: Pi keeps one credential per provider.
  { id: "openai", provider: "openai-api", name: "OpenAI", kind: "key" },
  { id: "anthropic", provider: "anthropic", name: "Anthropic", kind: "key" },
  { id: "google", provider: "google", name: "Google Gemini", kind: "key" },
  { id: "openrouter", provider: "openrouter", name: "OpenRouter", kind: "key" },
] as const;

export type Connection = (typeof CONNECTIONS)[number];
export type ConnectionId = Connection["id"];
/** Pi's provider ID, saved with each chat. */
export type ProviderId = Connection["provider"];

export interface ModelRef {
  connection: Connection;
  /** The model's ID at its provider. */
  id: string;
}

const MODEL_ID = /^[\x21-\x7e]{1,200}$/;

export function connectionById(id: unknown): Connection | undefined {
  return CONNECTIONS.find((connection) => connection.id === id);
}

export function connectionOf(provider: unknown): Connection | undefined {
  return CONNECTIONS.find((connection) => connection.provider === provider);
}

export function parseRef(ref: unknown): ModelRef | undefined {
  if (typeof ref !== "string") return undefined;
  const slash = ref.indexOf("/");
  const connection = connectionById(ref.slice(0, slash));
  const id = ref.slice(slash + 1);
  return slash > 0 && connection && MODEL_ID.test(id) ? { connection, id } : undefined;
}

export function formatRef(connection: ConnectionId, id: string): string {
  return `${connection}/${id}`;
}

/**
 * A study step's model as studying records it: a ChatGPT model by its bare ID, as studies always
 * have, so a saved step is still reused; any other by its reference.
 */
export function studyModel(ref: string): string {
  const parsed = parseRef(ref);
  return parsed?.connection.id === "chatgpt" ? parsed.id : ref;
}

/** The reference of a saved chat's model, from the provider and model ID it saved. */
export function refOf(provider: string, id: string): string {
  return formatRef(connectionOf(provider)?.id ?? "chatgpt", id);
}
