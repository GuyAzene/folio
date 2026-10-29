// Development-only stand-in for the Electron bridge, so the renderer can be previewed in a
// plain browser. Synthetic courses and PDFs only; it never talks to a model and is not built.
import type {
  AttachmentView,
  AgentNodeView,
  ChatSummary,
  ChatView,
  CourseView,
  DesktopEvent,
  DocumentView,
  FolioApi,
  JobView,
  KnowledgeView,
  NoteView,
  PageCoverageView,
  ProposalView,
  SendInput,
  StudyNotesView,
  TrashEntryView,
} from "../../src/desktop/api.ts";
import { chatTitle } from "../../src/chat-title.ts";
import { SYNTHETIC_LECTURE, syntheticPdf } from "../../tests/fixtures/synthetic-pdf.ts";

const listeners = new Set<(event: DesktopEvent) => void>();
const emit = (event: DesktopEvent) => listeners.forEach((listener) => listener(event));
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const courses: CourseView[] = [
  {
    id: id(1),
    name: "Algorithms",
    code: "CS 201",
    term: "Spring 2026",
    color: "blue",
    revision: 1,
    documents: 3,
  },
  {
    id: id(2),
    name: "Computational Models",
    code: "CS 230",
    term: "Spring 2026",
    color: "green",
    revision: 1,
    documents: 2,
  },
];
const documents: DocumentView[] = [
  {
    id: id(11),
    courseId: id(1),
    title: "Lecture 1 Graph traversal",
    role: "lecture",
    kind: "pdf",
    pages: 3,
    size: 2048,
    dueAt: null,
    importedAt: ago(30),
    revision: 1,
  },
  {
    id: id(12),
    courseId: id(1),
    title: "Recitation 1 BFS examples",
    role: "recitation",
    kind: "pdf",
    pages: 3,
    size: 2048,
    dueAt: null,
    importedAt: ago(28),
    revision: 1,
  },
  {
    id: id(13),
    courseId: id(1),
    title: "Assignment 1",
    role: "assignment",
    kind: "pdf",
    pages: 3,
    size: 2048,
    dueAt: ago(-60),
    importedAt: ago(20),
    revision: 1,
  },
  {
    id: id(21),
    courseId: id(2),
    title: "Lecture 1 Finite automata",
    role: "lecture",
    kind: "pdf",
    pages: 3,
    size: 2048,
    dueAt: null,
    importedAt: ago(10),
    revision: 1,
  },
  {
    id: id(22),
    courseId: id(2),
    title: "Lecture 2 Regular languages",
    role: "lecture",
    kind: "pdf",
    pages: 3,
    size: 2048,
    dueAt: null,
    importedAt: ago(8),
    revision: 1,
  },
];
const chats = new Map<string, ChatView>([
  [
    id(31),
    {
      id: id(31),
      kind: "course",
      title: "Why BFS marks vertices on enqueue",
      status: "idle",
      modelId: "gpt-6.1-sol",
      updatedAt: ago(2),
      courseId: id(1),
      focus: { documentId: id(11), page: 2 },
      reads: { courses: [], documents: [] },
      messages: [
        { role: "user", text: "Why is each vertex enqueued at most once?", state: "complete" },
        {
          role: "assistant",
          text: "Because a vertex is **marked visited when it enters the queue**, not when it leaves. The lecture's pseudocode checks this before every enqueue (Lecture 1 Graph traversal, page 2).",
          state: "complete",
          steps: [
            { label: "Read Lecture 1 Graph traversal, page 2", state: "done" },
            { label: "Read your note Graph traversal", state: "done" },
            { label: "Drafted a note edit for you to review", state: "done" },
          ],
          sources: [{ documentId: id(11), title: "Lecture 1 Graph traversal", page: 2 }],
          proposals: [id(41)],
        },
      ],
    },
  ],
  [
    id(32),
    {
      id: id(32),
      kind: "course",
      title: "Dijkstra and negative edges",
      status: "idle",
      modelId: "gpt-6.1-sol",
      updatedAt: ago(1),
      courseId: id(1),
      focus: null,
      reads: { courses: [], documents: [] },
      // Synthetic Hebrew and English with math, a list, a table, code and numbers.
      messages: [
        {
          role: "user",
          text: "למה Dijkstra נכשל כשיש קשת במשקל שלילי?\nתסביר עם הדוגמה מהתרגול.",
          state: "complete",
        },
        {
          role: "assistant",
          text: [
            "**קשת שלילית שוברת את ההנחה המרכזית של דייקסטרה:** כשמוציאים קודקוד מ־\\(Q\\) באמצעות `EXTRACT-MIN`, המרחק שלו כבר סופי.",
            "",
            "### הדוגמה מהתרגול",
            "בגרף יש שלוש קשתות:",
            "\\[",
            "s\\xrightarrow{2}a,\\qquad s\\xrightarrow{3}b,\\qquad b\\xrightarrow{-2}a.",
            "\\]",
            "1. אחרי שמוציאים את $s$: $d[a]=2$ ו־$d[b]=3$.",
            "2. Dijkstra extracts $a$ before $b$, since $2<3$.",
            "3. אבל המסלול $s\\to b\\to a$ קצר יותר: 3 + (-2) = 1, ולכן $\\delta(s,a)=1$ ולא 2.",
            "",
            "| איטרציה | קודקוד שהוצא | $d[a]$ |",
            "|---|---|---|",
            "| 1 | s | 2 |",
            "| 2 | a (final, wrong) | 2 |",
            "",
            "Python היא לא חלק מהקורס, אבל אפשר לבדוק את זה כך: `dist[a] > dist[b] + w(b, a)`.",
            "",
            "כך רואים שהמרחק בזמן ההוצאה אינו בהכרח סופי (Recitation 3 Dijkstra exercises, page 2).",
          ].join("\n"),
          state: "complete",
          steps: [{ label: "Searched the course", state: "done" }],
          sources: [{ documentId: id(11), title: "Lecture 1 Graph traversal", page: 2 }],
        },
      ],
    },
  ],
]);

const notes = new Map<string, { note: NoteView; content: string }>();
function putNote(noteId: string, courseId: string, content: string): NoteView {
  const previous = notes.get(noteId)?.note.revision ?? "0";
  const note: NoteView = {
    id: noteId,
    courseId,
    title:
      content
        .split("\n")
        .find((line) => line.trim())
        ?.replace(/^#+\s*/, "") || "Untitled note",
    revision: String(Number(previous) + 1),
    updatedAt: new Date().toISOString(),
  };
  notes.set(noteId, { note, content });
  return note;
}
putNote(
  id(51),
  id(1),
  "# Graph traversal\n\nBFS visits vertices in layers.\nEach vertex is marked when it is dequeued.\n",
);
// Exercises the note editor: Hebrew and English, math, tasks, a table, HTML and code.
putNote(
  id(52),
  id(2),
  [
    "# אוטומטים סופיים",
    "",
    "שפה היא **רגולרית** אם יש לה אוטומט סופי דטרמיניסטי $M = (Q, \\Sigma, \\delta, q_0, F)$. ראו גם [ההגדרה המלאה](https://en.wikipedia.org/wiki/Regular_language).",
    "",
    "- [x] להגדיר DFA",
    "- [ ] להוכיח את למת הניפוח עבור $L = \\{a^n b^n \\mid n \\ge 0\\}$",
    "- פריט ארוך שנשבר לכמה שורות כדי לבדוק שההזחה התלויה של הרשימה עובדת כמו שצריך גם בעברית וגם כשיש בה English words",
    "  - פריט מקונן",
    "",
    "$$",
    "\\delta^*(q, wa) = \\delta(\\delta^*(q, w), a)",
    "$$",
    "",
    "> כל שפה סופית היא רגולרית.",
    "",
    "| מושג | הגדרה |",
    "|---|---|",
    "| DFA | אוטומט דטרמיניסטי |",
    "| NFA | אוטומט *לא* דטרמיניסטי |",
    "",
    "<details><summary>הוכחה</summary>",
    "נבנה אוטומט עם מצב לכל מילה.",
    "</details>",
    "",
    "An English paragraph with <mark>highlighted</mark> HTML, `inline code`, ~~strikethrough~~ and *emphasis*.",
    "",
    "1. First step",
    "2. שלב שני: 3 + 4 = 7",
    "",
    "```python",
    "def accepts(dfa, word):",
    "    state = dfa.start",
    "    for a in word:",
    "        state = dfa.delta[state, a]",
    "    return state in dfa.accept",
    "```",
    "",
    "---",
    "",
    "נוסחה בתוך שורה $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$ וטקסט אחריה.",
    "",
  ].join("\n"),
);
const proposals: (ProposalView & { baseRevision: string | null })[] = [
  {
    id: id(41),
    courseId: id(1),
    chatId: id(31),
    noteId: id(51),
    noteTitle: "Graph traversal",
    find: "Each vertex is marked when it is dequeued.",
    text: "Each vertex is marked when it is enqueued, so it enters the queue at most once (Lecture 1, page 2).",
    reason: "Your note says dequeued; the lecture marks vertices on enqueue.",
    state: "pending",
    stale: false,
    createdAt: ago(2),
    resultNoteId: null,
    baseRevision: "1",
  },
];
const proposalView = ({ baseRevision, ...proposal }: (typeof proposals)[number]) => ({
  ...proposal,
  noteTitle: (proposal.noteId && notes.get(proposal.noteId)?.note.title) || proposal.noteTitle,
  stale:
    proposal.state === "pending" &&
    !!proposal.noteId &&
    notes.get(proposal.noteId)?.note.revision !== baseRevision,
});

// ── Background jobs ─────────────────────────────────────────────────────────
// Synthetic study runs. The running one advances on a timer and emits job events, so the Jobs
// page can be previewed live. Page counts are the job's own; the preview PDFs stay 3 pages.

/** A node plus preview-only bookkeeping, stripped before it leaves the bridge. */
type SimNode = AgentNodeView & {
  /** Nodes that must be done before this one starts. */
  after?: string[];
  /** Timer ticks this node runs for, and the usage it reports when done. */
  ticks?: number;
  ran?: number;
  final?: [calls: number, input: number, output: number];
  /** The document whose coverage this node changes. */
  doc?: string;
  /** Reader pages that the gate escalates. */
  escalates?: number[];
  /** Nodes that appear when this one finishes, such as an escalation. */
  spawns?: SimNode[];
};
type SimJob = Omit<JobView, "nodes" | "resumable"> & {
  nodes: SimNode[];
  /** Pages whose ledger ends in a stated gap, by document. */
  gaps: Record<string, number[]>;
  cancelled: boolean;
};

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const span = (startMinutesAgo: number, seconds: number) => ({
  startedAt: at(startMinutesAgo),
  endedAt: at(startMinutesAgo - seconds / 60),
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);
const regionsOn = (page: number) => 8 + ((page * 7) % 6);

function agent(
  nodeId: string,
  parentId: string | null,
  role: AgentNodeView["role"],
  title: string,
  task: string,
  model: string | null,
  status: AgentNodeView["status"],
  extra: Partial<SimNode> = {},
): SimNode {
  return {
    id: nodeId,
    parentId,
    role,
    title,
    task,
    provider: model ? "openai" : null,
    model,
    status,
    note: null,
    pages: [],
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: null,
    endedAt: null,
    attempt: 1,
    outcome: null,
    ...extra,
  };
}
const used = (calls: number, input: number, output: number) => ({
  calls,
  inputTokens: input,
  outputTokens: output,
});

const LUNA = "gpt-6-luna";
const SOL6 = "gpt-6-sol";
const SOL = "gpt-6.1-sol";

function coverageOf(
  documentId: string,
  pages: number,
  state: (page: number) => PageCoverageView["state"],
): PageCoverageView[] {
  return range(1, pages).map((page) => ({ documentId, page, state: state(page) }));
}

/** Two documents read at once: a lecture and its recitation. */
function runningJob(): SimJob {
  const L = id(11);
  const R = id(12);
  const nodes: SimNode[] = [
    agent(
      "a-run",
      null,
      "run",
      "Study run",
      "Reading Lecture 1 and Recitation 1 into a draft for your review",
      null,
      "running",
      { startedAt: at(9) },
    ),

    agent(
      "a-L",
      "a-run",
      "document",
      "Lecture 1 Graph traversal",
      "Four reader batches, then one author and an independent review",
      null,
      "running",
      { pages: range(1, 12), startedAt: at(9) },
    ),
    agent(
      "a-L-prep",
      "a-L",
      "prepare",
      "Prepare and inventory",
      "Rendered 12 pages and listed 136 regions to account for",
      null,
      "done",
      { pages: range(1, 12), ...span(9, 7) },
    ),
    agent(
      "a-L-brief",
      "a-L",
      "brief",
      "Lecture brief",
      "Fixed notation, glossary and outline before the readers start",
      SOL6,
      "done",
      { ...used(1, 18_420, 2_130), ...span(8.8, 46) },
    ),
    agent("a-L-r1", "a-L", "reader", "Pages 1–3", "Read every region on pages 1–3", LUNA, "done", {
      pages: [1, 2, 3],
      ...used(1, 22_140, 4_310),
      ...span(8, 52),
    }),
    agent("a-L-r2", "a-L", "reader", "Pages 4–6", "Read every region on pages 4–6", LUNA, "done", {
      pages: [4, 5, 6],
      ...used(1, 24_810, 4_920),
      ...span(7.9, 58),
    }),
    agent(
      "a-L-e5",
      "a-L-r2",
      "escalation",
      "Region 5.3 · chart",
      "Read the chart's axes and values from a full-resolution crop",
      SOL,
      "done",
      { pages: [5], ...used(1, 6_240, 1_080), ...span(6.9, 31) },
    ),
    agent("a-L-r3", "a-L", "reader", "Pages 7–9", "Read every region on pages 7–9", LUNA, "done", {
      pages: [7, 8, 9],
      ...used(1, 23_020, 4_390),
      ...span(6.8, 55),
    }),
    agent(
      "a-L-e8",
      "a-L-r3",
      "escalation",
      "Region 8.2 · diagram",
      "Listing the diagram's nodes and arrows, with their direction",
      SOL,
      "running",
      { pages: [8], doc: L, startedAt: at(0.7), ticks: 2, final: [1, 7_120, 1_640] },
    ),
    agent(
      "a-L-r4",
      "a-L",
      "reader",
      "Pages 10–12",
      "Reading every region on pages 10–12",
      LUNA,
      "running",
      {
        pages: [10, 11, 12],
        doc: L,
        startedAt: at(0.5),
        ticks: 3,
        final: [1, 21_730, 4_020],
        escalates: [11],
        spawns: [
          agent(
            "a-L-e11",
            "a-L-r4",
            "escalation",
            "Region 11.4 · equation",
            "Re-reading a small-type equation from a native-resolution crop",
            SOL,
            "running",
            { pages: [11], doc: L, ticks: 2, final: [1, 5_310, 920] },
          ),
        ],
      },
    ),
    agent(
      "a-L-author",
      "a-L",
      "author",
      "Author",
      "Write the lecture's draft pages, citing page and region for every claim",
      SOL,
      "queued",
      { after: ["a-L-r4", "a-L-e8", "a-L-e11"], ticks: 4, final: [6, 96_400, 14_200] },
    ),
    agent(
      "a-L-review",
      "a-L",
      "reviewer",
      "Review",
      "Check each claim against only its cited region crop",
      SOL6,
      "queued",
      { after: ["a-L-author"], ticks: 3, final: [3, 41_200, 5_160] },
    ),
    agent(
      "a-L-ledger",
      "a-L",
      "ledger",
      "Coverage ledger",
      "Give every region a recorded state: represented, omitted or gap",
      null,
      "queued",
      { after: ["a-L-review"], ticks: 1, doc: L },
    ),

    agent(
      "a-R",
      "a-run",
      "document",
      "Recitation 1 BFS examples",
      "Three reader batches, then one author after the lecture's",
      null,
      "running",
      { pages: range(1, 9), startedAt: at(9) },
    ),
    agent(
      "a-R-prep",
      "a-R",
      "prepare",
      "Prepare and inventory",
      "Rendered 9 pages and listed 98 regions to account for",
      null,
      "done",
      { pages: range(1, 9), ...span(9, 5) },
    ),
    agent(
      "a-R-brief",
      "a-R",
      "brief",
      "Recitation brief",
      "Matched the recitation's notation to the lecture brief",
      SOL6,
      "done",
      { ...used(1, 12_880, 1_460), ...span(8.7, 34) },
    ),
    agent("a-R-r1", "a-R", "reader", "Pages 1–3", "Read every region on pages 1–3", LUNA, "done", {
      pages: [1, 2, 3],
      ...used(1, 19_660, 3_870),
      ...span(7.6, 49),
    }),
    agent(
      "a-R-r2",
      "a-R",
      "reader",
      "Pages 4–6",
      "Reading every region on pages 4–6",
      LUNA,
      "running",
      { pages: [4, 5, 6], doc: R, startedAt: at(0.3), ticks: 2, final: [1, 20_410, 3_990] },
    ),
    agent(
      "a-R-r3",
      "a-R",
      "reader",
      "Pages 7–9",
      "Read every region on pages 7–9",
      LUNA,
      "queued",
      {
        pages: [7, 8, 9],
        doc: R,
        after: ["a-R-r2"],
        ticks: 3,
        final: [1, 21_080, 4_150],
        escalates: [7],
        spawns: [
          agent(
            "a-R-e7",
            "a-R-r3",
            "escalation",
            "Region 7.1 · table",
            "Reading a table that is only a picture on the page",
            SOL,
            "running",
            { pages: [7], doc: R, ticks: 2, final: [1, 6_020, 1_310] },
          ),
        ],
      },
    ),
    agent(
      "a-R-author",
      "a-R",
      "author",
      "Author",
      "Write the recitation's worked examples into the draft",
      SOL,
      "queued",
      { after: ["a-R-r3", "a-R-e7", "a-L-author"], ticks: 3, final: [4, 61_900, 9_400] },
    ),
    agent(
      "a-R-review",
      "a-R",
      "reviewer",
      "Review",
      "Check each claim against only its cited region crop",
      SOL6,
      "queued",
      { after: ["a-R-author"], ticks: 2, final: [2, 27_300, 3_480] },
    ),
    agent(
      "a-R-ledger",
      "a-R",
      "ledger",
      "Coverage ledger",
      "Give every region a recorded state: represented, omitted or gap",
      null,
      "queued",
      { after: ["a-R-review"], ticks: 1, doc: R },
    ),
  ];
  const coverage = [
    ...coverageOf(L, 12, (page) =>
      page === 5 || page === 8 ? "escalated" : page <= 9 ? "read" : "pending",
    ),
    ...coverageOf(R, 9, (page) => (page <= 3 ? "read" : "pending")),
  ];
  return {
    id: id(61),
    kind: "ingest",
    courseId: id(1),
    documentIds: [L, R],
    title: "Lecture 1 and Recitation 1",
    status: "running",
    createdAt: at(9),
    updatedAt: at(0.3),
    pages: 21,
    pagesRead: 0,
    regions: 0,
    regionsAccounted: 0,
    coverage,
    nodes,
    gaps: { [L]: [8] },
    cancelled: false,
  };
}

/** A finished draft that waits for the student's review. */
function waitingJob(): SimJob {
  const D = id(22);
  const start = 140;
  const nodes: SimNode[] = [
    agent(
      "b-run",
      null,
      "run",
      "Study run",
      "Read Lecture 2 into a draft for your review",
      null,
      "waiting",
      {
        startedAt: at(start),
        note: "The draft is ready for your review: 1 gap and 1 diagram described but not verified.",
      },
    ),
    agent(
      "b-D",
      "b-run",
      "document",
      "Lecture 2 Regular languages",
      "Four reader batches, one author and an independent review",
      null,
      "done",
      { pages: range(1, 10), ...span(start, 1_940) },
    ),
    agent(
      "b-prep",
      "b-D",
      "prepare",
      "Prepare and inventory",
      "Rendered 10 pages and listed 112 regions to account for",
      null,
      "done",
      { pages: range(1, 10), ...span(start, 6) },
    ),
    agent(
      "b-brief",
      "b-D",
      "brief",
      "Lecture brief",
      "Fixed notation, glossary and outline before the readers start",
      SOL6,
      "done",
      { ...used(1, 16_900, 1_980), ...span(start - 0.2, 41) },
    ),
    agent("b-r1", "b-D", "reader", "Pages 1–3", "Read every region on pages 1–3", LUNA, "done", {
      pages: [1, 2, 3],
      ...used(1, 21_400, 4_100),
      ...span(start - 1, 50),
    }),
    agent("b-r2", "b-D", "reader", "Pages 4–6", "Read every region on pages 4–6", LUNA, "done", {
      pages: [4, 5, 6],
      ...used(1, 22_960, 4_480),
      ...span(start - 1, 57),
    }),
    agent(
      "b-e5",
      "b-r2",
      "escalation",
      "Region 5.1 · diagram",
      "Listed the automaton's states and transitions, with direction",
      SOL,
      "done",
      { pages: [5], ...used(1, 7_400, 1_720), ...span(start - 2, 36) },
    ),
    agent("b-r3", "b-D", "reader", "Pages 7–9", "Read every region on pages 7–9", LUNA, "done", {
      pages: [7, 8, 9],
      ...used(1, 20_310, 3_960),
      ...span(start - 1.1, 53),
    }),
    agent("b-r4", "b-D", "reader", "Page 10", "Read every region on page 10", LUNA, "done", {
      pages: [10],
      ...used(1, 8_120, 1_510),
      ...span(start - 1.1, 21),
    }),
    agent(
      "b-author",
      "b-D",
      "author",
      "Author",
      "Wrote the lecture's draft pages, citing page and region for every claim",
      SOL,
      "done",
      { ...used(7, 108_300, 16_900), ...span(start - 3, 960) },
    ),
    agent(
      "b-review",
      "b-D",
      "reviewer",
      "Review",
      "Checked each claim against only its cited region crop",
      SOL6,
      "done",
      { ...used(3, 44_700, 5_620), ...span(start - 19, 540) },
    ),
    agent(
      "b-ledger",
      "b-D",
      "ledger",
      "Coverage ledger",
      "Every region has a recorded state; none is unaccounted",
      null,
      "done",
      { ...span(start - 28.5, 3) },
    ),
  ];
  return {
    id: id(62),
    kind: "ingest",
    courseId: id(2),
    documentIds: [D],
    title: "Lecture 2 Regular languages",
    status: "done",
    createdAt: at(start),
    updatedAt: at(start - 32),
    pages: 10,
    pagesRead: 0,
    regions: 0,
    regionsAccounted: 0,
    coverage: coverageOf(D, 10, (page) => (page === 6 ? "gap" : "represented")),
    nodes,
    gaps: {},
    cancelled: false,
  };
}

/** A published run with a reader that failed once and was retried. */
function doneJob(): SimJob {
  const D = id(21);
  const start = 2 * 24 * 60 + 35;
  const nodes: SimNode[] = [
    agent(
      "c-run",
      null,
      "run",
      "Study run",
      "Read Lecture 1 into the course knowledge base",
      null,
      "done",
      { ...span(start, 1_610) },
    ),
    agent(
      "c-D",
      "c-run",
      "document",
      "Lecture 1 Finite automata",
      "Three reader batches, one author and an independent review",
      null,
      "done",
      { pages: range(1, 8), ...span(start, 1_480) },
    ),
    agent(
      "c-prep",
      "c-D",
      "prepare",
      "Prepare and inventory",
      "Rendered 8 pages and listed 87 regions to account for",
      null,
      "done",
      { pages: range(1, 8), ...span(start, 5) },
    ),
    agent(
      "c-brief",
      "c-D",
      "brief",
      "Lecture brief",
      "Fixed notation, glossary and outline before the readers start",
      SOL6,
      "done",
      { ...used(1, 15_200, 1_760), ...span(start - 0.2, 39) },
    ),
    agent("c-r1", "c-D", "reader", "Pages 1–3", "Read every region on pages 1–3", LUNA, "done", {
      pages: [1, 2, 3],
      ...used(1, 20_100, 3_920),
      ...span(start - 1, 48),
    }),
    agent("c-r2", "c-D", "reader", "Pages 4–6", "Read every region on pages 4–6", LUNA, "failed", {
      pages: [4, 5, 6],
      ...used(1, 23_400, 8_190),
      ...span(start - 1, 74),
      note: "The answer was cut off on page 5, so the reader gate rejected it.",
    }),
    agent("c-r2b", "c-D", "reader", "Pages 4–6", "Read every region on pages 4–6", LUNA, "done", {
      pages: [4, 5, 6],
      attempt: 2,
      ...used(1, 23_400, 4_610),
      ...span(start - 2.3, 56),
    }),
    agent("c-r3", "c-D", "reader", "Pages 7–8", "Read every region on pages 7–8", LUNA, "done", {
      pages: [7, 8],
      ...used(1, 15_800, 3_020),
      ...span(start - 1, 41),
    }),
    agent(
      "c-e7",
      "c-r3",
      "escalation",
      "Region 7.2 · diagram",
      "Listed the automaton's states and transitions, with direction",
      SOL,
      "done",
      { pages: [7], ...used(1, 6_900, 1_540), ...span(start - 2, 33) },
    ),
    agent(
      "c-author",
      "c-D",
      "author",
      "Author",
      "Wrote the lecture's draft pages, citing page and region for every claim",
      SOL,
      "done",
      { ...used(5, 84_600, 12_300), ...span(start - 3.5, 780) },
    ),
    agent(
      "c-review",
      "c-D",
      "reviewer",
      "Review",
      "Checked each claim against only its cited region crop",
      SOL6,
      "done",
      { ...used(2, 33_900, 4_210), ...span(start - 16.5, 410) },
    ),
    agent(
      "c-ledger",
      "c-D",
      "ledger",
      "Coverage ledger",
      "Every region has a recorded state; none is unaccounted",
      null,
      "done",
      { ...span(start - 23.5, 2) },
    ),
    agent(
      "c-publish",
      "c-run",
      "publish",
      "Publish",
      "Switched the course to the reviewed draft you approved",
      null,
      "done",
      { ...span(start - 26.5, 4) },
    ),
  ];
  return {
    id: id(63),
    kind: "ingest",
    courseId: id(2),
    documentIds: [D],
    title: "Lecture 1 Finite automata",
    status: "done",
    createdAt: at(start),
    updatedAt: at(start - 26.8),
    pages: 8,
    pagesRead: 0,
    regions: 0,
    regionsAccounted: 0,
    coverage: coverageOf(D, 8, (page) => (page === 3 ? "gap" : "represented")),
    nodes,
    gaps: {},
    cancelled: false,
  };
}

const jobs: SimJob[] = [runningJob(), waitingJob(), doneJob()];
let jobTimer: ReturnType<typeof setInterval> | undefined;

/** Pages read and regions accounted, recounted from coverage and finished escalations. */
function recount(job: SimJob): void {
  const resolved = new Set(
    job.nodes
      .filter((node) => node.role === "escalation" && node.status === "done")
      .flatMap((node) => node.pages.map((page) => `${node.doc ?? ""}:${page}`)),
  );
  job.regions = job.coverage.reduce((total, cell) => total + regionsOn(cell.page), 0);
  job.pagesRead = job.coverage.filter((cell) => cell.state !== "pending").length;
  job.regionsAccounted = job.coverage.reduce((total, cell) => {
    if (cell.state === "pending") return total;
    const open = cell.state === "escalated" && !resolved.has(`${cell.documentId}:${cell.page}`);
    return total + regionsOn(cell.page) - (open ? 2 : 0);
  }, 0);
}

const NODE_KEYS = [
  "id",
  "parentId",
  "role",
  "title",
  "task",
  "provider",
  "model",
  "status",
  "note",
  "pages",
  "calls",
  "inputTokens",
  "outputTokens",
  "startedAt",
  "endedAt",
  "attempt",
  "outcome",
] as const satisfies readonly (keyof AgentNodeView)[];

function previewKnowledge(courseId: string): KnowledgeView {
  const notes = previewStudyNotes(courseId);
  return {
    courseId,
    generation: notes.generation,
    publishedAt: notes.publishedAt,
    summary: "alg-L01, alg-R01",
    sessions: notes.sessions.map(({ slug, title, documentId }) => ({ slug, title, documentId })),
    pages: notes.topics.length,
    blocks: notes.topics.reduce((sum, topic) => sum + topic.sections.length, 0),
    canRollBack: true,
  };
}

/** Synthetic study notes for Algorithms: Hebrew and English, math, citations, a gap. */
function previewStudyNotes(courseId: string): StudyNotesView {
  const section = (
    handle: string,
    title: string,
    body: string,
    pages: number[],
    session = "alg-L01",
    questions: string[] = [],
  ) => ({
    handle,
    title,
    body,
    session,
    documentId: session === "alg-L01" ? id(11) : id(12),
    pages,
    questions,
  });
  return {
    courseId,
    generation: 2,
    publishedAt: ago(3),
    sessions: [
      {
        slug: "alg-L01",
        title: "Graph traversal",
        type: "lecture",
        documentId: id(11),
        covers:
          "Graphs and how to store them, then breadth-first search: why it marks vertices on enqueue, its $O(V + E)$ running time, and the distances it finds.",
        worthRemembering: [
          "Mark a vertex when it enters the queue, not when it leaves it.",
          "סריקה לרוחב מוצאת מרחקים רק בגרף לא ממושקל.",
        ],
        openThreads: ["The lecture mentions depth-first search but leaves it for next week."],
        workedExamples: [{ title: "BFS on a six-vertex graph", page: 3 }],
        topics: ["alg-graphs", "alg-bfs", "alg-shortest-paths"],
        leftOut: [{ page: 1, reasons: ["Course logistics: office hours and grading."] }],
      },
      {
        slug: "alg-R01",
        title: "BFS examples",
        type: "recitation",
        documentId: id(12),
        covers: "Worked BFS runs and the tree of parent pointers they leave behind.",
        worthRemembering: [],
        openThreads: [],
        workedExamples: [{ title: "Tracing the queue", page: 2 }],
        topics: ["alg-bfs-tree"],
        leftOut: [],
      },
    ],
    topics: [
      {
        slug: "alg-graphs",
        title: "Graphs",
        type: "concept",
        intuition: "Dots joined by lines: the dots are vertices, the lines edges.",
        introducedIn: "alg-L01",
        prerequisites: [],
        usedBy: [{ slug: "alg-bfs", title: "Breadth-first search" }],
        sections: [
          section(
            "alg-graph-definition",
            "Definition",
            "A graph $G = (V, E)$ is a set of vertices $V$ with a set of edges $E \\subseteq V \\times V$. In an undirected graph each edge $\\{u, v\\}$ goes both ways.",
            [1],
            "alg-L01",
            ["What changes when the edges are directed?"],
          ),
          section(
            "alg-adjacency-lists",
            "ייצוג ברשימות שכנויות",
            "רשימת שכנויות שומרת לכל קודקוד את רשימת שכניו, כך שהזיכרון הכולל הוא $O(|V| + |E|)$. מטריצת שכנויות דורשת $O(|V|^2)$ גם כשהגרף דליל.",
            [1, 2],
          ),
        ],
      },
      {
        slug: "alg-bfs",
        title: "Breadth-first search",
        type: "technique",
        intuition: "Ripples spreading from a stone: first everything one step away, then two.",
        introducedIn: "alg-L01",
        prerequisites: [{ slug: "alg-graphs", title: "Graphs" }],
        usedBy: [
          { slug: "alg-shortest-paths", title: "Shortest paths in unweighted graphs" },
          { slug: "alg-bfs-tree", title: "The BFS tree" },
        ],
        sections: [
          section(
            "alg-bfs-marking",
            "Marking on enqueue",
            "Each vertex is marked **visited** when it *enters* the queue, so it is enqueued at most once.\n\n1. Put $s$ in the queue and mark it.\n2. Take the first vertex $u$ out.\n3. Enqueue and mark every unmarked neighbour of $u$.",
            [2],
            "alg-L01",
            ["Why would marking on dequeue let a vertex enter the queue twice?"],
          ),
          section(
            "alg-bfs-time",
            "Running time",
            'BFS runs in $O(V + E)$: every vertex is dequeued once, and every edge is looked at a constant number of times.\n\n> Not confirmed against the slides: "each edge is examined exactly twice"',
            [2, 3],
          ),
          section(
            "alg-bfs-layers",
            "שכבות",
            "סריקה לרוחב מבקרת בקודקודים לפי שכבות: קודם כל השכנים במרחק 1 מ-$s$, אחר כך במרחק 2, וכן הלאה (Lecture 1, page 3).",
            [3],
          ),
        ],
      },
      {
        slug: "alg-shortest-paths",
        title: "Shortest paths in unweighted graphs",
        type: "concept",
        intuition: "The layer a vertex lands in is its distance.",
        introducedIn: "alg-L01",
        prerequisites: [{ slug: "alg-bfs", title: "Breadth-first search" }],
        usedBy: [],
        sections: [
          section(
            "alg-bfs-distance",
            "Distances from BFS",
            "For every vertex $v$ reachable from $s$, $d(s, v)$ equals the layer BFS puts $v$ in:\n\n$$\nd(s, v) = \\min_{u \\,:\\, (u, v) \\in E} d(s, u) + 1\n$$",
            [3],
            "alg-L01",
            ["Why does this fail once edges have weights?"],
          ),
        ],
      },
      {
        slug: "alg-bfs-tree",
        title: "The BFS tree",
        type: "concept",
        intuition: "Keep, for each vertex, the edge it was discovered through.",
        introducedIn: "alg-R01",
        prerequisites: [{ slug: "alg-bfs", title: "Breadth-first search" }],
        usedBy: [],
        sections: [
          section(
            "alg-parent-pointers",
            "Parent pointers",
            "When $u$ discovers $v$, set $\\pi(v) = u$. Following $\\pi$ back from any $v$ gives a shortest path to $s$.",
            [2, 3],
            "alg-R01",
          ),
        ],
      },
    ],
  };
}

/** The job as the main process would send it: preview bookkeeping stripped, copied. */
function jobView(job: SimJob): JobView {
  const nodes = job.nodes.map(
    (node) =>
      Object.fromEntries(NODE_KEYS.map((key) => [key, node[key]])) as unknown as AgentNodeView,
  );
  return structuredClone({
    id: job.id,
    kind: job.kind,
    courseId: job.courseId,
    documentIds: job.documentIds,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    pages: job.pages,
    pagesRead: job.pagesRead,
    regions: job.regions,
    regionsAccounted: job.regionsAccounted,
    coverage: job.coverage,
    nodes,
    resumable: !job.cancelled && (job.status === "stopped" || job.status === "failed"),
  });
}

function setCoverage(
  job: SimJob,
  documentId: string,
  page: number,
  state: PageCoverageView["state"],
) {
  const cell = job.coverage.find(
    (candidate) => candidate.documentId === documentId && candidate.page === page,
  );
  if (cell) cell.state = state;
}

/** What a finished synthetic step produced, as the real pipeline records it. */
function outcomeOf(job: SimJob, node: SimNode): AgentNodeView["outcome"] {
  if (node.role === "author") return { topics: 6, sections: 14 };
  if (node.role === "reviewer") return { claims: 24, disagreements: 1 };
  if (node.role !== "document") return null;
  const documentId = job.documentIds.find(
    (candidate) => documents.find((document) => document.id === candidate)?.title === node.title,
  );
  return {
    pages: job.coverage.filter((cell) => cell.documentId === documentId).length,
    figures: 2,
    topics: 6,
    sections: 14,
    claims: 24,
    disagreements: 1,
    uncovered: (documentId && job.gaps[documentId]?.length) || 0,
  };
}

function finish(job: SimJob, node: SimNode, now: string): void {
  node.status = "done";
  node.endedAt = now;
  node.outcome = outcomeOf(job, node);
  if (node.final) [node.calls, node.inputTokens, node.outputTokens] = node.final;
  if (node.role === "reader" && node.doc)
    for (const page of node.pages)
      setCoverage(job, node.doc, page, node.escalates?.includes(page) ? "escalated" : "read");
  if (node.role === "ledger" && node.doc)
    for (const cell of job.coverage)
      if (cell.documentId === node.doc)
        cell.state = job.gaps[node.doc]?.includes(cell.page) ? "gap" : "represented";
  for (const spawned of node.spawns ?? []) job.nodes.push({ ...spawned, startedAt: now, ran: 0 });
}

function tick(): void {
  for (const job of jobs) {
    if (job.status !== "running") continue;
    const now = new Date().toISOString();
    const done = (nodeId: string) =>
      job.nodes.find((node) => node.id === nodeId)?.status === "done";
    for (const node of job.nodes) {
      if (node.status !== "running" || !node.ticks) continue;
      node.ran = (node.ran ?? 0) + 1;
      if (node.ran >= node.ticks) finish(job, node, now);
      else if (node.final) {
        // Usage grows as the step's requests complete.
        const share = node.ran / node.ticks;
        node.calls = Math.max(1, Math.floor(node.final[0] * share));
        node.inputTokens = Math.round(node.final[1] * share);
        node.outputTokens = Math.round(node.final[2] * share);
      }
    }
    for (const node of job.nodes)
      if (node.status === "queued" && (node.after ?? []).every(done)) {
        node.status = "running";
        node.startedAt = now;
        node.ran = 0;
      }
    for (const node of job.nodes)
      if (
        node.role === "document" &&
        node.status === "running" &&
        job.nodes.every((child) => child.parentId !== node.id || child.status === "done")
      ) {
        node.status = "done";
        node.endedAt = now;
        node.outcome = outcomeOf(job, node);
      }
    const run = job.nodes.find((node) => node.role === "run")!;
    if (job.nodes.every((node) => node.role !== "document" || node.status === "done")) {
      // Studied notes are added to the course without a review step.
      run.status = "done";
      run.note = null;
      job.status = "done";
    }
    recount(job);
    job.updatedAt = now;
    emit({ type: "job", job: jobView(job) });
  }
}

function findJob(jobId: string): SimJob {
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error("Unknown job.");
  return job;
}

for (const job of jobs) {
  for (const node of job.nodes) if (node.status === "done") node.outcome = outcomeOf(job, node);
  recount(job);
}

const summaries = (): ChatSummary[] =>
  [...chats.values()]
    .map(({ id, kind, title, updatedAt, status, courseId }) => ({
      id,
      kind,
      title,
      updatedAt,
      status,
      courseId,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

// Folio's Trash, simulated: each entry keeps what it removed and how to put it back.
const trashed: { view: TrashEntryView; restore: () => void }[] = [];
function putInTrash(
  kind: TrashEntryView["kind"],
  title: string,
  courseId: string | null,
  restore: () => void,
  contents: TrashEntryView["contents"] = null,
): TrashEntryView {
  const view: TrashEntryView = {
    id: crypto.randomUUID(),
    kind,
    title,
    courseId,
    courseName: courses.find((course) => course.id === courseId)?.name ?? null,
    removedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    contents,
    withStudyNotes: false,
  };
  trashed.unshift({ view, restore });
  emit({ type: "trash" });
  return structuredClone(view);
}
function take<T>(list: T[], match: (item: T) => boolean): T[] {
  const taken = list.filter(match);
  for (const item of taken) list.splice(list.indexOf(item), 1);
  return taken;
}

export const previewApi: FolioApi = {
  async bootstrap() {
    return {
      connection: { connected: true, signingIn: false },
      model: { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
      subscriptions: [
        {
          provider: "openai",
          name: "ChatGPT",
          available: true,
          connected: true,
          models: [
            { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
            { id: "gpt-6-sol", name: "GPT-6 Sol" },
            { id: "gpt-6-astra", name: "GPT-6 Astra" },
            { id: "gpt-6-luna", name: "GPT-6 Luna" },
            { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
          ],
        },
        { provider: "anthropic", name: "Claude", available: false, connected: false, models: [] },
      ],
      chats: summaries(),
      unavailableChats: 0,
      platform: "darwin",
    };
  },
  async openChat(chatId) {
    const chat = chats.get(chatId);
    if (!chat) throw new Error("Unknown chat.");
    return structuredClone(chat);
  },
  async send({ chatId, text, courseId, focus, modelId, attachments = [] }: SendInput) {
    const key = chatId ?? crypto.randomUUID();
    const chat: ChatView = chats.get(key) ?? {
      id: key,
      kind: courseId ? "course" : "library",
      title: chatTitle(text),
      status: "idle",
      modelId: modelId ?? "gpt-6.1-sol",
      updatedAt: new Date().toISOString(),
      courseId: courseId ?? null,
      focus: focus ?? null,
      messages: [],
      reads: { courses: [], documents: [] },
    };
    chat.status = "running";
    const views: AttachmentView[] = attachments.map((input) =>
      input.kind === "image"
        ? {
            kind: "image",
            name: input.name,
            thumbnail: URL.createObjectURL(new Blob([input.data.slice()])),
          }
        : { ...input },
    );
    if (chat.kind === "course")
      for (const input of attachments) {
        if (input.kind === "course" && !chat.reads.courses.includes(input.courseId))
          chat.reads.courses.push(input.courseId);
        if (input.kind === "document" && !chat.reads.documents.includes(input.documentId))
          chat.reads.documents.push(input.documentId);
      }
    chat.messages.push({
      role: "user",
      text,
      state: "complete",
      ...(views.length ? { attachments: views } : {}),
    });
    chats.set(key, chat);
    // Asking for a diagram or a drawing shows one being written and then drawn.
    const reply = /diagram|draw|flow|תרשים/i.test(text)
      ? [
          "Here is how breadth-first search moves through the queue:",
          "",
          "```mermaid",
          "flowchart TD",
          "  A[Put s in the queue and mark it] --> B{Is the queue empty?}",
          "  B -->|yes| C[Done]",
          "  B -->|no| D[Take u; mark and enqueue its unmarked neighbours]",
          "  D --> B",
          "```",
          "",
          "Each vertex enters the queue once, because it is marked as it enters.",
        ].join("\n")
      : "This is the **preview bridge**. In the app, Folio reads your course pages and answers from them.";
    queueMicrotask(async () => {
      emit({
        type: "chat",
        chat: structuredClone({
          ...chat,
          messages: [
            ...chat.messages,
            { role: "assistant", text: "", state: "streaming", steps: [], sources: [] },
          ],
        }),
      });
      emit({ type: "chats", chats: summaries() });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const words = reply.split(" ");
      for (let index = 1; index <= words.length; index++) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        emit({ type: "stream", chatId: key, text: words.slice(0, index).join(" ") });
      }
      chat.messages.push({
        role: "assistant",
        text: reply,
        state: "complete",
        steps: [],
        sources: [],
      });
      chat.status = "idle";
      emit({ type: "chat", chat: structuredClone(chat) });
      emit({ type: "chats", chats: summaries() });
    });
    return { chatId: key };
  },
  async cancel() {},
  async setFocus() {},
  async signIn() {},
  async cancelSignIn() {},
  async signOut() {},
  async listCourses() {
    return structuredClone(courses);
  },
  async createCourse(input) {
    const course: CourseView = {
      id: crypto.randomUUID(),
      name: input.name ?? "Course",
      code: input.code ?? "",
      term: input.term ?? "",
      color: input.color ?? "violet",
      revision: 1,
      documents: 0,
    };
    courses.push(course);
    return course;
  },
  async updateCourse(courseId, patch) {
    const course = courses.find((candidate) => candidate.id === courseId)!;
    Object.assign(course, patch, { revision: course.revision + 1 });
    return course;
  },
  async listDocuments(courseId) {
    return structuredClone(
      documents.filter((document) => !courseId || document.courseId === courseId),
    );
  },
  async importFiles() {
    return [];
  },
  async chooseFiles() {
    return [];
  },
  async updateDocument(documentId, patch) {
    const document = documents.find((candidate) => candidate.id === documentId)!;
    Object.assign(document, patch, { revision: document.revision + 1 });
    return document;
  },
  async readDocument() {
    return syntheticPdf(SYNTHETIC_LECTURE);
  },
  async listNotes(courseId) {
    return [...notes.values()]
      .map(({ note }) => note)
      .filter((note) => !courseId || note.courseId === courseId);
  },
  async readNote(noteId) {
    const entry = notes.get(noteId);
    if (!entry) throw new Error("That note no longer exists.");
    return structuredClone(entry);
  },
  async createNote(courseId, title) {
    const note = putNote(crypto.randomUUID(), courseId, `# ${title}\n\n`);
    emit({ type: "library" });
    return note;
  },
  async saveNote(noteId, content, revision) {
    const entry = notes.get(noteId);
    if (!entry || entry.note.revision !== revision)
      throw new Error("This note changed outside this editor. Reload it before saving.");
    const note = putNote(noteId, entry.note.courseId, content);
    emit({ type: "library" });
    return note;
  },
  async appendToNote(noteId, text) {
    const entry = notes.get(noteId)!;
    const note = putNote(noteId, entry.note.courseId, `${entry.content.trimEnd()}\n\n${text}\n`);
    emit({ type: "library" });
    return note;
  },
  async listProposals() {
    return proposals.map(proposalView);
  },
  async resolveProposal(proposalId, action) {
    const proposal = proposals.find((candidate) => candidate.id === proposalId)!;
    const view = proposalView(proposal);
    const entry = proposal.noteId ? notes.get(proposal.noteId) : undefined;
    if (action === "keep" && view.stale)
      throw new Error("Your note changed after Folio drafted this edit. Nothing was changed.");
    if (action === "keep" && entry)
      putNote(
        entry.note.id,
        entry.note.courseId,
        proposal.find ? entry.content.replace(proposal.find, proposal.text) : entry.content,
      );
    if (action === "insert" && entry)
      putNote(
        entry.note.id,
        entry.note.courseId,
        `${entry.content.trimEnd()}\n\n${proposal.text}\n`,
      );
    proposal.state = action === "keep" ? "kept" : action === "insert" ? "inserted" : "discarded";
    proposal.resultNoteId = action === "discard" ? null : proposal.noteId;
    emit({ type: "library" });
    return proposalView(proposal);
  },
  async scanFolder() {
    const names = [
      ...[1, 2, 3, 4, 5, 6].map((n) => `Lectures/lec0${n}.pdf`),
      ...[1, 2, 3, 4].map((n) => `Recitations/rec0${n}.pdf`),
      ...[1, 2, 3].map((n) => `Homework/hw${n}.pdf`),
      "hw1_solution.pdf",
      "syllabus.pdf",
    ];
    const role = (name: string) =>
      /solution/.test(name)
        ? "solution"
        : /syllabus/.test(name)
          ? "asset"
          : /hw/.test(name)
            ? "assignment"
            : /rec/.test(name)
              ? "recitation"
              : "lecture";
    return {
      path: "/synthetic/Computational Models",
      folderName: "Computational Models",
      files: names.map((name) => ({
        path: `/synthetic/Computational Models/${name}`,
        name,
        title: name
          .split("/")
          .at(-1)!
          .replace(/\.pdf$/, ""),
        role: role(name) as DocumentView["role"],
        kind: "pdf" as const,
        size: 2048,
      })),
      skipped: 3,
      truncated: false,
    };
  },
  async readSyllabus() {
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return {
      path: "/synthetic/syllabus.pdf",
      fileName: "syllabus.pdf",
      name: "Data Structures",
      code: "CS 202",
      term: "Fall 2026",
      read: true,
    };
  },
  async listJobs() {
    jobTimer ??= setInterval(tick, 4000);
    return jobs.map(jobView);
  },
  async startIngest() {
    throw new Error("The preview bridge does not study documents.");
  },
  async pauseJob(jobId) {
    const job = findJob(jobId);
    if (job.status !== "running" && job.status !== "queued")
      throw new Error("Only a running job can be paused.");
    const now = new Date().toISOString();
    for (const node of job.nodes)
      if (node.status === "running") {
        node.status = "stopped";
        node.endedAt = now;
      }
    const run = job.nodes.find((node) => node.role === "run")!;
    run.note = "Paused. Finished steps are kept and never run twice.";
    job.status = "stopped";
    job.updatedAt = now;
    emit({ type: "job", job: jobView(job) });
    return jobView(job);
  },
  async resumeJob(jobId) {
    const job = findJob(jobId);
    if (job.cancelled) throw new Error("This job was cancelled. Start it again from the course.");
    if (job.status !== "stopped" && job.status !== "failed") return jobView(job);
    const now = new Date().toISOString();
    for (const node of job.nodes)
      if (node.status === "stopped") {
        // Interrupted steps restart from their checkpoint; the run and documents carry on.
        node.status = "running";
        node.endedAt = null;
        if (node.ticks) {
          node.startedAt = now;
          node.ran = 0;
        }
      }
    job.nodes.find((node) => node.role === "run")!.note = null;
    job.status = "running";
    job.updatedAt = now;
    emit({ type: "job", job: jobView(job) });
    return jobView(job);
  },
  async cancelJob(jobId) {
    const job = findJob(jobId);
    const now = new Date().toISOString();
    for (const node of job.nodes)
      if (node.status === "running" || node.status === "queued" || node.status === "waiting") {
        node.status = "stopped";
        node.endedAt = node.startedAt ? now : null;
      }
    const run = job.nodes.find((node) => node.role === "run")!;
    run.status = "stopped";
    run.note = "Cancelled. Nothing was published; finished steps are kept.";
    job.cancelled = true;
    job.status = "stopped";
    job.updatedAt = now;
    emit({ type: "job", job: jobView(job) });
    return jobView(job);
  },
  async dismissJob(jobId) {
    const at = jobs.findIndex((candidate) => candidate.id === jobId);
    if (at >= 0) jobs.splice(at, 1);
  },
  async knowledge(courseId) {
    return courseId === id(1) ? previewKnowledge(courseId) : null;
  },
  async studyNotes(courseId) {
    return courseId === id(1) ? previewStudyNotes(courseId) : null;
  },
  async rollbackKnowledge(courseId) {
    return previewKnowledge(courseId);
  },
  async trashDocuments(ids) {
    return take(documents, (document) => ids.includes(document.id)).map((document) =>
      putInTrash("document", document.title, document.courseId, () => documents.push(document)),
    );
  },
  async trashNote(noteId) {
    const entry = notes.get(noteId);
    if (!entry) throw new Error("That note is no longer in your library.");
    notes.delete(noteId);
    return putInTrash("note", entry.note.title, entry.note.courseId, () =>
      notes.set(noteId, entry),
    );
  },
  async trashChat(chatId) {
    const chat = chats.get(chatId);
    if (!chat) throw new Error("Unknown chat.");
    if (chat.status === "running")
      throw new Error("Folio is still replying in that chat. Stop the reply first.");
    chats.delete(chatId);
    emit({ type: "chats", chats: summaries() });
    return putInTrash("chat", chat.title, chat.courseId, () => {
      chats.set(chatId, chat);
      emit({ type: "chats", chats: summaries() });
    });
  },
  async trashCourse(courseId) {
    const [course] = take(courses, (item) => item.id === courseId);
    if (!course) throw new Error("That course is no longer in your library.");
    const files = take(documents, (document) => document.courseId === courseId);
    const own = [...notes].filter(([, entry]) => entry.note.courseId === courseId);
    for (const [noteId] of own) notes.delete(noteId);
    const talks = [...chats].filter(([, chat]) => chat.courseId === courseId);
    for (const [chatId] of talks) chats.delete(chatId);
    emit({ type: "chats", chats: summaries() });
    return putInTrash(
      "course",
      course.name,
      courseId,
      () => {
        courses.push(course);
        documents.push(...files);
        for (const [noteId, entry] of own) notes.set(noteId, entry);
        for (const [chatId, chat] of talks) chats.set(chatId, chat);
        emit({ type: "chats", chats: summaries() });
      },
      { documents: files.length, notes: own.length, chats: talks.length },
    );
  },
  async listTrash() {
    return trashed.map((item) => structuredClone(item.view));
  },
  async restoreFromTrash(entryId) {
    const [item] = take(trashed, (candidate) => candidate.view.id === entryId);
    if (!item) throw new Error("That is no longer in the Trash.");
    if (item.view.kind !== "course" && item.view.courseId)
      if (!courses.some((course) => course.id === item.view.courseId)) {
        trashed.unshift(item);
        throw new Error(
          `${item.view.courseName ?? "Its course"} is in the Trash too. Restore the course first.`,
        );
      }
    item.restore();
    emit({ type: "library" });
    emit({ type: "trash" });
  },
  async deleteFromTrash(entryId) {
    take(trashed, (candidate) => candidate.view.id === entryId);
    emit({ type: "trash" });
  },
  async emptyTrash() {
    trashed.length = 0;
    emit({ type: "trash" });
  },
  async saveFile() {
    return false;
  },
  async loadWorkspace() {
    return null;
  },
  async saveWorkspace() {},
  pathForFile: () => "",
  onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
