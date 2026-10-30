import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { ModelGroupView, ModelView } from "./desktop/api.ts";
import { folioModel } from "./model-catalog.ts";
import { CONNECTIONS, formatRef, parseRef, type ConnectionId } from "./model-refs.ts";

/**
 * The models Folio offers in the composer, by connection. The ChatGPT plan lists only models a
 * real request accepted: Pi's catalog lists many more that the plan may refuse (on 2026-10-27,
 * ChatGPT refused gpt-5.5 as "not supported"). A key reaches its provider's whole catalog, so
 * each key offers a short list of current models from it; OpenRouter offers the models the
 * student picked in Settings.
 */
export interface Offer {
  models: string[];
  /** Earlier models, offered under "Older models". */
  older: string[];
}

export const OFFERS: Record<Exclude<ConnectionId, "openrouter">, Offer> = {
  chatgpt: {
    // Checked with one request each through a ChatGPT Pro plan on 2026-10-27; Terra on
    // 2026-10-29.
    models: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-luna"],
    older: ["gpt-6-sol", "gpt-5.6-sol"],
  },
  openai: { models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"], older: ["gpt-6-sol"] },
  anthropic: {
    models: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    older: ["claude-opus-5"],
  },
  google: { models: ["gemini-4-argon", "gemini-3.8-flash"], older: ["gemini-3.5-flash"] },
};

/** OpenRouter models offered until the student picks their own in Settings. */
export const DEFAULT_OPENROUTER: readonly string[] = [
  "anthropic/claude-sonnet-5.5",
  "google/gemini-3.8-flash",
  "deepseek/deepseek-v4-pro",
  "moonshotai/kimi-k3",
];

/** Whether the composer offers this model for a new chat. */
export function offered(ref: string, openrouter: readonly string[]): boolean {
  const parsed = parseRef(ref);
  if (!parsed) return false;
  if (parsed.connection.id === "openrouter") return openrouter.includes(parsed.id);
  const offer = OFFERS[parsed.connection.id];
  return offer.models.includes(parsed.id) || offer.older.includes(parsed.id);
}

/**
 * The model a reference names, from the catalog. The ChatGPT plan serves only the models it was
 * checked with; OpenRouter's batch variants answer later rather than now, so they are left out.
 */
export function modelFor(catalog: Models, ref: string): Model<Api> | undefined {
  const parsed = parseRef(ref);
  if (!parsed) return undefined;
  const { connection, id } = parsed;
  if (connection.id === "chatgpt" && !offered(ref, [])) return undefined;
  if (connection.id === "openrouter" && id.endsWith(":batch")) return undefined;
  return folioModel(catalog, id, connection.provider);
}

/** OpenRouter's name for a model's lab ("Anthropic: Claude Sonnet 5.5"), apart from its own. */
function openrouterNames(model: Model<Api>): { lab: string; name: string } {
  const colon = model.name.indexOf(": ");
  if (colon > 0) return { lab: model.name.slice(0, colon), name: model.name.slice(colon + 2) };
  const slash = model.id.indexOf("/");
  const lab = slash > 0 ? model.id.slice(0, slash).replace(/^~/, "") : "openrouter";
  return { lab: lab.charAt(0).toUpperCase() + lab.slice(1), name: model.name };
}

/** A model's name, without the lab OpenRouter puts before it. */
export function modelName(model: Model<Api>): string {
  return model.provider === "openrouter" ? openrouterNames(model).name : model.name;
}

export function modelView(catalog: Models, ref: string, older = false): ModelView | undefined {
  const model = modelFor(catalog, ref);
  if (!model) return undefined;
  const view: ModelView = { ref, name: model.name, images: model.input.includes("image") };
  if (older) view.older = true;
  if (model.provider === "openrouter") Object.assign(view, openrouterNames(model));
  return view;
}

/** Every OpenRouter model Folio can use, for choosing which ones the composer offers. */
export function openrouterCatalog(catalog: Models): ModelView[] {
  return catalog
    .getModels("openrouter")
    .flatMap((model) => modelView(catalog, formatRef("openrouter", model.id)) ?? [])
    .sort((a, b) => a.lab!.localeCompare(b.lab!) || a.name.localeCompare(b.name));
}

/** The composer's groups: one per connection, with the models it offers. */
export function modelGroups(
  catalog: Models,
  connected: ReadonlySet<ConnectionId>,
  openrouter: readonly string[],
): ModelGroupView[] {
  return CONNECTIONS.map((connection) => {
    const offer: Offer =
      connection.id === "openrouter"
        ? { models: [...openrouter], older: [] }
        : OFFERS[connection.id];
    const view = (id: string, older: boolean) =>
      modelView(catalog, formatRef(connection.id, id), older) ?? [];
    return {
      connection: connection.id,
      name: connection.name,
      connected: connected.has(connection.id),
      models: [
        ...offer.models.flatMap((id) => view(id, false)),
        ...offer.older.flatMap((id) => view(id, true)),
      ],
    };
  });
}
