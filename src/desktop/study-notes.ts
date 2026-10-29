import type { Knowledge } from "../kb/knowledge.ts";
import type { GenerationInfo } from "../kb/store.ts";
import type { StudyNotesView } from "./api.ts";

/**
 * A course's published knowledge as the student reads it: sessions with what they cover and
 * what was left out, and topic pages whose sections cite the slide pages they came from.
 * Prerequisites the course has no page for are dropped rather than shown as dead links.
 */
export function studyNotesView(knowledge: Knowledge, current: GenerationInfo): StudyNotesView {
  const titles = new Map(knowledge.pages.map((page) => [page.slug, page.title]));
  const linked = (slugs: string[]) =>
    slugs.flatMap((slug) => {
      const title = titles.get(slug);
      return title ? [{ slug, title }] : [];
    });
  return {
    courseId: knowledge.courseId,
    generation: current.generation,
    publishedAt: current.publishedAt,
    sessions: knowledge.sessions.map((session) => {
      const leftOut = new Map<number, Set<string>>();
      for (const entry of session.ledger)
        if (entry.state === "gap")
          leftOut.set(entry.page, (leftOut.get(entry.page) ?? new Set()).add(entry.reason));
      return {
        slug: session.slug,
        title: session.title,
        type: session.type,
        documentId: session.documentId,
        covers: session.covers,
        worthRemembering: session.worthRemembering,
        openThreads: session.openThreads,
        workedExamples: session.workedExamples.map(({ title, page }) => ({ title, page })),
        topics: knowledge.pages
          .filter((page) => page.introducedIn === session.slug)
          .map((page) => page.slug),
        leftOut: [...leftOut]
          .sort(([a], [b]) => a - b)
          .map(([page, reasons]) => ({ page, reasons: [...reasons].filter(Boolean) })),
      };
    }),
    topics: knowledge.pages.map((page) => ({
      slug: page.slug,
      title: page.title,
      type: page.type,
      intuition: page.intuition,
      introducedIn: page.introducedIn,
      prerequisites: linked(page.prerequisites.filter((slug) => slug !== page.slug)),
      usedBy: linked(
        knowledge.pages
          .filter((other) => other.slug !== page.slug && other.prerequisites.includes(page.slug))
          .map((other) => other.slug),
      ),
      sections: page.blocks.map((block) => ({
        handle: block.handle,
        title: block.title,
        body: block.body,
        session: block.session,
        documentId: block.documentId,
        pages: [...new Set(block.locators.map((locator) => locator.page))].sort((a, b) => a - b),
        questions: block.questions,
      })),
    })),
  };
}
