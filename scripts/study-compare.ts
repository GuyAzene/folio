/**
 * Compares models for two of studying's repetitive steps on the student's own material, before
 * a cheaper model takes one over. It reads local files in place and prints only numbers: no
 * slide text or claim is printed or saved. It spends the ChatGPT plan, so it runs only with
 * FOLIO_PROBE=1.
 *
 * Reading: the same pages read by each model, scored against the first model's reading:
 *   FOLIO_PROBE=1 vp run study:compare -- reading <pdf> --pages 1,12,30 \
 *     --models gpt-6.1-sol:medium,gpt-6.1-terra:medium,gpt-6-luna:high
 *
 * Rechecking: claims from the course's published notes, half of them altered (a number or a
 * word changed), checked against their pages by each model:
 *   FOLIO_PROBE=1 vp run study:compare -- recheck <pdf> <knowledge.json> <documentId> \
 *     --pages 1,12,30 --models gpt-6.1-sol:high,gpt-6-luna:high,gpt-6.1-terra:medium
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels, type ThinkingLevel } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createFolioModels, readConnectionStatus } from "../src/auth.ts";
import { folioHome } from "../src/home.ts";
import { jsonCall, png, text, type CompleteFn } from "../src/ingest/models.ts";
import { gateRegion, type PreparedSource } from "../src/ingest/pipeline.ts";
import { piComplete } from "../src/ingest/pi-complete.ts";
import {
  READER_SYSTEM,
  readerSchema,
  REVIEWER_SYSTEM,
  reviewerSchema,
  type ReadPage,
  type Verdict,
} from "../src/ingest/prompts.ts";
import { missingNumbers, tokenRecall } from "../src/ingest/reconcile.ts";
import { prepareSource } from "../src/ingest/source.ts";
import type { PageInventory } from "../src/ingest/types.ts";
import type { Knowledge } from "../src/kb/knowledge.ts";
import { folioModel } from "../src/model-catalog.ts";

/** The size pages are read at, as in the pipeline. */
const READ_EDGE = 1568;
/** Requests in flight at once, as studying uses. */
const AT_ONCE = 8;

interface Choice {
  model: string;
  effort: ThinkingLevel;
}

async function chatgpt(): Promise<CompleteFn> {
  const connectionHome = resolve(process.env.FOLIO_CONNECTION_HOME ?? folioHome());
  const connection = await createFolioModels({ home: connectionHome });
  if (!(await readConnectionStatus(connection.store)).connected)
    throw new Error(`No ChatGPT connection in ${connectionHome}. Connect ChatGPT in Folio first.`);
  const catalog = createModels();
  catalog.setProvider(openaiProvider());
  return piComplete(
    async () => connection.models,
    (id) => {
      const model = folioModel(catalog, id);
      if (!model) throw new Error(`Model '${id}' is not in Pi's catalog.`);
      return model;
    },
  );
}

/** Runs tasks a few at a time, in order of their results. */
async function pool<T>(tasks: (() => Promise<T>)[], size = AT_ONCE): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, async () => {
      while (next < tasks.length) {
        const at = next++;
        results[at] = await tasks[at]!();
      }
    }),
  );
  return results;
}

function regionList(page: PageInventory): string {
  return `Page ${page.page}. Regions:\n${page.regions.map((region) => `- ${region.id} [${region.kind}]${region.text ? ` "${region.text}"` : ""}`).join("\n")}`;
}

/** Arrows a reading writes out, as "from -> to" pairs. */
function arrows(content: string): Set<string> {
  const found = new Set<string>();
  for (const match of content.matchAll(/([^\s,;:()]+)\s*(?:->|→|⟶|=>)\s*([^\s,;:()]+)/g))
    found.add(`${match[1]!.toLowerCase()}>${match[2]!.toLowerCase()}`);
  return found;
}

function choices(list: string): Choice[] {
  return list.split(",").map((item) => {
    const [model, effort] = item.split(":");
    return { model: model!, effort: (effort ?? "medium") as ThinkingLevel };
  });
}

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const percent = (value: number) => `${Math.round(value * 100)}%`;

async function compareReading(
  complete: CompleteFn,
  source: PreparedSource,
  pages: PageInventory[],
  models: Choice[],
): Promise<void> {
  const readings = new Map<string, Map<number, { page: ReadPage | undefined; seconds: number }>>();
  for (const choice of models) {
    const label = `${choice.model}:${choice.effort}`;
    const done = await pool(
      pages.map((page) => async () => {
        const started = performance.now();
        const result = await jsonCall<{ pages: ReadPage[] }>(
          complete,
          {
            model: choice.model,
            system: READER_SYSTEM,
            content: [text(regionList(page)), png(await source.render(page.page, READ_EDGE))],
            maxTokens: 24000,
            reasoning: choice.effort,
          },
          readerSchema,
          () => {},
          (parts) => ({ pages: parts.flatMap((part) => part.pages) }),
        ).catch(() => ({ pages: [] as ReadPage[] }));
        return {
          number: page.page,
          page: result.pages.find((item) => item.page === page.page) ?? result.pages[0],
          seconds: (performance.now() - started) / 1000,
        };
      }),
    );
    readings.set(label, new Map(done.map((item) => [item.number, item])));
    console.log(`${label}: read ${pages.length} pages`);
  }
  const [reference, ...others] = models.map((choice) => `${choice.model}:${choice.effort}`);
  console.log(
    `\nAgainst ${reference} (words and arrows kept are shares of its reading; numbers are the text layer's):`,
  );
  console.log(
    [
      "model".padEnd(24),
      "s/page",
      "words",
      "numbers",
      "arrows",
      "close-ups",
      "unsure",
      "failed",
    ].join("  "),
  );
  for (const label of [reference!, ...others]) {
    const own = readings.get(label)!;
    const words: number[] = [];
    let numbers = 0;
    let numbersFound = 0;
    let arrowsWanted = 0;
    let arrowsFound = 0;
    let closeups = 0;
    let unsure = 0;
    let failed = 0;
    for (const page of pages) {
      const mine = own.get(page.page)?.page;
      const theirs = readings.get(reference!)!.get(page.page)?.page;
      if (!mine) {
        failed++;
        continue;
      }
      for (const region of page.regions) {
        const reading = mine.regions.find((item) => item.id === region.id);
        const base = theirs?.regions.find((item) => item.id === region.id);
        if (reading?.confidence === "unsure") unsure++;
        if (gateRegion(page, region, reading, null)) closeups++;
        if (base?.content.trim()) words.push(tokenRecall(base.content, reading?.content ?? ""));
        numbers += region.numbers.length;
        numbersFound +=
          region.numbers.length - missingNumbers(region.numbers, reading?.content ?? "").length;
        const wanted = arrows(base?.content ?? "");
        const got = arrows(reading?.content ?? "");
        arrowsWanted += wanted.size;
        arrowsFound += [...wanted].filter((arrow) => got.has(arrow)).length;
      }
    }
    console.log(
      [
        label.padEnd(24),
        mean(pages.map((page) => own.get(page.page)?.seconds ?? 0))
          .toFixed(1)
          .padStart(6),
        percent(mean(words)).padStart(5),
        (numbers ? percent(numbersFound / numbers) : "–").padStart(7),
        (arrowsWanted ? percent(arrowsFound / arrowsWanted) : "–").padStart(6),
        String(closeups).padStart(9),
        String(unsure).padStart(6),
        String(failed).padStart(6),
      ].join("  "),
    );
  }
}

/** A claim with one number or one word changed, or null when neither can be. */
function altered(claim: string): string | null {
  const digit = /\d/.exec(claim);
  if (digit) {
    const at = digit.index;
    return `${claim.slice(0, at)}${(Number(claim[at]) + 1) % 10}${claim.slice(at + 1)}`;
  }
  const swaps: [RegExp, string][] = [
    [/\bmore\b/i, "less"],
    [/\bless\b/i, "more"],
    [/\bfaster\b/i, "slower"],
    [/\bslower\b/i, "faster"],
    [/\bbefore\b/i, "after"],
    [/\bafter\b/i, "before"],
    [/\bhigher\b/i, "lower"],
    [/\blower\b/i, "higher"],
    [/\bincreases?\b/i, "decreases"],
    [/\bdecreases?\b/i, "increases"],
    [/\bcan\b/i, "cannot"],
    [/\bmust\b/i, "must not"],
    [/\balways\b/i, "never"],
    [/\bshared\b/i, "dedicated"],
    [/\bdedicated\b/i, "shared"],
  ];
  for (const [pattern, word] of swaps) if (pattern.test(claim)) return claim.replace(pattern, word);
  return null;
}

async function compareRecheck(
  complete: CompleteFn,
  source: PreparedSource,
  pages: PageInventory[],
  knowledge: Knowledge,
  documentId: string,
  models: Choice[],
): Promise<void> {
  const wanted = new Set(pages.map((page) => page.page));
  const pageOf = (region: string) => Number(/^p(\d+)\./.exec(region)?.[1] ?? 0);
  const claims = knowledge.pages
    .flatMap((page) => page.blocks)
    .filter((block) => block.documentId === documentId)
    .flatMap((block) => block.claims)
    .filter((claim) => wanted.has(pageOf(claim.region)));
  // Per page, a few true claims and as many altered ones.
  const tests: { id: string; text: string; region: string; altered: boolean }[] = [];
  for (const page of pages) {
    const own = claims.filter((claim) => pageOf(claim.region) === page.page).slice(0, 8);
    own.forEach((claim, at) => {
      const changed = at % 2 ? altered(claim.text) : null;
      tests.push({
        id: `t${tests.length + 1}`,
        text: changed ?? claim.text,
        region: claim.region,
        altered: changed !== null,
      });
    });
  }
  console.log(
    `${tests.length} claims on ${pages.length} pages, ${tests.filter((test) => test.altered).length} of them altered\n`,
  );
  console.log(
    ["model".padEnd(24), "s/page", "altered caught", "true kept", "no answer"].join("  "),
  );
  for (const choice of models) {
    const verdicts = new Map<string, Verdict>();
    const times = await pool(
      pages.map((page) => async () => {
        const batch = tests.filter((test) => pageOf(test.region) === page.page);
        if (!batch.length) return 0;
        const started = performance.now();
        const result = await jsonCall<{ verdicts: Verdict[] }>(
          complete,
          {
            model: choice.model,
            system: REVIEWER_SYSTEM,
            content: [
              text(regionList(page)),
              png(await source.render(page.page, READ_EDGE)),
              text(
                `Claims to check (answer with the claim ID in "claim"):\n${batch.map((test) => `[${test.id}] (${test.region}) ${test.text}`).join("\n")}`,
              ),
            ],
            maxTokens: 16000,
            reasoning: choice.effort,
          },
          reviewerSchema,
          () => {},
          (parts) => ({ verdicts: parts.flatMap((part) => part.verdicts) }),
        ).catch(() => ({ verdicts: [] as Verdict[] }));
        for (const verdict of result.verdicts) verdicts.set(verdict.claim, verdict);
        return (performance.now() - started) / 1000;
      }),
    );
    const changed = tests.filter((test) => test.altered);
    const kept = tests.filter((test) => !test.altered);
    const caught = changed.filter(
      (test) => verdicts.get(test.id) && verdicts.get(test.id)!.verdict !== "supported",
    ).length;
    const supported = kept.filter((test) => verdicts.get(test.id)?.verdict === "supported").length;
    const missing = tests.filter((test) => !verdicts.get(test.id)).length;
    console.log(
      [
        `${choice.model}:${choice.effort}`.padEnd(24),
        mean(times.filter(Boolean)).toFixed(1).padStart(6),
        `${caught}/${changed.length}`.padStart(14),
        `${supported}/${kept.length}`.padStart(9),
        String(missing).padStart(9),
      ].join("  "),
    );
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pages: { type: "string" },
      models: { type: "string" },
    },
  });
  if (process.env.FOLIO_PROBE !== "1") {
    console.error("The comparison spends the ChatGPT plan. Run it with FOLIO_PROBE=1.");
    process.exitCode = 2;
    return;
  }
  const [mode, pdf, knowledgeFile, documentId] = positionals;
  if ((mode !== "reading" && mode !== "recheck") || !pdf) {
    console.error(
      "Usage: study:compare -- reading <pdf> | recheck <pdf> <knowledge.json> <documentId>",
    );
    process.exitCode = 2;
    return;
  }
  const data = new Uint8Array(await readFile(pdf));
  const source = await prepareSource(data, createHash("sha256").update(data).digest("hex"));
  const sample = new Set((values.pages ?? "").split(",").filter(Boolean).map(Number));
  const pages = source.inventory.pages.filter((page) => !sample.size || sample.has(page.page));
  const complete = await chatgpt();
  try {
    if (mode === "reading")
      await compareReading(
        complete,
        source,
        pages,
        choices(values.models ?? "gpt-6.1-sol:medium,gpt-6.1-terra:medium,gpt-6-luna:high"),
      );
    else
      await compareRecheck(
        complete,
        source,
        pages,
        JSON.parse(await readFile(knowledgeFile!, "utf8")) as Knowledge,
        documentId!,
        choices(values.models ?? "gpt-6.1-sol:high,gpt-6-luna:high,gpt-6.1-terra:medium"),
      );
  } finally {
    await source.close();
    closeOpenAICodexWebSocketSessions();
  }
}

await main();
