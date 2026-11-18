import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { CHATGPT_PLAN } from "./connections.ts";
import type { ModelGroupView, ModelView } from "./desktop/api.ts";
import { DECLARED, folioModel } from "./model-catalog.ts";
import { CONNECTIONS, formatRef, parseRef, type ConnectionId } from "./model-refs.ts";

/**
 * The models Folio offers in the composer, by connection. The ChatGPT plan offers the models Pi
 * lists for it, which pi.dev keeps current between Pi's releases: Pi's OpenAI catalog lists many
 * more that the plan refuses (on 2026-10-27, ChatGPT refused gpt-5.5 as "not supported"). An
 * OpenAI key offers the same models, those its catalog has. The other keys each offer a short
 * list of current models from their provider's catalog; OpenRouter offers the models the student
 * picked in Settings.
 */
export interface Offer {
  models: string[];
  /** Earlier models, offered under "Older models". */
  older: string[];
}

export const OFFERS: Record<"anthropic" | "google", Offer> = {
  anthropic: {
    models: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    older: ["claude-opus-5"],
  },
  google: { models: ["gemini-4-argon", "gemini-3.8-flash"], older: ["gemini-3.5-flash"] },
};

/**
 * A model of the ChatGPT plan by its line and version: `gpt-6.2-sol` is version 6.2 of Sol. An ID
 * shaped otherwise is a line of its own, older than any version.
 */
function lineOf(id: string): { line: string; version: number[] } {
  const match = /^gpt-(\d+(?:\.\d+)*)-([a-z][\w.-]*)$/.exec(id);
  return match
    ? { line: match[2], version: match[1].split(".").map(Number) }
    : { line: id, version: [] };
}

/** Positive when version `a` is newer than `b`. */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

/** The line new chats and studies use, listed first among models of the same version. */
const FIRST_LINE = "sol";

/** Newest first; among one version, Sol first and then by name. */
function newestFirst(a: string, b: string): number {
  const [x, y] = [lineOf(a), lineOf(b)];
  return (
    compareVersions(y.version, x.version) ||
    Number(y.line === FIRST_LINE) - Number(x.line === FIRST_LINE) ||
    a.localeCompare(b)
  );
}

/**
 * The ChatGPT plan's models: those Pi lists for the plan, and those Folio declares for it, that
 * Folio can send a request to.
 */
function planModels(catalog: Models): string[] {
  const listed = catalog.getModels(CHATGPT_PLAN).map((model) => model.id);
  return [...new Set([...listed, ...Object.keys(DECLARED)])].filter((id) =>
    folioModel(catalog, id),
  );
}

/** The newest model of each line, and every earlier one apart. */
function byLine(ids: readonly string[]): Offer {
  const offer: Offer = { models: [], older: [] };
  const seen = new Set<string>();
  for (const id of [...ids].sort(newestFirst)) {
    const { line } = lineOf(id);
    (seen.has(line) ? offer.older : offer.models).push(id);
    seen.add(line);
  }
  return offer;
}

/** What a connection offers. OpenRouter offers `openrouter`, the student's picks. */
export function offerFor(
  catalog: Models,
  connection: ConnectionId,
  openrouter: readonly string[],
): Offer {
  if (connection === "openrouter") return { models: [...openrouter], older: [] };
  if (connection === "anthropic" || connection === "google") return OFFERS[connection];
  const plan = planModels(catalog);
  return byLine(
    connection === "chatgpt" ? plan : plan.filter((id) => catalog.getModel("openai-api", id)),
  );
}

/**
 * The newest model the ChatGPT plan offers in the line of `id`, such as `gpt-6.2-sol` for
 * `gpt-6.1-sol` once Pi lists it; `id` itself when none is newer.
 */
export function newestInLine(catalog: Models, id: string): string {
  const { line } = lineOf(id);
  return offerFor(catalog, "chatgpt", []).models.find((each) => lineOf(each).line === line) ?? id;
}

/** OpenRouter models offered until the student picks their own in Settings. */
export const DEFAULT_OPENROUTER: readonly string[] = [
  "anthropic/claude-sonnet-5.5",
  "google/gemini-3.8-flash",
  "deepseek/deepseek-v4-pro",
  "moonshotai/kimi-k3",
];

/** Whether the composer offers this model for a new chat. */
export function offered(catalog: Models, ref: string, openrouter: readonly string[]): boolean {
  const parsed = parseRef(ref);
  if (!parsed) return false;
  const offer = offerFor(catalog, parsed.connection.id, openrouter);
  return offer.models.includes(parsed.id) || offer.older.includes(parsed.id);
}

/**
 * The model a reference names, from the catalog. The ChatGPT plan serves only the models Pi lists
 * for it; OpenRouter's batch variants answer later rather than now, so they are left out.
 */
export function modelFor(catalog: Models, ref: string): Model<Api> | undefined {
  const parsed = parseRef(ref);
  if (!parsed) return undefined;
  const { connection, id } = parsed;
  if (connection.id === "chatgpt" && !offered(catalog, ref, [])) return undefined;
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
    const offer = offerFor(catalog, connection.id, openrouter);
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
