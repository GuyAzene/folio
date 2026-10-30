# Architecture

Folio is an Electron app. The main process owns everything that matters: the files on disk, the
connection to the model, and every check on what a chat may read. The renderer is a sandboxed
Svelte interface that talks to it through one small, typed API.

```text
app/                          the renderer: Svelte 5, sandboxed
  │   IPC, typed in src/desktop/api.ts
  ▼
src/desktop/main.ts           the main process
  ├─ ChatService ─▶ Conversation ─▶ Pi agent ─▶ ChatGPT, or a provider on a key
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
| `src/auth.ts`, `src/connections.ts`, `src/model-refs.ts`, `src/model-choices.ts`, `src/config.ts` | Connections and models: the ChatGPT sign-in and API keys, the models each connection offers, and which model does what (`config.json`). |
| `src/library/` | Courses and documents, PDF pages and page images, notes with their history, the Trash, the tutor's tools and teaching rules, and attachments. |
| `src/ingest/` | Studying a lecture: page inventory, reading, drafting, reconciling and publishing study notes. |
| `src/kb/` | Each course's knowledge base: immutable published versions, a search index and the tutor's study-note tools. |
| `src/jobs/` | Background study jobs and the saved output of every finished step. |
| `src/cli.ts` | A terminal client with a small synthetic demo course. |
| `tests/` | Deterministic test suites; `tests/fixtures/` builds synthetic PDFs and courses; `tests/electron/` checks Folio in a real window (`vp run test:electron`). |
| `scripts/desktop.ts` | Runs the app from the dev server or from the production build. |
| `scripts/package.ts`, `scripts/install.ts`, `resources/` | Builds `Folio.app` and its disk image (`vp run desktop:package`) and installs it (`vp run desktop:install`); the app icon. |

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

### Drawings and demos

The tutor shows anything a diagram can't express with one tool, `show_visual`, whose argument is
an SVG or an HTML fragment (`src/visual.ts`, `src/library/visual-tool.ts`). The tool checks it
(a title, no network, no storage, libraries only from Folio's list) and returns a correction the
tutor can act on; the visual is saved as the tool call itself, so a reopened chat shows it again
without running anything. A still SVG is shown as an image. Everything else runs in a sealed
frame:

- `ArtifactFrame.svelte` is the only place Folio creates a frame: `sandbox="allow-scripts"`,
  never same-origin, no permissions. A test checks that no other file makes one.
- The main process serves each demo from `folio-artifact://<hash>/` with its own content policy:
  no network at all, no frames, no forms, and scripts only inline or from
  `folio-artifact://lib/`, a fixed list of bundled files (`src/desktop/artifacts.ts`). Folio's
  own files are refused to anything but Folio's page, and a frame may load one demo, once.
- The page hands each demo a private port; a demo can only report its height, an error, or a
  question, and every message is checked (`app/lib/frames.ts`). A question only fills in the
  message box.
- Each demo runs in its own process, so one that loops forever freezes only itself; after four
  seconds of silence it is stopped. At most four run at once.

`vp run test:electron` checks all of this in a real window: a probe demo tries every way out
(requests, styles, sockets, forms, windows, navigation, Folio's page and storage) while a local
server records any request that arrives.

A note can hold a demo as a ```` ```demo ```` block, run the same way. In the editor it runs while
the cursor is away, and waits for **Run** while its code is being written.

## Chats and what they may read

There are three kinds of chat, fixed when a chat is created:

- **Course chats** read one course: its documents, its study notes and the student's notes in it.
- **Library chats**, started from Home, may read any course and work out which one a question is
  about.
- **Plain chats** read nothing. Only chats from early builds are plain.

The tutor's tools (`list_documents`, `read_page`, `search_course`, `read_sections`,
`related_sections`, `topic_map`, `list_notes`, `read_note`, `create_note`, `edit_note` and
`rename_note`) check every
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

Long chats are trimmed in the same spirit, and only as a question is sent, so a reopened chat
sends exactly what it sent before. Past a quarter of the model's context, tool results before the
last four questions reach the model as one-line notes of what they were (and earlier visuals as
their titles); the question records where that cut is, and the cut only moves forward. If the
chat is still past 60% of the context, the model writes one summary of the chat so far, saved as
a message of Folio's just before the question; from then on the model sees the summary instead
of what it covers. Nothing saved is deleted, the summary never judges what the student
understands, and which courses the student added is restated by Folio, not by the model. A
summary that fails is skipped; one the student stops leaves the chat as it was.

Each question carries how long the tutor thinks (Low to Max; Pi brings a level a model lacks to
its nearest one) and whether it goes on OpenAI's faster priority tier, which costs more and exists
only for OpenAI's models; both are recorded on the question and apply to it alone, so a fast
question never leaves the next one fast. Models the plan serves before
Pi's catalog lists them (GPT-6.1 Terra) are declared in `src/model-catalog.ts` as copies of a
listed sibling, and Pi's own entry replaces the declaration once it ships.

### Searching the web

Course and library chats can search the web with `search_web`, when the student asks or wants
more than the course material gives. The course comes first: the web never changes its notation
or definitions, and what comes from the web is labelled and linked. Each search is its own
request on the research model (GPT-6.1 Terra unless the student sets another) with its
provider's hosted search: OpenAI's web search, Anthropic's web search tool, Grounding with Google
Search, or OpenRouter's web plugin. It carries a fixed instruction and the query and nothing
else: no chat, course material, notes or Folio tools,
so a web page cannot reach what the student wrote or act through Folio. The query is checked in
code before it leaves (short, with no email, phone or ID numbers), a reply searches at most three
times, and the student can turn search off in Settings; the tool then refuses, so the prompt
stays the same. Pi drops the search's sources and citations; Folio reads them from the raw
stream, keeps only https links, saves them with the tool's result, and lists them under the
reply apart from course sources. Links open in the system browser.

## Connections and models

Folio reaches models through five connections: the ChatGPT plan, signed in through the browser,
and API keys for OpenAI, Anthropic, Google Gemini and OpenRouter (`src/model-refs.ts`). Pi keeps
one credential per provider, so the OpenAI API is a provider of its own (`openai-api`, with the
catalog's OpenAI models under it), and Pi never takes one of its requests for a ChatGPT sign-in.
Each key provider resolves only the key saved in Folio: never one from the environment, another
app's files or a provider's own sign-in. A key is checked with its provider before Folio keeps
it, by a request that lists models or describes the key, and the provider's answer is never
shown; it then goes in `keys.json`, apart from the ChatGPT sign-in, and never back to the window.

A model is named by a reference, `connection/model` (`chatgpt/gpt-6.1-sol`,
`openrouter/deepseek/deepseek-v4-pro`), and a chat saves its provider and model and keeps them.
The composer offers, per connection, the plan's checked models, a short list of current models
for each key, and the OpenRouter models the student picked, grouped by lab; a model that reads
text only is marked, and the tutor on one gets a note where a page image would be. The main
process refuses any other model, and asks for the connection a chat's model needs before it
sends.

Which model does what lives in `config.json`, edited in Settings or by hand (`src/config.ts`):
the tutor for new chats, web search, each step of studying (planner, reader, close-up, writer,
checker, topics) and reading a syllabus. Folio checks every entry in code: the model must exist
on its connection, and the steps that read slides must see images. An entry it can't use is
listed in Settings and its default applies; the file is never rewritten behind the student's
back, a change from Settings is refused when the file changed outside Folio, and hand edits are
picked up as they are saved. Defaults are the ChatGPT models studying always used, and nothing
falls back from one connection to another, so a key is billed only for what the student assigned
to it. Study steps name a ChatGPT model by its bare ID, as before, so saved steps are still
reused. Every answer tool is forced as its API names it ("required", or "any" for Anthropic and
Gemini), and Anthropic answers those steps without thinking, which it refuses alongside a forced
tool.

## Studying a lecture

Adding a lecture or recitation to a course is what starts its study; reading or explaining a
document never does. A PDF lecture or recitation is queued a moment after it is added (time to
fix a wrong role for free), and once after start Folio queues every lecture and recitation it
never studied. Studies run two at a time: what the student asked for first, then new files, then
the backlog, then redos. Each step runs on the model set for it (see
[Connections and models](#connections-and-models)); without a connection one of them needs,
studies wait and start when it is there. A
study the student cancels is not started again unless they ask. A file that moves to the Trash,
leaves its course or stops being a lecture has its study stopped first, and Folio waits until
nothing reads it any more before it moves; its study notes leave the course with it.

The student follows this, and nothing more: the Studying place lists what is being studied now,
each with one line of what Folio is doing and a bar, then what comes next in the order Folio will
take it. One line appears only when something needs them (no connection, a used-up plan, a study
that stopped). Finished studies leave the list, and no page counts what has been studied; a
course's Overview shows a single "Studying …" line while Folio works on that course.

A study job reads every page of a lecture: its text layer and regions, with close-up re-reads
where a page needs them. It then drafts study notes by topic, each section citing the pages and
regions it came from, and an independent checker tests the draft's claims against the page
images. Up to three revision rounds follow, each on what is still wrong: regions not yet written
up (read again up close first, if no close-up has read them) and claims the checker doubted.
Whatever every round still missed is written up from the slide itself, as a cited section marked
as not reviewed, so no part of a slide is dropped. A sentence the page contradicts leaves its
section; every claim still unconfirmed is kept on its section for the tutor, never shown to the
student as a warning. Every region ends up cited, or omitted as page furniture with a reason
(page numbers, repeated headers, build steps, duplicates); the student never sees this
accounting, which is a record for diagnosis. The result is published as a new, immutable
version of the course's knowledge, with a SQLite FTS5 search index. Each document is a session
numbered across its course (by the number in its title, or its place among the course's
lectures), and a re-studied document replaces its own session. Each step's output is saved, so a
job interrupted by a quit or a plan limit resumes where it stopped instead of starting over;
after a quit, interrupted studies go back in the queue on their own.

### Topics shared across a course

Study notes are organised by topic, not by file. A topic page gathers what every lecture and
recitation says about one concept or technique; each document keeps an anchor page in slide
order that points into the topics it feeds, with what only it teaches and its notation. Three
things keep a topic shared:

- The author of a new document is shown the course's topics as they were when its job started
  (slug, titles in both languages, aliases, a one-line meaning and where each is taught) and
  writes into an existing topic when the document teaches it.
- When a publish starts a new topic, code looks for topics it may duplicate (the same title or
  alias, or the course's search index ranking another topic's sections first), and GPT-6.1 Terra
  judges each pair: only "same" merges, leaving a redirect so old links keep resolving; "part of"
  and "related" become links. Block handles never change.
- A topic taught in several sessions gets a short overview citing the sections it draws on,
  written again only when those sections change.

Everything else on topic and anchor pages is derived from the blocks by code, and a version is
not written unless every block belongs to one session and one topic and every link is live.
Generations written before this (version 1) are upgraded as they are read, and their courses are
regrouped once, then each document is studied again behind new files.

## Notes

The student's notes are Markdown files. The editor (CodeMirror 6) renders Markdown, math (KaTeX),
tables and HTML as you write, and each line takes the direction of its first letter, so Hebrew and
English sit side by side. Saves are revision-checked: when a note changed outside Folio, the
editor stops and keeps both versions rather than overwriting either.

When the student asks, the tutor writes in the notebook itself: it creates a note, replaces one
exact passage or adds to the end, or renames a note, and links in other notes follow a rename.
Every change passes the revision the tutor read, so one made after the note changed is refused.
A course chat writes only to its own course's notes. Each change the tutor makes is kept in the
note's history (`<note>.history.jsonl`, the version it replaced, who and when), and so are the
student's own saves at most every five minutes; Undo on the chat's change card, or the note's
History menu, brings an earlier version back as a new one. Notes link to each other with
`[[Title]]` and to study-notes topics with `[[topic:slug]]`. Chats from before this keep their
suggested edits, which the student still keeps, inserts or discards.

All notes live in one notebook, a place of its own in the sidebar: a list grouped by when each
note last changed (pinned notes first) beside the open note. Courses are the folders and `#tags`
cut across them; a course's Notes tab is the same list filtered to it. Search reads every note's
text in the main process with the same Hebrew normalization as study-notes search, and ⌘O finds
a note by title or creates one. Folio reads a note's preview, tags, links and cited pages from
its Markdown each time it lists it (`src/library/note-meta.ts`); nothing about a note is stored
apart from the note. The bottom of a note lists the course's other notes that link to it and
those that only name it, and "Link" turns such a mention into a link as a revision-checked save.

A note can sit beside a document in place of the chat. "Add this page to a note" and "Quote to
notes" write into it as the student's own undoable edit, as a link back to the page
(`[[page:<document>#<page>|Lecture 3 · p. 12]]`), and the notes that cite a document are offered
first beside it. A tutor's reply is saved to a note only when the student chooses "Save to note",
with a line linking the chat (`[[chat:<id>|title]]`) and the pages it cited; Undo takes it back
out while the note is still as that save left it.

## Assignments

An assignment is a record of its own, not only a PDF with a due date: any coursework (a problem
set, a reading, exam prep, a project) on a board of To do, Doing, Submitted and Done, which the
student moves by dragging or by each card's status menu. A record keeps the files it came with
(the handout and the official solution, as links to library documents), steps, linked topics,
and, once handed in, every submission as it was handed in (read-only copies that are never
changed), the grade, the feedback and returned work, and what the student would do differently.
Overdue, late and extended are worked out from the dates rather than set. Each assignment file
in the library becomes a record once; a marker remembers which, so a record the student deletes
stays deleted. The record holds the due date. Records are revision-checked like the rest of the
library and go to the Trash with their files, alone or with their course.

## On disk

Everything lives in `~/.folio/` (or `FOLIO_HOME`), with directories `0700` and files `0600`:

| Path | Contents |
| --- | --- |
| `connection.json` | The ChatGPT connection and installation ID |
| `keys.json` | API keys, each checked with its provider before it was kept |
| `config.json` | Which model does what, and the OpenRouter models the composer offers; never a key |
| `sessions/<id>.json` | Each conversation |
| `library/` | Courses, read-only originals with their hashes, notes with their history, and suggested edits |
| `library/assignments/<id>/` | Each assignment's record and the files handed in or back |
| `library/courses/<id>/kb/generations/<n>/` | Each published version of a course's study notes |
| `library/kb.sqlite` | Which version of each course's study notes is current |
| `jobs.sqlite` | Study jobs and the saved output of their steps |
| `trash/<id>/` | Removed items, kept for 30 days |
| `workspace.json` | Open tabs |

Writes are atomic. Revision and hash checks refuse edits made elsewhere instead of overwriting
them, and a chat open in one process refuses writes from another. Session files are versioned and
pin the Pi runtime and transcript format they were written with.

## The packaged app

`vp run desktop:package` builds the renderer and the main process from a copy of the source, so a
Folio running from the checkout keeps its files, and electron-builder makes
`release/mac-arm64/Folio.app` and a disk image for Apple silicon (`scripts/package.ts`).

- The app's archive, `app.asar`, holds the main process, its preload, the renderer and only the
  packages the main process loads: those are `dependencies` in `package.json`. The renderer's
  libraries are `devDependencies`, since Vite already bundles them. The native canvas module sits
  unpacked beside the archive, and pdf.js keeps its legacy build, fonts, CMaps and decoders.
- Electron's fuses make the app run only its own archive, checked against a hash in its signed
  `Info.plist`, and ignore `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS`. The inspector flags stay on
  so the real-window checks can drive the packaged app (`FOLIO_E2E_APP=…/Folio.app`).
- It is signed ad-hoc with the hardened runtime. `CSC_NAME` or `CSC_LINK` signs it with a
  Developer ID instead, and Apple's notarization credentials in the environment notarize it.

`vp run desktop:install` then puts the app in /Applications (`scripts/install.ts`). It refuses
to replace an app with another bundle ID, and to run while a copy of Folio runs from anywhere
else; asks the Folio running from Applications to quit, by a signal to that process alone, and
waits for it; copies
the new app beside the old one, checks its signature, and swaps it in by renaming, so there is
never a half-copied app; a Folio that was open opens again. An app built on the Mac is not
quarantined, so it opens without Gatekeeper's prompt.

CI (`.github/workflows/ci.yml`) runs the checks and unit tests on Linux, and on macOS the
real-window checks, then the same checks on the packaged app and the install checks
(`tests/electron/install.e2e.ts`). After a push to `main` whose checks, tests and builds pass,
it builds the app for others (`FOLIO_DISTRIBUTE=1`: the inspector flags off), opens it on an
empty home and quits it,
then replaces the disk image on the rolling `nightly` pre-release and moves its tag to that
commit. The download link never changes, and there are no versioned releases to cut. The
real-window job reports on its own and does not hold the nightly back: those checks were written
on a Mac much faster than GitHub's virtual ones.

A quit signal (SIGTERM, as the installer sends) quits Folio as ⌘Q does: chats settle first.

The packaged app keeps its data where the development build does, in `~/.folio` (or `FOLIO_HOME`).
One Folio runs on a home at a time: opened while another runs there, Folio quits before it opens
anything in the home, and the one already open comes forward.
