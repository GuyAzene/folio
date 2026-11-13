// Development-only stand-in for the Electron bridge, so the renderer can be previewed in a
// plain browser. Synthetic courses and PDFs only; it never talks to a model and is not built.
import type {
  AssignmentView,
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
  ModelsView,
  ModelView,
  NoteView,
  PageCoverageView,
  ProposalView,
  ReleaseView,
  SendInput,
  UpdateView,
  ApprovalDecision,
  ApprovalView,
  McpServerView,
  McpView,
  SkillsView,
  SkillView,
  StudyNotesView,
  TrashEntryView,
  VisualView,
} from "../../src/desktop/api.ts";
import { chatTitle } from "../../src/chat-title.ts";
import { patchAssignment } from "../../src/library/assignments.ts";
import {
  categoriesInUse,
  categoriesProblem,
  categoryFor,
  categoryOf,
  DEFAULT_CATEGORIES,
  guessCategory,
  type Category,
} from "../../src/library/categories.ts";
import {
  applyPattern,
  uniqueTitle,
  type NamingScope,
  type Rename,
} from "../../src/library/naming.ts";
import {
  linkFirstMention,
  matchNote,
  mentionsOf,
  noteFacts,
  noteTitle,
} from "../../src/library/note-meta.ts";
import { FINITE_AUTOMATA, GRAPH_TRAVERSAL } from "../../tests/fixtures/showcase-slides.ts";
import { SYNTHETIC_LECTURE, syntheticPdf } from "../../tests/fixtures/synthetic-pdf.ts";
import { syntheticSlides } from "../../tests/fixtures/synthetic-slides.ts";

/** A synthetic drawing for the preview's fake visual reply. */
const PREVIEW_DRAWING = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 90">',
  "<title>The queue after two steps</title>",
  "<style>rect{fill:var(--folio-surface);stroke:var(--folio-line)}text{fill:var(--folio-text);font:14px var(--folio-font)}.new{stroke:var(--folio-accent)}</style>",
  '<rect x="10" y="30" width="60" height="36" rx="6"/><text x="40" y="53" text-anchor="middle">b</text>',
  '<rect x="80" y="30" width="60" height="36" rx="6"/><text x="110" y="53" text-anchor="middle">c</text>',
  '<rect class="new" x="150" y="30" width="60" height="36" rx="6"/><text x="180" y="53" text-anchor="middle">d</text>',
  '<text x="10" y="20">front</text>',
  "</svg>",
].join("");

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
    pages: GRAPH_TRAVERSAL.length,
    size: 2048,
    dueAt: null,
    category: null,
    number: 1,
    named: "own",
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
    category: null,
    number: 1,
    named: "own",
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
    category: null,
    number: 1,
    named: "own",
    importedAt: ago(20),
    revision: 1,
  },
  {
    id: id(21),
    courseId: id(2),
    title: "Lecture 1 Finite automata",
    role: "lecture",
    kind: "pdf",
    pages: FINITE_AUTOMATA.length,
    size: 2048,
    dueAt: null,
    category: null,
    number: 1,
    named: "own",
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
    category: null,
    number: 2,
    named: "own",
    importedAt: ago(8),
    revision: 1,
  },
];
/**
 * The tutor on why the automaton's start state accepts: the saved chat beside Lecture 1 Finite
 * automata, and the preview's answer when asked about the start state again, as in the README's
 * clip.
 */
const START_STATE_ANSWER = [
  "Because it accepts the words with an **even number of 1s**, and before reading anything it has seen none. Zero is even, so the empty word is accepted:",
  "",
  "$$",
  "\\delta^*(\\textsf{even}, \\varepsilon) = \\textsf{even} \\in F",
  "$$",
  "",
  "```mermaid",
  "stateDiagram-v2",
  "  direction LR",
  "  [*] --> even",
  "  even --> odd: 1",
  "  odd --> even: 1",
  "  even --> even: 0",
  "  odd --> odd: 0",
  "```",
  "",
  "So `1011` ends in odd and is rejected.",
].join("\n");
const START_STATE_STEP = {
  label: "Read Lecture 1 Finite automata, pages 3 and 4",
  state: "done" as const,
};
const START_STATE_SOURCES = [3, 4].map((page) => ({
  documentId: id(21),
  title: "Lecture 1 Finite automata",
  page,
}));

const chats = new Map<string, ChatView>([
  [
    id(31),
    {
      id: id(31),
      kind: "course",
      title: "Why BFS marks vertices on enqueue",
      status: "idle",
      model: "chatgpt/gpt-6.1-sol",
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
          webSources: [
            { url: "https://example.org/bfs", title: "Breadth-first search, explained" },
            { url: "https://example.com/queues", title: "Queues and visited sets" },
          ],
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
      model: "chatgpt/gpt-6.1-sol",
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
  [
    id(33),
    {
      id: id(33),
      kind: "course",
      title: "A topic map for week 1",
      status: "idle",
      model: "chatgpt/gpt-6.1-sol",
      updatedAt: ago(0.5),
      courseId: id(1),
      focus: null,
      reads: { courses: [], documents: [] },
      messages: [
        {
          role: "user",
          text: "I missed week 1. Can you plan a topic map for it, and we'll tackle each topic?",
          state: "complete",
        },
        {
          role: "assistant",
          text: [
            "Week 1 has four topics, each building on the one before:",
            "",
            "1. **Graphs and how to store them**: adjacency lists and matrices.",
            "2. **Breadth-first search**: layers, the queue, and why each vertex enters it once.",
            "3. **Depth-first search**: discovery and finish times.",
            "4. **Using the traversals**: connected components and shortest paths by edge count.",
            "",
            "Shall we start with the first?",
          ].join("\n"),
          state: "complete",
          steps: [
            { label: "Searched the course", state: "done" },
            { label: "Read Lecture 1 Graph traversal, 12 pages", state: "done" },
            { label: "Read Recitation 1 BFS examples, 9 pages", state: "done" },
            { label: "Read Lecture 1 Graph traversal, 8 pages", state: "done" },
          ],
          // In the order the tutor read them, as a long reply's sources arrive. The page
          // numbers are the course's own; the preview PDFs stay 3 pages.
          sources: (
            [
              [id(11), "Lecture 1 Graph traversal", [4, 6, 9, 10, 12, 11, 19, 20, 21, 22, 36, 35]],
              [id(12), "Recitation 1 BFS examples", [28, 10, 12, 8, 9, 11]],
              [id(11), "Lecture 1 Graph traversal", [45, 46, 50, 51, 52, 53, 49]],
              [id(12), "Recitation 1 BFS examples", [17, 18, 19]],
              [id(11), "Lecture 1 Graph traversal", [57]],
            ] as const
          ).flatMap(([documentId, title, pages]) =>
            pages.map((page) => ({ documentId, title, page })),
          ),
        },
      ],
    },
  ],
  [
    id(34),
    {
      id: id(34),
      kind: "course",
      title: "Why the start state is accepting",
      status: "idle",
      model: "chatgpt/gpt-6.1-sol",
      updatedAt: ago(0.2),
      courseId: id(2),
      focus: { documentId: id(21), page: 3 },
      reads: { courses: [], documents: [] },
      messages: [
        { role: "user", text: "Why is the start state also accepting here?", state: "complete" },
        {
          role: "assistant",
          text: START_STATE_ANSWER,
          state: "complete",
          steps: [{ ...START_STATE_STEP }],
          sources: START_STATE_SOURCES,
        },
      ],
    },
  ],
]);

const notes = new Map<string, { note: NoteView; content: string }>();

/** Synthetic assignments: one from a handed-out PDF, a reading, and finished work with a grade. */
function assignment(n: number, title: string, more: Partial<AssignmentView> = {}): AssignmentView {
  return {
    id: id(n),
    courseId: id(1),
    title,
    kind: "problem_set",
    status: "todo",
    dueAt: null,
    dueHasTime: false,
    originalDueAt: null,
    excused: false,
    documents: { statement: null, solution: null },
    steps: [],
    topics: [],
    attempts: [],
    grade: { score: null, max: null, text: "" },
    feedback: { text: "", files: [] },
    reflection: "",
    finishedAt: null,
    createdAt: ago(200),
    updatedAt: ago(1),
    revision: 1,
    ...more,
  };
}
const assignments = new Map<string, AssignmentView>(
  [
    assignment(81, "Assignment 1", {
      dueAt: ago(-60),
      documents: { statement: id(13), solution: null },
      status: "doing",
      steps: [
        { id: id(91), text: "Question 1: BFS on the given graph", done: true },
        { id: id(92), text: "Question 2: prove the running time", done: false },
      ],
    }),
    assignment(82, "Read chapter 22 before the recitation", { kind: "reading", dueAt: ago(-20) }),
    assignment(83, "Quiz 1", {
      kind: "quiz",
      status: "done",
      dueAt: ago(120),
      finishedAt: ago(96),
      attempts: [
        {
          id: id(93),
          submittedAt: ago(121),
          files: [
            {
              id: id(94),
              name: "quiz1.pdf",
              size: 120_000,
              sha256: "0".repeat(64),
              addedAt: ago(121),
            },
          ],
          note: "",
        },
      ],
      grade: { score: 88, max: 100, text: "" },
    }),
    // Computational Models' coursework, so each column of the board has some.
    assignment(84, "Problem set 1: DFAs and their languages", {
      courseId: id(2),
      status: "doing",
      dueAt: ago(-50),
      steps: [
        { id: id(121), text: "Question 1: a DFA for even numbers of 1s", done: true },
        { id: id(122), text: "Question 2: the product construction", done: true },
        { id: id(123), text: "Question 3: prove the language is regular", done: false },
      ],
    }),
    assignment(85, "Read the notes on nondeterminism", {
      courseId: id(2),
      kind: "reading",
      dueAt: ago(-30),
    }),
    assignment(86, "Prepare for the midterm", {
      courseId: id(2),
      kind: "exam_prep",
      dueAt: ago(-24 * 12),
    }),
    assignment(87, "Lab 1: a DFA simulator", {
      courseId: id(2),
      kind: "lab",
      status: "submitted",
      dueAt: ago(10),
      attempts: [
        {
          id: id(124),
          submittedAt: ago(14),
          files: [
            {
              id: id(125),
              name: "dfa.py",
              size: 3_200,
              sha256: "0".repeat(64),
              addedAt: ago(14),
            },
          ],
          note: "",
        },
      ],
    }),
    assignment(88, "Quiz 0: sets and strings", {
      courseId: id(2),
      kind: "quiz",
      status: "done",
      dueAt: ago(200),
      finishedAt: ago(190),
      grade: { score: 9, max: 10, text: "" },
    }),
  ].map((item) => [item.id, item]),
);
/** Each note's earlier versions in the preview, newest first. */
const noteVersions = new Map<string, { revision: string; at: string; content: string }[]>();
function putNote(noteId: string, courseId: string, content: string): NoteView {
  const previous = notes.get(noteId)?.note.revision ?? "0";
  const note: NoteView = {
    id: noteId,
    courseId,
    title: noteTitle(content),
    revision: String(Number(previous) + 1),
    updatedAt: new Date().toISOString(),
    ...noteFacts(content),
  };
  notes.set(noteId, { note, content });
  return note;
}
putNote(
  id(51),
  id(1),
  "# Graph traversal\n\nBFS visits vertices in layers.\nEach vertex is marked when it is dequeued.\n\n#graphs #exam\n",
);
putNote(
  id(53),
  id(1),
  "# Shortest paths\n\nDijkstra extends [[Graph traversal]] with a priority queue keyed by distance. Negative edges break it; use Bellman-Ford.\n\n#graphs\n",
);
putNote(
  id(54),
  id(1),
  "# Exam review\n\n## Week 1\n\nRedo the graph traversal questions from the recitation and time each one.\n\n## Week 2\n\n- [ ] Dijkstra by hand\n- [ ] Proofs of correctness\n\n#exam\n",
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
// What a student's own note looks like, for the README's notebook picture.
putNote(
  id(55),
  id(2),
  [
    "# Regular languages",
    "",
    "A language is **regular** if some DFA recognizes it. The definitions are in [[אוטומטים סופיים]].",
    "",
    "## Closure",
    "",
    "If $A$ and $B$ are regular, so are $A \\cup B$, $A \\cap B$ and $\\overline{A}$. For the first two, run both machines at once on pairs of states:",
    "",
    "$$",
    "\\delta\\big((p, q), a\\big) = \\big(\\delta_A(p, a),\\ \\delta_B(q, a)\\big)",
    "$$",
    "",
    "The complement swaps the accepting states: $F' = Q \\setminus F$.",
    "",
    "שפות רגולריות סגורות לאיחוד, לחיתוך ולמשלים.",
    "",
    "- [x] Product construction",
    "- [x] Complement",
    "- [ ] Pumping lemma for $\\{a^n b^n \\mid n \\ge 0\\}$",
    "",
    "#automata #exam",
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
    // One writer per topic, each starting once its own pages are read.
    agent(
      "a-L-w1",
      "a-L",
      "author",
      "Topic · Breadth-first search",
      "Write Breadth-first search from pages 1–5",
      SOL,
      "queued",
      {
        after: ["a-L-r2", "a-L-e5"],
        ticks: 3,
        final: [1, 31_200, 5_400],
        pages: [1, 2, 3, 4, 5],
      },
    ),
    agent(
      "a-L-w2",
      "a-L",
      "author",
      "Topic · Shortest paths",
      "Write Shortest paths from pages 6–9",
      SOL,
      "queued",
      {
        after: ["a-L-r3", "a-L-e8"],
        ticks: 3,
        final: [1, 28_900, 4_800],
        pages: [6, 7, 8, 9],
      },
    ),
    agent(
      "a-L-w3",
      "a-L",
      "author",
      "Topic · Graph representations",
      "Write Graph representations from pages 10–12",
      SOL,
      "queued",
      {
        after: ["a-L-r4", "a-L-e11"],
        ticks: 3,
        final: [1, 24_100, 4_100],
        pages: [10, 11, 12],
      },
    ),
    agent(
      "a-L-review",
      "a-L",
      "reviewer",
      "Review",
      "Check each claim against only its cited region crop",
      SOL6,
      "queued",
      { after: ["a-L-w1", "a-L-w2", "a-L-w3"], ticks: 3, final: [3, 41_200, 5_160] },
    ),
    agent("a-L-fix", "a-L", "fix", "Fix · round 1", "Fix 2 things the check found", SOL, "queued", {
      after: ["a-L-review"],
      ticks: 2,
      final: [1, 18_400, 2_900],
      pages: [7, 9],
    }),
    agent(
      "a-L-recheck",
      "a-L",
      "recheck",
      "Page 7",
      "Check 1 corrected claim on page 7",
      SOL6,
      "queued",
      { after: ["a-L-fix"], ticks: 1, final: [1, 6_100, 420], pages: [7] },
    ),
    agent(
      "a-L-ledger",
      "a-L",
      "ledger",
      "Coverage ledger",
      "Checked every part of every slide",
      null,
      "queued",
      { after: ["a-L-recheck"], ticks: 1, doc: L },
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
      { after: ["a-R-r3", "a-R-e7", "a-L-w1"], ticks: 3, final: [4, 61_900, 9_400] },
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
      "Checked every part of every slide",
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
    origin: "upload",
    waitingFor: null,
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
        note: "Notes written; one diagram described from the slide.",
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
    origin: "upload",
    waitingFor: null,
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
    origin: "upload",
    waitingFor: null,
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

/** Synthetic study notes for Algorithms: Hebrew and English, math and citations. */
function previewStudyNotes(courseId: string): StudyNotesView {
  const section = (
    handle: string,
    title: string,
    body: string,
    pages: number[],
    session = "alg-L01",
    questions: string[] = [],
    kind = "explanation",
  ) => ({
    handle,
    title,
    kind,
    body,
    session,
    documentId: session === "alg-L01" ? id(11) : id(12),
    pages,
    questions,
    alsoIn: [] as StudyNotesView["topics"][number]["sections"][number]["alsoIn"],
  });
  return sharedTopics({
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
        topics: [],
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
        topics: [],
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
            "BFS runs in $O(V + E)$: every vertex is dequeued once, and every edge is looked at a constant number of times.",
            [2, 3],
            "alg-L01",
            [],
            "theorem",
          ),
          section(
            "alg-bfs-queue-trace",
            "Tracing the queue",
            "The recitation traces the queue on a six-vertex graph: after $s$, its two neighbours enter together, then their neighbours, so the queue always holds at most two layers.",
            [2],
            "alg-R01",
            [],
            "example",
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
  });
}

/**
 * The preview's notes with what the app derives from blocks: where each topic is taught, each
 * session's slide-order outline and what only it teaches, and an overview of a shared topic.
 */
function sharedTopics(
  notes: Omit<StudyNotesView, "sessions" | "topics"> & {
    sessions: Omit<StudyNotesView["sessions"][number], "outline" | "onlyHere" | "notation">[];
    topics: Omit<StudyNotesView["topics"][number], "overview" | "taughtIn" | "related">[];
  },
): StudyNotesView {
  const sessions = new Map(notes.sessions.map((session) => [session.slug, session]));
  const topics = notes.topics.map((topic) => {
    const taught = [...new Set(topic.sections.map((section) => section.session))];
    return {
      ...topic,
      overview:
        taught.length > 1
          ? {
              text: "Breadth-first search explores a graph layer by layer from $s$. The lecture gives the rule and its running time; the recitation traces the queue on an example.",
              handles: topic.sections.map((section) => section.handle),
            }
          : null,
      taughtIn: taught.map((slug) => ({
        session: slug,
        documentId: sessions.get(slug)!.documentId,
        type: sessions.get(slug)!.type,
      })),
      related: [],
    };
  });
  return {
    ...notes,
    topics,
    sessions: notes.sessions.map((session) => {
      const outline = topics.flatMap((topic) => {
        const pages = topic.sections
          .filter((section) => section.session === session.slug)
          .flatMap((section) => section.pages);
        return pages.length
          ? [{ topic: topic.slug, pages: [...new Set(pages)].sort((a, b) => a - b) }]
          : [];
      });
      return {
        ...session,
        topics: outline.map((row) => row.topic),
        outline,
        onlyHere: topics
          .filter(
            (topic) => topic.taughtIn.length === 1 && topic.taughtIn[0]!.session === session.slug,
          )
          .map((topic) => topic.slug),
        notation:
          session.slug === "alg-L01"
            ? [
                { symbol: "$d(s, v)$", meaning: "the distance from $s$ to $v$" },
                { symbol: "$\\pi(v)$", meaning: "the vertex that discovered $v$" },
              ]
            : [],
      };
    }),
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
    origin: job.origin,
    waitingFor: job.waitingFor,
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
  if (node.role === "author")
    return node.title.startsWith("Topic · ")
      ? { topics: 1, sections: 5 }
      : { topics: 6, sections: 14 };
  if (node.role === "brief")
    return job.nodes.some(
      (item) => item.parentId === node.parentId && item.title.startsWith("Topic · "),
    )
      ? { topics: 3 }
      : null;
  if (node.role === "reviewer") {
    const fixing = job.nodes.some((item) => item.role === "fix" && item.parentId === node.parentId);
    return { claims: 24, disagreements: 1, regions: 96, ...(fixing ? { discrepancies: 2 } : {}) };
  }
  if (node.role === "fix") return { discrepancies: 2, fixed: 2 };
  if (node.role !== "document") return null;
  const fixing = job.nodes.some((item) => item.role === "fix" && item.parentId === node.id);
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
    ...(fixing ? { discrepancies: 2, fixed: 2 } : {}),
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
    .map(({ id, kind, title, updatedAt, status, courseId, focus }) => ({
      id,
      kind,
      title,
      updatedAt,
      status,
      courseId,
      focus,
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

// ── Connections and models: ChatGPT and an OpenRouter key, synthetic ─────

/**
 * The preview's Folio is a release behind and can update itself, so the sidebar's line and
 * Settings show one. Update downloads it over a few seconds; Restart starts over.
 */
let previewUpdates = true;
let previewUpdate: UpdateView = { step: "available" };
let previewDownload: ReturnType<typeof setInterval> | undefined;
function previewRelease(): ReleaseView {
  return {
    version: "0.1.0",
    on: previewUpdates,
    newer: previewUpdates
      ? { version: "0.2.0", url: "https://github.com/GuyAzene/folio/releases/latest" }
      : null,
    update: previewUpdates ? previewUpdate : null,
  };
}
function setPreviewUpdate(update: UpdateView): void {
  previewUpdate = update;
  emit({ type: "release", release: previewRelease() });
}

const previewConnected = new Set(["chatgpt", "openrouter"]);
const previewRoles: ModelsView["roles"] = {
  teaching: "chatgpt/gpt-6.1-sol",
  research: "chatgpt/gpt-6.1-terra",
  planner: "chatgpt/gpt-6-sol",
  reader: "chatgpt/gpt-6.1-sol",
  closeup: "chatgpt/gpt-6.1-sol",
  writer: "openrouter/deepseek/deepseek-v4-pro",
  checker: "chatgpt/gpt-6-sol",
  rechecker: "chatgpt/gpt-6.1-terra",
  topics: "chatgpt/gpt-6.1-terra",
  syllabus: "chatgpt/gpt-6.1-sol",
};
const OPENROUTER_CATALOG: ModelView[] = [
  ["anthropic/claude-opus-5.5", "Claude Opus 5.5", "Anthropic", true],
  ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", "Anthropic", true],
  ["anthropic/claude-haiku-5.5", "Claude Haiku 5.5", "Anthropic", true],
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro 0423", "DeepSeek", false],
  ["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "DeepSeek", true],
  ["google/gemini-4-argon", "Gemini 4 Argon", "Google", true],
  ["google/gemini-3.8-flash", "Gemini 3.8 Flash", "Google", true],
  ["moonshotai/kimi-k3", "Kimi K3", "MoonshotAI", true],
  ["openai/gpt-6.1-sol", "GPT-6.1 Sol", "OpenAI", true],
  ["qwen/qwen3.5-max", "Qwen3.5 Max", "Qwen", true],
].map(([id, name, lab, images]) => ({
  ref: `openrouter/${id}`,
  name: name as string,
  lab: lab as string,
  images: images as boolean,
}));
let previewOpenRouter = [
  "anthropic/claude-sonnet-5.5",
  "deepseek/deepseek-v4-pro",
  "moonshotai/kimi-k3",
];
const PREVIEW_GROUPS: {
  connection: string;
  name: string;
  kind: "plan" | "key";
  models: ModelView[];
}[] = [
  {
    connection: "chatgpt",
    name: "ChatGPT",
    kind: "plan",
    models: [
      { ref: "chatgpt/gpt-6.1-sol", name: "GPT-6.1 Sol", images: true },
      { ref: "chatgpt/gpt-6.1-terra", name: "GPT-6.1 Terra", images: true },
      { ref: "chatgpt/gpt-6-astra", name: "GPT-6 Astra", images: true },
      { ref: "chatgpt/gpt-6-luna", name: "GPT-6 Luna", images: true },
      { ref: "chatgpt/gpt-6-sol", name: "GPT-6 Sol", images: true, older: true },
      { ref: "chatgpt/gpt-5.6-sol", name: "GPT-5.6 Sol", images: true, older: true },
    ],
  },
  {
    connection: "openai",
    name: "OpenAI",
    kind: "key",
    models: [
      { ref: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", images: true },
      { ref: "openai/gpt-6-astra", name: "GPT-6 Astra", images: true },
      { ref: "openai/gpt-6-luna", name: "GPT-6 Luna", images: true },
    ],
  },
  {
    connection: "anthropic",
    name: "Anthropic",
    kind: "key",
    models: [
      { ref: "anthropic/claude-fable-5-1", name: "Claude Fable 5.1", images: true },
      { ref: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", images: true },
      { ref: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", images: true },
      { ref: "anthropic/claude-haiku-5-5", name: "Claude Haiku 5.5", images: true },
    ],
  },
  {
    connection: "google",
    name: "Google Gemini",
    kind: "key",
    models: [
      { ref: "google/gemini-4-argon", name: "Gemini 4 Argon", images: true },
      { ref: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", images: true },
    ],
  },
  { connection: "openrouter", name: "OpenRouter", kind: "key", models: [] },
];

/** Synthetic routines: two of Folio's own, and two in a folder the student added, which start off. */
const previewSkills: (SkillView & { body: string })[] = [
  {
    key: "~/.folio/skills/quiz-me",
    name: "quiz-me",
    description:
      "Quiz the student one question at a time on the material they name, waiting for each answer before the next.",
    source: "folio",
    from: "Folio",
    on: true,
    model: true,
    user: true,
    body: "Ask one question at a time. Wait for the answer, then say what was right and what was missing before the next question.",
  },
  {
    key: "~/.folio/skills/exam-prep",
    name: "exam-prep",
    description: "Plan a week of exam preparation from the course's lectures and past homework.",
    source: "folio",
    from: "Folio",
    on: true,
    model: false,
    user: true,
    body: "List the course's topics, ask which ones feel weakest, then plan seven days.",
  },
  {
    key: "~/Study/routines/feynman",
    name: "feynman",
    description: "Explain a concept in plain words, then find the gaps by teaching it back.",
    source: "folder",
    from: "~/Study/routines",
    on: false,
    model: true,
    user: true,
    body: "Explain it simply, then ask the student to teach it back.",
  },
  {
    key: "~/Study/routines/pdf",
    name: "pdf",
    description: "Fill, merge and split PDF files with Python scripts.",
    source: "folder",
    from: "~/Study/routines",
    on: false,
    model: true,
    user: true,
    allowedTools: "Bash(python:*) Read",
    body: "Run scripts/fill.py with the form's fields.",
  },
];
let previewSkillFolders: string[] = ["~/Study/routines"];
const skillRevision = (skill: { body: string; description: string }) =>
  `${skill.description.length}-${skill.body.length}-${skill.body.slice(0, 8)}`;
const skillFile = (skill: { name: string; description: string; body: string }) =>
  `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`;
function previewSkillsView(): SkillsView {
  return {
    skills: previewSkills
      .filter((skill) => skill.source === "folio" || previewSkillFolders.includes(skill.from))
      .map(({ body: _body, ...skill }) => structuredClone(skill)),
    skipped: previewSkillFolders.includes("~/Study/routines")
      ? [
          {
            key: "~/Study/routines/scratch",
            from: "~/Study/routines",
            reason: "it has no description",
          },
        ]
      : [],
    folders: [...previewSkillFolders],
    folder: "~/.folio/skills",
  };
}

/** Synthetic services: a local Moodle server that is running, a Piazza one that is off, and one that failed. */
const previewServers: McpServerView[] = [
  {
    id: "moodle",
    label: "Moodle",
    kind: "local",
    command: "moodle-mcp",
    args: [],
    cwd: null,
    env: ["MOODLE_URL", "MOODLE_TOKEN"],
    headers: [],
    enabled: true,
    approval: "ask",
    status: "ready",
    error: null,
    log: "",
    instructions: "Read-only access to a student's Moodle.",
    prompts: [
      {
        name: "weekly_briefing",
        title: null,
        description: "What is due, new, or needs action across your current courses.",
        arguments: [],
      },
      {
        name: "exam_prep",
        title: null,
        description: "A study plan from the course's slides and your past quiz mistakes.",
        arguments: [
          { name: "course", description: "The course.", required: true },
          { name: "topic", description: "One topic, if any.", required: false },
        ],
      },
    ],
    tools: [
      ["list_courses", "Courses by semester, with grades."],
      ["get_deadlines", "Upcoming to-dos and submission status."],
      ["get_announcements", "Announcement posts, newest first."],
      ["read_file", "Text of a course file (PDF, slides, documents)."],
      ["download_files", "Copies a course's files to a folder on this Mac."],
    ].map(([name, description]) => ({
      name: name!,
      title: null,
      description: description!,
      rule: name === "download_files" ? "off" : name === "list_courses" ? "allow" : "ask",
      hints: name === "download_files" ? { readOnly: false } : { readOnly: true },
    })),
    argWarning: false,
  },
  {
    id: "piazza",
    label: "Piazza",
    kind: "local",
    command: "/Users/student/piazza-mcp/.venv/bin/python",
    args: ["/Users/student/piazza-mcp/main.py"],
    cwd: null,
    env: ["PIAZZA_EMAIL", "PIAZZA_PASSWORD", "PIAZZA_COURSES"],
    headers: [],
    enabled: false,
    approval: "ask",
    status: "off",
    error: null,
    log: "",
    instructions: null,
    tools: [],
    prompts: [],
    argWarning: false,
  },
  {
    id: "campus",
    label: "Campus",
    kind: "local",
    command: "campus-mcp",
    args: ["--serve"],
    cwd: null,
    env: [],
    headers: [],
    enabled: true,
    approval: "ask",
    status: "failed",
    error:
      'Folio can\'t find the program "campus-mcp". Write its full path, or install it first (for a uv tool: uv tool install).',
    log: "",
    instructions: null,
    tools: [],
    prompts: [],
    argWarning: false,
  },
];
let previewApprovals: ApprovalView[] = [];
const approvalWaiters = new Map<string, (decision: ApprovalDecision) => void>();
const previewMcp = (): McpView => ({ servers: structuredClone(previewServers), problems: [] });
const previewServer = (id: string) => {
  const server = previewServers.find((candidate) => candidate.id === id);
  if (!server) throw new Error("That server is no longer in mcp.json.");
  return server;
};

let previewCategories: Category[] = structuredClone([...DEFAULT_CATEGORIES]);
let previewNaming: string | null = null;

/** The preview's pattern renames: what the main process works out, without its library. */
function previewRenames(scope: NamingScope): Rename[] {
  const renames: Rename[] = [];
  for (const document of documents) {
    const category = categoryOf(document, previewCategories);
    const pattern = category.naming ?? previewNaming;
    const course = courses.find((each) => each.id === document.courseId);
    if (
      !pattern ||
      !course ||
      (scope.courseId && document.courseId !== scope.courseId) ||
      (scope.categoryId && category.id !== scope.categoryId) ||
      (scope.documentIds && !scope.documentIds.includes(document.id))
    )
      continue;
    const taken = documents
      .filter((other) => other.courseId === document.courseId && other.id !== document.id)
      .map(
        (other) => renames.find((rename) => rename.documentId === other.id)?.next ?? other.title,
      );
    const next = uniqueTitle(
      applyPattern(pattern, {
        category: category.name,
        course: course.name,
        code: course.code,
        term: course.term,
        number: document.number,
        name: document.title,
      }),
      taken,
    );
    if (next !== document.title || document.named !== "pattern")
      renames.push({
        documentId: document.id,
        courseId: document.courseId,
        title: document.title,
        named: document.named,
        next,
      });
  }
  return renames;
}

function previewFollow(): void {
  for (const rename of previewRenames({}))
    if (rename.named === "pattern")
      Object.assign(
        documents.find((document) => document.id === rename.documentId)!,
        {
          title: rename.next,
        },
      );
}

function previewModels(): ModelsView {
  return {
    connections: PREVIEW_GROUPS.map((group) => ({
      id: group.connection,
      name: group.name,
      kind: group.kind,
      connected: previewConnected.has(group.connection),
      signingIn: false,
    })),
    groups: PREVIEW_GROUPS.map((group) => ({
      connection: group.connection,
      name: group.name,
      connected: previewConnected.has(group.connection),
      models:
        group.connection === "openrouter"
          ? previewOpenRouter.flatMap(
              (id) => OPENROUTER_CATALOG.find((model) => model.ref === `openrouter/${id}`) ?? [],
            )
          : group.models,
    })),
    roles: { ...previewRoles },
    problems: [],
    openrouter: [...previewOpenRouter],
    categories: structuredClone(previewCategories),
    naming: previewNaming,
  };
}

export const previewApi: FolioApi = {
  async bootstrap() {
    return {
      models: previewModels(),
      chats: summaries(),
      unavailableChats: 0,
      // ?platform=win32 shows the layout Folio has elsewhere than on a Mac.
      platform: new URLSearchParams(location.search).get("platform") ?? "darwin",
    };
  },
  async openChat(chatId) {
    const chat = chats.get(chatId);
    if (!chat) throw new Error("Unknown chat.");
    return structuredClone(chat);
  },
  async send({ chatId, text, courseId, focus, model, attachments = [], command }: SendInput) {
    const routine =
      command?.kind === "skill"
        ? previewSkills.find((skill) => skill.name === command.name && skill.on)
        : undefined;
    if (command?.kind === "skill" && !routine)
      throw new Error(`There is no routine "${command.name}" turned on.`);
    const served =
      command?.kind === "prompt"
        ? previewServers
            .find((server) => server.id === command.server && server.status === "ready")
            ?.prompts.find((prompt) => prompt.name === command.name)
        : undefined;
    if (command?.kind === "prompt") {
      if (!served) throw new Error("That service is off. Turn it on in Settings.");
      const missing = served.arguments.filter(
        (argument) => argument.required && !command.args[argument.name],
      );
      if (missing.length)
        throw new Error(`Fill in ${missing.map((argument) => argument.name).join(" and ")} first.`);
    }
    const key = chatId ?? crypto.randomUUID();
    const chat: ChatView = chats.get(key) ?? {
      id: key,
      kind: courseId ? "course" : "library",
      title: chatTitle(
        command
          ? text.trimStart().replace(/^\/\S+\s*/, "") ||
              (command.kind === "prompt" ? `${command.server} ${command.name}` : command.name)
          : text,
      ),
      status: "idle",
      model: model ?? previewRoles.teaching,
      updatedAt: new Date().toISOString(),
      courseId: courseId ?? null,
      focus: focus ?? null,
      messages: [],
      reads: { courses: [], documents: [] },
    };
    chat.status = "running";
    // As in Folio, a course chat remembers the page it was asked from, and keeps it otherwise.
    if (chat.kind === "course" && focus) chat.focus = focus;
    const views: AttachmentView[] = attachments.map((input): AttachmentView => {
      if (input.kind === "image")
        return {
          kind: "image",
          name: input.name,
          thumbnail: URL.createObjectURL(new Blob([input.data.slice()])),
        };
      if (input.kind === "file")
        return { kind: "file", name: input.path.split("/").at(-1)!, pages: null };
      return { ...input };
    });
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
      ...(command
        ? {
            command:
              command.kind === "prompt"
                ? { ...command, label: previewServer(command.server).label }
                : command,
          }
        : {}),
    });
    chats.set(key, chat);
    // Asking for a diagram or a drawing shows one being written and then drawn.
    const startState = /start state|accepting/i.test(text);
    const reply = startState
      ? START_STATE_ANSWER
      : /diagram|draw|flow|תרשים/i.test(text)
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
        : /visual|demo|הדגמה/i.test(text)
          ? "Here is the queue as it changes, and a demo you can step through:"
          : routine
            ? `Following your routine **${routine.name}**. First question: what does breadth-first search keep in its queue?`
            : command?.kind === "prompt"
              ? `Here is a week of exam preparation for **${command.args.course ?? "your course"}**${command.args.topic ? `, starting with ${command.args.topic}` : ""}.`
              : "This is the **preview bridge**. In the app, Folio reads your course pages and answers from them.";
    // Asking for a visual shows a drawing written piece by piece, then a demo's card.
    const visuals: VisualView[] = /visual|demo|הדגמה/i.test(text)
      ? [
          {
            id: "preview-drawing",
            kind: "svg",
            title: "The queue after two steps",
            source: PREVIEW_DRAWING,
            state: "ready",
            at: reply.length,
          },
          {
            id: "preview-demo",
            kind: "html",
            title: "Step through breadth-first search",
            source: "<title>Step through breadth-first search</title><button>Next</button>",
            state: "ready",
            at: reply.length,
          },
        ]
      : [];
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
      // A question about Moodle uses the synthetic Moodle server, asking first unless allowed.
      let answer = reply;
      let steps: { label: string; state: "running" | "done" | "failed" }[] = startState
        ? [{ ...START_STATE_STEP }]
        : [];
      const moodle = previewServers.find((server) => server.id === "moodle" && server.enabled);
      if (moodle && !command && /moodle|deadline|due/i.test(text)) {
        const tool = moodle.tools.find((candidate) => candidate.name === "get_deadlines")!;
        let decision: ApprovalDecision = "once";
        if (moodle.approval !== "allow" && tool.rule !== "allow") {
          const approval: ApprovalView = {
            id: crypto.randomUUID(),
            chatId: key,
            label: "Moodle",
            tool: "get_deadlines",
            description: tool.description,
            hints: tool.hints,
            args: JSON.stringify({ days: 7 }, null, 2),
          };
          previewApprovals = [...previewApprovals, approval];
          emit({ type: "approvals", approvals: structuredClone(previewApprovals) });
          emit({
            type: "chat",
            chat: structuredClone({
              ...chat,
              messages: [
                ...chat.messages,
                {
                  role: "assistant" as const,
                  text: "",
                  state: "streaming" as const,
                  steps: [
                    { label: "Waiting for you: Moodle · get_deadlines", state: "running" as const },
                  ],
                  sources: [],
                  approvals: [approval],
                },
              ],
            }),
          });
          decision = await new Promise<ApprovalDecision>((resolve) =>
            approvalWaiters.set(approval.id, resolve),
          );
          previewApprovals = previewApprovals.filter((waiting) => waiting.id !== approval.id);
          emit({ type: "approvals", approvals: structuredClone(previewApprovals) });
          if (decision === "always") tool.rule = "allow";
        }
        steps = [
          decision === "deny"
            ? { label: "You declined Moodle · get_deadlines", state: "failed" }
            : { label: "Used Moodle · get_deadlines", state: "done" },
        ];
        answer =
          decision === "deny"
            ? "You declined, so I didn't look at Moodle. Tell me what's due and I'll help you plan it."
            : "From Moodle, due in the next seven days:\n\n- **Homework 3**, Automata Theory: Thursday at 23:59, not submitted yet\n- **Quiz 2**, Algorithms: Sunday at 12:00";
        emit({
          type: "chat",
          chat: structuredClone({
            ...chat,
            messages: [
              ...chat.messages,
              {
                role: "assistant" as const,
                text: "",
                state: "streaming" as const,
                steps,
                sources: [],
              },
            ],
          }),
        });
      }
      const words = answer.split(" ");
      for (let index = 1; index <= words.length; index++) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        emit({ type: "stream", chatId: key, text: words.slice(0, index).join(" ") });
      }
      for (const visual of visuals)
        for (let length = 40; length < visual.source.length + 40; length += 40) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          emit({
            type: "visual",
            chatId: key,
            visual: { ...visual, source: visual.source.slice(0, length), state: "streaming" },
          });
        }
      chat.messages.push({
        role: "assistant",
        text: answer,
        state: "complete",
        steps,
        sources: startState ? START_STATE_SOURCES : [],
        ...(visuals.length ? { visuals } : {}),
      });
      chat.status = "idle";
      emit({ type: "chat", chat: structuredClone(chat) });
      emit({ type: "chats", chats: summaries() });
    });
    return { chatId: key };
  },
  async cancel() {},
  async setFocus(chatId, focus) {
    const chat = chats.get(chatId);
    if (chat?.kind !== "course") return;
    chat.focus = focus;
    emit({ type: "chats", chats: summaries() });
  },
  async signIn() {},
  async cancelSignIn() {},
  async signOut() {},
  async saveKey(connection, key) {
    await new Promise((done) => setTimeout(done, 600));
    const name = PREVIEW_GROUPS.find((group) => group.connection === connection)?.name ?? "It";
    if (key.trim().length < 8 || /bad/i.test(key))
      throw new Error(`${name} refused this key. Check that you copied all of it.`);
    previewConnected.add(connection);
    emit({ type: "models", models: previewModels() });
  },
  async removeKey(connection) {
    previewConnected.delete(connection);
    emit({ type: "models", models: previewModels() });
  },
  async setRoleModel(role, ref) {
    previewRoles[role] = ref;
    emit({ type: "models", models: previewModels() });
  },
  async setOpenRouterModels(ids) {
    previewOpenRouter = [...new Set(ids)];
    emit({ type: "models", models: previewModels() });
  },
  async setCategories(categories) {
    const problem =
      categoriesProblem(categories) ?? categoriesInUse(previewCategories, categories, documents);
    if (problem) throw new Error(problem);
    previewCategories = structuredClone(categories);
    previewFollow();
    emit({ type: "models", models: previewModels() });
    emit({ type: "library" });
  },
  async setNaming(pattern) {
    previewNaming = pattern?.trim() || null;
    previewFollow();
    emit({ type: "models", models: previewModels() });
    emit({ type: "library" });
  },
  async renames(scope) {
    return previewRenames(scope);
  },
  async applyNaming(scope) {
    const renames = previewRenames(scope);
    for (const rename of renames)
      Object.assign(
        documents.find((document) => document.id === rename.documentId)!,
        {
          title: rename.next,
          named: "pattern",
        },
      );
    emit({ type: "library" });
    return renames;
  },
  async listPending() {
    return [];
  },
  async resolvePending() {
    throw new Error("The preview has no tutor to propose changes.");
  },
  async undoAction() {
    throw new Error("The preview has no tutor changes to undo.");
  },
  async undoNaming(renames) {
    let restored = 0;
    for (const rename of renames) {
      const document = documents.find((each) => each.id === rename.documentId);
      if (document?.title !== rename.next) continue;
      Object.assign(document, { title: rename.title, named: rename.named });
      restored++;
    }
    emit({ type: "library" });
    return restored;
  },
  async openrouterCatalog() {
    return structuredClone(OPENROUTER_CATALOG);
  },
  async setWindowTheme() {},
  async revealConfig() {},
  async listSkills() {
    return previewSkillsView();
  },
  async setSkillOn(key, on) {
    const skill = previewSkills.find((candidate) => candidate.key === key);
    if (!skill) throw new Error("That routine is no longer there.");
    skill.on = on;
    return previewSkillsView();
  },
  async createSkill({ name, description, body }) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64)
      throw new Error(
        "That name can't be used: its name isn't lowercase letters, digits and single hyphens.",
      );
    if (!description.trim()) throw new Error("Write a description.");
    if (previewSkills.some((skill) => skill.source === "folio" && skill.name === name))
      throw new Error(`There is already a routine named ${name}.`);
    previewSkills.splice(previewSkills.filter((skill) => skill.source === "folio").length, 0, {
      key: `~/.folio/skills/${name}`,
      name,
      description: description.trim(),
      source: "folio",
      from: "Folio",
      on: true,
      model: true,
      user: true,
      body: body.trim(),
    });
    return previewSkillsView();
  },
  async readSkill(name) {
    const skill = previewSkills.find(
      (candidate) => candidate.source === "folio" && candidate.name === name,
    );
    if (!skill) throw new Error(`Folio has no routine of its own named ${name}.`);
    return { text: skillFile(skill), revision: skillRevision(skill) };
  },
  async saveSkill(name, text, revision) {
    const skill = previewSkills.find(
      (candidate) => candidate.source === "folio" && candidate.name === name,
    );
    if (!skill) throw new Error(`Folio has no routine of its own named ${name}.`);
    if (revision !== skillRevision(skill))
      throw new Error("This routine changed since you opened it. Open it again.");
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    const description = match && /description:\s*(.+)/.exec(match[1]!)?.[1]?.replace(/^"|"$/g, "");
    if (!match || !description) throw new Error("This can't be saved: it has no description.");
    skill.description = description;
    skill.body = match[2]!.trim();
    return previewSkillsView();
  },
  async addSkillFolder() {
    if (!previewSkillFolders.includes("~/Study/skills")) previewSkillFolders.push("~/Study/skills");
    return previewSkillsView();
  },
  async removeSkillFolder(key) {
    previewSkillFolders = previewSkillFolders.filter((folder) => folder !== key);
    return previewSkillsView();
  },
  async revealSkill() {},
  async mcpServers() {
    return previewMcp();
  },
  async addMcpServers(text) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("That isn't JSON. Paste the block with the server's name and command.");
    }
    const block = (parsed.mcpServers ?? parsed) as Record<
      string,
      { command?: string; args?: string[]; env?: Record<string, string> }
    >;
    for (const [id, entry] of Object.entries(block)) {
      if (previewServers.some((server) => server.id === id))
        throw new Error(`There is already a server named ${id}.`);
      previewServers.push({
        id,
        label: id.charAt(0).toUpperCase() + id.slice(1),
        kind: "local",
        command: entry.command ?? "",
        args: entry.args ?? [],
        cwd: null,
        env: Object.keys(entry.env ?? {}),
        headers: [],
        enabled: false,
        approval: "ask",
        status: "off",
        error: null,
        log: "",
        instructions: null,
        tools: [],
        prompts: [],
        argWarning: false,
      });
    }
    return previewMcp();
  },
  async saveMcpServer(input, previous) {
    const server = previous ? previewServer(previous) : undefined;
    if (!server) {
      if (previewServers.some((candidate) => candidate.id === input.id))
        throw new Error(`There is already a server named ${input.id}.`);
      previewServers.push({
        id: input.id,
        label: input.label || input.id,
        kind: input.url ? "remote" : "local",
        command: input.url ?? input.command ?? "",
        args: input.args ?? [],
        cwd: input.cwd ?? null,
        env: Object.keys(input.env ?? {}),
        headers: Object.keys(input.headers ?? {}),
        enabled: false,
        approval: "ask",
        status: "off",
        error: null,
        log: "",
        instructions: null,
        tools: [],
        prompts: [],
        argWarning: false,
      });
    } else {
      server.id = input.id;
      server.label = input.label || server.label;
      if (input.command !== undefined) server.command = input.command;
      if (input.args) server.args = input.args;
      for (const [name, value] of Object.entries(input.env ?? {}))
        server.env =
          value === null
            ? server.env.filter((known) => known !== name)
            : [...new Set([...server.env, name])];
    }
    return previewMcp();
  },
  async removeMcpServer(id) {
    previewServers.splice(previewServers.indexOf(previewServer(id)), 1);
    return previewMcp();
  },
  async setMcpServerOn(id, on) {
    const server = previewServer(id);
    server.enabled = on;
    server.status = on ? (server.id === "campus" ? "failed" : "starting") : "off";
    if (on && server.status === "starting")
      setTimeout(() => {
        server.status = "ready";
        if (!server.tools.length)
          server.tools = [
            {
              name: "list_courses",
              title: null,
              description: "The classes you are in.",
              rule: "ask",
              hints: {},
            },
            {
              name: "fetch_posts",
              title: null,
              description: "Recent posts from a class.",
              rule: "ask",
              hints: {},
            },
          ];
        emit({ type: "mcp", mcp: previewMcp() });
      }, 900);
    return previewMcp();
  },
  async restartMcpServer(id) {
    const server = previewServer(id);
    server.status = "starting";
    setTimeout(() => {
      server.status = server.id === "campus" ? "failed" : "ready";
      emit({ type: "mcp", mcp: previewMcp() });
    }, 900);
    return previewMcp();
  },
  async setMcpServerApproval(id, approval) {
    previewServer(id).approval = approval;
    return previewMcp();
  },
  async setMcpToolRule(id, tool, rule) {
    const found = previewServer(id).tools.find((candidate) => candidate.name === tool);
    if (found) found.rule = rule;
    return previewMcp();
  },
  async revealMcpConfig() {},
  async listApprovals() {
    return structuredClone(previewApprovals);
  },
  async answerApproval(id, decision) {
    const waiter = approvalWaiters.get(id);
    if (!waiter) throw new Error("That request is no longer waiting.");
    approvalWaiters.delete(id);
    waiter(decision);
  },
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
    const category = patch.category
      ? previewCategories.find((each) => each.id === patch.category)
      : patch.role && categoryFor(patch.role, previewCategories);
    Object.assign(
      document,
      patch,
      category && { role: category.kind, category: category.id },
      patch.title !== undefined && patch.named === undefined && { named: "own" },
      { revision: document.revision + 1 },
    );
    if (document.named === "pattern") previewFollow();
    return document;
  },
  async readDocument(documentId) {
    // Two lectures have slides drawn to show Folio off; the rest share a plain test page.
    if (documentId === id(11)) return syntheticSlides(GRAPH_TRAVERSAL);
    if (documentId === id(21)) return syntheticSlides(FINITE_AUTOMATA);
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
    noteVersions.set(noteId, [
      { revision, at: new Date().toISOString(), content: entry.content },
      ...(noteVersions.get(noteId) ?? []),
    ]);
    const note = putNote(noteId, entry.note.courseId, content);
    emit({ type: "library" });
    return note;
  },
  async noteHistory(noteId) {
    return (noteVersions.get(noteId) ?? []).map((version) => ({
      revision: version.revision,
      at: version.at,
      author: "student" as const,
      title: noteTitle(version.content),
      characters: version.content.length,
    }));
  },
  async restoreNote(noteId, version, revision) {
    const earlier = noteVersions.get(noteId)?.find((item) => item.revision === version);
    if (!earlier) throw new Error("That version of the note is no longer kept.");
    return previewApi.saveNote(noteId, earlier.content, revision);
  },
  async appendToNote(noteId, text) {
    const entry = notes.get(noteId)!;
    const note = putNote(noteId, entry.note.courseId, `${entry.content.trimEnd()}\n\n${text}\n`);
    emit({ type: "library" });
    return note;
  },
  async searchNotes(query, courseId) {
    return [...notes.values()]
      .filter(({ note }) => !courseId || note.courseId === courseId)
      .flatMap(({ note, content }) => {
        const match = matchNote(content, note.title, query);
        return match ? [{ noteId: note.id, ...match }] : [];
      })
      .sort((a, b) => b.score - a.score)
      .map(({ noteId, snippet }) => ({ noteId, snippet }));
  },
  async noteMentions(noteId) {
    const target = notes.get(noteId)!.note;
    return [...notes.values()].flatMap(({ note, content }) => {
      if (note.id === noteId || note.courseId !== target.courseId) return [];
      const found = mentionsOf(content, target.title);
      return found.linked.length || found.unlinked.length
        ? [{ noteId: note.id, title: note.title, revision: note.revision, ...found }]
        : [];
    });
  },
  async linkMention(source, target, revision) {
    const next = linkFirstMention(notes.get(source)!.content, notes.get(target)!.note.title);
    if (next === null) throw new Error("That note no longer mentions this one.");
    return previewApi.saveNote(source, next, revision);
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
    const category = (name: string) =>
      guessCategory(name.split("/").at(-1)!, "pdf", previewCategories);
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
        role: category(name).kind,
        category: category(name).id,
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
  async listAssignments() {
    return [...assignments.values()].map((item) => structuredClone(item));
  },
  async createAssignment(input) {
    if (!input.title.trim()) throw new Error("Give it a title.");
    const created = assignment(100 + assignments.size, input.title.trim(), {
      courseId: input.courseId,
      kind: input.kind ?? "problem_set",
      dueAt: input.dueAt ?? null,
      dueHasTime: input.dueHasTime ?? false,
      createdAt: new Date().toISOString(),
    });
    assignments.set(created.id, created);
    emit({ type: "library" });
    return structuredClone(created);
  },
  async updateAssignment(assignmentId, patch, revision) {
    const current = assignments.get(assignmentId);
    if (!current || current.revision !== revision)
      throw new Error("This item changed since it was opened. Reload it.");
    const next = {
      ...patchAssignment({ ...current, version: 1 }, patch),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const { version: _version, ...view } = next;
    assignments.set(assignmentId, view);
    emit({ type: "library" });
    return structuredClone(view);
  },
  async addAssignmentFiles() {
    // The browser preview has no file picker for Folio's library.
    return null;
  },
  async openAssignmentFile() {},
  async trashAssignment(assignmentId) {
    const item = assignments.get(assignmentId);
    if (!item) throw new Error("That assignment is no longer in Folio.");
    assignments.delete(assignmentId);
    return putInTrash("assignment", item.title, item.courseId, () =>
      assignments.set(assignmentId, item),
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
  // Demos run only in Folio's window; the preview shows a card instead.
  async release() {
    return previewRelease();
  },
  async checkRelease() {
    return previewRelease();
  },
  async setUpdateChecks(on) {
    previewUpdates = on;
    if (!on && previewUpdate.step === "downloading") {
      clearInterval(previewDownload);
      previewUpdate = { step: "available" };
    }
    return previewRelease();
  },
  async updateFolio() {
    if (previewUpdate.step === "downloading" || previewUpdate.step === "ready")
      return previewRelease();
    let percent = 0;
    previewUpdate = { step: "downloading", percent };
    previewDownload = setInterval(() => {
      percent = Math.min(100, percent + 7);
      if (percent < 100) return setPreviewUpdate({ step: "downloading", percent });
      clearInterval(previewDownload);
      setPreviewUpdate({ step: "downloading", percent: 100 });
      setTimeout(() => setPreviewUpdate({ step: "ready" }), 1_200);
    }, 250);
    return previewRelease();
  },
  async restartToUpdate() {
    setPreviewUpdate({ step: "available" });
  },
  async registerArtifact() {
    return { url: "" };
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
