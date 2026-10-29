# Architecture

Folio is an Electron app. The main process owns everything that matters: the files on disk, the
connection to the model, and every check on what a chat may read. The renderer is a sandboxed
Svelte interface that talks to it through one small, typed API.

```text
app/                          the renderer: Svelte 5, sandboxed
  │   IPC, typed in src/desktop/api.ts
  ▼
src/desktop/main.ts           the main process
  ├─ ChatService ─▶ Conversation ─▶ Pi agent ─▶ ChatGPT
  ├─ LibraryStore             courses, documents, notes, Trash
  ├─ IngestRunner ─▶ KnowledgeStore    studying lectures into study notes
  └─ ~/.folio                 everything Folio keeps, on disk
```

## Source layout

| Path | What it holds |
| --- | --- |
| `app/` | The renderer: `views/` (Home, course, reader, notes, study notes, chats, Studying, Trash), `components/`, and `lib/` (app state, Markdown and math rendering, text direction, the note editor in `lib/editor/`). |
| `src/desktop/` | The Electron main process, the preload bridge, the IPC contract (`api.ts`) and the chat service. |
| `src/conversation.ts`, `src/session-store.ts`, `src/transcript.ts`, `src/agents.ts` | Conversations on Pi: saving and resuming, cancellation, leases, and what history the model sees. |
| `src/library/` | Courses and documents, PDF pages and page images, notes and suggested edits, the Trash, the tutor's tools and teaching rules, and attachments. |
| `src/ingest/` | Studying a lecture: page inventory, reading, drafting, reconciling and publishing study notes. |
| `src/kb/` | Each course's knowledge base: immutable published versions, a search index and the tutor's study-note tools. |
| `src/jobs/` | Background study jobs and the saved output of every finished step. |
| `src/cli.ts` | A terminal client with a small synthetic demo course. |
| `tests/` | Deterministic test suites; `tests/fixtures/` builds synthetic PDFs and courses; `tests/electron/` checks Folio in a real window (`vp run test:electron`). |
| `scripts/desktop.ts` | Runs the app from the dev server or from the production build. |

## What the window may do

The renderer runs sandboxed, with context isolation, and loads only Folio's own files from its
`folio://app` scheme under a strict content policy. The main process adds rules the page cannot
change (`src/desktop/hardening.ts`):

- Only Folio's own page, in the window's main frame, can call the app over IPC.
- The page gets no browser permission beyond writing to the clipboard; frames inside it get none.
- The window makes no network requests: model traffic runs in the main process. The development
  server is the one exception.
- Frames inside the page cannot navigate, nothing opens a new window or attaches a webview, and
  downloads are refused. Links open in the system browser.

`FOLIO_PERMISSIONS=log` prints every permission request instead of refusing it, to take stock of
what the page uses.

Replies and notes are Markdown sanitized by DOMPurify. Math leaves the sanitizer as an inert
placeholder carrying its TeX percent-encoded (the sanitizer drops attributes such as `E[X]>0` or
`-->`), and KaTeX fills it in afterwards, so the sanitizing policy never has to allow SVG or
MathML.

Diagrams work the same way. A closed ```` ```mermaid ```` block leaves the sanitizer as code and
is drawn afterwards by Pele, which cannot run code: it escapes labels and emits only shapes and
text, with links and images turned off, and its SVG passes an SVG-only sanitizer before it joins
the page (`app/lib/diagrams.ts`). A block still being written, or never closed, stays code.
Colors come from CSS variables, so a theme switch needs no redraw, and each label takes the
direction of its first letter. In notes, the editor draws the same blocks in place
(`DiagramWidget`), and an SVG drawing written into a note is shown as an image, which runs no
scripts and loads nothing.

## Chats and what they may read

There are three kinds of chat, fixed when a chat is created:

- **Course chats** read one course: its documents, its study notes and the student's notes in it.
- **Library chats**, started from Home, may read any course and work out which one a question is
  about.
- **Plain chats** read nothing. Only chats from early builds are plain.

The tutor's tools (`list_documents`, `read_page`, `search_course`, `read_sections`,
`related_sections`, `topic_map`, `list_notes`, `read_note` and `propose_note_edit`) check every
argument in application code against what the chat may read. The app installs its own prompt
before each request, so a saved chat never carries stale permissions. That prompt stays the same
from turn to turn, which lets the provider reuse the start of each request: what changes with a
question travels on the question instead. A course chat's question records the page the student
had open, and the tutor is told when it changes; what the student adds says how to read it.

The student can widen a course chat, and only the student: a lecture or course added with the
composer's **+** is recorded on the student's own message, and the tools work out the chat's
reach from those messages on every call. The model never writes user messages, so it cannot add
to them. The student's own notes stay with their course even when that course is added
elsewhere.

`read_page` returns the page's text and the page itself as an image, so diagrams count. Every
request resends the conversation, so at most the six most recent messages with images keep them,
and earlier ones say an image was there. Older images are let go five at a time rather than one
per new image, so most requests repeat the one before.

## Studying a lecture

A study job reads every page of a lecture: its text layer and regions, with close-up re-reads
where a page needs them. It then drafts study notes by topic, each section citing the pages and
regions it came from. Every region ends up accounted for: cited, left out with a reason, or
listed as a gap. The result is published as a new, immutable version of the course's knowledge,
with a SQLite FTS5 search index. Each step's output is saved, so a job interrupted by a quit or a
plan limit resumes where it stopped instead of starting over.

## Notes

The student's notes are Markdown files. The editor (CodeMirror 6) renders Markdown, math (KaTeX),
tables and HTML as you write, and each line takes the direction of its first letter, so Hebrew and
English sit side by side. Saves are revision-checked: when a note changed outside Folio, the
editor stops and keeps both versions rather than overwriting either. Folio's own edits are only
ever suggestions that the student keeps, inserts or discards.

## On disk

Everything lives in `~/.folio/` (or `FOLIO_HOME`), with directories `0700` and files `0600`:

| Path | Contents |
| --- | --- |
| `connection.json` | The ChatGPT connection and installation ID |
| `sessions/<id>.json` | Each conversation |
| `library/` | Courses, read-only originals with their hashes, notes, and suggested edits |
| `library/courses/<id>/kb/generations/<n>/` | Each published version of a course's study notes |
| `library/kb.sqlite` | Which version of each course's study notes is current |
| `jobs.sqlite` | Study jobs and the saved output of their steps |
| `trash/<id>/` | Removed items, kept for 30 days |
| `workspace.json` | Open tabs |

Writes are atomic. Revision and hash checks refuse edits made elsewhere instead of overwriting
them, and a chat open in one process refuses writes from another. Session files are versioned and
pin the Pi runtime and transcript format they were written with.
