/**
 * How a reply should write math and code, so Folio renders it in Hebrew and in English. The
 * renderer accepts every common delimiter; these are the ones that never collide with Markdown.
 */
export const REPLY_FORMAT = [
  "Write math in TeX: \\( … \\) inside a sentence and \\[ … \\] on its own line. In a table, write |x| as \\lvert x \\rvert.",
  "Put code, commands and identifiers in backticks. Never write invisible direction characters or their escapes.",
  "Draw a diagram when structure is easier to see than to read: steps of an algorithm, an automaton or state machine, a sequence of messages, how concepts or classes relate, a timeline, or a small chart. Write it as a ```mermaid code block; Folio draws it. Use flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, mindmap, timeline, pie or xychart-beta. Keep it small (about 15 nodes or fewer), label it in the student's language, and write symbols as Unicode (δ, ε, Σ, →), not TeX. Explain in the text around it; the diagram does not replace the explanation. Do not draw one when a sentence or a short list says it as clearly.",
].join("\n");
