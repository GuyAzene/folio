import { normalizeText, words } from "../kb/normalize.ts";

/**
 * What Folio reads out of a note's Markdown to list, filter and link it: a preview line, its
 * #tags, the notes it links to, the pages it cites, and where other notes mention it. Pure text
 * work, shared by the main process and the window; code is never read as any of these.
 */

/** `[[target]]` or `[[target|shown text]]`; the same pattern the editor styles. */
const WIKILINK = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;

/**
 * A #tag as in Obsidian and Bear: after a space or the line start, letters in any script, digits,
 * `_`, `-` and `/` for nesting, and at least one character that is not a digit (so "#3" stays a
 * number). "# Heading" is a heading, not a tag.
 */
const TAG = /(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** A citation of a document's page, as "Add to note" writes it: `[[page:<document>#<page>|…]]`. */
const PAGE = /^page:([0-9a-f-]{36})#(\d{1,5})$/i;

/** The note without fenced code, inline code or HTML comments, with line breaks kept. */
function prose(content: string): string {
  const blank = (part: string) => part.replace(/[^\n]/g, " ");
  return content
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/** The body after the title line, as plain text on one line: what a list shows under a title. */
export function notePreview(content: string, length = 180): string {
  const lines = prose(content).split("\n");
  const title = lines.findIndex((line) => line.trim());
  return lines
    .slice(title + 1)
    .join(" ")
    .replace(WIKILINK, (_match, target: string, shown?: string) =>
      (shown ?? target.replace(/^topic:/, "")).trim(),
    )
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\$\$?([^$]*)\$\$?/g, "$1")
    .replace(/(^|\s)(#{1,6}|>|[-*+]|\d+[.)]|- \[[ xX]\])\s+/g, " ")
    .replace(/[*_~=]{1,3}(\S[^*_~=]*?)[*_~=]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, length);
}

/** The note's #tags, each once (the first spelling wins), in the order they first appear. */
export function noteTags(content: string): string[] {
  const seen = new Map<string, string>();
  for (const match of prose(content).matchAll(TAG)) {
    const tag = match[2]!.replace(/\/+$/, "");
    if (tag && !seen.has(tag.toLocaleLowerCase())) seen.set(tag.toLocaleLowerCase(), tag);
  }
  return [...seen.values()];
}

/** Titles of the notes this one links to, each once; topic, page and chat links are not notes. */
export function noteLinks(content: string): string[] {
  const seen = new Map<string, string>();
  for (const match of prose(content).matchAll(WIKILINK)) {
    const target = match[1]!.trim();
    if (/^(topic|page|chat):/i.test(target)) continue;
    if (!seen.has(target.toLocaleLowerCase())) seen.set(target.toLocaleLowerCase(), target);
  }
  return [...seen.values()];
}

/** A cited page from a link target, or null when the target is not a page citation. */
export function pageCitation(target: string): { documentId: string; page: number } | null {
  const match = PAGE.exec(target.trim());
  return match ? { documentId: match[1]!.toLowerCase(), page: Number(match[2]) } : null;
}

/** The documents this note cites, each with the pages cited, in order of first citation. */
export function noteCitations(content: string): { documentId: string; pages: number[] }[] {
  const cited = new Map<string, Set<number>>();
  for (const match of prose(content).matchAll(WIKILINK)) {
    const citation = pageCitation(match[1]!);
    if (!citation) continue;
    const pages = cited.get(citation.documentId) ?? new Set<number>();
    pages.add(citation.page);
    cited.set(citation.documentId, pages);
  }
  return [...cited].map(([documentId, pages]) => ({
    documentId,
    pages: [...pages].sort((a, b) => a - b),
  }));
}

/** The text of a page citation, written where the student chose "Add to note". */
export function citationLink(documentId: string, page: number, shown: string): string {
  return `[[page:${documentId}#${page}|${shown
    .replace(/[[\]|\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()}]]`;
}

/** The note's headings in order, with their 0-based line, for an outline. */
export function noteHeadings(content: string): { level: number; text: string; line: number }[] {
  const lines = prose(content).split("\n");
  const first = lines.findIndex((line) => line.trim());
  return lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    // The first line is the note's title, shown above the outline already.
    if (!match || index === first) return [];
    return [{ level: match[1]!.length, text: match[2]!, line: index }];
  });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where a title stands alone in text: not inside a longer word, in any script. */
function titlePattern(title: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(title)}(?![\\p{L}\\p{N}])`, "giu");
}

/** Links as they read: their shown text, or the target without a "topic:" prefix. */
function readable(text: string): string {
  return text.replace(WIKILINK, (_match, target: string, shown?: string) =>
    (shown ?? target.replace(/^topic:/, "")).trim(),
  );
}

/** One line of another note that mentions a title, trimmed to show the mention. */
export interface Mention {
  line: number;
  text: string;
}

function excerpt(line: string, at: number, length: number, width = 160): string {
  const start = Math.max(0, at - Math.floor((width - length) / 2));
  const end = Math.min(line.length, start + width);
  return `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`;
}

/**
 * Where `content` mentions the note titled `title`: lines that link to it, and lines that name
 * it in plain text without linking. Code, other links and the note's own title line are skipped.
 */
export function mentionsOf(
  content: string,
  title: string,
): { linked: Mention[]; unlinked: Mention[] } {
  const linked: Mention[] = [];
  const unlinked: Mention[] = [];
  const key = title.trim().toLocaleLowerCase();
  if (!key) return { linked, unlinked };
  const lines = prose(content).split("\n");
  const first = lines.findIndex((line) => line.trim());
  lines.forEach((line, index) => {
    if (index === first) return;
    let links = false;
    const plain = line.replace(WIKILINK, (match, target: string) => {
      if (target.trim().toLocaleLowerCase() === key) links = true;
      return " ".repeat(match.length);
    });
    if (links) {
      linked.push({ line: index, text: readable(excerpt(line.replace(/\s+/g, " ").trim(), 0, 0)) });
      return;
    }
    const found = titlePattern(title.trim()).exec(plain);
    if (found)
      unlinked.push({
        line: index,
        text: readable(excerpt(line, found.index, title.length).replace(/\s+/g, " ")),
      });
  });
  return { linked, unlinked };
}

/**
 * Turns the first plain-text mention of `title` into a link, keeping how it was written: a
 * different case becomes `[[Title|as written]]`. Returns null when there is none to link.
 */
export function linkFirstMention(content: string, title: string): string | null {
  const name = title.trim();
  if (!name) return null;
  // Positions in the code-free copy are positions in the note: blanking keeps every offset.
  const masked = prose(content).replace(WIKILINK, (match) => " ".repeat(match.length));
  const lines = masked.split("\n");
  const first = lines.findIndex((line) => line.trim());
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const found = index === first ? null : titlePattern(name).exec(line);
    if (found) {
      const at = offset + found.index;
      const written = content.slice(at, at + found[0].length);
      const link = written === name ? `[[${name}]]` : `[[${name}|${written}]]`;
      return content.slice(0, at) + link + content.slice(at + found[0].length);
    }
    offset += line.length + 1;
  }
  return null;
}

/** What a note list needs from a note's text, computed when the note is listed. */
export interface NoteFacts {
  preview: string;
  tags: string[];
  /** Titles of the notes it links to. */
  links: string[];
  /** Documents it cites a page of. */
  cites: string[];
}

export function noteFacts(content: string): NoteFacts {
  return {
    preview: notePreview(content),
    tags: noteTags(content),
    links: noteLinks(content),
    cites: noteCitations(content).map((citation) => citation.documentId),
  };
}

/** A note that matches a search, ranked, with the line that matched. */
export interface NoteMatch {
  score: number;
  snippet: string;
}

/**
 * Whether a note matches a search: every word of the query appears in its title or text,
 * compared after Hebrew and case normalization, so "גרף" finds "בגרפים" and "bfs" finds "BFS".
 * Title matches rank first. The snippet is the first line past the title that matches.
 */
export function matchNote(content: string, title: string, query: string): NoteMatch | null {
  const terms = words(query);
  if (!terms.length) return null;
  const head = normalizeText(title);
  const body = normalizeText(content);
  if (!terms.every((term) => head.includes(term) || body.includes(term))) return null;
  let score = terms.filter((term) => head.includes(term)).length * 100;
  for (const term of terms) score += Math.min(body.split(term).length - 1, 5);
  const lines = content.split("\n");
  const first = lines.findIndex((line) => line.trim());
  const at = lines.findIndex(
    (line, index) => index !== first && terms.some((term) => normalizeText(line).includes(term)),
  );
  if (at === -1) return { score, snippet: notePreview(content, 160) };
  const line = lines[at]!.replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/, "");
  const lower = line.toLocaleLowerCase();
  const raw = query
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((word) => lower.indexOf(word))
    .find((index) => index >= 0);
  return { score, snippet: excerpt(line, raw ?? 0, 0).replace(/\s+/g, " ") };
}
