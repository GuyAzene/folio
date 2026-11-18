import { describe, expect, it } from "vite-plus/test";
import { modelCatalog } from "../src/connections.ts";
import { folioModel } from "../src/model-catalog.ts";
import {
  DEFAULT_OPENROUTER,
  modelFor,
  modelGroups,
  newestInLine,
  OFFERS,
  offered,
  offerFor,
  openrouterCatalog,
} from "../src/model-choices.ts";

const catalog = modelCatalog();

describe("the models Folio offers", () => {
  it("resolve every offered ChatGPT model, Terra included, from Pi or Folio's declarations", () => {
    const { models, older } = offerFor(catalog, "chatgpt", []);
    for (const id of [...models, ...older]) expect(folioModel(catalog, id)?.id).toBe(id);
    const terra = folioModel(catalog, "gpt-6.1-terra")!;
    const sol = folioModel(catalog, "gpt-6.1-sol")!;
    expect(terra.name).toBe("GPT-6.1 Terra");
    expect(terra.api).toBe(sol.api);
    expect(terra.contextWindow).toBe(sol.contextWindow);
    expect(folioModel(catalog, "gpt-unknown")).toBeUndefined();
    // Terra is declared for the plan only; a key reaches the API's own catalog.
    expect(folioModel(catalog, "gpt-6.1-terra", "openai-api")).toBeUndefined();
  });

  it("offer the plan's newest model of each line, Sol first, and earlier ones apart", () => {
    // Pi's built-in list for the plan, with Terra declared by Folio.
    expect(offerFor(catalog, "chatgpt", [])).toEqual({
      models: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-luna"],
      older: ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"],
    });
    expect(offered(catalog, "chatgpt/gpt-5.6-sol", [])).toBe(true);
    // Pi's OpenAI catalog has gpt-5.5, but the plan refuses it, and Pi doesn't list it for the plan.
    expect(catalog.getModel("openai", "gpt-5.5")).toBeDefined();
    expect(offered(catalog, "chatgpt/gpt-5.5", [])).toBe(false);
    expect(newestInLine(catalog, "gpt-5.6-sol")).toBe("gpt-6.1-sol");
    expect(newestInLine(catalog, "gpt-6.1-terra")).toBe("gpt-6.1-terra");
    expect(newestInLine(catalog, "gpt-unknown")).toBe("gpt-unknown");
  });

  it("offer an OpenAI key the plan's models its own catalog has", () => {
    // Pi's OpenAI catalog has no 6.1 Terra yet, so a key's newest Terra is 5.6.
    expect(offerFor(catalog, "openai", [])).toEqual({
      models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-terra"],
      older: ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-luna"],
    });
  });

  it("resolve every key's offered models under that key's own provider", () => {
    for (const connection of ["openai", "anthropic", "google"] as const) {
      const { models, older } =
        connection === "openai" ? offerFor(catalog, connection, []) : OFFERS[connection];
      for (const id of [...models, ...older]) {
        const model = modelFor(catalog, `${connection}/${id}`);
        expect(model?.id).toBe(id);
        expect(model?.input).toContain("image");
      }
    }
    expect(modelFor(catalog, "openai/gpt-6.1-sol")?.provider).toBe("openai-api");
    expect(modelFor(catalog, "chatgpt/gpt-6.1-sol")?.provider).toBe("openai");
    // The plan serves only the models Pi lists for it; a key reaches the rest.
    expect(modelFor(catalog, "chatgpt/gpt-5.5")).toBeUndefined();
    expect(modelFor(catalog, "openai/gpt-5.5")?.id).toBe("gpt-5.5");
  });

  it("offer the OpenRouter models the student picked, grouped by lab", () => {
    for (const id of DEFAULT_OPENROUTER)
      expect(modelFor(catalog, `openrouter/${id}`)).toBeDefined();
    const groups = modelGroups(catalog, new Set(["chatgpt", "openrouter"]), [
      "deepseek/deepseek-v4-pro",
      "anthropic/claude-sonnet-5.5",
    ]);
    expect(groups.map((group) => [group.connection, group.connected])).toEqual([
      ["chatgpt", true],
      ["openai", false],
      ["anthropic", false],
      ["google", false],
      ["openrouter", true],
    ]);
    expect(groups.at(-1)!.models).toEqual([
      {
        ref: "openrouter/deepseek/deepseek-v4-pro",
        name: "DeepSeek V4 Pro 0423",
        lab: "DeepSeek",
        images: false,
      },
      {
        ref: "openrouter/anthropic/claude-sonnet-5.5",
        name: "Claude Sonnet 5.5",
        lab: "Anthropic",
        images: true,
      },
    ]);
    expect(
      offered(catalog, "openrouter/deepseek/deepseek-v4-pro", ["deepseek/deepseek-v4-pro"]),
    ).toBe(true);
    expect(offered(catalog, "openrouter/deepseek/deepseek-v4-pro", [])).toBe(false);
  });

  it("list OpenRouter's catalog for choosing, without batch variants", () => {
    const all = openrouterCatalog(catalog);
    expect(all.length).toBeGreaterThan(100);
    expect(all.every((model) => model.lab && !model.ref.endsWith(":batch"))).toBe(true);
    expect(modelFor(catalog, "openrouter/anthropic/claude-sonnet-5.5:batch")).toBeUndefined();
  });
});
