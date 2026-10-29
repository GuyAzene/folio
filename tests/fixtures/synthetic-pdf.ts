/** A tiny, valid PDF with real text layers, built in memory. Lines must be plain ASCII. */
export function syntheticPdf(pages: string[][]): Uint8Array {
  const escape = (line: string) => line.replace(/[\\()]/g, (char) => `\\${char}`);
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, index) => {
    const pageId = 4 + index * 2;
    const operations = [
      "BT",
      "/F1 14 Tf",
      "20 TL",
      "72 720 Td",
      ...lines.map((line, row) => `${row ? "T* " : ""}(${escape(line)}) Tj`),
      "ET",
    ].join("\n");
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
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
