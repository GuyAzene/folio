import {
  createModels,
  type ApiKeyAuth,
  type Models,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { connectionById, type Connection } from "./model-refs.ts";

/**
 * The providers behind the API-key connections. Each resolves only the key saved in Folio: never
 * one from the shell's environment, another app's files, or a provider's own sign-in.
 */
function storedKey(name: string): ApiKeyAuth {
  return {
    name,
    async resolve({ credential, signal }) {
      signal.throwIfAborted();
      return credential?.key ? { auth: { apiKey: credential.key }, source: "Folio" } : undefined;
    },
  };
}

/**
 * The OpenAI API on a key, apart from the ChatGPT plan. Its models are the catalog's OpenAI chat
 * models under their own provider, so Pi sends them to the API with the key and never takes them
 * for a ChatGPT sign-in.
 */
function openaiApiProvider(): Provider {
  const openai = openaiProvider();
  const models = openai.getModels().map((model) => ({ ...model, provider: "openai-api" }));
  return {
    ...openai,
    id: "openai-api",
    name: "OpenAI API",
    auth: { apiKey: storedKey("OpenAI API key") },
    getModels: () => models,
    getAllModels: () => models,
    filterModels: undefined,
    filterAllModels: undefined,
    classify: undefined,
  };
}

export function keyProviders(): Provider[] {
  return [
    openaiApiProvider(),
    { ...anthropicProvider(), auth: { apiKey: storedKey("Anthropic API key") } },
    { ...googleProvider(), auth: { apiKey: storedKey("Gemini API key") } },
    { ...openrouterProvider(), auth: { apiKey: storedKey("OpenRouter API key") } },
  ];
}

/** Every provider's models, with no credentials: for looking models up, never for requests. */
export function modelCatalog(): Models {
  const catalog: MutableModels = createModels();
  catalog.setProvider(openaiProvider());
  for (const provider of keyProviders()) catalog.setProvider(provider);
  return catalog;
}

/** A request that lists models or describes the key: free, and refused for a bad key. */
const CHECKS: Record<string, (key: string) => { url: string; headers: Record<string, string> }> = {
  openai: (key) => ({
    url: "https://api.openai.com/v1/models",
    headers: { authorization: `Bearer ${key}` },
  }),
  anthropic: (key) => ({
    url: "https://api.anthropic.com/v1/models",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  }),
  google: (key) => ({
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    headers: { "x-goog-api-key": key },
  }),
  openrouter: (key) => ({
    url: "https://openrouter.ai/api/v1/key",
    headers: { authorization: `Bearer ${key}` },
  }),
};

const KEY = /^[\x21-\x7e]{8,512}$/;
const CHECK_TIMEOUT_MS = 15_000;

/** The trimmed key, or why Folio won't save it, before anything leaves the Mac. */
export function cleanKey(connection: Connection, key: unknown): string {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!KEY.test(trimmed))
    throw new Error(`That doesn't look like a ${connection.name} API key. Paste the whole key.`);
  return trimmed;
}

/**
 * Asks the provider whether it accepts the key. Its answer's body is never shown: some providers
 * echo part of the key or account details back.
 */
export async function checkKey(
  id: string,
  key: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<void> {
  const connection = connectionById(id);
  const check = connection && CHECKS[connection.id];
  if (!connection || !check) throw new Error("Folio does not take a key for that.");
  const { url, headers } = check(cleanKey(connection, key));
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      headers: { accept: "application/json", ...headers },
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new Error(
      `Folio couldn't reach ${connection.name}. Check your internet connection and try again.`,
    );
  }
  await response.body?.cancel().catch(() => undefined);
  // Google answers a key it does not know with 400.
  const refused =
    response.status === 401 ||
    response.status === 403 ||
    (connection.id === "google" && response.status === 400);
  if (refused)
    throw new Error(`${connection.name} refused this key. Check that you copied all of it.`);
  if (!response.ok)
    throw new Error(
      `${connection.name} couldn't check the key right now (${response.status}). Try again in a moment.`,
    );
}
