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
| `app/` | The renderer: `views/` (Home, course, reader, notes, study notes, chats, Studying, Trash), `components/`, and `lib/` (app state, Markdown and math rendering, text direction, the note editor in `lib/editor/`); `capture.ts` is the hidden page that draws a note for the tutor to look at. |
| `src/desktop/` | The Electron main process, the preload bridge, the IPC contract (`api.ts`) and the chat service. |
| `src/conversation.ts`, `src/session-store.ts`, `src/transcript.ts`, `src/agents.ts` | Conversations on Pi: saving and resuming, cancellation, leases, and what history the model sees. |
| `src/auth.ts`, `src/chatgpt-sign-in.ts`, `src/connections.ts`, `src/model-refs.ts`, `src/model-choices.ts`, `src/live-catalog.ts`, `src/config.ts` | Connections and models: the ChatGPT sign-in and API keys, the models each connection offers, Pi's live list of OpenRouter's models, and which model does what (`config.json`). |
| `src/library/` | Courses and documents with their categories, numbers and names, the operations that change them, PDF pages and page images, notes with their history, the Trash, the tutor's tools and teaching rules, and attachments. |
| `src/ingest/` | Studying a lecture: page inventory, reading, drafting, reconciling and publishing study notes. |
| `src/kb/` | Each course's knowledge base: immutable published versions, a search index and the tutor's study-note tools. |
| `src/jobs/` | Background study jobs and the saved output of every finished step. |
| `src/skills/` | The student's routines (Agent Skills): finding and reading `SKILL.md` folders, `use_skill`, and `/name`. |
| `src/mcp/` | The student's MCP servers: `mcp.json`, starting and closing servers, their tools and prompts, and asking before a call. |
| `src/cli.ts` | A terminal client with a small synthetic demo course. |
| `tests/` | Deterministic test suites; `tests/fixtures/` builds synthetic PDFs and courses; `tests/electron/` checks Folio in a real window (`vp run test:electron`). |
| `scripts/desktop.ts` | Runs the app from the dev server or from the production build. |
| `src/releases.ts` | Whether a newer Folio is out: GitHub's latest release, asked at most once a day. |
| `src/self-update.ts`, `src/desktop/updater.ts` | Folio updating itself to that release on a Mac when the student clicks, through electron-updater and macOS's own updater. |
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

A note's figures load from `folio-note://<course>/<file>` (`src/desktop/note-asset-protocol.ts`),
only for Folio's own pages: the address must name exactly one figure of one course, and a
demo's frame gets nothing. A note writes a figure as `assets/<file>`, and the renderer turns that
into its own course's address after the sanitizer has checked it, so a note can never name
another course's figures.

When the tutor looks at a note (`view_note`), the main process opens a hidden window on
`capture.html` (`src/desktop/note-capture.ts`) for that one drawing and closes it afterwards. It
runs in an in-memory session of its own, so it shares no storage with the window, with no
preload and so no IPC, and under the same rules: no permissions, no network, no downloads, no
navigation. A stopped reply or a quit closes it at once. On Windows it draws offscreen: Windows
hardly draws a window that is never shown, so a screenshot of one can wait for a frame that never
comes.

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

## Tabs and panes

A tab holds one to three panes side by side (`app/lib/layout.ts`, `app/components/Panes.svelte`),
and side by side always means a document with what the student keeps beside it: the tutor, a
note or another document. Every other place (Home, a course, study notes, Chats, the Library,
the board) fills its tab, and a split left with no document gives way to its active pane
(`tidy`, applied to every navigation and to a restored workspace). The sidebar fills the tab
whatever it opens; "Open beside" on a file puts it beside the document the tab was reading
last. Only what sits beside the document has its own Close and Maximize; the document closes
with its tab, and its header shows or hides the tutor (⌘J). A tab's history is a history of
these layouts, so Back undoes the last navigation, a pane opened or closed included; turning a
page, resizing or maximizing a pane is no step of its own. Each pane's share of the width is
part of the layout, held above each pane's minimum (more for a page than for a chat or a note);
a window too narrow for every pane shows the active one, with the others as chips above it. The
open tabs and their current layouts are saved in `workspace.json` (version 2; a version 1 file,
from before panes, opens with the reader's old panel as a pane beside the document), and
restoring them never starts model work.

A chat on its own shows in Chats, with every chat listed beside it, newest first; with none
chosen, a new one. A chat about a lecture opens beside it again from its header ("Open beside"),
or with ⌥-click in the list. Notes works the same way, with the open note beside its list.

A chat follows the document pane in its tab used last. Each question carries that document's
page, as long as the chat may read it, and the chat remembers the document and page as the
student reads (`setFocus`), so opening the chat later, from anywhere, puts it back beside that
page. A question asked with no document beside the chat leaves that memory alone, and says
itself that nothing is open. Explain and Ask… go to the tab's chat, opening one beside the
document if there is none; "Add this page to a note" and "Quote to notes" go to the tab's note
the same way. A chat for another course gives way to a new chat for the document's own course,
since a course chat can't read beyond it.

On Windows and Linux the system draws its own window buttons over the tab strip's right end
(Electron's `titleBarOverlay`), on an all but transparent background with symbols in the strip's
icon color for the theme shown (`setWindowTheme`), and the strip leaves them room; the menu bar
shows only while Alt is held. Shortcuts are written the Mac way and shown there with Ctrl, Alt
and Shift (`app/lib/keys.ts`); they answer to Ctrl wherever they answer to ⌘. The browser
preview shows that layout with `?platform=win32`.

What the student is writing to a chat belongs to the chat, not to the pane: it stays through tab
switches and a restart until it is sent (`app/lib/drafts.ts`, in the window's storage on this
device, the most recent hundred). Pages and images added to it last until Folio closes.

## Chats and what they may read

There are three kinds of chat, fixed when a chat is created:

- **Course chats** read one course: its documents, its study notes and the student's notes in it.
- **Library chats**, started from Home, may read any course and work out which one a question is
  about.
- **Plain chats** read nothing. Only chats from early builds are plain.

The tutor's tools (`list_documents`, `read_page`, `search_course`, `read_sections`,
`related_sections`, `topic_map`, `list_notes`, `read_note`, `create_note`, `edit_note`,
`rename_note`, `view_note` and `add_note_figure`) check every
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

A PDF or Markdown file the student drops in a chat, or adds with **+**, is copied into `files/`
under its hash, read-only, and recorded on their message like anything else they add. The tutor
reads it with `read_page` in that chat only; reading it never adds it to a course. `add_file`
adds it when the student asks, through the same import as Materials.

`read_page` returns the page's text and the page itself as an image, so diagrams count; with a
`region` (fractions of the page), a sharper close-up of part of it instead. Every
request resends the conversation, so at most the six most recent messages with images keep them,
and earlier ones say an image was there. Older images are let go five at a time rather than one
per new image, so most requests repeat the one before.

In a PDF page's text, `read_page` marks bold `**…**` and italic `*…*` from the fonts' own names
(`Calibri-Bold`, `Arial,Italic`, TeX's `CMBX10`), never in math fonts, so a copy keeps the PDF's
emphasis exactly instead of guessing it from the image. pdf.js names a page's fonts only once it
lays the page out, so the page image is drawn first. Only `read_page` marks them: ingestion,
study notes and search keep the plain text layer.

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
stream, keeps only https links, and saves them with the tool's result. The reply links each
web claim where it makes it; under it, one folded line ("Searched the web · 4 pages") opens the
full list, apart from course sources. Links open in the system browser.

### Routines (skills)

A routine is the student's own instruction for how the tutor works, such as a way of quizzing
or explaining: a folder with a `SKILL.md` in the open Agent Skills format (a name, a description,
then the instructions), plus any files it refers to (`src/skills/`). Folio reads its own routines
in `~/.folio/skills/`, which are on, and routines in folders the student adds, which stay off
until turned on in Settings. It never looks in other apps' skill folders (`~/.claude/skills` and
the like) unless the student adds one. Switches and added folders are in `config.json` under
`skills`. A
skill without a description, with YAML that doesn't read or a name that isn't lowercase letters,
digits and hyphens is skipped, and Settings says why; among routines that are on, the first of a
name is used.

The tutor sees one tool, `use_skill`, whose description lists the routines it may pick (name and
description, within 8,000 characters), and loads one when it fits. A routine marked
`disable-model-invocation` is the student's to start. `use_skill` also reads a text file the
routine lists, only inside the routine's own folder (its real path, so links can't lead out), at
most 128 KB and never binary. Folio never runs a routine's scripts.

Typing `/` at the start of a message lists the routines that are on. A question started with
`/name` carries the routine's text as it was when sent, and a `folioCommand` record that shows it
as a chip on the question; editing the routine later never changes an earlier chat. A routine is
an instruction about how to work, never a source: it can't widen what a chat may read.

### Services (MCP servers)

The student can connect services, such as their university's Moodle, as MCP servers
(`src/mcp/`), with Folio as the client through Pi's MCP library. Servers are listed in
`~/.folio/mcp.json` (`0600`) in the common `mcpServers` shape, so a block from a server's README,
Claude Code or Claude Desktop pastes in as it is, with a `folio` block per server for what Folio
adds: its label, whether it is on, and which tools run without asking. A server added in Settings
starts off, so the student sees its full command line before it first runs. The values of its
settings (`env`) and headers never leave the main process: the window sees their names only, and
any of those values in a result, an error or a log reads `[hidden]`.

- **Local servers** run as the student's own programs in a clean environment (the login shell's
  PATH, read once with a time limit so commands installed with uv or Homebrew are found, plus the
  server's own settings, never Folio's), each in its own folder in `~/.folio/mcp/<name>/`. On
  Windows the PATH is the one Folio was opened with, a command is found by the extensions
  PATHEXT lists (`npx` is `npx.cmd`), and the environment adds what Windows programs need, such
  as `SystemRoot`. A server
  that stops is started again after 2, 10 and 60 seconds, and left failed after a fourth stop in
  ten minutes until the student restarts it. Closing Folio closes every server's process group.
- **Remote servers** (`"type": "http"`, https or this Mac only) are reached over Streamable HTTP
  with the headers the student gives, such as a token. Signing in to a remote server with OAuth is
  not built yet; Folio says so plainly, as it does for a token that is refused.

Each course and library chat gets the tools of every server that is on, named `server__tool`,
alongside Folio's own; the list is rebuilt for each question, and a server's last list of tools
is kept so one still starting offers the same tools and the request keeps its cached start. This
is a deliberate exception to course scope, chosen by the student: a server reaches whatever its
own account can see. Folio never hands a server its own files; a server gets only what the tutor
writes into a call, which is checked in code first (at most 16 KB, no path inside Folio's folder,
at most 20 calls in a reply).

Unless the student allowed the tool, or the whole server, a call waits for them inside the reply:
a card shows the server, the tool and exactly what Folio will send, with Allow once, Always allow
(saved in `mcp.json`) and Deny; it is listed under Needs you too. What a server says about its own
tools (read-only, destructive) is shown, never trusted. Stopping the reply while a card waits sends
nothing; approvals are never saved, so after a restart the reply is interrupted and the call never
runs. What a server returns is labelled as coming from outside Folio and never as instructions,
capped at 40,000 characters and four re-encoded images, and never ingested as course material.

A server's prompts appear in the `/` menu as `/server:name`; one with arguments shows a small form
in the composer, and its text goes with the question labelled as the service's, saved like a
routine.

## Connections and models

Folio reaches models through five connections: the ChatGPT plan, signed in through the browser,
and API keys for OpenAI, Anthropic, Google Gemini and OpenRouter (`src/model-refs.ts`). Pi keeps
one credential per provider, so the OpenAI API is a provider of its own (`openai-api`, with the
catalog's OpenAI models under it), and Pi never takes one of its requests for a ChatGPT sign-in.
Each key provider resolves only the key saved in Folio: never one from the environment, another
app's files or a provider's own sign-in. A key is checked with its provider before Folio keeps
it, by a request that lists models or describes the key, and the provider's answer is never
shown; it then goes in `keys.json`, apart from the ChatGPT sign-in, and never back to the window.

Folio signs in to ChatGPT itself (`src/chatgpt-sign-in.ts`), as OpenAI asks open-source apps to.
The first sign-in registers Folio with the student's account; OpenAI issues a client ID, which
Folio keeps with the account's verified identity in `connection.json` and reuses for every later
sign-in, sending the installation ID as the agent host. Signing out ends the renewable session at
OpenAI (when OpenAI doesn't confirm it, Folio says so) and forgets the tokens but keeps the
registration, so ChatGPT's settings list one Folio however often the student signs out and in.
The ID token is checked against OpenAI's keys before anything is saved, a returning sign-in must
come back for the same registration and the same account, and one that comes back without use
of the plan makes the next sign-in ask for consent. Pi renews the tokens.

A model is named by a reference, `connection/model` (`chatgpt/gpt-6.1-sol`,
`openrouter/deepseek/deepseek-v4-pro`), and a chat saves its provider and model and keeps them.
The composer offers, per connection, the plan's checked models, a short list of current models
for each key, and the OpenRouter models the student picked, grouped by lab; a model that reads
text only is marked, and the tutor on one gets a note where a page image would be. The main
process refuses any other model, and asks for the connection a chat's model needs before it
sends.

OpenRouter adds models faster than Pi releases, so Folio also reads Pi's live list, as Pi's own
app does (`src/live-catalog.ts`): pi.dev publishes each provider's models between releases, and
answers a request naming Folio's Pi release with a list that release can use. Folio asks for
OpenRouter's a moment after the window opens and again when its copy is four hours old, with the
copy's ETag; the copy is kept in `catalog/openrouter.json` and read before `config.json`, so a
model picked from it is known offline. The list is used only while it is newer than the one built
into Pi, and a live entry replaces the built-in one with its ID, as in Pi. It comes from outside
Folio, so each entry is checked against Pi's own schemas and kept only as a chat model on an API
the built-in OpenRouter provider speaks, at the address its built-in models use; its headers and
anything else are dropped. Every request still goes to OpenRouter with the student's key and
nothing more; the request to pi.dev names only the provider and Folio's Pi release. Offline or refused, the
copy stays; when the list changes, `config.json` is read again and the window is told. It is
fetched with Node's fetch, like model requests: Electron's `net` goes through the window's
session, which refuses every web request. `FOLIO_MODEL_CATALOG` names another source (an https
address, or one on this Mac) or turns it off, as the window tests do.

Which model does what lives in `config.json`, edited in Settings or by hand (`src/config.ts`):
the tutor for new chats, web search, each step of studying (planner, reader, close-up, writer,
checker, recheck, topics) and reading a syllabus. Folio checks every entry in code: the model must exist
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
never studied. Studies run two at a time, sharing one pool of requests so that one's waits are the
other's turn: what the student asked for first, then new files, then the backlog, then redos. Each
step runs on the model set for it (see [Connections and models](#connections-and-models));
without a connection one of them needs, studies wait and start when it is there. A study the
student cancels is not started again unless they ask. A file that moves to the Trash, leaves its
course or stops being a lecture has its study stopped first, and Folio waits until nothing reads
it any more before it moves; its study notes leave the course with it.

The student follows this, and nothing more: the Studying place lists what is being studied now,
each with one line of what Folio is doing and a bar, then what comes next in the order Folio will
take it. One line appears only when something needs them (no connection, a used-up plan, a study
that stopped). Finished studies leave the list, and no page counts what has been studied; a
course page shows a single "Studying …" line under its name while Folio works on that course.

A study job plans the lecture and reads it at the same time. One request reads the lecture's whole
text and the pages with the least of it, and returns the topics in teaching order with every page
each spans (about six pages at most, so no writer takes long), its notation and its Hebrew–English
terms. Meanwhile every page gets one careful reader of its own, many side by side: the reader writes
out every region, every diagram's nodes and arrows, a chart's values, a table's cells and what is
drawn inside any picture, including one that fills the page behind the text. A region is read again
up close only for a reason code can name: the reader skipped it, flagged it unreadable or said it
guessed; it is a picture the reader could say almost nothing about; or the reading lost words or
numbers the text layer has. One request re-reads all of a page's hard regions. Once the plan is made
and a topic's pages are read, a writer takes that topic, carrying every fact of its pages, beside
the writers of the other topics and the pages still being read; code joins their drafts into one, in
the plan's order. A lecture of one topic has a single writer. An independent checker goes through
every page that teaches something, one page per request, as soon as every topic on that page is
written (while the other topics are still being written), with the notes written so far in front of
it; once all are written, it checks what is left, such as a claim citing a page outside its topic:
for each region it lists the facts the region teaches and names the section that carries each one,
in any language or wording, and it tests the notes' claims against the page images. Code keeps the
books. A region no section cites whose every fact is carried somewhere gets a citation from those
sections; a region the checker could not make out is read again up close. What the check stands
behind becomes a numbered list of discrepancies: regions no section cites (read again up close
first, if no close-up has read them), facts no section carries, claims the checker doubted, and
citations of regions that do not exist. Fixers take that list a few discrepancies each, side by side
(those touching one section together); each sees only its discrepancies, the sections they concern,
the readings of the regions involved and those pages, and answers with patches: replace a section,
add one to an existing topic, or omit a region as page furniture. Code applies a patch only if it
names what it fixes, touches nothing else, leaves every cited region cited and is the only patch on
its section, so every other section stays exactly as written; then only the claims a patch changed
are checked again. There are at most two rounds, and none once a round stops reducing what is wrong
or changes nothing. How much of a cited region's wording reaches its section (often little, when
English notes explain a Hebrew slide) is recorded, never acted on. Word matching folds what a PDF's
text layer encodes differently (NFKC: math-italic letters, subscripts, ligatures; direction marks;
final letters), as the search index does. Whatever is still uncited, or has facts the check found in
no section, or was left by a fix that could not be had, is written up from the slide itself, as a
cited section marked as not reviewed, so no part of a slide is dropped. A sentence the page
contradicts leaves its section; every claim still unconfirmed is kept on its section for the tutor,
never shown to the student as a warning. Every region ends up cited, or omitted as page furniture
with a reason (page numbers, repeated headers, build steps, duplicates); the student never sees this
accounting, which is a record for diagnosis. The result is published as a new, immutable version of
the course's knowledge, with a SQLite FTS5 search index. Each document is a session numbered across
its course (by the file's number), keeping the course's prefix when the course is renamed, and a re-studied
document replaces its own session. Each step's output is saved, so a job interrupted by a quit or a
plan limit resumes where it stopped instead of starting over; after a quit, interrupted studies go
back in the queue on their own.

Every step takes its turn for one pool of sixteen model requests in flight, writing and checking
ahead of pages still waiting to be read. Each step has its own model and effort. By default
GPT-6.1 Sol plans, writes, checks and fixes at high effort, and reads pages at medium, one careful
request per page (more effort on a page makes reading slower, not better); GPT-6.1 Terra rechecks
the few claims a fix changed, which on a real lecture it did as well as Sol in less time.
`config.json` chooses another model for a step; `FOLIO_STUDY_PLANNER`, `_READER`, `_WRITER`,
`_CHECKER`, `_RECHECKER` and `FOLIO_STUDY_EFFORT_<STEP>` change a step's model or effort for a
trial, and `vp run study:compare` measures a cheaper reader or rechecker against it on the
student's own files. A request whose stream is cut off is sent again, like a dropped
connection. Every request about one document carries the same prompt-cache key, so the provider can
reuse the instructions and pages they share; each step records how much of its input came from that
cache. A request turned away by a short rate limit waits (10, 30, then 60 seconds) and goes again,
while the plan's usage limit pauses the study. `FOLIO_STUDY_CONCURRENCY` and `FOLIO_STUDY_JOBS`
raise the pool and the number of studies at once, to try what a plan allows.

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
  written again whenever those sections change, also when a file leaves the course or comes back.

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

A note can be a faithful copy of a handout, such as a homework workbook, and both views draw it
the same way:

- A container opened on its own, such as `<div style="background-color:#ffb9bb">` with Markdown
  and math inside and a blank line around them, draws as one block in the editor too. A colored
  block that sets no text color gets a readable one, so it stays legible in dark mode.
- A heading may carry HTML, such as a centered, underlined title; the note's title and outline
  read its words without the tags.
- Math is drawn at the reading size (`--reading-math`), and an inline formula breaks between its
  terms in a left-to-right line. One still wider than its line scrolls inside itself
  (`app/lib/wide-math.ts`) instead of pushing the page sideways. KaTeX's stylesheet sits outside
  Tailwind's layers and would beat any rule inside one, so Folio's rules for KaTeX's classes sit
  outside them too.
- A note shows emphasis as written, italics included, in both views; Folio's own interface and
  replies set no italic type. Empty lines beyond the one between two blocks keep their height
  when read, as in the editor: the space a workbook leaves for an answer.
- Figures are image files beside the course's notes, named by their SHA-256 and written
  `![What it shows|360](assets/<file>)`, the number being the width (`src/library/note-assets.ts`).
  A figure sits in its line, so a centered block centers it.
  A figure is never deleted with a note, so undo, history and the Trash find it where it was. A
  figure the tutor cropped but never placed stays in the folder too; a later sweep may clear the
  figures that no note, earlier version or Trash entry names.

The tutor can look at what it wrote. `view_note` draws a note in the edit view or the read view,
with the very components the note view uses (`NoteReading.svelte`, `createNoteEditor`), and cuts
it into pictures 784 pixels wide, between blocks, with which lines each shows. A close-up of a
passage comes at twice the size. The drawing also says what looked broken: a formula KaTeX
can't draw, anything wider than the column, HTML shown as text, a figure that doesn't load, a
colored block hard to read in either theme. `add_note_figure` crops a region of a course PDF
page into a figure and returns the Markdown that shows it, as wide against the note's column as
it was against the page's text column (measured from the text layer); placing it is an ordinary
`edit_note`, which the student can undo. A reply may look at notes 48 times and add 12 figures.

All notes live in one notebook, a place of its own in the sidebar: a list grouped by when each
note last changed (pinned notes first) beside the open note. Courses are the folders and `#tags`
cut across them; a course's Notes tab is the same list filtered to it. Search reads every note's
text in the main process with the same Hebrew normalization as study-notes search, and ⌘O finds
a note by title or creates one. Folio reads a note's preview, tags, links and cited pages from
its Markdown each time it lists it (`src/library/note-meta.ts`); nothing about a note is stored
apart from the note. The bottom of a note lists the course's other notes that link to it and
those that only name it, and "Link" turns such a mention into a link as a revision-checked save.

A note can sit in a pane beside a document, or between the document and its chat. Narrow, the
notebook there shows only the note, with the others in a menu. "Add this page to a note" and
"Quote to notes" write into it as the student's own undoable edit, as a link back to the page
(`[[page:<document>#<page>|Lecture 3 · p. 12]]`), and the notes that cite a document are offered
first beside it. A tutor's reply is saved to a note only when the student chooses "Save to note",
with a line linking the chat (`[[chat:<id>|title]]`) and the pages it cited; Undo takes it back
out while the note is still as that save left it.

### Changing Folio from a chat

The tutor can do what Folio's own controls do: create and edit courses, rename files and change
their numbers or categories, add a file from the chat, move files or a course to the Trash, edit
categories and naming patterns, choose a step's model, and start or stop studying. Its tools call
the same operations as the window (`src/library/operations.ts`), so neither can skip a step such
as studying a new lecture or taking a file's study notes out when it stops being one. Each change
is plain data (`src/library/app-actions.ts`), checked again whenever it runs.

How far the tutor may go is decided in its tools' code, not the prompt:

- **Done, with Undo.** One reversible change where nothing is lost, such as a rename, a number, a
  category of the same kind, a new course, an added file or up to five files to the Trash. A card
  under the reply says what changed; Undo refuses if what it changed has changed since.
- **Asks first.** More than five files at once, anything that drops study notes, a move to
  another course, a course to the Trash, removing a category, and a step's model. Nothing happens
  until the student presses Apply in the card (also listed under Needs you), which checks the
  change again; the tutor is told the answer with the student's next question.
- **Refused.** Deleting for good, emptying a course or more than one course per reply, and keys,
  sign-in and connections, which no tool reaches.

A course chat changes only its own course, moves files only to courses it can read, and adds only
files the student added to it; a library chat may change any course. Reopening a chat never runs
a change again.

## Categories, numbers and names

What a degree calls its course files is the student's: one list of categories for the whole
library, in `config.json` under `library.categories`, edited in Settings or by hand. Each has a
stable ID, a name and a plural, the words that place a new file in it (`R` before a number puts
R01 among recitations), an optional naming pattern, and a kind, one of Folio's five roles, which
is what Folio does with its files: study them, pair them with lectures as practice, put them on
the board, keep them as solutions, or keep them as files. Today's five categories are the
default. A file records its category beside its role, so older builds still read it by role; a
category with files in it can be renamed or reordered but not removed or given another kind.

Every file has a number: what orders it in its category, from the first number in its name (past
the course code's digits and years) or the next free one. Studying numbers and pairs sessions by
it. A pattern such as `{category} {n}` names new files from their category, course and number;
`library.naming` is the default and a category's own pattern overrides it. Names that follow a
pattern follow its changes, a renamed course or a new number, until the student renames the file
by hand. Files that came in earlier keep their names until the student renames them to match,
which can be undone. Renaming never studies a file again: study notes, sources and chats find a
file by its ID, and page links in notes show its current name.

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
| `connection.json` | The ChatGPT sign-in, Folio's registration with ChatGPT, and the installation ID |
| `keys.json` | API keys, each checked with its provider before it was kept |
| `config.json` | Which model does what, the OpenRouter models the composer offers, the student's categories and naming patterns, and which routines are on; never a key |
| `catalog/openrouter.json` | Pi's live list of OpenRouter's models, as last checked, with its ETag |
| `release.json` | Whether Folio checks for a newer release, and GitHub's latest release as last checked |
| `skills/<name>/SKILL.md` | The student's own routines |
| `mcp.json` | The student's MCP servers, with their settings and headers, and which tools run without asking |
| `mcp/<name>/` | Each local server's working folder, and its last list of tools |
| `sessions/<id>.json` | Each conversation |
| `files/<hash>.pdf\|md` | Files the student added to chats, read-only |
| `pending/<id>.json` | Changes the tutor proposed, waiting for the student or answered |
| `library/` | Courses, read-only originals with their hashes, notes with their history, and suggested edits |
| `library/assignments/<id>/` | Each assignment's record and the files handed in or back |
| `library/courses/<id>/notes/assets/` | Figures in the course's notes, each named by its SHA-256 |
| `library/courses/<id>/kb/generations/<n>/` | Each published version of a course's study notes |
| `library/kb.sqlite` | Which version of each course's study notes is current |
| `jobs.sqlite` | Study jobs and the saved output of their steps |
| `trash/<id>/` | Removed items, kept for 30 days |
| `workspace.json` | Open tabs and their panes |

Writes are atomic: a complete file is written and flushed beside the old one, renamed over it,
and the folder flushed too, so the rename survives a crash. Every flush goes through
`src/files.ts`: `flush` for a file, and `openDatabase` for a SQLite database that waits for the
disk on every commit. `FOLIO_FLUSH=off` skips that waiting, so a crash or a power cut can lose
the last writes. Only the unit tests set it. Windows can't flush a folder, and
journals the rename itself, so there the folder is left alone. Windows also refuses the rename
while anything has either file open, such as an antivirus scan or another reader, so there Folio
tries again for about three seconds, checking the file again before each try. Revision and hash checks refuse
edits made elsewhere instead of overwriting them, and a chat open in one process refuses writes from another. Session files are versioned and
pin the Pi runtime and transcript format they were written with.

## The packaged app

`vp run desktop:package` builds the renderer and the main process from a copy of the source, so a
Folio running from the checkout keeps its files, and electron-builder makes
`release/mac-arm64/Folio.app` and a disk image for Apple silicon (`scripts/package.ts`). On
Windows it makes `release/win-unpacked/Folio.exe` and an installer for x64,
`Folio-<version>-x64-setup.exe`, which installs for the student alone, with no administrator,
into their own programs folder with a Start menu entry. Its icon is the same drawing at 256
pixels, and it is unsigned unless `CSC_LINK` names a code-signing certificate, so SmartScreen
warns before its first run.

- The app's archive, `app.asar`, holds the main process, its preload, the renderer and only the
  packages the main process loads: those are `dependencies` in `package.json`. The renderer's
  libraries are `devDependencies`, since Vite already bundles them. The native canvas module sits
  unpacked beside the archive, and pdf.js keeps its legacy build, fonts, CMaps and decoders.
- Electron's fuses make the app run only its own archive, checked against a hash in its signed
  `Info.plist`, and ignore `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS`. The inspector flags stay on
  so the real-window checks can drive the packaged app (`FOLIO_E2E_APP=…/Folio.app`).
- On a Mac it is signed ad-hoc with the hardened runtime. `CSC_NAME` or `CSC_LINK` signs it with a
  Developer ID instead, the disk image too. That build encrypts its cookies and loads only
  libraries signed by its own team, which an ad-hoc signature can't do. With an App Store Connect
  API key in the environment as well, Apple notarizes the app and the disk image, each gets its
  ticket stapled, and the build checks both as Gatekeeper will on another Mac.
- CI builds releases and the nightly that way, from secrets in the `signing` environment, which
  only `main` and `v*` tags may use, so a pull request's build never sees them.
  `FOLIO_NOTARIZE=1` makes a build fail rather than come out unsigned when a secret is missing.
- A Developer ID build also makes `Folio-<version>-arm64-mac.zip` and `latest-mac.yml`, the
  update an earlier Folio downloads, and checks them: the file names the zip with this version
  and its checksum, and the app inside is signed, and once notarized carries its ticket. The
  release workflow attaches both to the release. `tests/electron/self-update.e2e.ts` installs a
  real update between two such builds made on one Mac.

`vp run desktop:install` then puts the app in /Applications (`scripts/install.ts`). It refuses
to replace an app with another bundle ID, and to run while a copy of Folio runs from anywhere
else; asks the Folio running from Applications to quit, by a signal to that process alone, and
waits for it; copies
the new app beside the old one, checks its signature, and swaps it in by renaming, so there is
never a half-copied app; a Folio that was open opens again. An app built on the Mac is not
quarantined, so it opens without Gatekeeper's prompt.

CI (`.github/workflows/ci.yml`) runs the checks and unit tests on Linux, and on macOS the
real-window checks, then the same checks on the packaged app and the install checks
(`tests/electron/install.e2e.ts`). On Windows it runs the unit tests and the real-window checks
on a fresh build, and packages Folio to run the same packaging checks as on macOS on
`Folio.exe`, then opens it and asks it to close. Both are part of the CI check, so nothing merges
before Windows passes too. The unit tests don't wait for the disk after each write
(`FOLIO_FLUSH=off`, set in `tests/setup.ts`), except the ones that check the flushing itself. On
GitHub's Windows runners the temporary folder is on a disk where one flush takes about 4 ms, and
the thousands of flushes, most of them SQLite commits, took most of the tests' time and ran some
past their limits. Tests that write many small files still run several
times slower there, so a test gets 20 seconds on Windows, and checks of a file's permissions
look only at whether it may be written (`tests/fixtures/modes.ts`), which is all Windows keeps.
A test's wait for background work gets three seconds, five on Windows (`tests/setup.ts`), since
GitHub's runners are busy machines. A wait that sets its own time for heavier work, such as a
whole study job or a chat of dozens of saved turns, gets three times that on Windows
(`tests/windows.ts`), where that work runs ten to twenty times slower than on a Mac. Electron's
binary, and electron-builder's tools where a job packages Folio, come from downloads kept between
runs for each lockfile
(`.github/actions/electron`), because GitHub's release downloads time out now and then. Electron's
is kept as soon as it is fetched, so a job that fails later still keeps it. Installing Electron and
packaging run through `.github/scripts/retry-downloads.sh`, which runs them again for four minutes
when GitHub answered a download with a server error, then says GitHub's downloads are down; any
other failure fails at once, so a check is never tried again. Only GitHub's own files are used:
`install.js` checks Electron against the checksums its package ships, and electron-builder checks
its tools against its own.

After a push to `main` that changes the app, once its checks, tests and builds pass, CI builds
the app for others (`FOLIO_DISTRIBUTE=1`: the inspector flags off) on macOS and on Windows, and
opens each on an empty home and quits it. The macOS job then replaces the disk image on the
rolling `nightly` pre-release, moves its tag to that commit and writes its notes. The Windows job
waits for it and then replaces the installer beside it, unless a newer push has moved the tag on
meanwhile, so the two downloads are always from one commit. The download link never changes, and
there are no versioned releases to cut. A push that changes only docs, templates or unit tests
rebuilds neither. The real-window job reports on its own and does not hold the nightly back: those
checks were written on a Mac much faster than GitHub's virtual ones.

On a pull request from this repository that changes the app, CI also retakes the README's
pictures on macOS (`vp run screenshots`). A still picture is replaced only when it looks
different (more than 50 pixels off by more than 8 in a colour channel, since Chromium draws the
same page a few values apart from one version to the next), and the clip, which is recorded in
real time, only when a picture changed. The pictures that changed are committed to the pull
request's branch, so they are reviewed with the change. A push with the workflow's own token
starts no workflow, so the job then starts CI on that commit itself (`workflow_dispatch`):
`main` requires the CI check on a pull request's latest commit. GitHub also holds a
`pull_request` run of that commit for approval; it runs nothing and can be left alone.

Nothing in the pictures comes from the Mac that takes them. The page is drawn at twice its size
by Chromium's emulation and captured by Chromium (`Page.captureScreenshot`), since Playwright's
screenshot of an Electron window takes the screen's own scale, once on GitHub's Macs, which have
no Retina screen; a picture of another size is refused. The scrollbars are hidden, since macOS
draws them by its own settings, and so is the caret, which blinks. GitHub's Mac draws text a
little differently from a newer macOS, so the pictures CI commits are the ones the README keeps:
elsewhere, `vp run screenshots` puts the pictures that changed in a temporary folder, and only
`--write` puts them in `docs/images`. The rule for "looks different" is in
`scripts/picture-difference.ts`, with its tests. The CI check waits for the pictures job but
not on its result, so a picture that doesn't come out holds no change back; if its commit went
through but starting CI on it failed, the pull request waits for a CI check, which shows.

Claude reviews every push to a pull request from this repository: the whole pull request the
first time, then only the changes since its last review, rechecking the serious findings it left
open. A finding is serious only when it is a real bug, a broken promise or a security hole in
lines the pull request changed; everything else is a note. Claude answers in JSON
(`--json-schema`), and `scripts/review.ts` posts that as one comment on the pull request. The
comment carries the review itself, as JSON in an HTML comment that GitHub doesn't show, and the
next review continues from the newest one the Review workflow's own token wrote. A branch that
merged `main` since the last review, or lost that review's commit to a force push, is reviewed
whole again against `main`, so `main`'s own changes never come into the diff, and its open
findings are still checked. A commit of only the README's pictures needs no review: the review of
the commit before it covers it. Claude doesn't review drafts, Dependabot's pull requests or other
repositories' branches. The review is advice for the agent and the owner, as Greptile's is in
rstack: nothing waits on it to merge. `main`'s ruleset requires only CI, and the owner merges.

It all runs from `main` (`review.yml`). The "Pull request" workflow, which holds no permissions
or secrets, only signals that a pull request has something new to review (it was opened, pushed
to, reopened or marked ready), and its end starts the Review workflow from `main`
(`workflow_run`). That workflow reviews one commit of a pull request at a time: a signal that
comes while a review runs waits for it, then finds that commit reviewed. Claude reviews in a job
of its own, which only takes this repository's branches. It can read and search the checkout and
the diff and commit log in `/tmp/review`. It loads none of the settings, hooks or MCP servers a
pull request brings (`--setting-sources user`, and `.claude`, `.mcp.json`, `CLAUDE.md` and the
other files the Claude action restores from the base branch on a pull request event are removed
here). Only Claude's answer leaves that job. The last job posts the comment, or, when the review
couldn't run after a second try, a comment that says why; the next signal tries again.

The `@claude` workflow uses the thread context and images the action collects. It can read and
search the checkout and `/tmp/github-images`, and uses the action's comment tool to reply. Both
workflows limit file tools to their working directories and also exclude by name `.git`, where
the pinned action puts its GitHub token, `/proc`, where the process environment can be read,
the runner's temporary folder, and Claude's and gh's own folders. Each lists its denies in one
`--disallowedTools` flag, so none depends on how repeated flags are merged. The review's
arguments are made in the start job, so they name the runner's temporary folder as that job
sees it; both jobs run on the same kind of runner, which the tests check. Both deny shell
access, including the Git commands the action adds for `@claude`. Claude Code enforces these
rules at the tool level and still uses the OAuth token in its process environment to
authenticate.

What the review can't stop. A pull request's own workflows hold the same kind of token as the
Review workflow, so one that adds a workflow could post a comment that looks like a review, and
text in a pull request can talk Claude into a clean review. Either would only mislead the agent's
loop and the next review: nothing merges on a review, and the owner reads the pull request before
merging it.

The agent shipping a change waits for each round with `scripts/wait-for-review.ts`, which the
`ship` skill in `.agents/skills/` runs: until every check on the pull request's newest commit has
finished, and the review of that commit, or of the one before CI's pictures, is in. It lists the
failed checks, the serious findings still open and the notes, and ends with an exit code for
what's next: nothing to fix, something to fix, or stuck. A review that couldn't run counts only
once a second look still finds no Review run of that pull request under way (each run is named
after its pull request's number, or its branch when GitHub leaves the number out), since that run
may be its retry. A pull request Claude doesn't review
finishes on its checks alone. It asks GitHub through the gh CLI, prints a line
whenever something changes, and never merges: its gh runs only `pr view` and reads through `api`,
and refuses anything else. The agent fixes what's right and pushes
again, for three rounds at most, then gives the owner the pull request's link. Agents merge only
when the owner tells them to, and then normally, pinned to the commit that passed
(`gh pr merge --squash --match-head-commit`).

Every agent reads one guide. Codex and Cursor read `AGENTS.md` from the root, and Claude Code reads
`CLAUDE.md`, which only imports it, so a Claude session in a worktree outside the owner's
checkout gets the same rules. `AGENTS.md` itself says how to isolate a task before its first
edit, because a skill's description doesn't always reach the agent: with many skills installed,
Claude Code lists some by name only. `tests/agent-guide.test.ts` holds the guide to that, and
checks that every skill has its link in `.claude/skills/` and that the guide's links resolve.

A quit signal (SIGTERM, as the installer sends) quits Folio as ⌘Q does: chats settle first.

Folio says when a newer release is out (`src/releases.ts`). The
window asks the main process a moment after it opens and then every
hour; the main process asks GitHub's public API for the repository's latest release only while
**Updates** is on in Settings → General and its last answer is a day old, or an hour after a
check that failed. The switch and the answer are kept together in `release.json`, so the choice
is the main process's, not the window's: turned off, a request under way is stopped and an
answer that still arrives is dropped. The request has no account and carries nothing about
the student. The answer's tag must be a semantic version, and is compared with the app's own,
from `package.json` (a packaged app reports it; a run from the checkout reads the file). GitHub's
latest release is never a pre-release, so the nightly, which carries the version of the release it
follows, hears of the next release and never of newer nightlies. `FOLIO_RELEASES` names another
source, or `off`, as the real-window checks set it.

On a Mac, a release or nightly build updates itself when the student asks (`src/self-update.ts`):

- The sidebar's line reads "Folio 0.3.0 is out · Update". Nothing downloads before that click.
  The click downloads the release, the line shows the percentage, and then it reads "Restart to
  update". Restarting, or simply quitting, installs it. Settings → General shows the same steps,
  with a link to the release's page.
- `src/desktop/updater.ts` hands the download to electron-updater, pointed at the folder of the
  release the check found: `releases/download/<tag>/` on GitHub, built from the tag
  (`FOLIO_RELEASE_DOWNLOADS` names another folder, for the checks). It reads the release's
  `latest-mac.yml`, refuses one that names another version, and downloads the zip it names,
  checked against the checksum there. macOS's own updater (Squirrel.Mac, under Electron's
  autoUpdater) then installs the app in the zip only if it is signed by the same Developer ID as
  the running Folio. That signature is what keeps another app out, since the checksum comes from
  the same release.
- The download goes through Electron's network stack in a session of its own, with no cookie or
  account, and carries nothing about the student. It is the whole zip each time.
- Restart quits as ⌘Q does, so running replies settle as interrupted first; the window asks
  before restarting while one is being written. Turning **Updates** off stops a download under
  way; one already downloaded still installs when Folio quits.
- Only a Developer ID build updates itself. `scripts/package.ts` gives it `app-update.yml` and
  makes the zip and `latest-mac.yml` beside the disk image, and the release workflow publishes
  them. Folio also has to replace itself where it is, which it can't from the disk image or from
  a copy macOS runs from elsewhere because it was opened in Downloads. On Windows, from the
  checkout, or in an ad-hoc build, the line links to the release's page instead, which opens in
  the system browser.

The packaged app keeps its data where the development build does, in `~/.folio` (or `FOLIO_HOME`).
One Folio runs on a home at a time: opened while another runs there, Folio quits before it opens
anything in the home, and the one already open comes forward.
