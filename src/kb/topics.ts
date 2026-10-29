import { Type } from "typebox";
import { jsonCall, text, type CompleteFn } from "../ingest/models.ts";
import type { KnowledgeIndex } from "./index.ts";
import type { Knowledge, KnowledgeBlock, KnowledgePage } from "./knowledge.ts";

/**
 * Topics shared across a course's documents. A lecture and a recitation that teach the same
 * concept write into one topic page: the author is shown the topics the course already has,
 * code finds topics that may still be duplicates, a cheap model call judges each pair, and a
 * merge leaves a redirect so old links keep working. Block handles never change. Everything
 * else on the topic and anchor pages is derived from the blocks by code.
 */

export { BLOCK_KINDS, type BlockKind } from "../ingest/prompts.ts";

/** How a candidate pair of topics relate: only "same" merges; the others become links. */
export type Relation = "same" | "part_of" | "related" | "different";

/** Lectures, then recitations, by their number: L01, R01, L02, R02, ... */
export function sessionRank(slug: string): number {
  const match = /-([LR])(\d+)(?:-(\d+))?$/.exec(slug);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[2]) * 100 + (match[1] === "R" ? 50 : 0) + Number(match[3] ?? 0);
}

const bySession = (a: string, b: string) => sessionRank(a) - sessionRank(b) || a.localeCompare(b);

/** The sessions that write into a topic, in course order. */
export function sessionsOf(page: KnowledgePage): string[] {
  return [...new Set(page.blocks.map((block) => block.session))].sort(bySession);
}

const firstSentence = (value: string) =>
  (/^[^\n]*?[.!?](?=\s|$)/.exec(value.trim())?.[0] ?? value.trim().split("\n")[0] ?? "").slice(
    0,
    160,
  );

/**
 * The course's topics as the author of a new document sees them: one line each with its slug
 * (as the author writes it, without the course prefix), titles, aliases, a one-line definition
 * and where it is taught. Past the budget, only topics that share words with `focus` stay.
 */
export function topicInventory(
  knowledge: Knowledge | null,
  focus: string[] = [],
  budget = 16_000,
): string {
  if (!knowledge?.pages.length) return "";
  const prefix = `${knowledge.prefix}-`;
  const lines = knowledge.pages.map((page) => {
    const hebrew = [...new Set(page.blocks.flatMap((block) => block.keywords_he))].slice(0, 2);
    const aliases = [...new Set(page.blocks.flatMap((block) => block.aliases))].slice(0, 3);
    const defining =
      page.blocks.find((block) => block.kind === "definition") ?? page.blocks[0] ?? null;
    const meaning = firstSentence(page.overview?.text || page.intuition || defining?.body || "");
    return [
      page.slug.startsWith(prefix) ? page.slug.slice(prefix.length) : page.slug,
      page.title,
      hebrew.join(", "),
      aliases.length ? `aka ${aliases.join(", ")}` : "",
      meaning,
      `taught in ${sessionsOf(page).join(", ")}`,
      defining?.kind === "definition" ? `definition [${defining.handle}]` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  });
  const all = lines.join("\n");
  if (all.length <= budget) return all;
  const wanted = new Set(
    focus.flatMap((item) => item.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
  );
  const near = lines.filter((line) =>
    (line.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).some((word) => wanted.has(word)),
  );
  const kept: string[] = [];
  let used = 0;
  for (const line of near.length ? near : lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return `${kept.join("\n")}\n[${lines.length - kept.length} more topics are not shown.]`;
}

/** Two topics that may be one; `topic` is the one being checked. */
export interface Candidate {
  topic: string;
  other: string;
}

const normal = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Topics that may duplicate each of `slugs`, found by code: the same title or alias in either
 * language, or the course's search index ranking another topic's sections first for the topic's
 * names and keywords. A topic is only compared with topics taught in other sessions.
 */
export function duplicateCandidates(
  knowledge: Knowledge,
  index: KnowledgeIndex | null,
  slugs: string[],
  perTopic = 3,
): Candidate[] {
  const pages = new Map(knowledge.pages.map((page) => [page.slug, page]));
  const topicOf = new Map(
    knowledge.pages.flatMap((page) => page.blocks.map((block) => [block.handle, page.slug])),
  );
  const names = (page: KnowledgePage) =>
    new Set(
      [
        page.title,
        ...page.blocks.flatMap((block) => [...block.aliases, ...block.keywords_he.slice(0, 2)]),
      ]
        .map(normal)
        .filter((name) => name.length > 2),
    );
  const seen = new Set<string>();
  const found: Candidate[] = [];
  for (const slug of slugs) {
    const page = pages.get(slug);
    if (!page) continue;
    const own = new Set(sessionsOf(page));
    const others = knowledge.sessions.map((session) => session.slug).filter((s) => !own.has(s));
    if (!others.length) continue;
    const mine = names(page);
    const picks: string[] = [];
    for (const other of knowledge.pages)
      if (
        other.slug !== slug &&
        sessionsOf(other).some((session) => !own.has(session)) &&
        [...names(other)].some((name) => mine.has(name))
      )
        picks.push(other.slug);
    const query = [
      page.title,
      ...page.blocks.flatMap((block) => [
        ...block.aliases,
        ...block.keywords_en.slice(0, 4),
        ...block.keywords_he.slice(0, 2),
      ]),
    ].join(" ");
    for (const hit of index?.search(query, others, 12) ?? []) {
      const other = topicOf.get(hit.handle);
      if (other && other !== slug && !picks.includes(other)) picks.push(other);
    }
    for (const other of picks.slice(0, perTopic)) {
      const key = [slug, other].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ topic: slug, other });
    }
  }
  return found;
}

/** Folio's calls for topics: judging candidate pairs, and overviews of shared topics. */
export interface TopicModel {
  judge(knowledge: Knowledge, pairs: Candidate[]): Promise<(Candidate & { relation: Relation })[]>;
  overview(
    knowledge: Knowledge,
    slugs: string[],
  ): Promise<{ slug: string; text: string; handles: string[] }[]>;
}

export const JUDGE_SYSTEM = [
  "You compare topics from the study notes of one university course, written from different lectures and recitations, and decide which belong on one study page.",
  'Answer "same" when a student would look for both on one page: the same concept or technique under different names, notation or languages (a Hebrew and an English name for one thing are the same), or two pages that mostly teach the same material, such as a problem and its membership proof, or a definition and the class it defines. Duplicate pages are worse than a slightly broader one.',
  'Answer "part_of" only when the first is a distinct part or special case of the second that deserves a page of its own; "related" only for a strong teaching link, where knowing one is needed to follow the other; "different" otherwise. Most pairs that are not the same are different.',
  "Judge only from what is given.",
].join("\n");

/**
 * Raised when the merging rules change, so courses grouped under older rules are grouped again
 * once. 2 (2026-10-29): clear overlaps merge; links are kept to a few per topic.
 */
export const TOPIC_POLICY = 2;

/** At most this many links per topic, its parts and wholes first. */
const MAX_LINKS = 4;

export const judgeSchema = Type.Object({
  pairs: Type.Array(
    Type.Object({
      pair: Type.Integer({ minimum: 1 }),
      relation: Type.Union([
        Type.Literal("same"),
        Type.Literal("part_of"),
        Type.Literal("related"),
        Type.Literal("different"),
      ]),
    }),
  ),
});

export const OVERVIEW_SYSTEM = [
  "You write the short overview at the top of a topic page in a university course's study notes. The topic is taught in more than one lecture or recitation; its sections are given with their handles.",
  "Write two to four plain sentences that say what the topic is and how the sources fit together, using only what the sections say, in the sections' notation. Write in English, keeping a Hebrew term in parentheses where the sections do.",
  "List the handles of the sections the overview draws on. Never add anything the sections do not say.",
].join("\n");

export const overviewSchema = Type.Object({
  overviews: Type.Array(
    Type.Object({
      topic: Type.String(),
      text: Type.String(),
      handles: Type.Array(Type.String()),
    }),
  ),
});

/** What a model is shown about a topic: its names and the start of each of its sections. */
function describe(page: KnowledgePage, budget = 1_200): string {
  const lines = [`${page.title} (${sessionsOf(page).join(", ")})`];
  if (page.intuition) lines.push(`Intuition: ${page.intuition}`);
  let used = 0;
  for (const block of page.blocks) {
    const line = `- [${block.handle}] ${block.title}: ${block.body.replace(/\s+/g, " ").slice(0, 400)}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

/** The topic calls on Terra at low effort, through the same requests ingestion uses. */
export function topicModel(complete: CompleteFn, model = "gpt-6.1-terra"): TopicModel {
  const usage = () => undefined;
  return {
    async judge(knowledge, pairs) {
      if (!pairs.length) return [];
      const pages = new Map(knowledge.pages.map((page) => [page.slug, page]));
      const judged: (Candidate & { relation: Relation })[] = [];
      for (let start = 0; start < pairs.length; start += 20) {
        const batch = pairs.slice(start, start + 20);
        const body = batch
          .map(
            (pair, index) =>
              `Pair ${index + 1}\nFirst: ${describe(pages.get(pair.topic)!)}\nSecond: ${describe(pages.get(pair.other)!)}`,
          )
          .join("\n\n");
        const answer = await jsonCall<{ pairs: { pair: number; relation: Relation }[] }>(
          complete,
          {
            model,
            system: JUDGE_SYSTEM,
            content: [text(body)],
            maxTokens: 2_000,
            reasoning: "low",
          },
          judgeSchema,
          usage,
        );
        for (const item of answer.pairs) {
          const pair = batch[item.pair - 1];
          if (pair) judged.push({ ...pair, relation: item.relation });
        }
      }
      return judged;
    },
    async overview(knowledge, slugs) {
      if (!slugs.length) return [];
      const pages = slugs.flatMap((slug) => knowledge.pages.filter((page) => page.slug === slug));
      const answer = await jsonCall<{
        overviews: { topic: string; text: string; handles: string[] }[];
      }>(
        complete,
        {
          model,
          system: OVERVIEW_SYSTEM,
          content: [
            text(pages.map((page) => `Topic ${page.slug}\n${describe(page, 3_000)}`).join("\n\n")),
          ],
          maxTokens: 600 * pages.length + 400,
          reasoning: "low",
        },
        overviewSchema,
        usage,
      );
      return answer.overviews.map((item) => ({
        slug: item.topic,
        text: item.text,
        handles: item.handles,
      }));
    },
  };
}

/**
 * Applies judged pairs. A "same" pair becomes one topic: the one taught first keeps its slug and
 * gains the other's blocks, and the other's slug redirects to it. "part_of" and "related" become
 * links on both pages. Derived fields are recomputed afterwards.
 */
export function applyRelations(
  knowledge: Knowledge,
  judged: (Candidate & { relation: Relation })[],
): Knowledge {
  const next: Knowledge = structuredClone(knowledge);
  next.redirects ??= {};
  const live = (slug: string) => {
    let current = slug;
    for (let hops = 0; next.redirects![current] && hops < 20; hops++)
      current = next.redirects![current]!;
    return current;
  };
  const first = (page: KnowledgePage) => sessionRank(sessionsOf(page)[0] ?? "");
  for (const pair of judged) {
    const a = next.pages.find((page) => page.slug === live(pair.topic));
    const b = next.pages.find((page) => page.slug === live(pair.other));
    if (!a || !b || a === b) continue;
    if (pair.relation === "same") {
      const [keep, gone] =
        first(a) < first(b) || (first(a) === first(b) && a.slug < b.slug) ? [a, b] : [b, a];
      keep.blocks.push(...gone.blocks);
      keep.prerequisites = [...new Set([...keep.prerequisites, ...gone.prerequisites])];
      keep.related = [...(keep.related ?? []), ...(gone.related ?? [])];
      keep.intuition ||= gone.intuition;
      delete keep.overview;
      next.redirects[gone.slug] = keep.slug;
      next.pages = next.pages.filter((page) => page !== gone);
    } else if (pair.relation === "part_of" || pair.relation === "related") {
      a.related = [...(a.related ?? []), { slug: b.slug, relation: pair.relation }];
      b.related = [
        ...(b.related ?? []),
        { slug: a.slug, relation: pair.relation === "part_of" ? "has_part" : "related" },
      ];
    }
  }
  return finishKnowledge(next);
}

/**
 * Recomputes everything on topic and anchor pages that code derives from the blocks: links
 * through redirects, where each topic was introduced, each session's slide-order outline and
 * what only it teaches. Overviews whose sections changed are dropped, to be written again.
 */
export function finishKnowledge(knowledge: Knowledge): Knowledge {
  const next: Knowledge = {
    ...knowledge,
    version: 2,
    redirects: { ...knowledge.redirects },
  };
  const slugs = new Set(next.pages.map((page) => page.slug));
  // A redirect points at a live topic, in one step; one whose target is gone is dropped.
  const resolve = (slug: string) => {
    let current = slug;
    for (let hops = 0; next.redirects![current] && hops < 20; hops++)
      current = next.redirects![current]!;
    return current;
  };
  const redirects = next.redirects ?? {};
  next.redirects = Object.fromEntries(
    Object.keys(redirects)
      .map((from): [string, string] => [from, resolve(from)])
      .filter(([from, to]) => slugs.has(to) && !slugs.has(from)),
  );
  next.pages = next.pages.map((page) => {
    const sessions = sessionsOf(page);
    const handles = page.blocks.map((block) => block.handle).sort();
    const related = new Map<string, NonNullable<KnowledgePage["related"]>[number]>();
    for (const link of page.related ?? []) {
      const slug = resolve(link.slug);
      if (slug !== page.slug && slugs.has(slug) && !related.has(slug))
        related.set(slug, { ...link, slug });
    }
    const links = [...related.values()].sort(
      (a, b) => Number(a.relation === "related") - Number(b.relation === "related"),
    );
    return {
      ...page,
      introducedIn: sessions[0] ?? page.introducedIn,
      prerequisites: [
        ...new Set(page.prerequisites.map(resolve).filter((slug) => slug !== page.slug)),
      ],
      related: links.slice(0, MAX_LINKS),
      blocks: page.blocks.map((block) => ({ ...block, kind: block.kind ?? "explanation" })),
      ...(page.overview && page.overview.basis === handles.join(",")
        ? { overview: page.overview }
        : { overview: undefined }),
    };
  });
  for (const page of next.pages) if (!page.overview) delete page.overview;
  const teachers = new Map(next.pages.map((page) => [page.slug, sessionsOf(page)]));
  next.sessions = next.sessions.map((session) => {
    const own = next.pages.flatMap((page) =>
      page.blocks
        .filter((block) => block.session === session.slug)
        .map((block) => ({ page, block })),
    );
    const first = (block: KnowledgeBlock) =>
      Math.min(...block.locators.map((locator) => locator.page));
    const outline = own
      .sort((a, b) => first(a.block) - first(b.block) || a.page.slug.localeCompare(b.page.slug))
      .reduce<NonNullable<typeof session.outline>>((rows, { page, block }) => {
        const pages = [...new Set(block.locators.map((locator) => locator.page))].sort(
          (a, b) => a - b,
        );
        const last = rows.at(-1);
        if (last?.topic === page.slug) {
          last.handles.push(block.handle);
          last.pages = [...new Set([...last.pages, ...pages])].sort((a, b) => a - b);
        } else rows.push({ topic: page.slug, pages, handles: [block.handle] });
        return rows;
      }, []);
    return {
      ...session,
      outline,
      onlyHere: [
        ...new Set(
          own
            .filter(({ page }) => (teachers.get(page.slug) ?? []).length === 1)
            .map(({ page }) => page.slug),
        ),
      ],
      workedExamples: session.workedExamples.map((example) => ({
        ...example,
        slug: resolve(example.slug),
      })),
    };
  });
  return next;
}

/** Topics taught in more than one session, with no overview for their current sections. */
export function needingOverview(knowledge: Knowledge): string[] {
  return knowledge.pages
    .filter((page) => sessionsOf(page).length > 1 && !page.overview)
    .map((page) => page.slug);
}

/** Keeps each overview whose cited handles are the topic's own; the rest are dropped. */
export function withOverviews(
  knowledge: Knowledge,
  written: { slug: string; text: string; handles: string[] }[],
): Knowledge {
  const next: Knowledge = structuredClone(knowledge);
  for (const item of written) {
    const page = next.pages.find((candidate) => candidate.slug === item.slug);
    if (!page || !item.text.trim()) continue;
    const own = new Set(page.blocks.map((block) => block.handle));
    const handles = [...new Set(item.handles.filter((handle) => own.has(handle)))];
    if (!handles.length) continue;
    page.overview = {
      text: item.text.trim(),
      handles,
      basis: page.blocks
        .map((block) => block.handle)
        .sort()
        .join(","),
    };
  }
  return next;
}

/**
 * Settles a course's topics after new sections arrive or on a regroup: pairs among `slugs` and
 * the rest are judged and applied, then shared topics get overviews. A model failure leaves the
 * knowledge as it was, never blocking a publish.
 */
export async function settleTopics(
  knowledge: Knowledge,
  index: KnowledgeIndex | null,
  model: TopicModel | undefined,
  slugs: string[],
): Promise<{ knowledge: Knowledge; merged: { from: string; into: string }[] }> {
  let next = finishKnowledge(knowledge);
  if (!model) return { knowledge: next, merged: [] };
  const titles = new Map(next.pages.map((page) => [page.slug, page.title]));
  try {
    const pairs = duplicateCandidates(next, index, slugs);
    if (pairs.length) next = applyRelations(next, await model.judge(next, pairs));
  } catch (error) {
    console.error("Folio could not compare topics:", error);
  }
  try {
    const wanting = needingOverview(next);
    if (wanting.length) next = withOverviews(next, await model.overview(next, wanting));
  } catch (error) {
    console.error("Folio could not write topic overviews:", error);
  }
  next = finishKnowledge(next);
  const live = new Map(next.pages.map((page) => [page.slug, page.title]));
  // What merged, by title: each topic that is gone, and the topic it became part of.
  const merged = [...titles]
    .filter(([slug]) => !live.has(slug))
    .map(([slug, from]) => {
      let into = slug;
      for (let hops = 0; next.redirects?.[into] && hops < 20; hops++) into = next.redirects[into]!;
      return { from, into: live.get(into) ?? from };
    });
  return { knowledge: next, merged };
}

/** Lints a knowledge before it is published: every block in one session, every link live. */
export function topicProblems(knowledge: Knowledge): string[] {
  const problems: string[] = [];
  const sessions = new Set(knowledge.sessions.map((session) => session.slug));
  const slugs = new Set(knowledge.pages.map((page) => page.slug));
  const handles = new Map<string, number>();
  for (const page of knowledge.pages)
    for (const block of page.blocks) {
      handles.set(block.handle, (handles.get(block.handle) ?? 0) + 1);
      if (!sessions.has(block.session))
        problems.push(`${block.handle} belongs to no session (${block.session}).`);
    }
  for (const [handle, count] of handles)
    if (count > 1) problems.push(`${handle} appears on ${count} topic pages.`);
  for (const session of knowledge.sessions)
    for (const row of session.outline ?? [])
      if (!slugs.has(row.topic)) problems.push(`${session.slug}'s outline points to ${row.topic}.`);
  for (const [from, to] of Object.entries(knowledge.redirects ?? {}))
    if (!slugs.has(to)) problems.push(`The redirect from ${from} points to ${to}, which is gone.`);
  return problems;
}
