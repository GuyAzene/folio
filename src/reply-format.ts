/**
 * How a reply should write math and code, so Folio renders it in Hebrew and in English. The
 * renderer accepts every common delimiter; these are the ones that never collide with Markdown.
 */
export const REPLY_FORMAT = [
  "Write math in TeX: \\( … \\) inside a sentence and \\[ … \\] on its own line. In a table, write |x| as \\lvert x \\rvert.",
  "Put code, commands and identifiers in backticks. Never write invisible direction characters or their escapes.",
].join("\n");
