import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { describe, expect, it } from "vite-plus/test";
import { folioModel } from "../src/model-catalog.ts";
import { OFFERED_MODELS, SUBSCRIPTIONS } from "../src/model-choices.ts";

const catalog = createModels();
catalog.setProvider(openaiProvider());

describe("the models Folio offers", () => {
  it("resolve every offered model, Terra included, from Pi or Folio's declarations", () => {
    for (const id of OFFERED_MODELS) expect(folioModel(catalog, id)?.id).toBe(id);
    const terra = folioModel(catalog, "gpt-6.1-terra")!;
    const sol = folioModel(catalog, "gpt-6.1-sol")!;
    expect(terra.name).toBe("GPT-6.1 Terra");
    expect(terra.api).toBe(sol.api);
    expect(terra.contextWindow).toBe(sol.contextWindow);
    expect(folioModel(catalog, "gpt-unknown")).toBeUndefined();
  });

  it("offer older models apart, and still accept them", () => {
    const chatgpt = SUBSCRIPTIONS.find((subscription) => subscription.provider === "openai")!;
    expect(chatgpt.models).toEqual(["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-luna"]);
    expect(chatgpt.older).toEqual(["gpt-6-sol", "gpt-5.6-sol"]);
    expect(OFFERED_MODELS).toContain("gpt-5.6-sol");
  });
});
