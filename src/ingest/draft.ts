import type { AuthorDraft, DraftBlock, DraftPage } from "./prompts.ts";

/**
 * Renders an author's draft as wiki Markdown: Obsidian-readable pages with core frontmatter,
 * an `evidence` list whose locators carry region IDs, and marked evidence blocks.
 */

export interface SessionInfo {
  /** Course slug prefix, such as "alg". */
  prefix: string;
  /** "alg-L01" or "alg-R01". */
  slug: string;
  type: "lecture" | "recitation";
  /** The source ID used in locators, such as "alg-L01". */
  sourceId: string;
  /** Library-relative path of the original, for `sources`. */
  sourcePath: string;
  date: string;
  pairedWith: string[];
}

export interface WikiFile {
  /** Relative to the wiki root, such as "concepts/alg-bfs.md". */
  path: string;
  content: string;
}

/** A course-prefixed slug; free text a model wrote ("Directed graphs") is turned into one too. */
export function topicSlug(prefix: string, slug: string): string {
  const clean = slug
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.startsWith(`${prefix}-`) ? clean : `${prefix}-${clean}`;
}

/** The pages a draft creates or extends, plus its session page. */
export function renderDraft(draft: AuthorDraft, session: SessionInfo): WikiFile[] {
  const files = draft.pages.map((page) => ({
    path: `${page.type === "technique" ? "techniques" : "concepts"}/${topicSlug(session.prefix, page.slug)}.md`,
    content: renderTopic(page, session),
  }));
  files.push({
    path: `${session.type === "lecture" ? "lectures" : "recitations"}/${session.slug}.md`,
    content: renderSession(draft, session),
  });
  return files;
}

export function renderTopic(page: DraftPage, session: SessionInfo): string {
  const slug = topicSlug(session.prefix, page.slug);
  const frontmatter = {
    title: page.title,
    slug,
    type: page.type,
    introduced_in: session.slug,
    prerequisites: page.prerequisites.map((item) => topicSlug(session.prefix, item)),
    used_by: [] as string[],
    confidence: "not-yet-tested",
    last_reviewed: session.date,
    sources: [session.sourcePath],
    evidence: page.blocks.map((block) => evidenceEntry(block, session)),
  };
  const body = [
    `# ${page.title}`,
    "",
    page.intuition.trim(),
    "",
    ...page.blocks.flatMap((block) => [
      `## ${block.title}`,
      "",
      `<!-- study-rag: ${block.id} -->`,
      block.body.trim(),
      `<!-- /study-rag -->`,
      "",
    ]),
  ];
  return `---\n${yaml(frontmatter)}---\n\n${body.join("\n").trim()}\n`;
}

function evidenceEntry(block: DraftBlock, session: SessionInfo) {
  return {
    id: block.id,
    title: block.title,
    source_locators: block.locators.map((locator) => ({
      source_id: session.sourceId,
      page: locator.page,
      region: locator.region,
      location: locator.location,
    })),
    keywords_en: block.keywords_en,
    keywords_he: block.keywords_he,
    aliases: block.aliases,
    questions: block.questions,
    interpretations: block.interpretations,
    gaps: block.gaps,
  };
}

export function renderSession(draft: AuthorDraft, session: SessionInfo): string {
  const frontmatter = {
    title: draft.session.title,
    slug: session.slug,
    type: session.type,
    sources: [session.sourcePath],
    date_ingested: session.date,
    last_reviewed: session.date,
    paired_with: session.pairedWith,
  };
  const link = (slug: string) => `[[${topicSlug(session.prefix, slug)}]]`;
  const lines = [
    session.pairedWith.length
      ? `Companion to ${session.pairedWith.map((slug) => `[[${slug}]]`).join(", ")}.\n`
      : "",
    "## What this session covers",
    draft.session.covers.trim(),
    "",
    "## New concepts introduced",
    ...draft.pages.map((page) => `- ${link(page.slug)}`),
    "",
    "## Concepts used (already known)",
    ...[...new Set(draft.pages.flatMap((page) => page.prerequisites))].map(
      (slug) => `- ${link(slug)}`,
    ),
    "",
    "## Worked examples",
    ...draft.session.worked_examples.map(
      (example) => `- ${example.title}: physical page ${example.page}; ${link(example.slug)}.`,
    ),
    "",
    "## Worth remembering",
    ...draft.session.worth_remembering.map((item) => `- ${item}`),
    "",
    "## Open threads",
    ...draft.session.open_threads.map((item) => `- ${item}`),
  ];
  return `---\n${yaml(frontmatter)}---\n\n${lines.join("\n").trim()}\n`;
}

/** A small YAML writer for the frontmatter shapes above: strings are always quoted. */
export function yaml(value: Record<string, unknown>, indent = ""): string {
  let out = "";
  for (const [key, item] of Object.entries(value))
    out += `${indent}${key}:${yamlValue(item, indent)}`;
  return out;
}

function yamlValue(item: unknown, indent: string): string {
  if (Array.isArray(item)) {
    if (!item.length) return " []\n";
    if (item.every((entry) => typeof entry !== "object" || entry === null))
      return ` [${item.map(scalar).join(", ")}]\n`;
    return `\n${item
      .map((entry) => {
        const nested = yaml(entry as Record<string, unknown>, `${indent}    `);
        return `${indent}  - ${nested.trimStart()}`;
      })
      .join("")}`;
  }
  if (item && typeof item === "object")
    return `\n${yaml(item as Record<string, unknown>, `${indent}  `)}`;
  return ` ${scalar(item)}\n`;
}

function scalar(item: unknown): string {
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  if (item === null || item === undefined) return "null";
  return JSON.stringify(item as string);
}
