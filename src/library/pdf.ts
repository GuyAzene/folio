import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Opens a PDF for reading only: no scripts, no embedded fonts, no network. */
export function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({
    // pdf.js transfers the buffer it is given; keep the caller's copy intact.
    data: data.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
}

/** Releases the document and its worker; pdf.js 6 tears down through the loading task. */
export function closePdf(document: PDFDocumentProxy): Promise<void> {
  return document.loadingTask.destroy();
}

export async function pdfPageCount(data: Uint8Array): Promise<number> {
  const document = await openPdf(data);
  try {
    return document.numPages;
  } finally {
    await closePdf(document);
  }
}

/** The page's text layer in reading order; empty for scanned pages. */
export async function pdfPageText(document: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await document.getPage(pageNumber);
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  page.cleanup();
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
