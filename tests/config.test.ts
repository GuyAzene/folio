import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_ROLES, FolioConfig, readConfig } from "../src/config.ts";
import { modelCatalog } from "../src/connections.ts";
import { DEFAULT_OPENROUTER } from "../src/model-choices.ts";

const catalog = modelCatalog();
const homes: string[] = [];

async function makeHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "folio-config-test-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("which model does what", () => {
  it("uses today's ChatGPT assignments without a config file", async () => {
    const config = await FolioConfig.open(await makeHome(), catalog);
    expect(config.roles).toEqual(DEFAULT_ROLES);
    expect(config.openrouter).toEqual(DEFAULT_OPENROUTER);
    expect(config.problems).toEqual([]);
  });

  it("takes each role's model from config.json, a text-only writer included", () => {
    const state = readConfig(catalog, {
      version: 1,
      teaching: { model: "openrouter/deepseek/deepseek-v4-pro" },
      research: { model: "google/gemini-3.8-flash" },
      studying: {
        reader: "chatgpt/gpt-6.1-sol",
        writer: "openrouter/deepseek/deepseek-v4-pro",
        topics: "openrouter/deepseek/deepseek-v4-pro",
      },
      library: { syllabus: "openai/gpt-6-luna" },
      openrouter: { models: ["deepseek/deepseek-v4-pro"] },
      later: { something: "a newer Folio wrote" },
    });
    expect(state.problems).toEqual([]);
    expect(state.roles).toEqual({
      ...DEFAULT_ROLES,
      // A text-only tutor reads the page's text; Pi leaves a note where an image would be.
      teaching: "openrouter/deepseek/deepseek-v4-pro",
      research: "google/gemini-3.8-flash",
      reader: "chatgpt/gpt-6.1-sol",
      writer: "openrouter/deepseek/deepseek-v4-pro",
      topics: "openrouter/deepseek/deepseek-v4-pro",
      syllabus: "openai/gpt-6-luna",
    });
    expect(state.openrouter).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  it("reports each entry it can't use, and keeps that role's default", () => {
    const state = readConfig(catalog, {
      version: 1,
      teaching: { model: "openrouter/anthropic/claude-sonnet-5.5" },
      studying: {
        planner: "chatgpt/gpt-5.5",
        reader: "openrouter/deepseek/deepseek-v4-pro",
        checker: "xai/grok-4.7",
        writer: "anthropic/claude-opus-9",
        closeup: 7,
      },
      library: "openai/gpt-6-luna",
      openrouter: { models: ["deepseek/deepseek-v4-pro", "nobody/no-model"] },
    });
    expect(state.roles).toEqual(DEFAULT_ROLES);
    expect(state.openrouter).toEqual(["deepseek/deepseek-v4-pro"]);
    expect(state.problems).toEqual([
      "openrouter.models: OpenRouter has no model nobody/no-model that Folio knows.",
      "teaching.model: add Claude Sonnet 5.5 to the composer's OpenRouter models first.",
      "studying.planner: gpt-5.5 isn't one of the ChatGPT plan's models in Folio.",
      "studying.reader: DeepSeek V4 Pro 0423 reads text only, and reading slides needs page images.",
      "studying.closeup: write a model as connection/model, such as chatgpt/gpt-6.1-sol.",
      "studying.writer: Anthropic has no model claude-opus-9 that Folio knows.",
      "studying.checker: write a model as connection/model, such as chatgpt/gpt-6.1-sol.",
      'library: write an object, such as { "syllabus": "chatgpt/gpt-6.1-sol" }.',
    ]);
  });

  it("falls back to its defaults on a file it can't read, and never rewrites it", async () => {
    const home = await makeHome();
    const file = resolve(home, "config.json");
    for (const [text, problem] of [
      ["{ not json", "isn't valid JSON"],
      [JSON.stringify({ version: 2, teaching: { model: "chatgpt/gpt-6-luna" } }), "version 2"],
    ]) {
      await writeFile(file, text);
      const config = await FolioConfig.open(home, catalog);
      expect(config.roles).toEqual(DEFAULT_ROLES);
      expect(config.problems.join(" ")).toContain(problem);
      await expect(config.setRole("teaching", "chatgpt/gpt-6-luna")).rejects.toThrow(
        "Fix or remove it",
      );
      expect(await readFile(file, "utf8")).toBe(text);
    }
  });

  it("writes a change from Settings into the file, keeping everything else in it", async () => {
    const home = await makeHome();
    const file = resolve(home, "config.json");
    await writeFile(
      file,
      JSON.stringify({ version: 1, studying: { reader: "chatgpt/gpt-6.1-sol" }, note: "mine" }),
    );
    const config = await FolioConfig.open(home, catalog);
    await config.setRole("writer", "openrouter/deepseek/deepseek-v4-pro");
    await config.setOpenRouter(["moonshotai/kimi-k3", "moonshotai/kimi-k3"]);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved).toEqual({
      version: 1,
      studying: { reader: "chatgpt/gpt-6.1-sol", writer: "openrouter/deepseek/deepseek-v4-pro" },
      note: "mine",
      openrouter: { models: ["moonshotai/kimi-k3"] },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(config.roles.writer).toBe("openrouter/deepseek/deepseek-v4-pro");
    expect(config.openrouter).toEqual(["moonshotai/kimi-k3"]);
  });

  it("refuses a model that can't do the role, before writing anything", async () => {
    const home = await makeHome();
    const config = await FolioConfig.open(home, catalog);
    await expect(config.setRole("reader", "openrouter/deepseek/deepseek-v4-pro")).rejects.toThrow(
      "DeepSeek V4 Pro 0423 reads text only",
    );
    await expect(config.setRole("teaching", "anthropic/claude-opus-4-5")).rejects.toThrow(
      "isn't one of the composer's models",
    );
    await expect(config.setOpenRouter(["nobody/no-model"])).rejects.toThrow("OpenRouter's list");
    await expect(lstat(resolve(home, "config.json"))).rejects.toThrow();
  });

  it("refuses to overwrite an edit made outside Folio, and shows that edit instead", async () => {
    const home = await makeHome();
    const file = resolve(home, "config.json");
    const config = await FolioConfig.open(home, catalog);
    await config.setRole("reader", "chatgpt/gpt-6.1-sol");
    const edited = JSON.stringify({ version: 1, studying: { reader: "chatgpt/gpt-6-sol" } });
    await writeFile(file, edited);
    await expect(config.setRole("writer", "chatgpt/gpt-6-sol")).rejects.toThrow(
      "changed outside Folio",
    );
    expect(await readFile(file, "utf8")).toBe(edited);
    expect(config.roles.reader).toBe("chatgpt/gpt-6-sol");
    await config.setRole("writer", "chatgpt/gpt-6-sol");
    expect(JSON.parse(await readFile(file, "utf8")).studying).toEqual({
      reader: "chatgpt/gpt-6-sol",
      writer: "chatgpt/gpt-6-sol",
    });
  });

  it("writes today's choices when asked to open a file that doesn't exist yet", async () => {
    const home = await makeHome();
    const config = await FolioConfig.open(home, catalog);
    await config.ensure();
    const saved = JSON.parse(await readFile(config.path, "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.studying.writer).toBe(DEFAULT_ROLES.writer);
    expect(saved.openrouter.models).toEqual(DEFAULT_OPENROUTER);
    expect(readConfig(catalog, saved).roles).toEqual(DEFAULT_ROLES);
    const text = await readFile(config.path, "utf8");
    await config.ensure();
    expect(await readFile(config.path, "utf8")).toBe(text);
  });

  it("keeps a config.json linked from elsewhere a link", async () => {
    const home = await makeHome();
    const elsewhere = await makeHome();
    const target = resolve(elsewhere, "folio.json");
    await writeFile(target, JSON.stringify({ version: 1 }));
    await symlink(target, resolve(home, "config.json"));
    const config = await FolioConfig.open(home, catalog);
    await config.setRole("reader", "chatgpt/gpt-6.1-sol");
    expect((await lstat(resolve(home, "config.json"))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8")).studying.reader).toBe("chatgpt/gpt-6.1-sol");
  });

  it("notices an edit made by hand", async () => {
    const home = await makeHome();
    const config = await FolioConfig.open(home, catalog);
    const changed = vi.fn();
    const stop = config.watch(changed);
    try {
      await writeFile(
        config.path,
        JSON.stringify({ version: 1, teaching: { model: "chatgpt/gpt-6-luna" } }),
      );
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 3_000 });
      expect(config.roles.teaching).toBe("chatgpt/gpt-6-luna");
    } finally {
      stop();
    }
  });
});
