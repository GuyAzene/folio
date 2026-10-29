/**
 * A document's title without its course's name in front, for places that already show the
 * course: "Automata Theory Lecture 1" becomes "Lecture 1". The full title stays when nothing
 * would be left, or when the title doesn't start with the course name.
 */
export function shortTitle(title: string, courseName: string | null | undefined): string {
  const name = courseName?.trim();
  if (!name || !title.toLocaleLowerCase().startsWith(name.toLocaleLowerCase())) return title;
  const rest = title.slice(name.length).replace(/^[\s\-–—:·|_,.]+/, "");
  return rest || title;
}

/**
 * Plain search for the composer's +: every typed word must appear in the item's name (its
 * title and course), a number as a whole number ("2" finds Lecture 2, not CS 201), and matches
 * at the start of a word rank first. IDs never match.
 */
export function searchScore(value: string, search: string, keywords: string[] = []): number {
  const haystack = `${value} ${keywords.join(" ")}`
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
    .toLocaleLowerCase();
  const parts = haystack.split(/[\s\-–—:·|_,.()]+/).filter(Boolean);
  const words = search.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const found = (word: string) =>
    /^\d+$/.test(word) ? parts.includes(word) : haystack.includes(word);
  if (!words.every(found)) return 0;
  const starts = words.filter((word) => parts.some((part) => part.startsWith(word))).length;
  return 0.5 + (0.5 * starts) / words.length;
}
