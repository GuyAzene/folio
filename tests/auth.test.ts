import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import type { OAuthCredential, OAuthAuth } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createFolioModels, readConnectionStatus } from "../src/auth.ts";

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
    expect((await store.read("openai"))?.refresh).toBe("synthetic-refresh");
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
    expect((await a.store.read("openai"))?.refresh).toBe("synthetic-refresh");
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
    expect((await store.read("openai"))?.access).toBe("synthetic-replacement");
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
    expect((await store.read("openai"))?.refresh).toBe("synthetic-rotated");
  });

  it("rejects putting protected connection data in the repository", async () => {
    await expect(createFolioModels({ home: resolve(".folio-credentials") })).rejects.toThrow(
      "outside the project",
    );
  });
});
