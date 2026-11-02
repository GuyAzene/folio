import type { SlideShape, SlideText, SyntheticSlide, TextRun } from "./synthetic-slides.ts";

/**
 * Two short synthetic lectures for the browser preview and the README's pictures, drawn like
 * plain course slides: titles, definitions, a state diagram, a run in a table, pseudocode and a
 * graph in layers. Made up for Folio; never real course material. Symbol-font letters are byte
 * codes: S is Sigma, d delta, e epsilon, Î "in", Í "subset of", ´ "times",
 * ® an arrow, È union and Ç intersection.
 */

const title = (text: string): SlideText[] => [{ x: 60, y: 78, size: 30, text }];
const rule: SlideShape = { kind: "line", from: [60, 96], to: [660, 96], width: 1.5 };
const symbol = (text: string): TextRun => ({ text, font: "symbol" });
const math = (text: string): TextRun => ({ text, font: "math" });
const sub = (text: string): TextRun => ({ text, size: 12, rise: -5 });

/** A state: its circle, a second ring if it accepts, and its name in the middle. */
function state(name: string, [x, y]: [number, number], accepting = false) {
  const shapes: SlideShape[] = [{ kind: "circle", center: [x, y], radius: 46 }];
  if (accepting) shapes.push({ kind: "circle", center: [x, y], radius: 39 });
  return { shapes, texts: [{ x: x - name.length * 5.6, y: y + 7, size: 20, text: name }] };
}

/** A loop above a state, read on `label`. */
function loop([x, y]: [number, number], label: string) {
  const shapes: SlideShape[] = [
    { kind: "line", from: [x - 14, y - 44], to: [x - 22, y - 84] },
    { kind: "line", from: [x - 22, y - 84], to: [x + 22, y - 84] },
    { kind: "arrow", from: [x + 22, y - 84], to: [x + 14, y - 45] },
  ];
  return { shapes, texts: [{ x: x - 5, y: y - 92, size: 18, text: label }] };
}

const even = state("even", [250, 290], true);
const odd = state("odd", [500, 290]);
const evenLoop = loop([250, 290], "0");
const oddLoop = loop([500, 290], "0");

/** Lecture 1 of the preview's Computational Models: finite automata, six slides. */
export const FINITE_AUTOMATA: SyntheticSlide[] = [
  {
    shapes: [{ kind: "rect", x: 60, y: 214, width: 56, height: 6, fill: 0.15 }],
    texts: [
      { x: 60, y: 190, size: 18, text: "Computational Models - Lecture 1" },
      { x: 60, y: 270, size: 46, text: "Finite automata" },
      {
        x: 60,
        y: 320,
        size: 18,
        text: "Deterministic automata, how they run, and what they recognize",
      },
      { x: 60, y: 480, size: 14, text: "CS 230 - Spring 2026" },
    ],
  },
  {
    shapes: [rule],
    texts: [
      ...title("A deterministic finite automaton"),
      {
        x: 60,
        y: 150,
        size: 22,
        runs: [
          { text: "is a 5-tuple  " },
          math("M"),
          { text: " = (" },
          math("Q"),
          { text: ", " },
          symbol("S"),
          { text: ", " },
          symbol("d"),
          { text: ", " },
          math("q"),
          sub("0"),
          { text: ", " },
          math("F"),
          { text: ")" },
        ],
      },
      ...(
        [
          [[math("Q")], "a finite set of states"],
          [[symbol("S")], "the input alphabet"],
          [
            [
              symbol("d"),
              { text: " : " },
              math("Q"),
              symbol(" ´ "),
              symbol("S"),
              symbol(" ® "),
              math("Q"),
            ],
            "the transition function",
          ],
          [[math("q"), sub("0"), symbol(" Î "), math("Q")], "the start state"],
          [[math("F"), symbol(" Í "), math("Q")], "the accepting states"],
        ] as [TextRun[], string][]
      ).flatMap(([runs, meaning], row): SlideText[] => [
        { x: 96, y: 222 + row * 46, size: 20, runs },
        { x: 300, y: 222 + row * 46, size: 20, text: meaning },
      ]),
    ],
  },
  {
    shapes: [
      rule,
      { kind: "arrow", from: [128, 290], to: [203, 290] },
      { kind: "arrow", from: [292, 270], to: [456, 270] },
      { kind: "arrow", from: [456, 310], to: [292, 310] },
      ...even.shapes,
      ...odd.shapes,
      ...evenLoop.shapes,
      ...oddLoop.shapes,
    ],
    texts: [
      ...title("A DFA for an even number of 1s"),
      ...even.texts,
      ...odd.texts,
      ...evenLoop.texts,
      ...oddLoop.texts,
      { x: 369, y: 260, size: 18, text: "1" },
      { x: 369, y: 336, size: 18, text: "1" },
      { x: 96, y: 278, size: 16, text: "start" },
      {
        x: 60,
        y: 440,
        size: 18,
        text: "Reading a 1 switches between even and odd; reading a 0 stays put.",
      },
      {
        x: 60,
        y: 470,
        size: 18,
        text: "Start in even. It is also the accepting state.",
      },
    ],
  },
  {
    shapes: [
      rule,
      { kind: "rect", x: 60, y: 168, width: 420, height: 34, fill: 0.9 },
      ...[0, 1, 2, 3, 4, 5].map((row): SlideShape => ({
        kind: "line",
        from: [60, 202 + row * 34],
        to: [480, 202 + row * 34],
        width: row === 0 || row === 5 ? 1.2 : 0.4,
      })),
    ],
    texts: [
      ...title("Running a DFA"),
      {
        x: 60,
        y: 140,
        size: 20,
        runs: [{ text: "On the input  " }, math("w"), { text: " = 1011" }],
      },
      ...["step", "reads", "state"].map((word, column) => ({
        x: 76 + column * 140,
        y: 191,
        size: 17,
        text: word,
      })),
      ...(
        [
          ["0", "", "even"],
          ["1", "1", "odd"],
          ["2", "0", "odd"],
          ["3", "1", "even"],
          ["4", "1", "odd"],
        ] as const
      ).flatMap((cells, row) =>
        cells.map((text, column) => ({ x: 76 + column * 140, y: 225 + row * 34, size: 17, text })),
      ),
      { x: 60, y: 430, size: 18, text: "It ends in odd, which is not accepting," },
      { x: 60, y: 458, size: 18, runs: [{ text: "so " }, math("M"), { text: " rejects 1011." }] },
    ],
  },
  {
    shapes: [rule],
    texts: [
      ...title("The language of a DFA"),
      {
        x: 110,
        y: 170,
        size: 24,
        runs: [
          symbol("d"),
          { text: "*(" },
          math("q"),
          { text: ", " },
          symbol("e"),
          { text: ") = " },
          math("q"),
        ],
      },
      {
        x: 110,
        y: 220,
        size: 24,
        runs: [
          symbol("d"),
          { text: "*(" },
          math("q"),
          { text: ", " },
          math("wa"),
          { text: ") = " },
          symbol("d"),
          { text: "(" },
          symbol("d"),
          { text: "*(" },
          math("q"),
          { text: ", " },
          math("w"),
          { text: "), " },
          math("a"),
          { text: ")" },
        ],
      },
      {
        x: 110,
        y: 290,
        size: 24,
        runs: [
          math("L"),
          { text: "(" },
          math("M"),
          { text: ") = { " },
          math("w"),
          symbol(" Î "),
          symbol("S"),
          { text: "* | " },
          symbol("d"),
          { text: "*(" },
          math("q"),
          sub("0"),
          { text: ", " },
          math("w"),
          { text: ")" },
          symbol(" Î "),
          math("F"),
          { text: " }" },
        ],
      },
      { x: 60, y: 400, size: 20, text: "A language is regular if some DFA recognizes it." },
    ],
  },
  {
    shapes: [rule],
    texts: [
      ...title("Closure"),
      {
        x: 60,
        y: 150,
        size: 20,
        runs: [
          { text: "If " },
          math("A"),
          { text: " and " },
          math("B"),
          { text: " are regular, so are:" },
        ],
      },
      ...(
        [
          [
            [math("A"), symbol(" È "), math("B")],
            "run both machines at once and accept if either does",
          ],
          [
            [math("A"), symbol(" Ç "), math("B")],
            "the same pair of machines, accepting if both do",
          ],
          [[{ text: "the complement of " }, math("A")], "swap accepting and rejecting states"],
        ] as [TextRun[], string][]
      ).flatMap(([runs, how], row): SlideText[] => [
        { x: 96, y: 210 + row * 64, size: 20, runs },
        { x: 120, y: 236 + row * 64, size: 16, text: how },
      ]),
    ],
  },
];

/** The graph on the layers slide: each vertex, where it is drawn, and its edges. */
const VERTICES: Record<string, [number, number]> = {
  s: [120, 280],
  a: [260, 200],
  b: [260, 360],
  c: [400, 200],
  d: [400, 360],
  e: [540, 280],
};
const EDGES = ["sa", "sb", "ab", "ac", "bd", "cd", "ce", "de"];

/** Lecture 1 of the preview's Algorithms: graph traversal, four slides. */
export const GRAPH_TRAVERSAL: SyntheticSlide[] = [
  {
    shapes: [{ kind: "rect", x: 60, y: 214, width: 56, height: 6, fill: 0.15 }],
    texts: [
      { x: 60, y: 190, size: 18, text: "Algorithms - Lecture 1" },
      { x: 60, y: 270, size: 46, text: "Graph traversal" },
      { x: 60, y: 320, size: 18, text: "Breadth-first and depth-first search" },
      { x: 60, y: 480, size: 14, text: "CS 201 - Spring 2026" },
    ],
  },
  {
    shapes: [rule, { kind: "rect", x: 440, y: 150, width: 230, height: 120 }],
    texts: [
      ...title("Breadth-first search"),
      ...[
        "BFS(G, s)",
        "  mark s;  Q = [s]",
        "  while Q is not empty:",
        "    u = dequeue(Q)",
        "    for each neighbour v of u:",
        "      if v is not marked:",
        "        mark v;  enqueue(Q, v)",
      ].map((text, row) => ({
        x: 72 + text.search(/\S/) * 9,
        y: 160 + row * 32,
        size: 18,
        text: text.trim(),
      })),
      ...["A vertex is marked when it", "enters the queue, so it is", "enqueued at most once."].map(
        (text, row) => ({ x: 456, y: 182 + row * 24, size: 16, text }),
      ),
      { x: 60, y: 450, size: 20, text: "Running time: O(V + E)" },
    ],
  },
  {
    shapes: [
      rule,
      ...EDGES.map((edge): SlideShape => ({
        kind: "line",
        from: VERTICES[edge[0]!]!,
        to: VERTICES[edge[1]!]!,
      })),
      ...Object.values(VERTICES).map((center): SlideShape => ({
        kind: "circle",
        center,
        radius: 22,
      })),
    ],
    texts: [
      ...title("Layers"),
      ...Object.entries(VERTICES).map(([name, [x, y]]) => ({
        x: x - 5,
        y: y + 6,
        size: 18,
        text: name,
      })),
      ...["L0", "L1", "L2", "L3"].map((text, layer) => ({
        x: [110, 250, 390, 530][layer]!,
        y: 440,
        size: 16,
        text,
      })),
      {
        x: 60,
        y: 480,
        size: 18,
        text: "BFS reaches every vertex of layer i before any of layer i + 1.",
      },
    ],
  },
  {
    shapes: [rule],
    texts: [
      ...title("Depth-first search"),
      { x: 60, y: 150, size: 20, text: "DFS explores one branch fully before backtracking." },
      {
        x: 60,
        y: 200,
        size: 20,
        text: "Each vertex gets a discovery time d[v] and a finish time f[v].",
      },
      { x: 60, y: 270, size: 20, text: "Parenthesis theorem: for any two vertices u and v," },
      { x: 90, y: 305, size: 20, text: "the intervals [d[u], f[u]] and [d[v], f[v]] are" },
      { x: 90, y: 340, size: 20, text: "either disjoint or one contains the other." },
    ],
  },
];
