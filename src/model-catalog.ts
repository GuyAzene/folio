import type { Api, Model, Models } from "@earendil-works/pi-ai";

/**
 * Models the ChatGPT plan serves that Pi's catalog does not list yet, each declared as a copy of
 * a listed sibling. Pi's own entry wins as soon as it ships one, and the declaration can go.
 */
const DECLARED: Record<string, { from: string; name: string }> = {
  // Accepted at low and max effort on 2026-10-29; Pi 1.4.0 does not list it. Its context
  // window, output limit and prices are assumed to be Sol's.
  "gpt-6.1-terra": { from: "gpt-6.1-sol", name: "GPT-6.1 Terra" },
};

/** An OpenAI model from Pi's catalog, or one Folio declares; undefined when neither has it. */
export function folioModel(catalog: Models, id: string): Model<Api> | undefined {
  const listed = catalog.getModel("openai", id);
  if (listed) return listed;
  const declared = DECLARED[id];
  const base = declared && catalog.getModel("openai", declared.from);
  return base ? { ...base, id, name: declared.name } : undefined;
}
