import type { DocumentDraft, LedgerEntry } from "./pipeline.ts";
import type { AuthorDraft, DraftBlock, Patch, RegionCoverage } from "./prompts.ts";

/** What the checker found each region teaches, by region ID. */
export type Coverage = Record<string, RegionCoverage>;

/**
 * Something a check stands behind that the notes get wrong, with an ID the fixer answers to:
 * a region no block cites, facts of a cited region no block carries, a claim the page
 * contradicts or could not confirm, or a citation of a region that does not exist.
 */
export interface Discrepancy {
  id: string;
  kind: "uncited" | "missing" | "contradicted" | "unchecked" | "bad_locator";
  region: string;
  page: number;
  /** The blocks it concerns; none for a region no block cites. */
  blocks: string[];
  detail: string;
}

export interface PatchResult {
  draft: AuthorDraft;
  applied: Patch[];
  rejected: { patch: Patch; problem: string }[];
}

/** What is wrong with a draft, in the order the fixer should see it. Word overlap is never here. */
export function discrepancies(
  ledger: LedgerEntry[],
  verdicts: DocumentDraft["verdicts"],
  draft: AuthorDraft,
  coverage: Coverage = {},
): Discrepancy[] {
  const found: Omit<Discrepancy, "id">[] = [];
  const blocks = draft.pages.flatMap((page) => page.blocks);
  const missing = missingFacts(coverage, draft);
  const listed = (region: string) =>
    missing.get(region)?.length
      ? ` The slide teaches: ${missing
          .get(region)!
          .map((fact) => `"${fact}"`)
          .join("; ")}.`
      : "";
  for (const entry of ledger)
    if (entry.state === "unaccounted" && !entry.blocks.length)
      found.push({
        kind: "uncited",
        region: entry.region,
        page: entry.page,
        blocks: [],
        detail: `Region ${entry.region} (page ${entry.page}) is not cited by any block.${listed(entry.region)}`,
      });
  for (const entry of ledger)
    if (entry.blocks.length && missing.get(entry.region)?.length)
      found.push({
        kind: "missing",
        region: entry.region,
        page: entry.page,
        blocks: entry.blocks,
        detail: `No block carries these facts of region ${entry.region}:${listed(entry.region).replace(" The slide teaches:", "")}`,
      });
  for (const verdict of Object.values(verdicts)) {
    if (verdict.verdict === "supported") continue;
    found.push({
      kind: verdict.verdict === "contradicted" ? "contradicted" : "unchecked",
      region: verdict.region,
      page: pageOf(verdict.region),
      blocks: blocks
        .filter((block) =>
          block.claims.some(
            (claim) => claim.text === verdict.text && claim.region === verdict.region,
          ),
        )
        .map((block) => block.id),
      detail:
        verdict.verdict === "contradicted"
          ? `The claim "${verdict.text}" is contradicted by the page: ${verdict.note}`
          : `The claim "${verdict.text}" could not be checked against the page: ${verdict.note}`,
    });
  }
  const regions = new Set(ledger.map((entry) => entry.region));
  for (const block of blocks)
    for (const locator of block.locators)
      if (!regions.has(locator.region))
        found.push({
          kind: "bad_locator",
          region: locator.region,
          page: locator.page,
          blocks: [block.id],
          detail: `Block ${block.id} cites ${locator.region}, which is not a region of page ${locator.page}.`,
        });
  return found.map((item, index) => ({ ...item, id: `d${index + 1}` }));
}

/**
 * Applies the fixer's patches to the draft, refusing any that would do more than fix what was
 * found: a patch must name the discrepancies it fixes, touch only the blocks they concern (or the
 * region they leave uncited), point at blocks, topics and regions that exist, leave every region
 * cited that was cited, omit only a region nothing cites, and be the only patch on its block.
 * Blocks no applied patch touches are returned exactly as they were.
 */
export function applyPatches(
  draft: AuthorDraft,
  patches: Patch[],
  found: Discrepancy[],
  regions: Set<string>,
): PatchResult {
  const next: AuthorDraft = { ...draft, pages: draft.pages.map((page) => ({ ...page })) };
  const byId = new Map(found.map((item) => [item.id, item]));
  const touched = new Set<string>();
  const applied: Patch[] = [];
  const rejected: PatchResult["rejected"] = [];
  const allBlocks = () => next.pages.flatMap((page) => page.blocks);
  const cited = (region: string, except?: DraftBlock) =>
    allBlocks().some(
      (block) => block !== except && block.locators.some((locator) => locator.region === region),
    );

  for (const patch of patches) {
    const problem = check(patch);
    if (problem) {
      rejected.push({ patch, problem });
      continue;
    }
    if (patch.op === "replace_block") {
      const page = next.pages.find((candidate) =>
        candidate.blocks.some((b) => b.id === patch.block_id),
      )!;
      page.blocks = page.blocks.map((block) => (block.id === patch.block_id ? patch.block : block));
      touched.add(patch.block_id);
    } else if (patch.op === "add_block") {
      const page = next.pages.find((candidate) => candidate.slug === patch.topic)!;
      const at = patch.after
        ? page.blocks.findIndex((block) => block.id === patch.after) + 1
        : page.blocks.length;
      page.blocks = [...page.blocks.slice(0, at), patch.block, ...page.blocks.slice(at)];
      touched.add(patch.block.id);
    } else {
      next.omitted = [
        ...next.omitted,
        { region: patch.region, reason: patch.reason, note: patch.note },
      ];
    }
    applied.push(patch);
  }
  return { draft: next, applied, rejected };

  function check(patch: Patch): string | null {
    if (!patch.fixes.length || patch.fixes.some((id) => !byId.has(id)))
      return "does not name the discrepancies it fixes";
    const fixes = patch.fixes.map((id) => byId.get(id)!);
    // Regions the patch must cite: those nothing cited, and those whose facts it adds.
    const uncited = fixes
      .filter((item) => item.kind === "uncited" || item.kind === "missing")
      .map((item) => item.region);
    if (patch.op === "omit_region") {
      const furniture = fixes.filter((item) => item.kind === "uncited").map((item) => item.region);
      if (!furniture.includes(patch.region)) return `omits ${patch.region}, which it does not fix`;
      if (cited(patch.region)) return `omits ${patch.region}, which a block cites`;
      return null;
    }
    const block = patch.block;
    const unknown = [
      ...block.locators.map((locator) => locator.region),
      ...block.claims.map((claim) => claim.region),
    ].filter((region) => !regions.has(region));
    if (unknown.length) return `cites ${unknown[0]}, which is not a region`;
    if (touched.has(block.id)) return `patches ${block.id} a second time`;
    const leftOut = uncited.filter(
      (region) => !block.locators.some((locator) => locator.region === region),
    );
    if (patch.op === "add_block") {
      if (!next.pages.some((page) => page.slug === patch.topic))
        return `adds to ${patch.topic}, which is not a topic`;
      const topic = next.pages.find((page) => page.slug === patch.topic)!;
      if (patch.after && !topic.blocks.some((existing) => existing.id === patch.after))
        return `adds after ${patch.after}, which is not in ${patch.topic}`;
      if (allBlocks().some((existing) => existing.id === block.id))
        return `adds ${block.id}, which already exists`;
      if (leftOut.length) return `does not cite ${leftOut[0]}, which it fixes`;
      return null;
    }
    const old = allBlocks().find((existing) => existing.id === patch.block_id);
    if (!old) return `replaces ${patch.block_id}, which is not a block`;
    if (block.id !== patch.block_id) return `renames ${patch.block_id} to ${block.id}`;
    const concerned = fixes.some((item) => item.blocks.includes(old.id));
    if (!concerned && (!uncited.length || leftOut.length))
      return `changes ${old.id}, which no discrepancy it fixes concerns`;
    const dropped = old.locators
      .map((locator) => locator.region)
      .filter(
        (region) =>
          !block.locators.some((locator) => locator.region === region) && !cited(region, old),
      );
    if (dropped.length) return `would leave ${dropped[0]} uncited`;
    return null;
  }
}

/** Facts each region teaches that no block of the draft carries, by region. */
export function missingFacts(coverage: Coverage, draft: AuthorDraft): Map<string, string[]> {
  const ids = new Set(draft.pages.flatMap((page) => page.blocks.map((block) => block.id)));
  const missing = new Map<string, string[]>();
  for (const [region, entry] of Object.entries(coverage)) {
    const facts = entry.facts.filter((fact) => !ids.has(fact.block)).map((fact) => fact.fact);
    if (facts.length) missing.set(region, facts);
  }
  return missing;
}

/**
 * A region nothing cites whose every fact the checker found in some block is restated there:
 * code adds a citation of it to those blocks, so it counts as covered without a fix.
 */
export function withRestated(
  draft: AuthorDraft,
  ledger: LedgerEntry[],
  coverage: Coverage,
): AuthorDraft {
  const ids = new Set(draft.pages.flatMap((page) => page.blocks.map((block) => block.id)));
  const restated = new Map<string, LedgerEntry[]>();
  for (const entry of ledger) {
    const facts = coverage[entry.region]?.facts ?? [];
    if (entry.state !== "unaccounted" || entry.blocks.length || !facts.length) continue;
    if (!facts.every((fact) => ids.has(fact.block))) continue;
    for (const block of new Set(facts.map((fact) => fact.block)))
      restated.set(block, [...(restated.get(block) ?? []), entry]);
  }
  if (!restated.size) return draft;
  return {
    ...draft,
    pages: draft.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) =>
        restated.has(block.id)
          ? {
              ...block,
              locators: [
                ...block.locators,
                ...restated.get(block.id)!.map((entry) => ({
                  page: entry.page,
                  region: entry.region,
                  location: "restated",
                })),
              ],
            }
          : block,
      ),
    })),
  };
}

/**
 * Marks the facts an applied patch says it added as carried by the block it wrote, so they are
 * not listed again, and forgets the facts of a region a patch omitted as page furniture; the
 * patch's own claims are checked against the page like any other.
 */
export function answered(
  coverage: Coverage,
  applied: Patch[],
  found: Discrepancy[],
  draft: AuthorDraft,
): Coverage {
  const next = structuredClone(coverage);
  const byId = new Map(found.map((item) => [item.id, item]));
  const ids = new Set(draft.pages.flatMap((page) => page.blocks.map((block) => block.id)));
  for (const patch of applied) {
    // A region omitted as page furniture teaches nothing, so none of its facts are missing.
    if (patch.op === "omit_region") {
      delete next[patch.region];
      continue;
    }
    for (const id of patch.fixes) {
      const item = byId.get(id);
      const entry =
        item && (item.kind === "missing" || item.kind === "uncited")
          ? next[item.region]
          : undefined;
      if (!entry || !patch.block.locators.some((locator) => locator.region === item!.region))
        continue;
      for (const fact of entry.facts) if (!ids.has(fact.block)) fact.block = patch.block.id;
    }
  }
  return next;
}

function pageOf(region: string): number {
  return Number(/^p(\d+)\./.exec(region)?.[1] ?? 0);
}
