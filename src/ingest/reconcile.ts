/**
 * Deterministic checks that a model's words carry a region's words. They establish presence,
 * not correctness: a fluent wrong explanation can still pass.
 */

const STOPWORDS = new Set(
  "the a an and or of to in on for is are was were be by with as at from that this these those it its into than then so if not no".split(
    " ",
  ),
);

/** NFC, lowercase, niqqud and cantillation removed, final letters folded, punctuation dropped. */
export function normalize(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[֑-ׇ]/g, "")
    .replace(/[ךםןףץ]/g, (letter) => ({ ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" })[letter]!)
    .replace(/[״"׳'`’‘“”]/g, "");
}

/** Words of three or more characters that carry content, in normalized form. */
export function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of normalize(text).split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 3 && !STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

/**
 * Share of the source's content words found in the candidate. Hebrew words also match with one
 * attached prefix letter (ו ה ב כ ל מ ש) removed on either side.
 */
export function tokenRecall(source: string, candidate: string): number {
  const wanted = contentTokens(source);
  if (!wanted.size) return 1;
  const have = contentTokens(candidate);
  const stripped = new Set([...have].map(stripPrefix));
  let found = 0;
  for (const token of wanted)
    if (have.has(token) || stripped.has(stripPrefix(token)) || have.has(stripPrefix(token)))
      found++;
  return found / wanted.size;
}

function stripPrefix(token: string): string {
  return /^[והבכלמש][א-ת]{2,}/.test(token) ? token.slice(1) : token;
}

/** Numbers and math tokens from the source that the candidate lacks (spaces ignored). */
export function missingNumbers(numbers: string[], candidate: string): string[] {
  const squeezed = normalize(candidate).replace(/\s+/g, "");
  return numbers.filter((number) => !squeezed.includes(normalize(number).replace(/\s+/g, "")));
}
