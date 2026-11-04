import type { DocumentRole } from "../../src/desktop/api.ts";
import { categoryOf, type Category } from "../../src/library/categories.ts";

/** A course page's tabs: its files, Folio's study notes, the student's notes, and its chats. */
export const COURSE_TABS = [
  { tab: "materials", label: "Materials" },
  { tab: "study", label: "Study notes" },
  { tab: "notes", label: "Notes" },
  { tab: "chats", label: "Chats" },
] as const;
export type CourseTab = (typeof COURSE_TABS)[number]["tab"];

/**
 * Materials as one section per category, in the student's order of categories; a section with
 * no files is not shown.
 */
export function materialSections<
  T extends {
    role: DocumentRole;
    category?: string | null;
    number?: number | null;
    title: string;
  },
>(
  documents: readonly T[],
  categories: readonly Category[],
): { category: Category; documents: T[] }[] {
  const sections = new Map<string, { category: Category; documents: T[] }>();
  for (const document of documents) {
    const category = categoryOf(document, categories);
    const section = sections.get(category.id) ?? { category, documents: [] };
    section.documents.push(document);
    sections.set(category.id, section);
  }
  const order = (category: Category) => {
    const index = categories.findIndex((each) => each.id === category.id);
    return index < 0 ? categories.length : index;
  };
  // Within a section, files go by their number, then by name.
  for (const section of sections.values())
    section.documents.sort(
      (a, b) =>
        (a.number ?? Infinity) - (b.number ?? Infinity) ||
        a.title.localeCompare(b.title, undefined, { numeric: true }),
    );
  return [...sections.values()].sort((a, b) => order(a.category) - order(b.category));
}

/**
 * A saved course tab as one of today's. Anything else opens on Materials: the per-role tabs
 * saved before 2026-10-29 (lectures, recitations, assignments, files), and the Overview, which
 * a course opened on until 2026-11-04.
 */
export function courseTab(value: unknown): CourseTab {
  return COURSE_TABS.some((entry) => entry.tab === value) ? (value as CourseTab) : "materials";
}
