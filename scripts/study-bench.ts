import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import Value from "typebox/value";
import { createFolioModels, readConnectionStatus } from "../src/auth.ts";
import { folioHome } from "../src/home.ts";
import { jsonObjects, type CompleteFn, type ModelReply } from "../src/ingest/models.ts";
import { IngestRunner, trialRoles, type DocumentDraft } from "../src/ingest/pipeline.ts";
import { piComplete } from "../src/ingest/pi-complete.ts";
import {
  AUTHOR_SYSTEM,
  BRIEF_SYSTEM,
  CHECK_SYSTEM,
  ESCALATION_SYSTEM,
  FIX_SYSTEM,
  READER_SYSTEM,
  REVIEWER_SYSTEM,
  type AuthorDraft,
  type DraftBlock,
  type Patch,
} from "../src/ingest/prompts.ts";
import { prepareSource } from "../src/ingest/source.ts";
import { stepTimings, timingTable, type DocumentTiming } from "../src/jobs/report.ts";
import { JobStore } from "../src/jobs/store.ts";
import { LibraryStore, type DocumentRecord } from "../src/library/store.ts";
import { folioModel } from "../src/model-catalog.ts";
import { studyDecks, type PlantedFact, type StudyDeck } from "../tests/fixtures/study-decks.ts";

/**
 * The study benchmark: Folio's real ingest pipeline on synthetic lectures with planted facts,
 * in a temporary home, scored for what the notes kept and how long each step took. With the
 * real model it spends the student's ChatGPT plan, so it runs only when asked:
 *
 *   FOLIO_BENCH=1 vp run study:bench [--inject-omission k] [--concurrency n] [--jobs n] [--keep]
 *   vp run study:bench --fake [--inject-omission k]     offline, with a model that reads text layers
 *   vp run study:bench --compare <a> <b>                two saved runs, by file or name in .bench/
 *
 * A run is saved as .bench/<commit>.json (with -dirty, -fake and -omit<k> when they apply). The
 * ChatGPT connection is read in place from FOLIO_CONNECTION_HOME, or Folio's own home; nothing
 * else of that home is read or written.
 */

/** One planted fact, as the finished notes have it. */
export interface FactResult {
  id: string;
  page: number;
  /** Every `must` value is in a block that cites the fact's page. */
  found: boolean;
  /** The wrong values those blocks hold. */
  wrong: string[];
  /** Its block was removed from the first draft by --inject-omission. */
  omitted: boolean;
}

export interface DeckResult {
  deck: string;
  title: string;
  /** The study job's status: done, unless it failed or stopped on the plan's limit. */
  status: string;
  facts: FactResult[];
  /** Blocks written from the slide itself because every revision missed a region. */
  fallbacks: number;
  /** Claims the checker could not confirm, kept on their blocks for the tutor. */
  disputes: number;
  /** Regions nothing accounted for before the fallbacks were written. */
  unaccounted: number;
  /** What the first check found wrong, and how much of it the fixes put right, when recorded. */
  discrepancies?: number;
  fixed?: number;
  timings: DocumentTiming | null;
}

export interface BenchRun {
  version: 1;
  commit: string;
  dirty: boolean;
  createdAt: string;
  model: "fake" | "chatgpt";
  /** Planted blocks removed from each first draft. */
  omit: number;
  decks: DeckResult[];
}

// ── Scoring ──────────────────────────────────────────────────────────────

/**
 * Text as it is compared: NFKC (math italic, subscripts and ligatures become plain letters and
 * digits), lower case, the LaTeX and ASCII spellings of ≤, ≥, ∑ and → made the symbols, markup
 * gone, and spaces kept only between two letters or digits. So "𝑥₁ + 𝑥₂ = 19",
 * "$x_1 + x_2 = 19$" and "x1+x2=19" are the same, while "57 42" stays two numbers.
 */
export function fold(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\\(?:leq?|leqslant)(?![a-z])/g, "≤")
    .replace(/\\(?:geq?|geqslant)(?![a-z])/g, "≥")
    .replace(/\\sum(?![a-z])/g, "∑")
    .replace(/\\(?:to|rightarrow|longrightarrow)(?![a-z])/g, "→")
    .replace(/<=/g, "≤")
    .replace(/>=/g, "≥")
    .replace(/-+>|=>|⟶|⇒/g, "→")
    .replace(/[$_{}*`\\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/ (?=[^\p{L}\p{N}])|(?<=[^\p{L}\p{N}]) /gu, "")
    .trim();
}

/** Whether folded text holds a folded value, a number never matching inside a longer one. */
export function holds(text: string, value: string): boolean {
  const haystack = fold(text);
  const needle = fold(value);
  if (!needle) return false;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1] ?? "";
    const after = haystack.slice(at + needle.length, at + needle.length + 2);
    if (/\d/.test(needle[0]!) && /[\d.]/.test(before)) continue;
    if (/\d/.test(needle.at(-1)!) && /^(\d|\.\d)/.test(after)) continue;
    return true;
  }
  return false;
}

function blockText(block: DraftBlock): string {
  return [
    block.title,
    block.body,
    ...block.keywords_en,
    ...block.keywords_he,
    ...block.aliases,
    ...block.claims.map((claim) => claim.text),
  ].join("\n");
}

/** Everything the blocks citing a page say. */
function pageText(draft: AuthorDraft, page: number): string {
  return draft.pages
    .flatMap((topic) => topic.blocks)
    .filter((block) => block.locators.some((locator) => locator.page === page))
    .map(blockText)
    .join("\n\n");
}

/** Each planted fact, as the notes have it in the blocks that cite its page. */
export function scoreFacts(
  draft: AuthorDraft,
  facts: PlantedFact[],
  omitted: readonly string[] = [],
): FactResult[] {
  return facts.map((fact) => {
    const text = pageText(draft, fact.page);
    return {
      id: fact.id,
      page: fact.page,
      found: fact.must.every((value) => holds(text, value)),
      wrong: fact.wrong.filter((value) => holds(text, value)),
      omitted: omitted.includes(fact.id),
    };
  });
}

/** What a finished study of one deck kept, missed and needed. */
export function scoreDocument(
  document: DocumentDraft,
  deck: StudyDeck,
  omitted: readonly string[] = [],
): Pick<DeckResult, "facts" | "fallbacks" | "disputes" | "unaccounted"> {
  const blocks = document.draft.pages.flatMap((topic) => topic.blocks);
  return {
    facts: scoreFacts(document.draft, deck.facts, omitted),
    fallbacks: blocks.filter((block) => block.unreviewed).length,
    disputes: blocks.reduce((sum, block) => sum + (block.disputed?.length ?? 0), 0),
    unaccounted: document.ledger.filter((entry) => entry.state === "unaccounted").length,
  };
}

// ── Omission injection ───────────────────────────────────────────────────

/**
 * Removes up to `count` blocks that carry planted facts, as if the author had forgotten them,
 * and names every fact that went with them.
 */
export function omitPlantedBlocks(
  draft: AuthorDraft,
  facts: PlantedFact[],
  count: number,
): { draft: AuthorDraft; omitted: string[] } {
  const blocks = draft.pages.flatMap((topic) => topic.blocks);
  const removed = new Set<string>();
  for (const fact of facts) {
    if (removed.size >= count) break;
    const carrier = blocks.find(
      (block) =>
        !removed.has(block.id) &&
        block.locators.some((locator) => locator.page === fact.page) &&
        fact.must.every((value) => holds(blockText(block), value)),
    );
    if (carrier) removed.add(carrier.id);
  }
  const result: AuthorDraft = {
    ...draft,
    pages: draft.pages.map((topic) => ({
      ...topic,
      blocks: topic.blocks.filter((block) => !removed.has(block.id)),
    })),
  };
  const before = scoreFacts(draft, facts);
  const after = scoreFacts(result, facts);
  return {
    draft: result,
    omitted: facts
      .filter((_, index) => before[index]!.found && !after[index]!.found)
      .map((fact) => fact.id),
  };
}

const requestText = (request: Parameters<CompleteFn>[0]) =>
  request.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

/**
 * Takes planted blocks out of each deck's first draft before the pipeline checks it, recording
 * which facts went, so the run measures how many omissions the checks bring back. Pipelines from
 * before patch fixes had the author rewrite the draft ("Your previous draft"); that rewrite is
 * the pipeline's answer, so it is left alone.
 */
export function withOmissions(
  complete: CompleteFn,
  decks: StudyDeck[],
  count: number,
  omitted: Map<string, string[]>,
): CompleteFn {
  return async (request) => {
    const reply = await complete(request);
    if (!request.system.startsWith(AUTHOR_SYSTEM)) return reply;
    const text = requestText(request);
    const deck = decks.find((candidate) => text.includes(candidate.title));
    if (!deck || omitted.has(deck.name) || text.includes("Your previous draft")) return reply;
    const [answer] = reply.answers?.length ? reply.answers : parsed(reply.text);
    if (!answer || typeof answer !== "object" || !("pages" in answer)) return reply;
    const result = omitPlantedBlocks(answer as AuthorDraft, deck.facts, count);
    omitted.set(deck.name, result.omitted);
    return reply.answers?.length
      ? { ...reply, answers: [result.draft, ...reply.answers.slice(1)] }
      : { ...reply, text: JSON.stringify(result.draft) };
  };
}

function parsed(text: string): unknown[] {
  return jsonObjects(text).flatMap((candidate) => {
    try {
      return [JSON.parse(candidate) as unknown];
    } catch {
      return [];
    }
  });
}

// ── The offline model ────────────────────────────────────────────────────

const REGION = /^(p\d+\.[rx]\d+) \[([^\]]*)\]/;
const UNREAD = "A picture; the offline model reads text layers, not pixels.";

/** Splits "- p1.r1 [text] …" entries, whose text may run over several lines. */
function entries(list: string): string[] {
  return list
    .split(/(?:^|\n)- (?=p\d+\.[rx]\d+ \[)/)
    .map((entry) => entry.trim())
    .filter((entry) => REGION.test(entry));
}

const unquote = (value: string) => value.replace(/^"([\s\S]*)"$/, "$1");

/**
 * A stand-in for ChatGPT that answers every study step from the text layer the pipeline sends:
 * readers and close-ups restate it, the author writes one block per page citing every region,
 * the checker maps each region's text to a block that carries it, the fixer adds a block for each
 * page's uncited regions, and every claim is supported. Pictures stay unread, so facts only in
 * pixels are missed, which is what the offline run shows the scoring catches.
 */
export function fakeStudyModel(): CompleteFn {
  return async (request) => {
    const parts = request.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    const all = parts.join("\n");
    // Fields a schema gains later (a reader's confidence, say) are filled with their defaults,
    // so the offline run keeps up with the prompts without being told about each change.
    const reply = (value: unknown): ModelReply => ({
      text: "",
      answers: [request.answer ? Value.Repair(request.answer.schema, value) : value],
      stopReason: "toolUse",
      usage: {
        input: Math.ceil(all.length / 4),
        output: Math.ceil(JSON.stringify(value).length / 4),
      },
    });
    const system = request.system;
    if (system.startsWith(BRIEF_SYSTEM))
      return reply({
        title: /^Lecture: (.*)$/m.exec(all)?.[1] ?? "Lecture",
        outline: [],
        notation: [],
        terms: [],
      });
    if (system.startsWith(READER_SYSTEM)) {
      const pages = parts.flatMap((part) => {
        const header = /^Page (\d+)[^\n]*Regions:\n/.exec(part);
        if (!header) return [];
        return [
          {
            page: Number(header[1]),
            regions: entries(part.slice(header[0].length)).map((entry) => {
              const [match, id, kind] = REGION.exec(entry)!;
              const content = unquote(entry.slice(match.length).trim());
              return {
                id,
                type: kind === "text" ? "text" : kind === "drawing" ? "diagram" : "image",
                content: content || UNREAD,
                claims: content ? [{ text: content, basis: "transcribed" }] : [],
                flags: [],
              };
            }),
            missed: [],
            new_terms: [],
            unresolved_symbols: [],
          },
        ];
      });
      return reply({ pages });
    }
    if (system.startsWith(ESCALATION_SYSTEM)) {
      const regions = parts.flatMap((part) => {
        const match = /^Region (\S+) \[(\w+)\] — why: /.exec(part);
        if (!match) return [];
        const layer = /Text layer: "([\s\S]*?)"(?: First reader said:|$)/.exec(part)?.[1];
        const first = /First reader said: "([\s\S]*)"$/.exec(part)?.[1];
        const content = layer || (first !== UNREAD ? first : "") || "";
        return [
          {
            id: match[1],
            type: match[2] === "text" ? "text" : match[2] === "drawing" ? "diagram" : "image",
            content: content || UNREAD,
            claims: [],
            nodes: [],
            edges: [],
            unreadable: content ? "" : "The offline model cannot read the picture.",
          },
        ];
      });
      return reply({ regions });
    }
    if (system.startsWith(AUTHOR_SYSTEM)) return reply(fakeDraft(all));
    if (system.startsWith(FIX_SYSTEM)) return reply({ patches: fakePatches(all) });
    if (system.startsWith(CHECK_SYSTEM))
      return reply({ coverage: fakeCoverage(parts), verdicts: supportAll(all) });
    if (system.startsWith(REVIEWER_SYSTEM)) return reply({ verdicts: supportAll(all) });
    throw new Error(`The offline model has no answer for: ${system.slice(0, 60)}`);
  };
}

/** Every claim the request asks about ("[c0123456789] (p2.r1) …"), supported. */
function supportAll(request: string) {
  return [...request.matchAll(/^\[(c[0-9a-f]+)\] \(/gm)].map(([, claim]) => ({
    claim: claim!,
    verdict: "supported",
    note: "",
  }));
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The first check's coverage, as a checker that reads text but not pixels would give it: each
 * region's text (or what the reader read) is its one fact, carried by a block whose text holds
 * it, the blocks citing the region first, or by none (""). A picture it cannot read is illegible.
 */
function fakeCoverage(parts: string[]) {
  const notes = parts.find((part) => part.startsWith("The notes, every block by topic:")) ?? "";
  const blocks = notes.split(/\n(?=\[[a-z0-9-]+\] )/).flatMap((piece) => {
    const match = /^\[([a-z0-9-]+)\] ([\s\S]*)$/.exec(piece);
    // The last block of a topic runs up to the next topic's heading.
    return match ? [{ id: match[1]!, text: squash(match[2]!.replace(/\n\n## [\s\S]*$/, "")) }] : [];
  });
  return parts.flatMap((part) => {
    const header = /^Page \d+[^\n]*Regions:\n/.exec(part);
    if (!header) return [];
    return entries(part.slice(header[0].length)).flatMap((entry) => {
      const match =
        /^(p\d+\.[rx]\d+) \[\w+\](?: "([\s\S]*?)")? · (?:cited by (.+?)|not cited)(?: · read: "([\s\S]*)")?$/.exec(
          entry,
        );
      if (!match) return [];
      const [, region, layer, citing, reading] = match;
      const fact = squash(layer || (reading === UNREAD ? "" : (reading ?? "")));
      if (!fact)
        return [{ region: region!, legible: false, note: "A picture with no text.", facts: [] }];
      const cited = citing?.split(", ") ?? [];
      const carrier = [
        ...blocks.filter((block) => cited.includes(block.id)),
        ...blocks.filter((block) => !cited.includes(block.id)),
      ].find((block) => block.text.includes(fact));
      return [
        { region: region!, legible: true, note: "", facts: [{ fact, block: carrier?.id ?? "" }] },
      ];
    });
  });
}

/** One topic with a block per page, citing every region; page numbers are omitted. */
function fakeDraft(request: string): AuthorDraft {
  const list = /Regions found on every page[^\n]*\n([\s\S]*?)\n\nAllowed omission reasons/.exec(
    request,
  )?.[1];
  const regions = entries(list ?? "").map((entry) => {
    const [match, id] = REGION.exec(entry)!;
    const content = entry
      .slice(match.length)
      .split(/\n {2}(?:claims|unreadable): /)[0]!
      .trim();
    return { id: id!, page: Number(/^p(\d+)\./.exec(id!)![1]), content };
  });
  const numbers = regions.filter((region) => /^\d+$/.test(region.content));
  const pages = [...new Set(regions.map((region) => region.page))].sort((a, b) => a - b);
  const session = /^Session: (\S+),/m.exec(request)?.[1]?.toLowerCase() ?? "lecture";
  return {
    session: {
      title: "Benchmark lecture",
      covers: "What the slides say, page by page.",
      worked_examples: [],
      worth_remembering: [],
      open_threads: [],
    },
    pages: [
      {
        slug: session.replace(/[^a-z0-9]+/g, "-"),
        title: "From the slides",
        type: "concept",
        prerequisites: [],
        intuition: "",
        similar_to: [],
        blocks: pages
          .map((page) =>
            pageBlock(
              `page-${page}`,
              page,
              regions.filter((region) => region.page === page && !numbers.includes(region)),
            ),
          )
          .filter((block) => block.locators.length),
      },
    ],
    omitted: numbers.map((region) => ({ region: region.id, reason: "page_number", note: "" })),
  };
}

/** A block restating what was read in a page's regions, each cited and each a claim. */
function pageBlock(
  id: string,
  page: number,
  regions: { id: string; content: string }[],
): DraftBlock {
  return {
    id,
    kind: "explanation",
    restates: "",
    title: `Page ${page}`,
    body: regions.map((region) => region.content).join("\n\n"),
    locators: regions.map((region) => ({ page, region: region.id, location: "on the slide" })),
    keywords_en: [],
    keywords_he: [],
    aliases: [],
    questions: [],
    claims: regions
      .filter((region) => region.content && region.content !== UNREAD)
      .map((region) => ({ text: region.content, region: region.id })),
    interpretations: [],
  };
}

/**
 * Fixes only what it can from the text: a block per page for the regions no block cites, at the
 * end of the first topic. Doubted claims are left out, as a fixer that cannot read the page would.
 */
function fakePatches(request: string): Patch[] {
  const topic = /^Topics in the notes[^\n]*\n- (\S+) /m.exec(request)?.[1];
  if (!topic) return [];
  const uncited = [...request.matchAll(/^\[(d\d+)\] uncited · (\S+) \(page (\d+)\)/gm)].map(
    ([, id, region, page]) => ({ id: id!, region: region!, page: Number(page) }),
  );
  const found = /What readers found in these regions:\n([\s\S]*?)(?:\n\n|$)/.exec(request)?.[1];
  const readings = new Map(
    entries(found ?? "").map((entry) => {
      const [match, id] = REGION.exec(entry)!;
      return [
        id!,
        entry
          .slice(match.length)
          .split(/\n {2}unreadable: /)[0]!
          .trim(),
      ];
    }),
  );
  return [...new Set(uncited.map((item) => item.page))].map((page) => {
    const items = uncited.filter((item) => item.page === page);
    return {
      op: "add_block",
      fixes: items.map((item) => item.id),
      topic,
      after: "",
      block: pageBlock(
        `fixed-page-${page}`,
        page,
        items.map((item) => ({ id: item.region, content: readings.get(item.region) || UNREAD })),
      ),
    };
  });
}

// ── Running ──────────────────────────────────────────────────────────────

export interface BenchOptions {
  /** A fresh, temporary Folio home. */
  home: string;
  complete: CompleteFn;
  decks: StudyDeck[];
  /** Planted blocks to remove from each first draft. */
  omit?: number;
  concurrency?: number;
  /** Studies at once; the app studies two at a time. */
  jobs?: number;
  log?: (line: string) => void;
}

const ENDED = new Set(["done", "failed", "stopped", "waiting"]);

/** Studies every deck as the app would after they were added to a course, and scores each. */
export async function runBench(options: BenchOptions): Promise<DeckResult[]> {
  const { home, decks } = options;
  const log = options.log ?? (() => undefined);
  const library = await LibraryStore.open({ home });
  const store = await JobStore.open(home);
  try {
    const course = await library.createCourse({ name: "Benchmark", code: "BENCH 100" });
    const incoming = resolve(home, "incoming");
    await mkdir(incoming, { recursive: true });
    const documents: DocumentRecord[] = [];
    for (const deck of decks) {
      const file = resolve(incoming, `${deck.title}.pdf`);
      await writeFile(file, deck.pdf);
      documents.push((await library.importFile(course.id, file, { role: "lecture" })).document);
    }

    const drafts = new Map<string, DocumentDraft>();
    const omitted = new Map<string, string[]>();
    const complete = options.omit
      ? withOmissions(options.complete, decks, options.omit, omitted)
      : options.complete;
    let ids: string[] = [];
    let settle = () => {};
    const settled = new Promise<void>((done) => (settle = done));
    const seen = new Map<string, string>();
    const runner = new IngestRunner({
      store,
      library,
      complete,
      prepare: prepareSource,
      roles: trialRoles(process.env),
      concurrency: options.concurrency,
      parallelJobs: options.jobs,
      emit(job) {
        if (seen.get(job.id) !== job.status) {
          const note = job.nodes.find((node) => node.role === "run")?.note;
          log(`${job.title}: ${job.status}${job.status !== "running" && note ? ` (${note})` : ""}`);
        }
        seen.set(job.id, job.status);
        if (ids.length && ids.every((id) => ENDED.has(store.job(id).status))) settle();
      },
      async publish(bundle) {
        for (const document of bundle.documents) drafts.set(document.documentId, document);
        return drafts.size;
      },
    });
    ids = (
      await runner.queue(
        course.id,
        documents.map((document) => document.id),
        "upload",
      )
    ).map((job) => job.id);
    if (ids.every((id) => ENDED.has(store.job(id).status))) settle();
    await settled;
    // The last study's end lets the runner look for queued work once more; let it, before the
    // store closes under it.
    await new Promise((done) => setImmediate(done));

    const db = new DatabaseSync(resolve(home, "jobs.sqlite"), { readOnly: true });
    try {
      return decks.map((deck, index): DeckResult => {
        const document = documents[index]!;
        const job = store.jobs().find((candidate) => candidate.documentIds.includes(document.id));
        const draft = drafts.get(document.id);
        const scored = draft
          ? scoreDocument(draft, deck, omitted.get(deck.name))
          : {
              facts: scoreFacts(EMPTY, deck.facts, omitted.get(deck.name)),
              fallbacks: 0,
              disputes: 0,
              unaccounted: 0,
            };
        const outcome = job
          ? store.nodes(job.id).find((node) => node.role === "document")?.outcome
          : null;
        return {
          deck: deck.name,
          title: deck.title,
          status: job?.status ?? "missing",
          ...scored,
          // Before the fallbacks, when the pipeline recorded it; what is left after them otherwise.
          unaccounted: outcome?.uncovered ?? scored.unaccounted,
          discrepancies: outcome?.discrepancies,
          fixed: outcome?.fixed,
          timings: job ? (stepTimings(db, { job: job.id })[0] ?? null) : null,
        };
      });
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
}

const EMPTY: AuthorDraft = {
  session: { title: "", covers: "", worked_examples: [], worth_remembering: [], open_threads: [] },
  pages: [],
  omitted: [],
};

// ── Reporting ────────────────────────────────────────────────────────────

const found = (deck: DeckResult) => deck.facts.filter((fact) => fact.found).length;
const wrongHits = (deck: DeckResult) => deck.facts.filter((fact) => fact.wrong.length).length;
const caught = (deck: DeckResult) => deck.facts.filter((fact) => fact.omitted && fact.found).length;
const injected = (deck: DeckResult) => deck.facts.filter((fact) => fact.omitted).length;

/** Each deck's scores and step timings. */
export function benchReport(run: BenchRun): string {
  return run.decks
    .map((deck) => {
      const missed = deck.facts.filter((fact) => !fact.found).map((fact) => fact.id);
      const wrong = deck.facts.filter((fact) => fact.wrong.length);
      return [
        `${deck.title} (${deck.deck}) · ${deck.status}`,
        `  planted facts found: ${found(deck)}/${deck.facts.length}${missed.length ? ` (missed: ${missed.join(", ")})` : ""}`,
        `  wrong values: ${wrong.length ? wrong.map((fact) => `${fact.id} has ${fact.wrong.join(", ")}`).join("; ") : "none"}`,
        `  fallback blocks ${deck.fallbacks} · disputes ${deck.disputes} · unaccounted regions ${deck.unaccounted}`,
        ...(deck.discrepancies === undefined
          ? []
          : [`  discrepancies found ${deck.discrepancies}, fixed ${deck.fixed ?? 0}`]),
        ...(injected(deck)
          ? [`  omissions injected ${injected(deck)}, brought back ${caught(deck)}`]
          : []),
        deck.timings ? timingTable([deck.timings]).replace(/^/gm, "  ") : "  no timings",
      ].join("\n");
    })
    .join("\n\n");
}

/** Two runs side by side, deck by deck; numbers that went down are better except facts found. */
export function compareRuns(a: BenchRun, b: BenchRun, names: [string, string]): string {
  const rows: string[][] = [["", names[0], names[1], "change"]];
  const add = (label: string, x: number | undefined, y: number | undefined, digits = 0) => {
    const show = (value: number) =>
      value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    const change = x === undefined || y === undefined ? 0 : y - x;
    rows.push([
      label,
      x === undefined ? "–" : show(x),
      y === undefined ? "–" : show(y),
      Math.abs(change) < 0.05 ? "" : `${change > 0 ? "+" : ""}${show(change)}`,
    ]);
  };
  const omissions = (deck: DeckResult | undefined) => (deck && injected(deck) ? deck : undefined);
  for (const name of new Set([...a.decks, ...b.decks].map((deck) => deck.deck))) {
    const x = a.decks.find((deck) => deck.deck === name);
    const y = b.decks.find((deck) => deck.deck === name);
    rows.push([`${name} (${x?.status ?? "–"} / ${y?.status ?? "–"})`, "", "", ""]);
    add(`  facts found (of ${(x ?? y)!.facts.length})`, x && found(x), y && found(y));
    add("  wrong values", x && wrongHits(x), y && wrongHits(y));
    if (omissions(x) || omissions(y)) {
      add("  omissions injected", omissions(x) && injected(x!), omissions(y) && injected(y!));
      add("  omissions brought back", omissions(x) && caught(x!), omissions(y) && caught(y!));
    }
    add("  fallback blocks", x?.fallbacks, y?.fallbacks);
    add("  disputes", x?.disputes, y?.disputes);
    add("  unaccounted regions", x?.unaccounted, y?.unaccounted);
    if (x?.discrepancies !== undefined || y?.discrepancies !== undefined) {
      add("  discrepancies found", x?.discrepancies, y?.discrepancies);
      add("  discrepancies fixed", x?.fixed, y?.fixed);
    }
    const steps = [
      ...new Set(
        [...(x?.timings?.steps ?? []), ...(y?.timings?.steps ?? [])].map((row) => row.step),
      ),
    ];
    const row = (deck: DeckResult | undefined, step: string) =>
      deck?.timings?.steps.find((candidate) => candidate.step === step);
    add(
      "  close-ups",
      row(x, "escalation")?.nodes ?? (x ? 0 : undefined),
      row(y, "escalation")?.nodes ?? (y ? 0 : undefined),
    );
    add("  model calls", x?.timings?.wall.calls, y?.timings?.wall.calls);
    add("  output tokens", x?.timings?.wall.outputTokens, y?.timings?.wall.outputTokens);
    for (const step of steps)
      add(`  ${step} span min`, row(x, step)?.spanMinutes, row(y, step)?.spanMinutes, 1);
    add("  wall min", x?.timings?.wall.spanMinutes, y?.timings?.wall.spanMinutes, 1);
  }
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((cells) => cells[column]!.length)),
  );
  return rows
    .map((cells) =>
      cells
        .map((cell, column) =>
          column ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** The saved run's file name: the commit, and what sets this run apart from a plain one. */
export function runName(run: Pick<BenchRun, "commit" | "dirty" | "model" | "omit">): string {
  return `${run.commit}${run.dirty ? "-dirty" : ""}${run.model === "fake" ? "-fake" : ""}${run.omit ? `-omit${run.omit}` : ""}`;
}

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function readRun(name: string): Promise<BenchRun> {
  const file = existsSync(name) ? name : resolve(".bench", `${name}.json`);
  return JSON.parse(await readFile(file, "utf8")) as BenchRun;
}

/** ChatGPT through the student's own connection, read where Folio keeps it. */
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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fake: { type: "boolean" },
      compare: { type: "boolean" },
      "inject-omission": { type: "string" },
      concurrency: { type: "string" },
      jobs: { type: "string" },
      keep: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      [
        "FOLIO_BENCH=1 vp run study:bench [--inject-omission k] [--concurrency n] [--jobs n] [--keep]",
        "vp run study:bench --fake [--inject-omission k] [--keep]",
        "vp run study:bench --compare <a> <b>",
      ].join("\n"),
    );
    return;
  }
  if (values.compare) {
    if (positionals.length !== 2)
      throw new Error("--compare takes two runs: files, or names in .bench/.");
    const [a, b] = positionals as [string, string];
    console.log(compareRuns(await readRun(a), await readRun(b), [a, b]));
    return;
  }
  if (!values.fake && process.env.FOLIO_BENCH !== "1")
    throw new Error(
      "The benchmark studies three lectures with ChatGPT and spends your plan. Run it with FOLIO_BENCH=1, or offline with --fake.",
    );
  const count = (value: string | undefined, name: string) => {
    if (value === undefined) return undefined;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new Error(`${name} needs a whole number.`);
    return number;
  };
  const omit = count(values["inject-omission"], "--inject-omission") ?? 0;
  const complete = values.fake ? fakeStudyModel() : await chatgpt();
  const home = await mkdtemp(resolve(tmpdir(), "folio-bench-"));
  const started = Date.now();
  try {
    const decks = await runBench({
      home,
      complete,
      decks: studyDecks(),
      omit,
      concurrency: count(values.concurrency, "--concurrency"),
      jobs: count(values.jobs, "--jobs"),
      log: (line) => console.log(`[${((Date.now() - started) / 60_000).toFixed(1)} min] ${line}`),
    });
    const run: BenchRun = {
      version: 1,
      commit: git("rev-parse", "--short", "HEAD") ?? "unknown",
      dirty: !!git("status", "--porcelain"),
      createdAt: new Date().toISOString(),
      model: values.fake ? "fake" : "chatgpt",
      omit,
      decks,
    };
    await mkdir(".bench", { recursive: true });
    const file = resolve(".bench", `${runName(run)}.json`);
    await writeFile(file, `${JSON.stringify(run, null, 2)}\n`);
    console.log(`\n${benchReport(run)}\n\nSaved ${file}`);
  } finally {
    // Requests that carry a cache key keep a WebSocket open for minutes; the run is over.
    if (!values.fake) closeOpenAICodexWebSocketSessions();
    if (values.keep) console.log(`The run's Folio home is kept at ${home}`);
    else await rm(home, { recursive: true, force: true });
  }
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
