/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import type { FolioApi, ModelsView } from "../../src/desktop/api.ts";
import { launch, type Running } from "./app.ts";
import { seedHome } from "./seed.ts";

/**
 * Keys and "which model does what", in a real window over the Electron bridge: a synthetic
 * OpenRouter key and a config.json written beforehand, read back through Settings, changed from
 * the window and removed. Run with `vp run test:electron`; nothing here talks to a model, and no
 * key is ever checked with a provider (a key that can't be real is refused before it leaves).
 */

const running: Running[] = [];
const catalogs: { close: () => Promise<void> }[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
  await Promise.allSettled(catalogs.map((catalog) => catalog.close()));
});

declare global {
  interface Window {
    folio: FolioApi;
  }
}

void describe("connections and models", () => {
  void it("reads keys and config.json, writes changes back, and removes a key", async () => {
    const seeded = await seedHome("A synthetic reply.");
    const connection = await mkdtemp(resolve(tmpdir(), "folio-e2e-keys-"));
    const keys = resolve(connection, "keys.json");
    await writeFile(
      keys,
      JSON.stringify({
        version: 1,
        keys: {
          openrouter: {
            type: "api_key",
            key: "sk-or-synthetic-0123456789",
            addedAt: "2026-10-30T00:00:00.000Z",
          },
        },
      }),
      { mode: 0o600 },
    );
    const config = resolve(seeded.home, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        studying: {
          writer: "openrouter/deepseek/deepseek-v4-pro",
          reader: "openrouter/deepseek/deepseek-v4-pro",
        },
      }),
    );
    const app = await launch(seeded.home, { FOLIO_CONNECTION_HOME: connection });
    running.push(app);
    const { page } = app;
    await page.waitForFunction(() => "folio" in window);

    const boot = await page.evaluate(() => window.folio.bootstrap());
    const connected = (models: ModelsView) =>
      models.connections.filter((each) => each.connected).map((each) => each.id);
    assert.deepEqual(connected(boot.models), ["openrouter"]);
    assert.equal(boot.models.roles.writer, "openrouter/deepseek/deepseek-v4-pro");
    // A text-only reader can't read slides: reported, and the default (a ChatGPT model) reads.
    assert.match(boot.models.roles.reader, /^chatgpt\//);
    assert.match(
      boot.models.problems.join(" "),
      /studying\.reader: DeepSeek V4 Pro .* reads text only/,
    );
    const openrouter = boot.models.groups.find((group) => group.connection === "openrouter")!;
    assert.ok(openrouter.connected && openrouter.models.length > 0);

    // Settings shows the problem, and a change from the window lands in the file.
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.getByRole("button", { name: "Models" }).click();
    await page.getByText("Folio couldn't use some of config.json").waitFor();
    await page.evaluate(() => window.folio.setRoleModel("planner", "chatgpt/gpt-6.1-sol"));
    const saved = JSON.parse(await readFile(config, "utf8"));
    assert.equal(saved.studying.planner, "chatgpt/gpt-6.1-sol");
    assert.equal(saved.studying.reader, "openrouter/deepseek/deepseek-v4-pro");
    await assert.rejects(
      page.evaluate(() =>
        window.folio.setRoleModel("reader", "openrouter/deepseek/deepseek-v4-pro"),
      ),
      /reads text only/,
    );

    // A key that can't be real never leaves the Mac; removing one empties its entry.
    await assert.rejects(
      page.evaluate(() => window.folio.saveKey("anthropic", "short")),
      /Paste the whole key/,
    );
    await page.evaluate(() => window.folio.removeKey("openrouter"));
    assert.deepEqual(JSON.parse(await readFile(keys, "utf8")).keys, {});
    const after = await page.evaluate(() => window.folio.bootstrap());
    assert.deepEqual(connected(after.models), []);
    await page.getByRole("button", { name: "Connections" }).click();
    await page.getByText("No key").first().waitFor();
  });

  void it("lists the models Pi published since its release, and keeps them when offline", async () => {
    const seeded = await seedHome("A synthetic reply.");
    const id = "synthetic-lab/synthetic-reader";
    const ref = `openrouter/${id}`;
    await writeFile(
      resolve(seeded.home, "config.json"),
      JSON.stringify({ version: 1, studying: { reader: ref } }),
    );
    const live = await startCatalog([
      {
        type: "chat",
        id,
        name: "Synthetic Lab: Synthetic Reader",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        provider: "openrouter",
        input: ["text", "image"],
        reasoning: true,
        cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      },
    ]);
    catalogs.push(live);
    const app = await launch(seeded.home, { FOLIO_MODEL_CATALOG: live.url });
    running.push(app);
    const { page } = app;
    await page.waitForFunction(() => "folio" in window);

    // Read before the list arrives, the reader's model is unknown and its default reads.
    const listed = () =>
      page.evaluate(async (wanted) => {
        const catalog = await window.folio.openrouterCatalog();
        return catalog.some((model) => model.ref === wanted);
      }, ref);
    for (let waited = 0; !(await listed()); waited += 100) {
      assert.ok(waited < 15_000, "the live list never arrived");
      await new Promise((ready) => setTimeout(ready, 100));
    }
    assert.equal(live.requests[0]?.searchParams.get("pi-version"), "1.4.0");
    // config.json is read again once its model is known.
    await page.waitForFunction(
      (wanted) => window.folio.bootstrap().then((boot) => boot.models.roles.reader === wanted),
      ref,
    );
    const kept = JSON.parse(
      await readFile(resolve(seeded.home, "catalog/openrouter.json"), "utf8"),
    );
    assert.deepEqual(
      kept.models.map((model: { id: string }) => model.id),
      [id],
    );

    // The chooser in Settings lists it under its lab.
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.getByRole("button", { name: "Models" }).click();
    await page.getByRole("button", { name: "Choose…" }).click();
    await page.getByRole("textbox", { name: "Search OpenRouter models" }).fill("synthetic");
    await page.getByRole("checkbox", { name: /Synthetic Reader/ }).waitFor();
    await app.close();

    // pi.dev can't be reached: the kept list is read at start, before config.json.
    await live.close();
    const offline = await launch(seeded.home, { FOLIO_MODEL_CATALOG: live.url });
    running.push(offline);
    await offline.page.waitForFunction(() => "folio" in window);
    const boot = await offline.page.evaluate(() => window.folio.bootstrap());
    assert.equal(boot.models.roles.reader, ref);
    assert.deepEqual(boot.models.problems, []);
  });
});

/** A synthetic pi.dev on this Mac, serving one list of OpenRouter models. */
async function startCatalog(models: unknown[]): Promise<{
  url: string;
  requests: URL[];
  close: () => Promise<void>;
}> {
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url);
    if (url.pathname !== "/api/models/providers/openrouter") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        "content-type": "application/json",
        etag: '"synthetic"',
        "last-modified": new Date(Date.now() - 60_000).toUTCString(),
      })
      .end(JSON.stringify(models));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
