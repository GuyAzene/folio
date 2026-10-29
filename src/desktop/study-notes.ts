import type { Knowledge, KnowledgeBlock } from "../kb/knowledge.ts";
import { sessionRank, sessionsOf, type BlockKind } from "../kb/topics.ts";
import type { GenerationInfo } from "../kb/store.ts";
import type { StudyNotesView } from "./api.ts";

/**
 * A course's published knowledge as the student reads it: sessions with what they cover, and
 * topic pages whose sections cite the slide pages they came from.
 * Prerequisites the course has no page for are dropped rather than shown as dead links.
 */
export function studyNotesView(knowledge: Knowledge, current: GenerationInfo): StudyNotesView {
  const titles = new Map(knowledge.pages.map((page) => [page.slug, page.title]));
  const linked = (slugs: string[]) =>
    slugs.flatMap((slug) => {
      const title = titles.get(slug);
      return title ? [{ slug, title }] : [];
    });
  const sessions = new Map(knowledge.sessions.map((session) => [session.slug, session]));
  return {
    courseId: knowledge.courseId,
    generation: current.generation,
    publishedAt: current.publishedAt,
    sessions: knowledge.sessions.map((session) => ({
      slug: session.slug,
      title: session.title,
      type: session.type,
      documentId: session.documentId,
      covers: session.covers,
      worthRemembering: session.worthRemembering,
      openThreads: session.openThreads,
      workedExamples: session.workedExamples.map(({ title, page }) => ({ title, page })),
      topics: [...new Set((session.outline ?? []).map((row) => row.topic))],
      outline: (session.outline ?? []).map(({ topic, pages }) => ({ topic, pages })),
      onlyHere: session.onlyHere ?? [],
      notation: session.notation ?? [],
    })),
    topics: knowledge.pages.map((page) => {
      // A block that restates another one's definition is shown inside it, with its own pages.
      const restating = new Map<string, KnowledgeBlock[]>();
      for (const block of page.blocks)
        if (block.restates && page.blocks.some((other) => other.handle === block.restates))
          restating.set(block.restates, [...(restating.get(block.restates) ?? []), block]);
      const folded = new Set([...restating.values()].flat().map((block) => block.handle));
      const pagesOf = (block: KnowledgeBlock) =>
        [...new Set(block.locators.map((locator) => locator.page))].sort((a, b) => a - b);
      const order = (block: KnowledgeBlock) =>
        KIND_ORDER.indexOf((block.kind ?? "explanation") as BlockKind) * 10_000 +
        sessionRank(block.session) / 100;
      return {
        slug: page.slug,
        title: page.title,
        type: page.type,
        intuition: page.intuition,
        overview: page.overview
          ? { text: page.overview.text, handles: page.overview.handles }
          : null,
        introducedIn: page.introducedIn,
        taughtIn: sessionsOf(page).flatMap((slug) => {
          const session = sessions.get(slug);
          return session
            ? [{ session: slug, documentId: session.documentId, type: session.type }]
            : [];
        }),
        prerequisites: linked(page.prerequisites.filter((slug) => slug !== page.slug)),
        usedBy: linked(
          knowledge.pages
            .filter((other) => other.slug !== page.slug && other.prerequisites.includes(page.slug))
            .map((other) => other.slug),
        ),
        related: (page.related ?? []).flatMap((link) => {
          const title = titles.get(link.slug);
          return title ? [{ slug: link.slug, title, relation: link.relation }] : [];
        }),
        sections: page.blocks
          .filter((block) => !folded.has(block.handle))
          .sort((a, b) => order(a) - order(b))
          .map((block) => ({
            handle: block.handle,
            title: block.title,
            kind: block.kind ?? "explanation",
            body: block.body,
            session: block.session,
            documentId: block.documentId,
            pages: pagesOf(block),
            questions: block.questions,
            alsoIn: (restating.get(block.handle) ?? []).map((other) => ({
              handle: other.handle,
              documentId: other.documentId,
              pages: pagesOf(other),
              body: other.body,
            })),
          })),
      };
    }),
  };
}

/** Where each kind of section sits on a topic page. */
const KIND_ORDER: BlockKind[] = [
  "intuition",
  "definition",
  "theorem",
  "technique",
  "explanation",
  "example",
  "notation",
  "warning",
];
