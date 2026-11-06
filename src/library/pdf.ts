import {
  AnnotationMode,
  getDocument,
  OPS,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

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

export interface PageTextOptions {
  /**
   * Mark bold text `**…**` and italic text `*…*`, as the page's fonts name their styles, and
   * write an asterisk printed on the page as `\*`. Fonts are named only in a document opened
   * with `fontNames` (`openSource` in ingest/pages.ts); in any other, nothing is marked.
   */
  emphasis?: boolean;
}

/** The page's text layer in reading order; empty for scanned pages. */
export async function pdfPageText(
  document: PDFDocumentProxy,
  pageNumber: number,
  { emphasis = false }: PageTextOptions = {},
): Promise<string> {
  const page = await document.getPage(pageNumber);
  try {
    const content = await page.getTextContent();
    const runs: TextRun[] = content.items.flatMap((item) => ("str" in item ? [item] : []));
    const text = emphasis
      ? markedText(runs, await pageFontEmphasis(page, new Set(runs.map((run) => run.fontName))))
      : runs.map((run) => (run.hasEOL ? `${run.str}\n` : run.str)).join("");
    return text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } finally {
    page.cleanup();
  }
}

/** Whether a font draws its text bold or italic. */
export interface Emphasis {
  bold: boolean;
  italic: boolean;
}

const PLAIN: Emphasis = { bold: false, italic: false };
/**
 * Fonts whose styles are not emphasis: math fonts, whose italics are math letters (Cambria Math,
 * Latin Modern Math, TeX's CMMI, CMSY and CMEX, the AMS and Euler fonts), and symbol fonts.
 */
const NOT_EMPHASIS =
  /math|symbol|dingbat|wingding|webding|^(?:cmmi|cmmib|cmsy|cmbsy|cmex|msam|msbm|eu[frs][mb]|euex|rsfs)\d/i;
/** Computer Modern's text fonts give their style in TeX's short names: CMBX10, CMTI10, CMBXTI10. */
const TEX_BOLD = /^cm(?:b|bx|bxsl|bxti|ssbx)\d/i;
const TEX_ITALIC = /^cm(?:ti|sl|bxsl|bxti|ssi|itt|sltt)\d/i;

/**
 * The emphasis a font's own name gives its text: `Calibri-Bold`, `Arial,BoldItalic`,
 * `Helvetica-Oblique`, Adobe's `MinionPro-BoldIt`, TeX's `CMBX10`. Math and symbol fonts have
 * none.
 */
export function fontEmphasis(fontName: string): Emphasis {
  // A subset font carries a six-letter tag: ABCDEF+Calibri-Bold.
  const name = fontName.replace(/^[A-Z]{6}\+/, "");
  if (NOT_EMPHASIS.test(name)) return PLAIN;
  // The style after the family, where Adobe's short "It" can stand for italic.
  const style = name.split(/[-,]/).slice(1).join("-");
  return {
    bold: /bold/i.test(name) || TEX_BOLD.test(name),
    italic:
      /italic|oblique|slant/i.test(name) || /It(?![a-z])/.test(style) || TEX_ITALIC.test(name),
  };
}

/**
 * The emphasis of these fonts of a page, by the IDs its text runs give them, read from the
 * fonts' own names; a font whose name can't be read is plain. pdf.js names fonts only in a
 * document opened with `fontNames`, and hands a page's fonts over only once it lays the page
 * out, so a page whose fonts haven't arrived, because it hasn't been drawn, is laid out first.
 */
export async function pageFontEmphasis(
  page: PDFPageProxy,
  fontIds: Iterable<string>,
): Promise<Map<string, Emphasis>> {
  const wanted = new Set(fontIds);
  const fonts = page.commonObjs;
  if ([...wanted].some((id) => !fonts.has(id))) {
    const layout = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
    // pdf.js sends each font before the layout that sets it, and settles it soon after.
    const used = new Set<string>();
    layout.fnArray.forEach((fn, index) => {
      if (fn === OPS.setFont) used.add(String(layout.argsArray[index]?.[0]));
    });
    await Promise.all(
      [...used]
        .filter((id) => wanted.has(id))
        .map((id) => new Promise((settled) => fonts.get(id, settled))),
    );
  }
  const emphasis = new Map<string, Emphasis>();
  for (const id of wanted) {
    const font: unknown = fonts.has(id) ? fonts.get(id) : null;
    const name = typeof font === "object" ? (font as { name?: unknown } | null)?.name : undefined;
    emphasis.set(id, typeof name === "string" ? fontEmphasis(name) : PLAIN);
  }
  return emphasis;
}

/** One run of pdf.js's text layer: text in one font. */
interface TextRun {
  str: string;
  /** pdf.js's ID for the run's font. */
  fontName: string;
  hasEOL: boolean;
}

type Mark = "bold" | "italic";
const MARKS: Record<Mark, string> = { bold: "**", italic: "*" };

/**
 * The runs' text with each stretch of bold or italic marked once, neighbouring runs of the same
 * style joined and marks nested where styles overlap: `**bold *and italic* text**`. Spaces stay
 * outside the marks, and every line closes its own.
 */
function markedText(runs: readonly TextRun[], emphasis: ReadonlyMap<string, Emphasis>): string {
  let text = "";
  /** The marks open, outermost first. */
  let open: Mark[] = [];
  /** Whitespace waiting for the next text, which decides which side of a mark it falls on. */
  let space = "";
  const closeFrom = (index: number) => {
    for (const mark of open.slice(index).reverse()) text += MARKS[mark];
    open = open.slice(0, index);
  };
  for (const run of runs) {
    const [, lead = "", core = "", trail = ""] = /^(\s*)(.*?)(\s*)$/su.exec(run.str) ?? [];
    if (core) {
      const style = emphasis.get(run.fontName) ?? PLAIN;
      // Close the first mark this run lacks, and every mark opened inside it.
      const lacking = open.findIndex((mark) => !style[mark]);
      if (lacking >= 0) closeFrom(lacking);
      text += space + lead;
      space = "";
      for (const mark of ["bold", "italic"] as const)
        if (style[mark] && !open.includes(mark)) {
          text += MARKS[mark];
          open.push(mark);
        }
      text += core.replaceAll("*", "\\*");
      space = trail;
    } else {
      space += run.str;
    }
    if (run.hasEOL) {
      closeFrom(0);
      text += `${space}\n`;
      space = "";
    }
  }
  closeFrom(0);
  return text + space;
}
