import type { DocumentRole } from "../desktop/api.ts";
import { unknownFields } from "./naming.ts";

/**
 * The student's own kinds of course file, one list for the whole library, kept in config.json
 * under `library.categories`. A category is a name and what Folio does with its files: its kind
 * is one of Folio's five roles, so studying, the board and solutions work as they always have
 * whatever a degree calls its sessions. Renaming a category never moves a file, since files hold
 * its id.
 */
export interface Category {
  /** Stable: files point at it, so renaming the category keeps them. */
  id: string;
  /** One file of it: "Recitation". */
  name: string;
  /** Its Materials section: "Recitations". */
  plural: string;
  /** What Folio does with its files. */
  kind: DocumentRole;
  /** Words in a file name that place a new file here: "rec", "tirgul", or "R" before a number. */
  match: string[];
  /** How its files are named, such as "{category} {n}"; null keeps each file's own name. */
  naming: string | null;
}

/** Today's five, in the order a course hands them out. */
export const DEFAULT_CATEGORIES: readonly Category[] = [
  {
    id: "lecture",
    name: "Lecture",
    plural: "Lectures",
    kind: "lecture",
    match: ["lecture", "lec", "L", "הרצאה"],
    naming: null,
  },
  {
    id: "recitation",
    name: "Recitation",
    plural: "Recitations",
    kind: "recitation",
    match: ["recitation", "rec", "tirgul", "tutorial", "R", "תרגול"],
    naming: null,
  },
  {
    id: "assignment",
    name: "Assignment",
    plural: "Assignments",
    kind: "assignment",
    match: ["assignment", "homework", "hw", "problem set", "ps", "ex", "מטלה"],
    naming: null,
  },
  {
    id: "solution",
    name: "Official solution",
    plural: "Solutions",
    kind: "solution",
    match: ["solution", "sol", "pitron", "פתרון"],
    naming: null,
  },
  {
    id: "asset",
    name: "Other file",
    plural: "Other files",
    kind: "asset",
    match: ["syllabus", "syllabi", "course outline", "סילבוס"],
    naming: null,
  },
];

/** What Folio studies: lectures and recitations in PDF. */
export function studied(document: { role: DocumentRole; kind: "pdf" | "markdown" }): boolean {
  return (document.role === "lecture" || document.role === "recitation") && document.kind === "pdf";
}

const KINDS: readonly DocumentRole[] = ["lecture", "recitation", "assignment", "solution", "asset"];
/** What each kind does, in the words Settings uses. */
export const KIND_LABEL: Record<DocumentRole, string> = {
  lecture: "Studied",
  recitation: "Studied as practice",
  assignment: "Coursework",
  solution: "Official solutions",
  asset: "Kept as files",
};
/**
 * Which kind wins when a name has words of several: a syllabus that lists lectures stays a
 * file, and "HW3 solution" is a solution.
 */
const PRECEDENCE: readonly DocumentRole[] = [
  "asset",
  "solution",
  "assignment",
  "recitation",
  "lecture",
];
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LIMITS = { name: 40, plural: 40, words: 20, word: 40, naming: 120, categories: 40 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A file name as words: "HW3_sol.pdf" → "hw3 sol". */
function words(fileName: string): string {
  return fileName
    .replace(/\.[a-z0-9]{1,9}$/i, "")
    .toLowerCase()
    .replace(/[_.-]+/g, " ");
}

/**
 * Whether a file name has this word. Hebrew is found anywhere, prefixes included; other words
 * stand on their own, a plural and a number after them allowed ("lectures", "lec05"); a word of
 * one or two letters counts only before a number ("R01", "hw 3").
 */
export function hasWord(fileName: string, word: string): boolean {
  const target = word.trim().toLowerCase();
  if (!target) return false;
  const name = words(fileName);
  if (/[^\p{ASCII}]/u.test(target)) return name.includes(target);
  const body = target
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  const pattern =
    target.replace(/\s/g, "").length < 3
      ? `(?<![\\p{L}\\p{N}])${body}\\s?\\d`
      : `(?<![\\p{L}\\p{N}])${body}(?:e?s)?(?!\\p{L})`;
  return new RegExp(pattern, "u").test(name);
}

/** The category of a new file, from the words in its name; a PDF otherwise is a lecture. */
export function guessCategory(
  fileName: string,
  kind: "pdf" | "markdown",
  categories: readonly Category[],
): Category {
  for (const role of PRECEDENCE)
    for (const category of categories)
      if (category.kind === role && category.match.some((word) => hasWord(fileName, word)))
        return category;
  return categoryFor(kind === "pdf" ? "lecture" : "asset", categories);
}

/** The first category of a kind, or today's when the student's list has none of it. */
export function categoryFor(kind: DocumentRole, categories: readonly Category[]): Category {
  return (
    categories.find((category) => category.kind === kind) ??
    DEFAULT_CATEGORIES.find((category) => category.kind === kind)!
  );
}

/**
 * A file's category: the one it names, when it still exists with the file's kind, otherwise the
 * first of its kind. Files from before categories, and ones whose category was taken out of
 * config.json by hand, show under the first category of their role.
 */
export function categoryOf(
  document: { role: DocumentRole; category?: string | null },
  categories: readonly Category[],
): Category {
  const named = categories.find((category) => category.id === document.category);
  return named?.kind === document.role ? named : categoryFor(document.role, categories);
}

/** An id for a new category, from its name, unlike any other. */
export function categoryId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "category";
  let id = base;
  for (let copy = 2; taken.includes(id); copy++) id = `${base}-${copy}`;
  return id;
}

/** One category as config.json may hold it, or why it can't be used. */
function readCategory(value: unknown, at: string): Category | string {
  if (!isRecord(value)) return `${at}: write an object with an id, a name and a kind.`;
  const { id, name, plural, kind, match, naming } = value;
  if (typeof id !== "string" || !ID.test(id))
    return `${at}.id: use lowercase letters, digits and dashes, such as "lab".`;
  if (typeof name !== "string" || !name.trim() || name.trim().length > LIMITS.name)
    return `${at}.name: write a name of up to ${LIMITS.name} characters.`;
  if (
    plural !== undefined &&
    (typeof plural !== "string" || !plural.trim() || plural.trim().length > LIMITS.plural)
  )
    return `${at}.plural: write a name of up to ${LIMITS.plural} characters.`;
  if (!KINDS.includes(kind as DocumentRole))
    return `${at}.kind: use one of ${KINDS.map((each) => `"${each}"`).join(", ")}.`;
  if (
    match !== undefined &&
    (!Array.isArray(match) ||
      match.length > LIMITS.words ||
      !match.every((word) => typeof word === "string" && word.trim().length <= LIMITS.word))
  )
    return `${at}.match: write a list of up to ${LIMITS.words} words.`;
  const unusable = naming === undefined ? null : namingProblem(naming);
  if (unusable) return `${at}.naming: ${unusable}.`;
  return {
    id,
    name: name.trim(),
    plural: typeof plural === "string" ? plural.trim() : `${name.trim()}s`,
    kind: kind as DocumentRole,
    match: ((match as string[] | undefined) ?? []).map((word) => word.trim()).filter(Boolean),
    naming: typeof naming === "string" && naming.trim() ? naming.trim() : null,
  };
}

/**
 * The categories config.json lists under `library.categories`, or today's when it lists none.
 * An entry Folio can't use is reported and left out; a list it can't use at all is replaced by
 * today's.
 */
export function readCategories(library: unknown): { categories: Category[]; problems: string[] } {
  const defaults = DEFAULT_CATEGORIES.map((category) => ({ ...category }));
  if (library === undefined) return { categories: defaults, problems: [] };
  // config.json's library section also holds the syllabus model, which reports a section that
  // isn't an object.
  if (!isRecord(library)) return { categories: defaults, problems: [] };
  const listed = library.categories;
  if (listed === undefined) return { categories: defaults, problems: [] };
  if (!Array.isArray(listed) || !listed.length || listed.length > LIMITS.categories)
    return {
      categories: defaults,
      problems: [
        `library.categories: write a list of 1 to ${LIMITS.categories} categories; Folio uses its own until then.`,
      ],
    };
  const categories: Category[] = [];
  const problems: string[] = [];
  listed.forEach((value, index) => {
    const read = readCategory(value, `library.categories[${index}]`);
    if (typeof read === "string") problems.push(read);
    else if (categories.some((category) => category.id === read.id))
      problems.push(`library.categories[${index}].id: "${read.id}" is used twice.`);
    else categories.push(read);
  });
  if (!categories.length) return { categories: defaults, problems };
  return { categories, problems };
}

/** Why a naming pattern can't be used, or null when it can. */
export function namingProblem(pattern: unknown): string | null {
  if (pattern === null) return null;
  if (typeof pattern !== "string" || pattern.length > LIMITS.naming)
    return `write a pattern of up to ${LIMITS.naming} characters, such as "{category} {n}", or null`;
  const unknown = unknownFields(pattern);
  if (unknown.length)
    return `Folio has no field {${unknown[0]}}; use {category}, {course}, {code}, {term}, {n}, {n:2} or {name}`;
  return null;
}

/** The library's naming pattern for categories without their own, from config.json. */
export function readNaming(library: unknown): { naming: string | null; problems: string[] } {
  if (!isRecord(library) || library.naming === undefined || library.naming === null)
    return { naming: null, problems: [] };
  const problem = namingProblem(library.naming);
  if (problem) return { naming: null, problems: [`library.naming: ${problem}.`] };
  const naming = (library.naming as string).trim();
  return { naming: naming || null, problems: [] };
}

/** The list as config.json writes it. */
export function writeCategories(categories: readonly Category[]): Record<string, unknown>[] {
  return categories.map(({ id, name, plural, kind, match, naming }) => ({
    id,
    name,
    plural,
    kind,
    match,
    ...(naming ? { naming } : {}),
  }));
}

/**
 * Why a new list can't replace the current one while files are in its categories, or null: a
 * category with files in it can be renamed, reordered or given new words, but it can't go or
 * change its kind, which would change what Folio does with the files behind the student's back.
 */
export function categoriesInUse(
  current: readonly Category[],
  next: readonly Category[],
  documents: readonly { role: DocumentRole; category?: string | null }[],
): string | null {
  const used = new Map<string, number>();
  for (const document of documents) {
    const { id } = categoryOf(document, current);
    used.set(id, (used.get(id) ?? 0) + 1);
  }
  for (const [id, count] of used) {
    const before = current.find((category) => category.id === id);
    // A file shown under today's category because the list has none of its kind.
    if (!before) continue;
    const after = next.find((category) => category.id === id);
    const files = count === 1 ? "1 file is" : `${count} files are`;
    if (!after) return `${files} in ${before.plural}. Move them to another category first.`;
    if (after.kind !== before.kind)
      return `${files} in ${before.plural}, so what Folio does with it stays as it is. Make a new category instead.`;
  }
  return null;
}

/** Why a list from Settings can't be saved, or null when it can. */
export function categoriesProblem(value: unknown): string | null {
  if (!Array.isArray(value) || !value.length) return "Keep at least one category.";
  const { categories, problems } = readCategories({ categories: value });
  if (problems.length) return problems[0]!.replace(/^library\.categories\[\d+\]\.?\w*: /, "");
  if (categories.length !== value.length) return "Each category needs its own id.";
  return null;
}
