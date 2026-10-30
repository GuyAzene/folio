/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
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
    await page.keyboard.press("Meta+Comma");
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
});
