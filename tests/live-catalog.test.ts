import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { FolioConfig } from "../src/config.ts";
import { modelCatalog } from "../src/connections.ts";
import {
  CHECK_EVERY_MS,
  LiveCatalog,
  liveModel,
  liveModels,
  liveSource,
  PI_CATALOG,
  PI_LIST_MADE,
  PI_VERSION,
} from "../src/live-catalog.ts";
import { modelFor, openrouterCatalog } from "../src/model-choices.ts";
import { expectMode } from "./fixtures/modes.ts";

const homes: string[] = [];

async function makeHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "folio-live-catalog-test-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const OPENROUTER = "https://openrouter.ai/api/v1";
const BASES = new Map([
  ["openai-completions", OPENROUTER],
  ["anthropic-messages", "https://openrouter.ai/api"],
]);
const NEW_ID = "synthetic-lab/synthetic-reader";
const NEW_REF = `openrouter/${NEW_ID}`;

/** A synthetic live entry in the shape pi.dev publishes, with `fields` changed. */
function entry(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "chat",
    id: NEW_ID,
    name: "Synthetic Lab: Synthetic Reader",
    api: "openai-completions",
    baseUrl: OPENROUTER,
    provider: "openrouter",
    input: ["text", "image"],
    reasoning: true,
    thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high" },
    cost: {
      input: 1,
      output: 4,
      cacheRead: 0.1,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 200_000, input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 }],
    },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: "openrouter",
      supportsStrictMode: true,
    },
    inputLimits: {
      images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } },
    },
    ...fields,
  };
}

const AFTER_PI = new Date(PI_LIST_MADE + 86_400_000).toUTCString();

/** A pi.dev that answers from `answer`, keeping each request's URL and headers. */
function piDev(answer: (request: { url: URL; headers: Record<string, string> }) => Response) {
  const requests: { url: URL; headers: Record<string, string> }[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    const request = {
      url: new URL(input),
      headers: { ...(init?.headers as Record<string, string>) },
    };
    requests.push(request);
    return answer(request);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const list = (entries: unknown[], headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(entries), {
    headers: { etag: '"one"', "last-modified": AFTER_PI, ...headers },
  });

describe("an entry from the live list", () => {
  it("is used in the shape Folio's Pi release knows, at OpenRouter's own address", () => {
    const model = liveModel(
      entry({ samplingParams: { temperature: 2 }, unknown: true }),
      "openrouter",
      BASES,
    )!;
    expect(model.id).toBe(NEW_ID);
    expect(model.baseUrl).toBe(OPENROUTER);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost.tiers).toHaveLength(1);
    expect(model.thinkingLevelMap?.medium).toBeNull();
    expect(Object.keys(model)).not.toContain("samplingParams");
    expect(Object.keys(model)).not.toContain("unknown");
  });

  it("never carries headers, and never another address", () => {
    const withHeaders = liveModel(entry({ headers: { "x-extra": "1" } }), "openrouter", BASES)!;
    expect(withHeaders.headers).toBeUndefined();
    for (const baseUrl of [
      "https://elsewhere.example/v1",
      "http://openrouter.ai/api/v1",
      undefined,
    ])
      expect(liveModel(entry({ baseUrl }), "openrouter", BASES)).toBeUndefined();
    // Each API has its own address.
    expect(liveModel(entry({ api: "anthropic-messages" }), "openrouter", BASES)).toBeUndefined();
    expect(
      liveModel(
        entry({
          api: "anthropic-messages",
          baseUrl: "https://openrouter.ai/api",
          compat: undefined,
        }),
        "openrouter",
        BASES,
      )?.baseUrl,
    ).toBe("https://openrouter.ai/api");
  });

  it("is refused when it is not a chat model Folio can check", () => {
    const refused = [
      entry({ type: "image" }),
      entry({ type: "classifier" }),
      entry({ provider: "moonshotai" }),
      entry({ api: "openai-responses" }),
      entry({ id: "auto" }),
      entry({ id: "../escape" }),
      entry({ id: 7 }),
      entry({ name: "" }),
      entry({ name: "Line\nbreak" }),
      entry({ input: ["image"] }),
      entry({ input: ["text", "audio"] }),
      entry({ reasoning: "yes" }),
      entry({ contextWindow: 0 }),
      entry({ maxTokens: 1.5 }),
      entry({ cost: { input: -1, output: -1, cacheRead: 0, cacheWrite: 0 } }),
      entry({ cost: { input: 1, output: 1 } }),
      entry({
        cost: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          tiers: [{ inputTokensAbove: 1, input: -2, output: 1, cacheRead: 0, cacheWrite: 0 }],
        },
      }),
      entry({ thinkingLevelMap: { high: 3 } }),
      entry({ compat: { thinkingFormat: "something-new" } }),
      entry({ inputLimits: { images: { resize: { jpegQuality: 500 } } } }),
      "not an object",
      null,
    ];
    for (const each of refused) expect(liveModel(each, "openrouter", BASES)).toBeUndefined();
  });

  it("is listed once by its ID, the first one winning", () => {
    const models = liveModels("openrouter", [
      entry({ name: "Synthetic Lab: First" }),
      entry({ name: "Synthetic Lab: Second" }),
      entry({ id: "auto" }),
    ]);
    expect(models.map((model) => model.name)).toEqual(["Synthetic Lab: First"]);
  });
});

describe("the live list", () => {
  it("names the Pi release Folio ships and when its own list was made", async () => {
    const pinned = JSON.parse(await readFile("package.json", "utf8")).dependencies[
      "@earendil-works/pi-ai"
    ];
    expect(PI_VERSION).toBe(pinned);
    expect(PI_LIST_MADE).toBe(getBuiltinModelDataGeneratedAt());
  });

  it("asks pi.dev for this Pi release's list, and lists its models with Pi's own", async () => {
    const home = await makeHome();
    const existing = "deepseek/deepseek-v4-pro";
    const { fetch, requests } = piDev(() =>
      list([
        entry(),
        entry({
          id: existing,
          name: "DeepSeek: DeepSeek V4 Pro",
          input: ["text"],
          cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
        }),
      ]),
    );
    const live = new LiveCatalog({ home, fetch });
    await live.load();
    const catalog = modelCatalog(live);
    const builtIn = catalog.getModels("openrouter").length;
    expect(modelFor(catalog, NEW_REF)).toBeUndefined();

    expect(await live.refresh()).toBe(true);
    const [request] = requests;
    expect(request!.url.origin).toBe(PI_CATALOG);
    expect(request!.url.pathname).toBe("/api/models/providers/openrouter");
    expect(request!.url.searchParams.get("pi-version")).toBe(PI_VERSION);
    expect(request!.url.searchParams.get("types")).toBe("chat");
    expect(Object.keys(request!.headers)).toEqual(["accept"]);

    expect(catalog.getModels("openrouter")).toHaveLength(builtIn + 1);
    expect(modelFor(catalog, NEW_REF)?.baseUrl).toBe(OPENROUTER);
    expect(openrouterCatalog(catalog).find((model) => model.ref === NEW_REF)).toMatchObject({
      lab: "Synthetic Lab",
      name: "Synthetic Reader",
      images: true,
    });
    // A live entry replaces Pi's built-in one with its ID.
    expect(catalog.getModel("openrouter", existing)?.cost.input).toBe(9);
  });

  it("keeps the list in Folio's home, readable only by the student, and reads it back offline", async () => {
    const home = await makeHome();
    const live = new LiveCatalog({ home, fetch: piDev(() => list([entry()])).fetch });
    await live.load();
    await live.refresh();
    const file = resolve(home, "catalog/openrouter.json");
    await expectMode(file, 0o600);
    await expectMode(resolve(home, "catalog"), 0o700);

    const offline = piDev(() => {
      throw new Error("offline");
    });
    const again = new LiveCatalog({ home, fetch: offline.fetch });
    await again.load();
    expect(again.models("openrouter").map((model) => model.id)).toEqual([NEW_ID]);
    // Checked a moment ago: nothing is asked for four hours.
    expect(await again.refresh()).toBe(false);
    expect(offline.requests).toHaveLength(0);
  });

  it("checks again after four hours with its validator, and keeps the list when nothing changed", async () => {
    const home = await makeHome();
    let now = PI_LIST_MADE + 10 * 86_400_000;
    let answer: Response = list([entry()]);
    const { fetch, requests } = piDev(() => answer);
    const live = new LiveCatalog({ home, fetch, now: () => now });
    await live.load();
    await live.refresh();
    now += CHECK_EVERY_MS - 1;
    expect(await live.refresh()).toBe(false);
    expect(requests).toHaveLength(1);

    now += 2;
    answer = new Response(null, { status: 304 });
    expect(await live.refresh()).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers["if-none-match"]).toBe('"one"');
    expect(live.models("openrouter")).toHaveLength(1);
    // The check is remembered: no request until four hours from it.
    expect(await live.refresh()).toBe(false);
    expect(requests).toHaveLength(2);

    answer = list([entry({ name: "Synthetic Lab: Renamed" })], { etag: '"two"' });
    expect(await live.refresh({ force: true })).toBe(true);
    expect(live.models("openrouter")[0]!.name).toBe("Synthetic Lab: Renamed");
  });

  it("keeps the kept list when pi.dev can't be reached or answers badly, and never throws", async () => {
    const home = await makeHome();
    let answer: () => Response = () => list([entry()]);
    const { fetch } = piDev(() => answer());
    const live = new LiveCatalog({ home, fetch });
    await live.load();
    await live.refresh();
    const failures: (() => Response)[] = [
      () => {
        throw new Error("offline");
      },
      () => new Response("busy", { status: 500 }),
      () => new Response("{not json", { headers: { "last-modified": AFTER_PI } }),
      () => new Response("[]", { headers: { "content-length": String(9 * 1024 * 1024) } }),
      () => new Response(`[${" ".repeat(9 * 1024 * 1024)}]`),
    ];
    for (const failure of failures) {
      answer = failure;
      expect(await live.refresh({ force: true })).toBe(false);
      expect(live.models("openrouter").map((model) => model.id)).toEqual([NEW_ID]);
    }
  });

  it("drops the list when pi.dev has none for this Pi release", async () => {
    const home = await makeHome();
    let answer = list([entry()]);
    const live = new LiveCatalog({ home, fetch: piDev(() => answer).fetch });
    await live.load();
    await live.refresh();
    answer = new Response("no list", { status: 404 });
    expect(await live.refresh({ force: true })).toBe(true);
    expect(live.models("openrouter")).toEqual([]);
  });

  it("is not used while it is no newer than the list built into Pi", async () => {
    const home = await makeHome();
    const older = new Date(PI_LIST_MADE - 86_400_000).toUTCString();
    const live = new LiveCatalog({
      home,
      fetch: piDev(() => list([entry()], { "last-modified": older })).fetch,
    });
    await live.load();
    expect(await live.refresh()).toBe(false);
    expect(live.models("openrouter")).toEqual([]);
    expect(modelFor(modelCatalog(live), NEW_REF)).toBeUndefined();
  });

  it("asks once when checked twice at the same time", async () => {
    const home = await makeHome();
    const { fetch, requests } = piDev(() => list([entry()]));
    const live = new LiveCatalog({ home, fetch });
    await live.load();
    const [first, second] = await Promise.all([live.refresh(), live.refresh()]);
    expect([first, second]).toEqual([true, true]);
    expect(requests).toHaveLength(1);
  });

  it("checks what it reads back: an edited or broken file is no list, or only its usable part", async () => {
    const home = await makeHome();
    const live = new LiveCatalog({ home, fetch: piDev(() => list([entry()])).fetch });
    await live.load();
    await live.refresh();
    const file = resolve(home, "catalog/openrouter.json");
    const kept = JSON.parse(await readFile(file, "utf8"));
    kept.models.push({
      ...kept.models[0],
      id: "synthetic-lab/elsewhere",
      baseUrl: "https://elsewhere.example/v1",
    });
    await writeFile(file, JSON.stringify(kept));
    const edited = new LiveCatalog({ home, source: null });
    await edited.load();
    expect(edited.models("openrouter").map((model) => model.id)).toEqual([NEW_ID]);

    await writeFile(file, "{broken");
    const broken = new LiveCatalog({ home, source: null });
    await broken.load();
    expect(broken.models("openrouter")).toEqual([]);
  });

  it("is never asked for when it is off, and only an https address or this Mac may replace pi.dev", async () => {
    const home = await makeHome();
    const { fetch, requests } = piDev(() => list([entry()]));
    const live = new LiveCatalog({ home, source: null, fetch });
    await live.load();
    expect(await live.refresh({ force: true })).toBe(false);
    expect(requests).toHaveLength(0);
    expect(liveSource(undefined)).toBe(PI_CATALOG);
    expect(liveSource("off")).toBeNull();
    expect(liveSource("http://catalog.example")).toBeNull();
    expect(liveSource("not a url")).toBeNull();
    expect(liveSource("http://127.0.0.1:8123")).toBe("http://127.0.0.1:8123");
    expect(liveSource("https://catalog.example")).toBe("https://catalog.example");
  });

  it("makes a config.json entry usable once its model arrives", async () => {
    const home = await makeHome();
    await writeFile(
      resolve(home, "config.json"),
      JSON.stringify({ version: 1, studying: { reader: NEW_REF } }),
    );
    const live = new LiveCatalog({ home, fetch: piDev(() => list([entry()])).fetch });
    await live.load();
    const config = await FolioConfig.open(home, modelCatalog(live));
    expect(config.roles.reader).not.toBe(NEW_REF);
    expect(config.problems.join(" ")).toContain(NEW_ID);

    await live.refresh();
    expect(await config.reload()).toBe(true);
    expect(config.roles.reader).toBe(NEW_REF);
    expect(config.problems).toEqual([]);
  });
});
