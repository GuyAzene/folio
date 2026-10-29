import { topicSlug, yaml, type WikiFile } from "../ingest/draft.ts";
import type { DraftBundle, LedgerEntry } from "../ingest/pipeline.ts";
import type { DraftBlock } from "../ingest/prompts.ts";

/**
 * A course's published knowledge: the structured source every generation's Markdown and search
 * index are built from. Blocks keep the session and source they came from, so re-studying a
 * lecture replaces exactly its own blocks.
 */
export interface KnowledgeBlock extends DraftBlock {
  /** Course-prefixed and unique within the course, such as "alg-bfs-marking". */
  handle: string;
  session: string;
  sourceId: string;
  documentId: string;
}

export interface KnowledgePage {
  slug: string;
  title: string;
  type: "concept" | "technique";
  introducedIn: string;
  prerequisites: string[];
  intuition: string;
  blocks: KnowledgeBlock[];
}

export interface KnowledgeSession {
  slug: string;
  type: "lecture" | "recitation";
  title: string;
  documentId: string;
  sha256: string;
  covers: string;
  workedExamples: { title: string; page: number; slug: string }[];
  worthRemembering: string[];
  openThreads: string[];
  pairedWith: string[];
  newConcepts: string[];
  /** Region states after review, including gaps the student acknowledged. */
  ledger: LedgerEntry[];
  /** Each page's text layer, for locating unreviewed wording; not teaching evidence. */
  sourcePages: { page: number; text: string }[];
  studiedAt: string;
  jobId: string;
}

export interface Knowledge {
  version: 1;
  courseId: string;
  prefix: string;
  sessions: KnowledgeSession[];
  pages: KnowledgePage[];
}

export function emptyKnowledge(courseId: string, prefix: string): Knowledge {
  return { version: 1, courseId, prefix, sessions: [], pages: [] };
}

/** A region the student accepted as a gap when it was left unaccounted. */
export interface Acknowledgement {
  documentId: string;
  region: string;
  note: string;
}

/**
 * Merges a reviewed draft into the course's knowledge. A re-studied document replaces its own
 * session record and blocks, whatever slug they had; pages extend by slug; nothing from other
 * documents is touched, even one whose session already has the slug this one asks for.
 */
export function mergeDraft(
  previous: Knowledge,
  bundle: DraftBundle,
  acknowledgements: Acknowledgement[] = [],
): Knowledge {
  const next: Knowledge = structuredClone(previous);
  for (const document of bundle.documents) {
    const { draft } = document;
    const held = (slug: string) =>
      next.sessions.some(
        (existing) => existing.slug === slug && existing.documentId !== document.documentId,
      );
    let slug = document.session.slug;
    for (let copy = 2; held(slug); copy++) slug = `${document.session.slug}-${copy}`;
    const session = { ...document.session, slug };
    const replaced = new Set([
      slug,
      ...next.sessions
        .filter((existing) => existing.documentId === document.documentId)
        .map((existing) => existing.slug),
    ]);
    next.prefix = session.prefix;
    next.sessions = next.sessions.filter((existing) => !replaced.has(existing.slug));
    for (const page of next.pages)
      page.blocks = page.blocks.filter((block) => !replaced.has(block.session));

    const ledger = document.ledger.map((entry) => {
      const accepted = acknowledgements.find(
        (item) => item.documentId === document.documentId && item.region === entry.region,
      );
      return entry.state === "unaccounted" && accepted
        ? { ...entry, state: "gap" as const, reason: `Accepted by the student: ${accepted.note}` }
        : entry;
    });
    const unaccounted = ledger.filter((entry) => entry.state === "unaccounted");
    if (unaccounted.length)
      throw new Error(
        `${unaccounted.length} region${unaccounted.length === 1 ? " is" : "s are"} still unaccounted for in ${session.slug}. Review ${unaccounted.length === 1 ? "it" : "them"} before publishing.`,
      );

    const handles = new Set(next.pages.flatMap((page) => page.blocks.map((block) => block.handle)));
    const newConcepts: string[] = [];
    for (const page of draft.pages) {
      const slug = topicSlug(session.prefix, page.slug);
      let target = next.pages.find((existing) => existing.slug === slug);
      if (!target) {
        target = {
          slug,
          title: page.title,
          type: page.type,
          introducedIn: session.slug,
          prerequisites: [],
          intuition: page.intuition,
          blocks: [],
        };
        next.pages.push(target);
        newConcepts.push(slug);
      }
      target.intuition ||= page.intuition;
      target.prerequisites = [
        ...new Set([
          ...target.prerequisites,
          ...page.prerequisites.map((item) => topicSlug(session.prefix, item)),
        ]),
      ];
      for (const block of page.blocks) {
        let handle = topicSlug(session.prefix, block.id);
        // A draft may reuse a generic id such as "definition" on several pages; every block
        // still gets a handle of its own, or the index (and so publishing) would fail.
        if (handles.has(handle)) {
          const base = `${handle}-${session.slug.toLowerCase()}`;
          handle = base;
          for (let n = 2; handles.has(handle); n++) handle = `${base}-${n}`;
        }
        handles.add(handle);
        target.blocks.push({
          ...block,
          handle,
          session: session.slug,
          sourceId: session.sourceId,
          documentId: document.documentId,
        });
      }
    }
    next.sessions.push({
      slug: session.slug,
      type: session.type,
      title: draft.session.title,
      documentId: document.documentId,
      sha256: document.sha256,
      covers: draft.session.covers,
      workedExamples: draft.session.worked_examples.map((example) => ({
        ...example,
        slug: topicSlug(session.prefix, example.slug),
      })),
      worthRemembering: draft.session.worth_remembering,
      openThreads: draft.session.open_threads,
      pairedWith: session.pairedWith,
      newConcepts,
      ledger,
      sourcePages: document.inventory.pages.map((page) => ({
        page: page.page,
        text: page.regions
          .map((region) => region.text)
          .filter(Boolean)
          .join("\n"),
      })),
      studiedAt: bundle.createdAt,
      jobId: bundle.jobId,
    });
  }
  next.pages = next.pages.filter((page) => page.blocks.length);
  next.sessions.sort((a, b) => a.slug.localeCompare(b.slug, undefined, { numeric: true }));
  next.pages.sort((a, b) => a.slug.localeCompare(b.slug));
  return next;
}

/**
 * The knowledge without what Folio wrote from these documents: their sessions and blocks go,
 * topics left with no blocks go too, and a topic another session also wrote about now counts
 * as introduced by that session.
 */
export function withoutDocuments(knowledge: Knowledge, documentIds: string[]): Knowledge {
  const removed = new Set(documentIds);
  const next: Knowledge = structuredClone(knowledge);
  next.sessions = next.sessions.filter((session) => !removed.has(session.documentId));
  const kept = new Set(next.sessions.map((session) => session.slug));
  for (const page of next.pages) {
    page.blocks = page.blocks.filter((block) => !removed.has(block.documentId));
    if (!kept.has(page.introducedIn) && page.blocks.length)
      page.introducedIn = page.blocks[0]!.session;
  }
  next.pages = next.pages.filter((page) => page.blocks.length);
  return next;
}

/**
 * Brings back what Folio wrote from these documents, as an earlier version had it: the
 * documents' sessions and their blocks, into the topics they belonged to. A session that was
 * studied again since is left as it is now, and a block whose handle is taken stays out.
 */
export function withDocumentsFrom(
  knowledge: Knowledge,
  earlier: Knowledge,
  documentIds: string[],
): Knowledge {
  const wanted = new Set(documentIds);
  const next: Knowledge = structuredClone(knowledge);
  const present = new Set(next.sessions.map((session) => session.slug));
  const sessions = earlier.sessions.filter(
    (session) => wanted.has(session.documentId) && !present.has(session.slug),
  );
  if (!sessions.length) return next;
  const slugs = new Set(sessions.map((session) => session.slug));
  const handles = new Set(next.pages.flatMap((page) => page.blocks.map((block) => block.handle)));
  for (const page of earlier.pages) {
    const blocks = page.blocks.filter(
      (block) => slugs.has(block.session) && !handles.has(block.handle),
    );
    if (!blocks.length) continue;
    const target = next.pages.find((candidate) => candidate.slug === page.slug);
    if (target) target.blocks.push(...structuredClone(blocks));
    else next.pages.push({ ...structuredClone(page), blocks: structuredClone(blocks) });
  }
  next.sessions.push(...structuredClone(sessions));
  next.sessions.sort((a, b) => a.slug.localeCompare(b.slug, undefined, { numeric: true }));
  next.pages.sort((a, b) => a.slug.localeCompare(b.slug));
  return next;
}

/**
 * A page's prerequisites that are pages of this course. Models sometimes name a concept the
 * course never covers; those stay out of links rather than pointing nowhere.
 */
export function linkedPrerequisites(knowledge: Knowledge, page: KnowledgePage): string[] {
  return page.prerequisites.filter(
    (slug) => slug !== page.slug && knowledge.pages.some((other) => other.slug === slug),
  );
}

/** The generation's readable wiki: Markdown pages that Obsidian can open. */
export function renderKnowledge(knowledge: Knowledge, date: string): WikiFile[] {
  const usedBy = new Map<string, string[]>();
  for (const page of knowledge.pages)
    for (const prerequisite of linkedPrerequisites(knowledge, page))
      usedBy.set(prerequisite, [...(usedBy.get(prerequisite) ?? []), page.slug]);
  const sourcePath = (documentId: string) => `documents/${documentId}/original.pdf`;

  const files: WikiFile[] = knowledge.pages.map((page) => {
    const sources = [...new Set(page.blocks.map((block) => sourcePath(block.documentId)))];
    const frontmatter = {
      title: page.title,
      slug: page.slug,
      type: page.type,
      introduced_in: page.introducedIn,
      prerequisites: linkedPrerequisites(knowledge, page),
      used_by: usedBy.get(page.slug) ?? [],
      confidence: "not-yet-tested",
      last_reviewed: date,
      sources,
      evidence: page.blocks.map((block) => ({
        id: block.handle,
        title: block.title,
        source_locators: block.locators.map((locator) => ({
          source_id: block.sourceId,
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
      })),
    };
    const body = [
      `# ${page.title}`,
      "",
      page.intuition.trim(),
      "",
      ...page.blocks.flatMap((block) => [
        `## ${block.title}`,
        "",
        `<!-- study-rag: ${block.handle} -->`,
        block.body.trim(),
        `<!-- /study-rag -->`,
        "",
      ]),
    ];
    return {
      path: `${page.type === "technique" ? "techniques" : "concepts"}/${page.slug}.md`,
      content: `---\n${yaml(frontmatter)}---\n\n${body.join("\n").trim()}\n`,
    };
  });

  for (const session of knowledge.sessions) {
    const frontmatter = {
      title: session.title,
      slug: session.slug,
      type: session.type,
      sources: [sourcePath(session.documentId)],
      date_ingested: session.studiedAt.slice(0, 10),
      last_reviewed: date,
      paired_with: session.pairedWith,
    };
    const used = [
      ...new Set(
        knowledge.pages
          .filter((page) => page.blocks.some((block) => block.session === session.slug))
          .flatMap((page) => linkedPrerequisites(knowledge, page)),
      ),
    ];
    const lines = [
      session.pairedWith.length
        ? `Companion to ${session.pairedWith.map((slug) => `[[${slug}]]`).join(", ")}.\n`
        : "",
      "## What this session covers",
      session.covers.trim(),
      "",
      "## New concepts introduced",
      ...session.newConcepts.map((slug) => `- [[${slug}]]`),
      "",
      "## Concepts used (already known)",
      ...used.map((slug) => `- [[${slug}]]`),
      "",
      "## Worked examples",
      ...session.workedExamples.map(
        (example) => `- ${example.title}: physical page ${example.page}; [[${example.slug}]].`,
      ),
      "",
      "## Worth remembering",
      ...session.worthRemembering.map((item) => `- ${item}`),
      "",
      "## Open threads",
      ...session.openThreads.map((item) => `- ${item}`),
    ];
    files.push({
      path: `${session.type === "lecture" ? "lectures" : "recitations"}/${session.slug}.md`,
      content: `---\n${yaml(frontmatter)}---\n\n${lines.join("\n").trim()}\n`,
    });
  }

  files.push({
    path: "index.md",
    content: [
      "# Index",
      "",
      "## Sessions",
      ...knowledge.sessions.map((session) => `- [[${session.slug}]] ${session.title}`),
      "",
      "## Topics",
      ...knowledge.pages.map((page) => `- [[${page.slug}]] ${page.title}`),
      "",
    ].join("\n"),
  });
  return files;
}
