/** Part of a line drawn in one font, by its PostScript name, such as Helvetica-Bold. */
export interface SyntheticRun {
  text: string;
  font: string;
}
/** A line in Helvetica, or a line of runs in their own fonts. */
export type SyntheticLine = string | SyntheticRun[];

/**
 * A tiny, valid PDF with real text layers, built in memory. Lines must be plain ASCII. Fonts are
 * named, not embedded, as the standard 14 are.
 */
export function syntheticPdf(pages: SyntheticLine[][]): Uint8Array {
  const escape = (line: string) => line.replace(/[\\()]/g, (char) => `\\${char}`);
  const runsOf = (line: SyntheticLine) =>
    typeof line === "string" ? [{ text: line, font: "Helvetica" }] : line;
  const fonts = [
    ...new Set([
      "Helvetica",
      ...pages.flat().flatMap((line) => runsOf(line).map((run) => run.font)),
    ]),
  ];
  const objects: string[] = [];
  const firstPage = 3 + fonts.length;
  const pageIds = pages.map((_, index) => firstPage + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  fonts.forEach((font, index) => {
    objects[3 + index] = `<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`;
  });
  const resources = fonts.map((_, index) => `/F${index + 1} ${3 + index} 0 R`).join(" ");
  pages.forEach((lines, index) => {
    const pageId = firstPage + index * 2;
    let current = 0;
    const operations = [
      "BT",
      "/F1 14 Tf",
      "20 TL",
      "72 720 Td",
      ...lines.map((line, row) =>
        runsOf(line)
          .map(({ text, font }, column) => {
            const next = fonts.indexOf(font);
            const switched = next === current ? "" : `/F${next + 1} 14 Tf `;
            current = next;
            return `${row && !column ? "T* " : ""}${switched}(${escape(text)}) Tj`;
          })
          .join("\n"),
      ),
      "ET",
    ].join("\n");
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << ${resources} >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${operations.length} >>\nstream\n${operations}\nendstream`;
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets.push(body.length);
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body +=
    `xref\n0 ${objects.length}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

export const SYNTHETIC_LECTURE = [
  [
    "Synthetic Lecture 1: Graph traversal",
    "This page is a disposable test fixture.",
    "Breadth-first search visits vertices in layers.",
  ],
  [
    "Breadth-first search",
    "Each vertex is marked visited when it enters the queue,",
    "so every vertex is enqueued at most once.",
    "The running time is O(V + E).",
  ],
  ["Depth-first search", "DFS explores one branch fully before backtracking."],
];
