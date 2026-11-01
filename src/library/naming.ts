/**
 * File numbers and names from a pattern. Every file has a number of its own: whatever orders
 * it within its category, such as its week or its place among the lectures. A category's
 * pattern, or the library's, names its files from that number and the course, such as
 * "{category} {n}" for "Recitation 1" from R01.pdf.
 */

/** A file to import: its path, with any category, number or name chosen before it comes in. */
export type ImportItem =
  | string
  | {
      path: string;
      /** The file's own name when the path doesn't carry it, as for a file added in a chat. */
      name?: string;
      category?: string;
      number?: number;
      title?: string;
    };

/** A file whose name a pattern changes: what it is called, and what it will be. */
export interface Rename {
  documentId: string;
  courseId: string;
  title: string;
  named: "pattern" | "own";
  next: string;
}

/** Which files a pattern rename covers: a course's, a category's, or both. */
export interface NamingScope {
  courseId?: string;
  categoryId?: string;
  documentIds?: string[];
}

/** The fields a pattern may use, each written in braces. */
export const NAMING_FIELDS = ["category", "course", "code", "term", "n", "name"] as const;
const TOKEN = /\{(category|course|code|term|n|name)(?::(\d))?\}/g;
const ANY_TOKEN = /\{([^{}]*)\}/g;
/** What separates a field from the next: an empty field takes its separator with it. */
const SEPARATOR = "[\\s_\\-–—:.,·|/]";
const MAX_TITLE = 160;

export interface NamingValues {
  /** The category's name for one file: "Recitation". */
  category: string;
  course: string;
  code: string;
  term: string;
  number: number | null;
  /** The name from the original file, cleaned: "R01". */
  name: string;
}

/** A readable title from a file name: "lec05_graph-traversal.pdf" → "lec05 graph traversal". */
export function titleFromName(fileName: string): string {
  const title = (fileName.split(/[\\/]/).at(-1) ?? "")
    .replace(/\.[^.]*$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s*-\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE);
  return title || "Untitled";
}

/**
 * The number a file's name gives it: its first number, leaving out the course code's own and
 * years, so "CS201_lec3_2026.pdf" is 3, "R01.pdf" is 1 and "Lecture 3 part 2" is 3. Null when
 * the name has none.
 */
export function numberFromName(fileName: string, courseCode = ""): number | null {
  const code = new Set(courseCode.match(/\d+/g)?.map(Number) ?? []);
  const base = fileName
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.[a-z0-9]{1,9}$/i, "");
  for (const match of base.matchAll(/\d+/g)) {
    const value = Number(match[0]);
    if (code.has(value) || /^(19|20)\d\d$/.test(match[0]) || value > 9999) continue;
    return value;
  }
  return null;
}

/** The number after the highest one already in a category of a course. */
export function nextNumber(taken: readonly (number | null | undefined)[]): number {
  return Math.max(0, ...taken.filter((value): value is number => typeof value === "number")) + 1;
}

/** Fields a pattern names that Folio doesn't know, such as "{week}". */
export function unknownFields(pattern: string): string[] {
  return [...pattern.matchAll(ANY_TOKEN)]
    .map((match) => match[1]!)
    .filter((field) => !/^(category|course|code|term|n|name)(:\d)?$/.test(field));
}

/**
 * A file's name from a pattern. A field with no value, such as a course without a code, leaves
 * out the separator before it too, and any brackets around it: "{code} {category} {n}" is
 * "Lecture 3" without a code.
 */
export function applyPattern(pattern: string, values: NamingValues): string {
  const value = (field: string, width?: string): string => {
    switch (field) {
      case "n":
        return values.number === null
          ? ""
          : String(values.number).padStart(Number(width ?? 0), "0");
      case "category":
        return values.category;
      case "course":
        return values.course;
      case "code":
        return values.code;
      case "term":
        return values.term;
      default:
        return values.name;
    }
  };
  const gap = "\u0000";
  const title = pattern
    .replace(TOKEN, (_match, field: string, width?: string) => value(field, width).trim() || gap)
    .replace(new RegExp(`${SEPARATOR}*${gap}`, "g"), gap)
    .replace(new RegExp(`^${gap}${SEPARATOR}*`), "")
    .replaceAll(gap, "")
    // Brackets an empty field leaves behind go too: "Recitation 3 ({term})".
    .replace(/\s*(\(\s*\)|\[\s*\])/g, "")
    .replace(/\s+/g, " ")
    .replace(new RegExp(`^${SEPARATOR}+|${SEPARATOR}+$`, "g"), "")
    .slice(0, MAX_TITLE)
    .trim();
  return title || values.name || "Untitled";
}

/** A name no other file in the course has: the second "Lecture 3" is "Lecture 3 (2)". */
export function uniqueTitle(title: string, taken: readonly string[]): string {
  const used = new Set(taken.map((each) => each.toLocaleLowerCase()));
  if (!used.has(title.toLocaleLowerCase())) return title;
  for (let copy = 2; ; copy++) {
    const candidate = `${title.slice(0, MAX_TITLE - 6)} (${copy})`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
}
