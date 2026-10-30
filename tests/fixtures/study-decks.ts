import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import {
  SYMBOL,
  syntheticSlides,
  type SlideImage,
  type SlideText,
  type SyntheticSlide,
} from "./synthetic-slides.ts";

/**
 * Three synthetic lectures for measuring study quality, each with facts planted on known pages:
 * Hebrew as text and inside pictures, math (Symbol-font ≤ and ∑, subscripts, math italic), and
 * arrows and charts. Every fact is invented, so notes can only get it from the slide, never
 * from what a model already knows. Disposable test data, never real course material.
 *
 * Visible Hebrew is a picture drawn with canvas, with the same words in an invisible text layer
 * laid over it, as on a slide whose text was recognized; the fixture's Hebrew font alone would
 * show Latin glyphs. A picture with no text layer must be read from its pixels.
 */

/** A fact the notes should carry, on the page that shows it. */
export interface PlantedFact {
  id: string;
  page: number;
  /** All of these appear in the blocks that cite the page when the fact made it into the notes. */
  must: string[];
  /** Any of these there means the notes got the fact wrong. None appears anywhere in the deck. */
  wrong: string[];
}

export interface StudyDeck {
  name: string;
  /** The lecture's title, and its file name. */
  title: string;
  pdf: Uint8Array;
  facts: PlantedFact[];
}

/** Pixels per point in the drawn pictures: sharp at the page renders' resolution. */
const SCALE = 3;
const HEBREW_FONT = `"Arial Hebrew", "Noto Sans Hebrew", "Arial Unicode MS", sans-serif`;
const LATIN_FONT = `Helvetica, Arial, sans-serif`;
const FOOTER = "Synthetic benchmark deck: invented facts, not course material";

/** A picture of `width` by `height` points, drawn on white. */
function picture(
  x: number,
  y: number,
  width: number,
  height: number,
  draw: (context: SKRSContext2D) => void,
): SlideImage {
  const canvas = createCanvas(Math.round(width * SCALE), Math.round(height * SCALE));
  const context = canvas.getContext("2d");
  context.scale(SCALE, SCALE);
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "black";
  context.strokeStyle = "black";
  draw(context);
  return { x, y, width, height, png: new Uint8Array(canvas.encodeSync("png")) };
}

/**
 * Hebrew lines drawn right-aligned in a picture, each with an invisible text layer at its
 * baseline. `y` is each line's baseline on the page.
 */
function hebrewLines(
  box: { x: number; y: number; width: number; height: number },
  lines: { text: string; y: number; size: number }[],
): { image: SlideImage; texts: SlideText[] } {
  const right = box.width - 8;
  const image = picture(box.x, box.y, box.width, box.height, (context) => {
    context.direction = "rtl";
    context.textAlign = "right";
    for (const line of lines) {
      context.font = `${line.size}px ${HEBREW_FONT}`;
      context.fillText(line.text, right, line.y - box.y);
    }
  });
  const texts = lines.map((line): SlideText => ({
    // Helvetica's widths are near enough: the text layer only has to sit over the words.
    x: box.x + right - line.text.length * line.size * 0.55,
    y: line.y,
    size: line.size,
    runs: [{ text: line.text, font: "hebrew" }],
    invisible: true,
  }));
  return { image, texts };
}

function slide(page: number, content: SyntheticSlide): SyntheticSlide {
  return {
    ...content,
    texts: [
      ...(content.texts ?? []),
      { x: 36, y: 520, size: 9, text: FOOTER },
      { x: 676, y: 520, size: 10, text: String(page) },
    ],
  };
}

function arrow(context: SKRSContext2D, from: [number, number], to: [number, number]) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  context.beginPath();
  context.moveTo(...from);
  context.lineTo(...to);
  context.stroke();
  context.beginPath();
  context.moveTo(...to);
  context.lineTo(to[0] - 9 * Math.cos(angle - 0.4), to[1] - 9 * Math.sin(angle - 0.4));
  context.lineTo(to[0] - 9 * Math.cos(angle + 0.4), to[1] - 9 * Math.sin(angle + 0.4));
  context.closePath();
  context.fill();
}

function hebrewDeck(): StudyDeck {
  const title = hebrewLines({ x: 160, y: 150, width: 520, height: 70 }, [
    { text: "תורי Kestrel במערכות הפעלה", y: 200, size: 32 },
  ]);
  const definitions = hebrewLines({ x: 60, y: 50, width: 620, height: 200 }, [
    { text: "הגדרות", y: 90, size: 30 },
    { text: "תור Kestrel מחזיק לכל היותר 48 משימות", y: 160, size: 22 },
    { text: "זמן ההמתנה המרבי הוא 250 מילישניות", y: 210, size: 22 },
  ]);
  const flow = picture(60, 120, 360, 200, (context) => {
    context.lineWidth = 2;
    context.strokeRect(10, 70, 110, 60);
    context.strokeRect(240, 70, 110, 60);
    arrow(context, [120, 100], [238, 100]);
    context.direction = "rtl";
    context.textAlign = "center";
    context.font = `22px ${HEBREW_FONT}`;
    context.fillText("מקבל", 295, 108);
    context.fillText("שולח", 65, 108);
    context.font = `18px ${HEBREW_FONT}`;
    context.fillText("חלון בגודל 37", 180, 60);
  });
  // A screenshot of a settings panel, with its words in the text layer.
  const panel = hebrewLines({ x: 450, y: 140, width: 230, height: 140 }, [
    { text: "מקדם דעיכה 0.85", y: 190, size: 20 },
    { text: "סף התראה 920", y: 240, size: 20 },
  ]);
  return {
    name: "hebrew",
    title: "Lecture 1 Kestrel queues",
    pdf: syntheticSlides([
      slide(1, {
        images: [title.image],
        texts: [
          ...title.texts,
          { x: 160, y: 270, size: 16, text: "Queues, waiting and windows, in Hebrew" },
        ],
      }),
      slide(2, { images: [definitions.image], texts: definitions.texts }),
      slide(3, {
        images: [flow, panel.image],
        texts: [{ x: 60, y: 80, size: 26, text: "Kestrel at run time" }, ...panel.texts],
      }),
    ]),
    facts: [
      { id: "kestrel-capacity", page: 2, must: ["kestrel", "48"], wrong: ["84"] },
      { id: "kestrel-wait", page: 2, must: ["250"], wrong: ["520", "205"] },
      { id: "window-in-picture", page: 3, must: ["37"], wrong: ["73"] },
      { id: "decay-in-screenshot", page: 3, must: ["0.85"], wrong: ["0.58"] },
      { id: "alert-in-screenshot", page: 3, must: ["920"], wrong: ["290"] },
    ],
  };
}

function mathDeck(): StudyDeck {
  const sub = (text: string) => ({ text, size: 13, rise: -5 });
  return {
    name: "math",
    title: "Lecture 2 Varnel bounds",
    pdf: syntheticSlides([
      slide(1, {
        texts: [
          { x: 60, y: 200, size: 34, text: "Varnel bounds" },
          { x: 60, y: 250, size: 16, text: "Sums, inequalities and the Varnel constant" },
        ],
      }),
      slide(2, {
        texts: [
          { x: 60, y: 80, size: 26, text: "Bounding the running time" },
          {
            x: 60,
            y: 170,
            size: 20,
            runs: [
              { text: "For every n " },
              { text: SYMBOL.greaterEqual, font: "symbol" },
              { text: " 4:  T(n) " },
              { text: SYMBOL.lessEqual, font: "symbol" },
              { text: " 3n + 11" },
            ],
          },
          {
            x: 60,
            y: 240,
            size: 20,
            runs: [
              { text: SYMBOL.sum, font: "symbol" },
              { text: " w" },
              sub("i"),
              { text: " = 64 over the five Varnel weights" },
            ],
          },
        ],
      }),
      slide(3, {
        texts: [
          { x: 60, y: 80, size: 26, text: "The Varnel constant" },
          {
            x: 60,
            y: 170,
            size: 20,
            runs: [
              { text: "c", font: "math" },
              { ...sub("V"), font: "math" },
              { text: " = 2.75 is the Varnel constant" },
            ],
          },
          {
            x: 60,
            y: 230,
            size: 20,
            runs: [{ text: "ML", font: "math" }, { text: " = 128 for every deck" }],
          },
          {
            x: 60,
            y: 290,
            size: 20,
            runs: [
              { text: "x", font: "math" },
              sub("1"),
              { text: " + " },
              { text: "x", font: "math" },
              sub("2"),
              { text: " = 19" },
            ],
          },
        ],
      }),
    ]),
    facts: [
      { id: "bound", page: 2, must: ["≤3n+11"], wrong: ["≥3n+11"] },
      { id: "weights-sum", page: 2, must: ["64"], wrong: ["46"] },
      { id: "varnel-constant", page: 3, must: ["2.75"], wrong: ["27.5", "2.57"] },
      { id: "math-italic", page: 3, must: ["ml=128"], wrong: ["ml=182"] },
      { id: "subscripts", page: 3, must: ["x1+x2=19"], wrong: ["x1+x2=91"] },
    ],
  };
}

function arrowsDeck(): StudyDeck {
  const bars = [
    { label: "Alder", value: 42, x: 140 },
    { label: "Birch", value: 57, x: 300 },
    { label: "Cedar", value: 23, x: 460 },
  ];
  const chart = picture(60, 110, 600, 360, (context) => {
    context.lineWidth = 1.5;
    arrow(context, [50, 320], [50, 20]);
    arrow(context, [50, 320], [580, 320]);
    const points: [number, number][] = [
      [60, 290],
      [140, 240],
      [220, 200],
      [300, 90],
      [380, 170],
      [460, 230],
      [540, 260],
    ];
    context.lineWidth = 2.5;
    context.beginPath();
    points.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
    context.stroke();
    context.beginPath();
    context.arc(300, 90, 6, 0, Math.PI * 2);
    context.fill();
    context.font = `18px ${LATIN_FONT}`;
    context.fillText("peak 316", 312, 82);
    context.fillText("Latency (ms)", 60, 20);
    context.fillText("minutes", 510, 345);
  });
  return {
    name: "arrows",
    title: "Lecture 3 Pipeline diagrams",
    pdf: syntheticSlides([
      slide(1, {
        texts: [
          { x: 60, y: 200, size: 34, text: "Pipeline diagrams" },
          { x: 60, y: 250, size: 16, text: "Stages, arrows and the charts they produce" },
        ],
      }),
      slide(2, {
        shapes: [
          { kind: "rect", x: 60, y: 180, width: 140, height: 60 },
          { kind: "rect", x: 290, y: 180, width: 140, height: 60 },
          { kind: "rect", x: 520, y: 180, width: 140, height: 60 },
          { kind: "arrow", from: [200, 210], to: [288, 210] },
          { kind: "arrow", from: [430, 210], to: [518, 210] },
          { kind: "line", from: [590, 240], to: [590, 300] },
          { kind: "line", from: [590, 300], to: [130, 300] },
          { kind: "arrow", from: [130, 300], to: [130, 242] },
        ],
        texts: [
          { x: 60, y: 80, size: 26, text: "Three stages" },
          { x: 108, y: 216, text: "Parse" },
          { x: 342, y: 216, text: "Plan" },
          { x: 570, y: 216, text: "Emit" },
          { x: 250, y: 322, size: 14, text: "retry at most 13 times" },
          {
            x: 60,
            y: 420,
            size: 18,
            runs: [
              { text: "Overflow: Grebe " },
              { text: SYMBOL.arrowRight, font: "symbol" },
              { text: " Tern" },
            ],
          },
        ],
      }),
      slide(3, {
        shapes: [
          { kind: "line", from: [100, 420], to: [600, 420] },
          { kind: "line", from: [100, 420], to: [100, 120] },
          ...bars.map((bar) => ({
            kind: "rect" as const,
            x: bar.x,
            y: 420 - bar.value * 5,
            width: 80,
            height: bar.value * 5,
            fill: 0.6,
          })),
        ],
        texts: [
          { x: 60, y: 80, size: 26, text: "Requests per second by stage host" },
          ...bars.flatMap((bar): SlideText[] => [
            { x: bar.x + 22, y: 440, size: 14, text: bar.label },
            { x: bar.x + 30, y: 412 - bar.value * 5, size: 14, text: String(bar.value) },
          ]),
        ],
      }),
      slide(4, {
        images: [chart],
        texts: [{ x: 60, y: 80, size: 26, text: "Latency over a run" }],
      }),
    ]),
    facts: [
      { id: "flow-direction", page: 2, must: ["parse→plan"], wrong: ["plan→parse"] },
      { id: "retry-limit", page: 2, must: ["13"], wrong: ["31"] },
      { id: "symbol-arrow", page: 2, must: ["grebe→tern"], wrong: ["tern→grebe"] },
      { id: "birch-bar", page: 3, must: ["birch", "57"], wrong: ["75"] },
      { id: "cedar-bar", page: 3, must: ["cedar", "23"], wrong: ["32"] },
      { id: "chart-peak", page: 4, must: ["316"], wrong: ["361", "613"] },
    ],
  };
}

/** The three benchmark lectures, built afresh (pictures are drawn with the machine's fonts). */
export function studyDecks(): StudyDeck[] {
  return [hebrewDeck(), mathDeck(), arrowsDeck()];
}
