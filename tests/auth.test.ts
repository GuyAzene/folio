import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import type { OAuthCredential, OAuthAuth } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createFolioModels, readConnections, readConnectionStatus } from "../src/auth.ts";

const run = promisify(execFile);
const homes: string[] = [];
const fixture = (expires = Date.now() + 3_600_000): OAuthCredential => ({
  type: "oauth",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires,
  clientId: "synthetic-client",
  scopes: ["chatgpt.tokens.use.direct"],
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "folio-auth-test-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("Folio ChatGPT connection", () => {
  it("keeps a stable installation ID and private versioned connection across restarts and logout", async () => {
    const home = await makeHome();
    const first = await createFolioModels({ home });
    expect(await readConnectionStatus(first.store)).toEqual({ connected: false });
    await first.store.modify("openai", async () => fixture());
    const restarted = await createFolioModels({ home });
    expect(restarted.store.getDeviceId()).toBe(first.store.getDeviceId());
    expect((await readConnectionStatus(restarted.store)).connected).toBe(true);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(resolve(home, "connection.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(resolve(home, "connection.json"), "utf8")).version).toBe(1);
    await restarted.models.logout("openai");
    expect(await readConnectionStatus(first.store)).toEqual({ connected: false });
    expect((await createFolioModels({ home })).store.getDeviceId()).toBe(first.store.getDeviceId());
  });

  it("cannot use a shell API key or save an API-key credential", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-synthetic-never-use";
    try {
      const { models, store } = await createFolioModels({ home: await makeHome() });
      expect(await models.getAuth("openai")).toBeUndefined();
      expect(models.getProvider("openai")?.auth.apiKey).toBeUndefined();
      await expect(
        store.modify("openai", async () => ({ type: "api_key", key: "sk-synthetic" })),
      ).rejects.toThrow("Invalid Folio ChatGPT connection");
      expect(await store.list()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("does not overwrite malformed or future-format stored data", async () => {
    const home = await makeHome();
    const file = resolve(home, "connection.json");
    await writeFile(file, JSON.stringify({ version: 22 }), { mode: 0o600 });
    await expect(createFolioModels({ home })).rejects.toThrow("Unsupported or invalid");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 22 });
  });

  it("recovers an abandoned stale lock after a process has stopped", async () => {
    const home = await makeHome();
    const first = await createFolioModels({ home });
    await mkdir(resolve(home, "connection.lock"));
    const old = new Date(Date.now() - 60_000);
    await utimes(resolve(home, "connection.lock"), old, old);
    const restarted = await createFolioModels({ home });
    expect(restarted.store.getDeviceId()).toBe(first.store.getDeviceId());
  });

  it("sanitizes token-endpoint diagnostics while preserving the stored renewable session", async () => {
    const { models, store } = await createFolioModels({ home: await makeHome() });
    await store.modify("openai", async () => fixture(1));
    vi.stubGlobal(
      "fetch",
      async () => new Response("synthetic-sensitive-response-body", { status: 400 }),
    );
    let failure: unknown;
    try {
      await models.getAuth("openai");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const cause = (failure as Error & { cause: Error }).cause;
    expect(cause.message).toBe(
      "ChatGPT connection renewal failed. Run the login command to reconnect.",
    );
    expect(cause.cause).toBeUndefined();
    expect(((await store.read("openai")) as OAuthCredential | undefined)?.refresh).toBe(
      "synthetic-refresh",
    );
  });

  it("serializes refreshes across store instances and preserves a failed refresh", async () => {
    const home = await makeHome();
    const a = await createFolioModels({ home });
    const b = await createFolioModels({ home });
    await a.store.modify("openai", async () => fixture(1));
    let refreshes = 0;
    const oauth: OAuthAuth = {
      name: "Synthetic subscription",
      login: async () => {
        throw new Error("No login in tests");
      },
      refresh: async () => {
        refreshes++;
        await setTimeout(60);
        return fixture();
      },
      toAuth: async (credential) => ({ apiKey: credential.access }),
    };
    for (const { models } of [a, b]) {
      models.setProvider({ ...models.getProvider("openai")!, auth: { oauth } });
    }
    const results = await Promise.all([a.models.getAuth("openai"), b.models.getAuth("openai")]);
    expect(refreshes).toBe(1);
    expect(results.every((result) => result?.source === "OAuth")).toBe(true);
    await a.store.modify("openai", async () => fixture(1));
    a.models.setProvider({
      ...a.models.getProvider("openai")!,
      auth: {
        oauth: {
          ...oauth,
          refresh: async () => {
            throw new Error("synthetic refresh failure");
          },
        },
      },
    });
    await expect(a.models.getAuth("openai")).rejects.toThrow("OAuth refresh failed");
    expect(((await a.store.read("openai")) as OAuthCredential | undefined)?.refresh).toBe(
      "synthetic-refresh",
    );
  });

  it("serializes rotating-token refresh across separate processes", async () => {
    const home = await makeHome();
    const { store } = await createFolioModels({ home });
    await store.modify("openai", async () => fixture(1));
    const source = new URL("../src/auth.ts", import.meta.url).href;
    const trace = resolve(home, "synthetic-refreshes.txt");
    const program = `
      import { createFolioModels } from ${JSON.stringify(source)};
      import { appendFile } from 'node:fs/promises';
      import { setTimeout } from 'node:timers/promises';
      const { models } = await createFolioModels({home:${JSON.stringify(home)}});
      models.setProvider({...models.getProvider('openai'),auth:{oauth:{
        name:'Synthetic',login:async()=>{throw Error('not used')},
        toAuth:async c=>({apiKey:c.access}),refresh:async c=>{
          await appendFile(${JSON.stringify(trace)},'refresh\\n');
          await setTimeout(100);
          return {...c,access:'synthetic-replacement',expires:Date.now()+3600000};
        }
      }}});
      await models.getAuth('openai');
    `;
    await Promise.all([
      run(process.execPath, ["--input-type=module", "--eval", program]),
      run(process.execPath, ["--input-type=module", "--eval", program]),
    ]);
    expect(await readFile(trace, "utf8")).toBe("refresh\n");
    expect(((await store.read("openai")) as OAuthCredential | undefined)?.access).toBe(
      "synthetic-replacement",
    );
  });

  it("cancels waiting for a credential update and commits an already-rotated token", async () => {
    const { store } = await createFolioModels({ home: await makeHome() });
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = store.modify("openai", async () => {
      entered();
      await gate;
      return fixture();
    });
    await enteredPromise;
    const canceled = new AbortController();
    const waiter = store.modify(
      "openai",
      async () => {
        throw new Error("must not run");
      },
      { signal: canceled.signal },
    );
    canceled.abort();
    await expect(waiter).rejects.toThrow();
    release();
    await active;
    const rotated = new AbortController();
    await store.modify(
      "openai",
      async () => {
        rotated.abort();
        return { ...fixture(), refresh: "synthetic-rotated" };
      },
      { signal: rotated.signal },
    );
    expect(((await store.read("openai")) as OAuthCredential | undefined)?.refresh).toBe(
      "synthetic-rotated",
    );
  });

  it("rejects putting protected connection data in the repository", async () => {
    await expect(createFolioModels({ home: resolve(".folio-credentials") })).rejects.toThrow(
      "outside the project",
    );
  });
});

describe("Folio's API keys", () => {
  const key = (value = "sk-synthetic-0123456789") => ({ type: "api_key" as const, key: value });

  it("keep each key in a private file apart from the ChatGPT sign-in, and remove it", async () => {
    const home = await makeHome();
    const { models, store } = await createFolioModels({ home });
    await store.modify("openai", async () => fixture());
    const signIn = await readFile(resolve(home, "connection.json"), "utf8");
    await store.modify("anthropic", async () => key("sk-ant-synthetic-0123"));
    await store.modify("openrouter", async () => key("sk-or-synthetic-4567"));
    expect(await readFile(resolve(home, "connection.json"), "utf8")).toBe(signIn);
    expect((await stat(resolve(home, "keys.json"))).mode & 0o777).toBe(0o600);
    expect([...(await readConnections(store))].sort()).toEqual([
      "anthropic",
      "chatgpt",
      "openrouter",
    ]);
    expect((await models.getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-synthetic-0123");
    const restarted = await createFolioModels({ home });
    expect((await restarted.models.getAuth("openrouter"))?.auth.apiKey).toBe(
      "sk-or-synthetic-4567",
    );
    await restarted.models.logout("anthropic");
    expect(await models.getAuth("anthropic")).toBeUndefined();
    expect([...(await readConnections(store))].sort()).toEqual(["chatgpt", "openrouter"]);
    expect(await readFile(resolve(home, "connection.json"), "utf8")).toBe(signIn);
  });

  it("never read a key from the shell or a provider's own sign-in", async () => {
    const names = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"];
    const previous = names.map((name) => process.env[name]);
    for (const name of names) process.env[name] = "sk-synthetic-never-use";
    try {
      const { models } = await createFolioModels({ home: await makeHome() });
      for (const provider of ["openai", "openai-api", "anthropic", "google", "openrouter"])
        expect(await models.getAuth(provider)).toBeUndefined();
      for (const provider of ["openai-api", "anthropic", "google", "openrouter"])
        expect(models.getProvider(provider)?.auth.oauth).toBeUndefined();
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });

  it("send OpenAI API models to the API on the key, never as a ChatGPT sign-in", async () => {
    const { models, store } = await createFolioModels({ home: await makeHome() });
    await store.modify("openai-api", async () => key());
    const model = models.getModel("openai-api", "gpt-6.1-sol")!;
    expect(model.provider).toBe("openai-api");
    expect(model.baseUrl).toBe("https://api.openai.com/v1");
    expect((await models.getAuth(model))?.auth.apiKey).toBe("sk-synthetic-0123456789");
    expect(await models.getAuth("openai")).toBeUndefined();
  });

  it("refuse keys that can't be real, and providers Folio doesn't connect to", async () => {
    const home = await makeHome();
    const { store } = await createFolioModels({ home });
    for (const bad of ["short", "has a space in it", "line\nbreak-0123456789"])
      await expect(store.modify("anthropic", async () => key(bad))).rejects.toThrow(
        "Invalid API key",
      );
    await expect(store.modify("xai", async () => key())).rejects.toThrow("does not connect");
    expect(await store.list()).toEqual([]);
  });

  it("keep keys of providers a newer Folio added, and never overwrite a future format", async () => {
    const home = await makeHome();
    const file = resolve(home, "keys.json");
    const { store } = await createFolioModels({ home });
    const later = {
      type: "api_key",
      key: "sk-later-0123456789",
      addedAt: "2026-11-01T00:00:00.000Z",
    };
    await writeFile(file, JSON.stringify({ version: 1, keys: { later } }), { mode: 0o600 });
    await store.modify("google", async () => key("AIza-synthetic-0123"));
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.keys.later).toEqual(later);
    expect(saved.keys.google.key).toBe("AIza-synthetic-0123");
    await writeFile(file, JSON.stringify({ version: 2 }), { mode: 0o600 });
    await expect(store.read("google")).rejects.toThrow("Unsupported or invalid");
    await expect(store.modify("google", async () => key())).rejects.toThrow("Unsupported");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 2 });
  });
});
