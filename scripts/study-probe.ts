/**
 * Measures what studying can ask of the ChatGPT plan before its defaults are chosen: how long
 * one careful page read takes at each effort, how many reads can run at once before the plan
 * pushes back, and whether repeated requests are served from the prompt cache. It spends the
 * student's plan, so it runs only with FOLIO_PROBE=1, and only on synthetic slides.
 *
 *   FOLIO_PROBE=1 vp run study:probe [--burst 8,12] [--efforts medium,high,xhigh,max]
 *
 * Results print as a table and are kept in .bench/probe-<time>.json (git-ignored).
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels, type ThinkingLevel } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createFolioModels, readConnectionStatus } from "../src/auth.ts";
import { folioHome } from "../src/home.ts";
import { png, text, type CompleteFn, type ModelRequest } from "../src/ingest/models.ts";
import { cacheKey, type PreparedSource } from "../src/ingest/pipeline.ts";
import { piComplete } from "../src/ingest/pi-complete.ts";
import { READER_SYSTEM, readerSchema } from "../src/ingest/prompts.ts";
import { prepareSource } from "../src/ingest/source.ts";
import type { PageInventory } from "../src/ingest/types.ts";
import { folioModel } from "../src/model-catalog.ts";
import { studyDecks } from "../tests/fixtures/study-decks.ts";

/** The size pages are read at, as in the pipeline. */
const READ_EDGE = 1568;
const MODEL = "gpt-6.1-sol";

interface Call {
  label: string;
  effort: ThinkingLevel;
  seconds: number;
  input: number;
  cached: number;
  output: number;
  ok: boolean;
  error: string | null;
}

async function chatgpt(): Promise<CompleteFn> {
  const connectionHome = resolve(process.env.FOLIO_CONNECTION_HOME ?? folioHome());
  const connection = await createFolioModels({ home: connectionHome });
  if (!(await readConnectionStatus(connection.store)).connected)
    throw new Error(`No ChatGPT connection in ${connectionHome}. Connect ChatGPT in Folio first.`);
  const catalog = createModels();
  catalog.setProvider(openaiProvider());
  // No retries: the probe wants to see a 429 when the plan sends one.
  return piComplete(
    async () => connection.models,
    (id) => {
      const model = folioModel(catalog, id);
      if (!model) throw new Error(`Model '${id}' is not in Pi's catalog.`);
      return model;
    },
    [],
    [],
  );
}

/** One page as the pipeline's reader sees it: its regions and text layer, then the image. */
async function pageRequest(
  source: PreparedSource,
  page: PageInventory,
  effort: ThinkingLevel,
  key: string,
): Promise<ModelRequest> {
  const regions = page.regions
    .map((region) => `- ${region.id} [${region.kind}]${region.text ? ` "${region.text}"` : ""}`)
    .join("\n");
  return {
    model: MODEL,
    system: READER_SYSTEM,
    content: [
      text("Lecture brief: a synthetic deck used to measure reading."),
      text(`Page ${page.page}. Regions:\n${regions}`),
      png(await source.render(page.page, READ_EDGE)),
    ],
    maxTokens: 16000,
    reasoning: effort,
    cacheKey: key,
    answer: { name: "submit", description: "Submit the reading.", schema: readerSchema },
  };
}

async function timed(complete: CompleteFn, label: string, request: ModelRequest): Promise<Call> {
  const started = performance.now();
  try {
    const reply = await complete(request);
    return {
      label,
      effort: request.reasoning ?? "medium",
      seconds: (performance.now() - started) / 1000,
      input: reply.usage.input,
      cached: reply.usage.cached ?? 0,
      output: reply.usage.output,
      ok: reply.stopReason !== "error" && (reply.answers?.length ?? 0) > 0,
      error: reply.error ?? null,
    };
  } catch (error) {
    return {
      label,
      effort: request.reasoning ?? "medium",
      seconds: (performance.now() - started) / 1000,
      input: 0,
      cached: 0,
      output: 0,
      ok: false,
      error: (error as Error).message,
    };
  }
}

function row(call: Call): string {
  return [
    call.label.padEnd(22),
    call.effort.padEnd(7),
    `${call.seconds.toFixed(1)} s`.padStart(8),
    `in ${call.input}`.padStart(10),
    `cached ${call.cached}`.padStart(13),
    `out ${call.output}`.padStart(10),
    call.ok ? "ok" : `FAILED ${call.error?.slice(0, 80) ?? ""}`,
  ].join("  ");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      burst: { type: "string", default: "8,12" },
      efforts: { type: "string", default: "medium,high,xhigh,max" },
    },
  });
  if (process.env.FOLIO_PROBE !== "1") {
    console.error("The probe spends the ChatGPT plan. Run it with FOLIO_PROBE=1.");
    process.exitCode = 2;
    return;
  }
  const complete = await chatgpt();
  const decks = studyDecks();
  const deck = decks.find((item) => item.name === "arrows") ?? decks[0]!;
  const source = await prepareSource(deck.pdf, createHash("sha256").update(deck.pdf).digest("hex"));
  const pages = source.inventory.pages;
  const key = cacheKey({ sha256: "0".repeat(64) });
  const calls: Call[] = [];
  const log = (call: Call) => {
    calls.push(call);
    console.log(row(call));
  };
  try {
    console.log(`Deck "${deck.name}", ${pages.length} pages, ${MODEL}.\n`);

    console.log("One page at each effort, one request at a time:");
    for (const effort of values.efforts.split(",") as ThinkingLevel[])
      for (const page of pages.slice(0, 2))
        log(
          await timed(complete, `page ${page.page}`, await pageRequest(source, page, effort, key)),
        );

    console.log("\nThe same request twice in a row, for the prompt cache:");
    const repeat = await pageRequest(source, pages[0]!, "low", key);
    log(await timed(complete, "cache first", repeat));
    log(await timed(complete, "cache again", repeat));

    for (const size of values.burst.split(",").map(Number)) {
      console.log(`\n${size} page reads at once, at xhigh:`);
      const started = performance.now();
      const burst = await Promise.all(
        Array.from({ length: size }, async (_, index) => {
          const page = pages[index % pages.length]!;
          return timed(
            complete,
            `burst ${size} #${index + 1}`,
            await pageRequest(source, page, "xhigh", `${key}-${size}-${index}`),
          );
        }),
      );
      burst.forEach(log);
      const wall = (performance.now() - started) / 1000;
      const failed = burst.filter((call) => !call.ok).length;
      const mean = burst.reduce((sum, call) => sum + call.seconds, 0) / burst.length;
      console.log(
        `  wall ${wall.toFixed(1)} s, mean ${mean.toFixed(1)} s per read, ${failed} refused or failed`,
      );
    }
  } finally {
    await source.close();
    closeOpenAICodexWebSocketSessions();
  }
  await mkdir(".bench", { recursive: true });
  const file = resolve(".bench", `probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ model: MODEL, deck: deck.name, calls }, null, 2));
  console.log(`\nSaved ${file}`);
}

await main();
