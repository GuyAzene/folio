/**
 * Search normalization, applied identically to indexed text and to questions. SQLite's built-in
 * tokenizer splits Hebrew at vowel marks and acronym quotes and knows nothing of prefixes, and
 * node:sqlite cannot register a tokenizer, so this runs in app code (see the local-search research).
 */

/** Bumped whenever normalization changes; indexes built with another version are rebuilt. */
export const NORMALIZE_VERSION = 2;

const HEBREW_LETTER = /[א-ת]/;
const FINALS: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
const PREFIXES = new Set(["ו", "ה", "ב", "כ", "ל", "מ", "ש"]);

/**
 * NFKC; bidi and zero-width marks removed (they split words); niqqud and cantillation removed;
 * geresh and gershayim inside Hebrew words dropped (ת"א, צ'ט become תא, צט); final letters folded;
 * lowercase; Latin diacritics left to SQLite.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/[֑-ׇ]/g, (mark) => (mark === "־" ? "-" : ""))
    .replace(/([א-ת])["״'׳`’]+(?=[א-ת])/g, "$1")
    .replace(/([א-ת])[׳']/g, "$1")
    .replace(/[ךםןףץ]/g, (letter) => FINALS[letter]!)
    .toLowerCase();
}

/** Words as SQLite's unicode61 tokenizer will see them after normalization. */
export function words(text: string): string[] {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Prefix-stripped forms of Hebrew words: up to three attached prefix letters (ו ה ב כ ל מ ש), keeping
 * at least three letters. Collisions happen (מלך → לך); the surface column outranks this one.
 */
export function strippedForms(text: string): string[] {
  const forms = new Set<string>();
  for (const word of words(text)) {
    if (!HEBREW_LETTER.test(word)) continue;
    let rest = word;
    for (let removed = 0; removed < 3; removed++) {
      if (rest.length - 1 < 3 || !PREFIXES.has(rest[0]!)) break;
      rest = rest.slice(1);
      forms.add(rest);
    }
  }
  return [...forms];
}

/**
 * An FTS5 MATCH expression for a question: every word as a quoted term (so FTS syntax in the
 * question can never inject operators), Hebrew words also by their stripped forms, joined by OR.
 * BM25 then ranks blocks matching more and rarer words first.
 */
export function matchQuery(question: string): string | null {
  const terms = new Set<string>();
  for (const word of words(question)) {
    if (word.length < 2) continue;
    terms.add(word);
    for (const form of strippedForms(word)) terms.add(form);
  }
  if (!terms.size) return null;
  return [...terms].map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}
