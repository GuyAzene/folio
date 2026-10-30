import { describe, expect, it } from "vite-plus/test";
import { checkKey } from "../src/connections.ts";
import { formatRef, parseRef, refOf } from "../src/model-refs.ts";

type Seen = { url: string; headers: Record<string, string> };

function answering(status: number, body = "synthetic-sensitive-body sk-synthetic") {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: init?.headers as Record<string, string> });
    return new Response(body, { status });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

describe("checking an API key", () => {
  it("asks each provider with its own header, and accepts what it accepts", async () => {
    const cases = [
      ["openai", "https://api.openai.com/v1/models", "authorization", "Bearer sk-synthetic-0123"],
      ["anthropic", "https://api.anthropic.com/v1/models", "x-api-key", "sk-synthetic-0123"],
      [
        "google",
        "https://generativelanguage.googleapis.com/v1beta/models",
        "x-goog-api-key",
        "sk-synthetic-0123",
      ],
      [
        "openrouter",
        "https://openrouter.ai/api/v1/key",
        "authorization",
        "Bearer sk-synthetic-0123",
      ],
    ] as const;
    for (const [id, url, header, value] of cases) {
      const { fetch, seen } = answering(200);
      await checkKey(id, "  sk-synthetic-0123\n", { fetch });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(url);
      expect(seen[0]!.headers[header]).toBe(value);
    }
  });

  it("says a refused key was refused, without the provider's answer", async () => {
    for (const [id, status] of [
      ["openai", 401],
      ["anthropic", 403],
      ["google", 400],
      ["openrouter", 401],
    ] as const) {
      const failure = await checkKey(id, "sk-synthetic-0123", answering(status)).catch(
        (error: Error) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/refused this key/);
      expect((failure as Error).message).not.toMatch(/sensitive|sk-synthetic/);
    }
  });

  it("tells an unreachable provider and a provider error apart from a refusal", async () => {
    await expect(
      checkKey("anthropic", "sk-synthetic-0123", {
        fetch: (async () => {
          throw new TypeError("synthetic network failure");
        }) as typeof fetch,
      }),
    ).rejects.toThrow("couldn't reach Anthropic");
    await expect(checkKey("openai", "sk-synthetic-0123", answering(500))).rejects.toThrow(
      "couldn't check the key right now (500)",
    );
    await expect(checkKey("openai", "sk-synthetic-0123", answering(400))).rejects.toThrow("(400)");
  });

  it("refuses a key before anything leaves Folio when it can't be real", async () => {
    const { fetch, seen } = answering(200);
    await expect(checkKey("anthropic", "short", { fetch })).rejects.toThrow("Paste the whole key");
    await expect(checkKey("anthropic", "two words-0123456789", { fetch })).rejects.toThrow(
      "doesn't look like",
    );
    await expect(checkKey("chatgpt", "sk-synthetic-0123", { fetch })).rejects.toThrow(
      "does not take a key",
    );
    expect(seen).toHaveLength(0);
  });
});

describe("model references", () => {
  it("name a model on a connection, with slashes kept in the model's ID", () => {
    expect(parseRef("chatgpt/gpt-6.1-sol")).toMatchObject({
      connection: { id: "chatgpt", provider: "openai" },
      id: "gpt-6.1-sol",
    });
    expect(parseRef("openrouter/deepseek/deepseek-v4-pro")).toMatchObject({
      connection: { id: "openrouter" },
      id: "deepseek/deepseek-v4-pro",
    });
    for (const bad of ["gpt-6.1-sol", "/gpt", "chatgpt/", "xai/grok-4.7", "openai/has space", 7])
      expect(parseRef(bad)).toBeUndefined();
    expect(formatRef("anthropic", "claude-opus-5-5")).toBe("anthropic/claude-opus-5-5");
    expect(refOf("openai", "gpt-6-sol")).toBe("chatgpt/gpt-6-sol");
    expect(refOf("openai-api", "gpt-6-sol")).toBe("openai/gpt-6-sol");
  });
});
