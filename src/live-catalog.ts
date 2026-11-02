import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isModelType, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { CompatSchemasByApi } from "@earendil-works/pi-ai/providers/compat-schema";
import {
  ModelCostSchema,
  ModelInputLimitsSchema,
  ThinkingLevelMapSchema,
} from "@earendil-works/pi-ai/providers/model-schema";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { TSchema } from "typebox";
import Value from "typebox/value";
import { privateDirectory, writeAtomic } from "./files.ts";
import { urlProblem } from "./mcp/config.ts";

/**
 * Pi's live model list. Between releases pi.dev publishes the models each provider offers, and
 * Pi's own app adds them to the list built into its release; Folio does the same for OpenRouter,
 * the one connection whose whole catalog the student chooses from. The list is kept in
 * `catalog/openrouter.json` in Folio's home, checked again when it is four hours old, and used
 * only while it is newer than the list built into Pi.
 *
 * It comes from outside Folio, so an entry is used only in the shape Folio's Pi release knows,
 * checked against Pi's own schemas: a chat model on an API the built-in provider speaks, at the
 * address its built-in models use. Headers and anything else in an entry are dropped, so every
 * request still goes to OpenRouter with the student's key and nothing more. Nothing about the
 * student is sent to pi.dev: the request names only the provider and Folio's Pi release.
 */

/** The Pi release Folio ships: pi.dev answers with a list that release can use. */
export const PI_VERSION = "1.4.0";
/** When the list built into that release was made; a live list older than this is not used. */
export const PI_LIST_MADE = Date.parse("2026-10-21T22:33:24.994Z");

export const PI_CATALOG = "https://pi.dev";
export const LIVE_PROVIDERS = ["openrouter"] as const;

/** How old the kept list may be before it is checked again, as Pi's own app does. */
export const CHECK_EVERY_MS = 4 * 3_600_000;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 2_000;

/** Built-in models of each provider the live list adds to: the shape a live entry must match. */
const BUILT_IN: Record<string, () => readonly Model<Api>[]> = {
  openrouter: () => openrouterProvider().getModels(),
};

/** A provider's live list as kept on disk. */
interface Kept {
  version: 1;
  /** When pi.dev was last asked, successfully. */
  checkedAt: number;
  /** pi.dev's Last-Modified for the list: 0 when it sent none, or has none for this release. */
  lastModified: number;
  etag?: string;
  models: Model<Api>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ID = /^~?[A-Za-z0-9][\w.-]*\/[\w.:+-]+$/;
const CONTROL = /\p{Cc}/u;

const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 100_000_000;

/** Prices are dollars per million tokens: never negative, as OpenRouter's routers report. */
function prices(cost: Record<string, unknown>): boolean {
  const rates = [cost, ...((cost.tiers as Record<string, unknown>[] | undefined) ?? [])];
  return rates.every((rate) =>
    ["input", "output", "cacheRead", "cacheWrite", "inputTokensAbove"].every(
      (field) =>
        (field === "inputTokensAbove" && rate === cost) ||
        (Number.isFinite(rate[field]) && (rate[field] as number) >= 0),
    ),
  );
}

/** The value checked against Pi's schema, with anything the schema doesn't name removed. */
function checked(schema: TSchema, value: unknown): unknown {
  return Value.Check(schema, value) ? Value.Clean(schema, structuredClone(value)) : undefined;
}

/**
 * One live entry as a model Folio can use, or undefined when it isn't one: a chat model on an
 * API in `bases`, at the base URL given there for it. Only the fields Folio's Pi release reads are
 * kept, each checked; the address comes from `bases`, never from the entry.
 */
export function liveModel(
  entry: unknown,
  provider: string,
  bases: ReadonlyMap<string, string>,
): Model<Api> | undefined {
  if (!isRecord(entry)) return undefined;
  const { type, id, name, api, input, reasoning, contextWindow, maxTokens } = entry;
  if (type !== undefined && type !== "chat") return undefined;
  if (entry.provider !== undefined && entry.provider !== provider) return undefined;
  if (typeof id !== "string" || id.length > 200 || !ID.test(id)) return undefined;
  if (typeof name !== "string" || !name.trim() || name.length > 200 || CONTROL.test(name))
    return undefined;
  const base = typeof api === "string" ? bases.get(api) : undefined;
  if (!base || entry.baseUrl !== base) return undefined;
  if (
    !Array.isArray(input) ||
    !input.includes("text") ||
    input.some((each) => each !== "text" && each !== "image")
  )
    return undefined;
  if (typeof reasoning !== "boolean" || !count(contextWindow) || !count(maxTokens))
    return undefined;
  const cost = checked(ModelCostSchema, entry.cost);
  if (!isRecord(cost) || !prices(cost)) return undefined;
  const model: Record<string, unknown> = {
    type: "chat",
    id,
    name,
    api,
    provider,
    baseUrl: base,
    input: [...new Set(input)],
    reasoning,
    cost,
    contextWindow,
    maxTokens,
  };
  const optional: [string, TSchema | undefined][] = [
    ["thinkingLevelMap", ThinkingLevelMapSchema],
    ["compat", CompatSchemasByApi[api as keyof typeof CompatSchemasByApi]],
    ["inputLimits", ModelInputLimitsSchema],
  ];
  for (const [field, schema] of optional) {
    if (entry[field] === undefined) continue;
    const value = schema && checked(schema, entry[field]);
    if (value === undefined) return undefined;
    model[field] = value;
  }
  return model as unknown as Model<Api>;
}

/** The usable models among a provider's live entries, the first of each ID. */
export function liveModels(provider: string, entries: readonly unknown[]): Model<Api>[] {
  const builtIn = BUILT_IN[provider]?.() ?? [];
  const bases = new Map<string, string>();
  for (const model of builtIn)
    if (isModelType(model, "chat") && !bases.has(model.api)) bases.set(model.api, model.baseUrl);
  const models = new Map<string, Model<Api>>();
  for (const entry of entries) {
    const model = liveModel(entry, provider, bases);
    if (model && !models.has(model.id)) models.set(model.id, model);
    if (models.size >= MAX_MODELS) break;
  }
  return [...models.values()];
}

/** Where the live list comes from: pi.dev, another https address (tests), or nowhere ("off"). */
export function liveSource(value: string | undefined): string | null {
  if (value === undefined || value === "") return PI_CATALOG;
  if (value === "off" || urlProblem(value)) return null;
  return value;
}

/** A response's body as text, refused once it is larger than `max` bytes. */
async function capped(response: Response, max: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new Error("The model list is too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error("The model list is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class LiveCatalog {
  readonly #directory: string;
  readonly #source: string | null;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #made: number;
  #kept = new Map<string, Kept>();
  /** Counts changes to the models in use, so a provider's merged list is built once per change. */
  #revision = 0;
  #checking: Promise<boolean> | undefined;

  constructor(options: {
    home: string;
    /** pi.dev unless given; null never asks. */
    source?: string | null;
    fetch?: typeof fetch;
    now?: () => number;
    /** When the built-in list was made; tests pass their own. */
    made?: number;
  }) {
    this.#directory = resolve(options.home, "catalog");
    this.#source = options.source === undefined ? PI_CATALOG : options.source;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#made = options.made ?? PI_LIST_MADE;
  }

  #file(provider: string): string {
    return resolve(this.#directory, `${provider}.json`);
  }

  /** Reads the kept lists; one that is missing or unreadable is no list. */
  async load(): Promise<void> {
    for (const provider of LIVE_PROVIDERS) {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(this.#file(provider), "utf8"));
      } catch {
        continue;
      }
      if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.models)) continue;
      const time = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? value : 0;
      this.#kept.set(provider, {
        version: 1,
        checkedAt: time(raw.checkedAt),
        lastModified: time(raw.lastModified),
        ...(typeof raw.etag === "string" ? { etag: raw.etag } : {}),
        models: liveModels(provider, raw.models),
      });
    }
    this.#revision++;
  }

  /** The live models used for a provider: none while its list is no newer than Pi's own. */
  models(provider: string): readonly Model<Api>[] {
    const kept = this.#kept.get(provider);
    return kept && kept.lastModified > this.#made ? kept.models : [];
  }

  /**
   * The provider, listing its live models with its built-in ones. A live entry replaces the
   * built-in one with its ID, as in Pi's own app: the live list corrects prices and limits too.
   */
  wrap(provider: Provider): Provider {
    let merged: { revision: number; models: Model<Api>[] } | undefined;
    const models = (): Model<Api>[] => {
      if (merged?.revision !== this.#revision) {
        const byId = new Map(provider.getModels().map((model) => [model.id, model]));
        for (const model of this.models(provider.id)) byId.set(model.id, model);
        merged = { revision: this.#revision, models: [...byId.values()] };
      }
      return merged.models;
    };
    return {
      ...provider,
      getModels: models,
      getAllModels: () => [
        ...models(),
        ...(provider.getAllModels?.() ?? []).filter((model) => !isModelType(model, "chat")),
      ],
    };
  }

  /**
   * Asks pi.dev for each list that is four hours old, or every list when `force`. True when the
   * models Folio uses changed. It never throws: offline or refused, the kept list stays.
   */
  refresh(options: { force?: boolean } = {}): Promise<boolean> {
    this.#checking ??= this.#check(options.force ?? false).finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  async #check(force: boolean): Promise<boolean> {
    if (!this.#source) return false;
    let changed = false;
    for (const provider of LIVE_PROVIDERS) {
      try {
        if (await this.#checkOne(provider, force)) changed = true;
      } catch {
        // Offline, refused or unreadable: the kept list stays, and the next check tries again.
      }
    }
    return changed;
  }

  async #checkOne(provider: string, force: boolean): Promise<boolean> {
    const kept = this.#kept.get(provider);
    const now = this.#now();
    if (!force && kept && now >= kept.checkedAt && now - kept.checkedAt < CHECK_EVERY_MS)
      return false;
    const url = new URL(`/api/models/providers/${provider}`, this.#source!);
    url.searchParams.set("types", "chat");
    url.searchParams.set("pi-version", PI_VERSION);
    const headers: Record<string, string> = { accept: "application/json" };
    // Only a kept list backs the validator, so "not modified" never leaves Folio with none.
    if (kept?.etag && kept.models.length) headers["if-none-match"] = kept.etag;
    const response = await this.#fetch(url.href, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 304 && kept) {
      await response.body?.cancel();
      await this.#keep(provider, { ...kept, checkedAt: now });
      return false;
    }
    // pi.dev has no list for this Pi release.
    if (response.status === 404 || response.status === 501) {
      await response.body?.cancel();
      return this.#keep(provider, { version: 1, checkedAt: now, lastModified: 0, models: [] });
    }
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const body: unknown = JSON.parse(await capped(response, MAX_BYTES));
    const entries = Array.isArray(body)
      ? body
      : isRecord(body) && Array.isArray(body.models)
        ? body.models
        : isRecord(body)
          ? Object.values(body)
          : [];
    const modified = Date.parse(response.headers.get("last-modified") ?? "");
    const etag = response.headers.get("etag");
    return this.#keep(provider, {
      version: 1,
      checkedAt: now,
      lastModified: Number.isNaN(modified) ? 0 : modified,
      ...(etag ? { etag } : {}),
      models: liveModels(provider, entries),
    });
  }

  /** Saves a provider's list and uses it; true when the models in use changed. */
  async #keep(provider: string, kept: Kept): Promise<boolean> {
    const before = JSON.stringify(this.models(provider));
    await privateDirectory(this.#directory, "model lists", Error);
    await writeAtomic(this.#file(provider), `${JSON.stringify(kept)}\n`);
    this.#kept.set(provider, kept);
    const changed = JSON.stringify(this.models(provider)) !== before;
    if (changed) this.#revision++;
    return changed;
  }
}
