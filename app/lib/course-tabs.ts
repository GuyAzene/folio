import type { DocumentRole } from "../../src/desktop/api.ts";

/** A course page's tabs: its files, Folio's study notes, the student's notebook, and its chats. */
export const COURSE_TABS = [
  { tab: "materials", label: "Materials" },
  { tab: "study", label: "Study notes" },
  { tab: "notes", label: "Notes" },
  { tab: "chats", label: "Chats" },
] as const;
export type CourseTab = (typeof COURSE_TABS)[number]["tab"];

/** Materials in the order a course hands them out; a section with no files is not shown. */
export const MATERIAL_SECTIONS: { title: string; roles: DocumentRole[] }[] = [
  { title: "Lectures", roles: ["lecture"] },
  { title: "Recitations", roles: ["recitation"] },
  { title: "Assignments", roles: ["assignment", "solution"] },
  { title: "Other files", roles: ["asset"] },
];

/**
 * A saved course tab as one of today's. Workspaces saved before 2026-10-29 may hold the old
 * per-role tabs (lectures, recitations, assignments, files), which all live in Materials now.
 */
export function courseTab(value: unknown): CourseTab {
  return COURSE_TABS.some((entry) => entry.tab === value) ? (value as CourseTab) : "materials";
}
