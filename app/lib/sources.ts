import type { SourceView } from "../../src/desktop/api.ts";
import { pageRuns, plural, type PageRun } from "./labels.ts";

/** The pages a reply read from one document, in page order and run together. */
export interface SourceGroup {
  documentId: string;
  title: string;
  pages: number[];
  runs: PageRun[];
}

/** A reply's pages by document, each document where the tutor first read it. */
export function groupSources(sources: SourceView[]): SourceGroup[] {
  const groups = new Map<string, { title: string; pages: number[] }>();
  for (const source of sources) {
    const group = groups.get(source.documentId);
    if (group) group.pages.push(source.page);
    else groups.set(source.documentId, { title: source.title, pages: [source.page] });
  }
  return [...groups].map(([documentId, { title, pages }]) => {
    const sorted = [...new Set(pages)].sort((a, b) => a - b);
    return { documentId, title, pages: sorted, runs: pageRuns(sorted) };
  });
}

/**
 * Up to three runs of pages sit under a reply as they are, one chip each; more fold into a
 * single line that opens to a line per document.
 */
export function foldSources(groups: Pick<SourceGroup, "runs">[]): boolean {
  return groups.reduce((runs, group) => runs + group.runs.length, 0) > 3;
}

/** "Read 33 pages from 2 files", or "Read 12 pages from Lecture 2" when one file gave them all. */
export function readSummary(groups: Pick<SourceGroup, "title" | "pages">[]): string {
  const pages = groups.reduce((count, group) => count + group.pages.length, 0);
  const from = groups.length === 1 ? groups[0]!.title : plural(groups.length, "file");
  return `Read ${plural(pages, "page")} from ${from}`;
}
