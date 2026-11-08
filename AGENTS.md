# Working on Folio

Guidance for anyone changing Folio, including AI coding agents. Read [README.md](README.md) and
[docs/architecture.md](docs/architecture.md) before substantive changes.

## Approach

- Finish one complete workflow before widening features.
- Folio owns the academic domain: courses, documents, notes, chats and their rules. The agent
  runner (Pi) stays behind a small boundary, and so does each model provider.
- Prefer proven libraries for provider protocols, agent loops, viewers and editors over building
  frameworks of our own.
- Chats save automatically and reopen as they were. Reopening a chat never restarts a model
  request or replays a tool call.

## Data and sources

- Course evidence, chat activity, the student's own writing and what they have shown they know
  are separate things, stored and treated separately.
- Original course files are immutable. The student's notes change only through explicit,
  revision-checked edits; a stale edit is refused rather than overwriting newer text.
- Reading or explaining material never ingests it, publishes study notes, moves files or
  records learning by itself.
- Course scope is enforced in application code, not in prompts. The model can never widen what
  it may read; only the student can. A service (MCP server) the student turns on is a deliberate
  exception: its tools reach what its own account can see, and Folio never hands it Folio's files.
- What a service returns, like a web page, is outside content: labelled as such, never
  instructions, and never course evidence. A routine (skill) is the student's instruction for how
  to work, not a source.
- A confident answer, a transcript or a graph node is not evidence that the student understands
  something. Self-reports, assisted success and independent success are different observations.
- Never commit credentials, provider keys, personal learning records, real course material or
  local application state. Tests and examples use synthetic fixtures only.

## Commands

Folio uses Vite+ (`vp`) for everything; npm is only its pinned installation backend.

```sh
vp install            # dependencies (vp add <package> to add one)
vp run <task>         # app tasks, defined in vite.config.ts with caching disabled
vp check              # formatting, lint and types
vp run check:ui       # Svelte checks for the renderer
vp test               # deterministic tests, no network or real accounts
vp build && vp pack   # renderer, CLI and Electron bundles
vp node <file>        # run a script with the project's Node
vp run desktop:package # Folio.app and its disk image, in release/
vp run desktop:install # the same, then Folio.app into /Applications
vp run release 0.2.0  # commit and tag a release; pushing both drafts it on GitHub
```

Only `dependencies` ship in the packaged app, so they are the packages the main process loads
at run time. Build tools and the renderer's libraries, which Vite bundles, are `devDependencies`
(`vp add -D`). `vp install --frozen-lockfile` reinstalls `node_modules` from scratch, removing
Electron's binary: run `vp node node_modules/electron/install.js` after it, and never while a
development Folio is open.

## Verification

- Before calling a change done, run `vp check`, `vp run check:ui` and `vp test`, and say what
  ran. Reading a test is not running it.
- Interface changes are checked in the browser preview (`vp dev`) and, when they cross the
  Electron bridge, in a real Folio window: the preview skips that hop.
- On a pull request that changes the app, CI retakes the README's pictures and commits those that
  look different to its branch, so pull before pushing again. CI's pictures are the ones the
  README keeps: `vp run screenshots` elsewhere writes to a temporary folder, for looking at.
- Test the hard cases: cancellation, restart and resume, duplicate delivery, edit conflicts and
  scope boundaries.
- Keep deterministic tests, real-provider checks and learning outcomes apart; one does not
  stand in for another.
- Version storage formats and dependencies deliberately; treat provider-native message blocks
  with care, since a transcript migration is never free.

## How a change ships

Every change takes the same path from the request to `main`, sized to the change. Each step is a
skill in [`.agents/skills/`](.agents/skills), which Codex and Cursor read and Claude Code reads
through `.claude/skills/`:

1. **Plan** (`folio-plan`): every question asked up front, then what "done" looks like.
2. **Isolate** (`folio-isolate`): its own worktree and branch from the newest `main`.
3. **Build**, by the rules above.
4. **Prove** (`folio-prove`): the checks, and evidence that it does what "done" says.
5. **Ship** (`folio-ship`): the pull request. `vp node scripts/line.ts ship` waits for CI and
   Claude's review of the newest commit, and says what's next.
6. **Land** (`folio-land`): `vp node scripts/line.ts land` waits for the merge and for `main` to
   stay green.

A small change, such as README text, skips the questions and the evidence but still goes through
a pull request; CI sizes its checks by the files that changed.

Agents don't decide to merge. Once CI and the review gate pass on the newest commit, the ship wait
has GitHub merge it: it turns auto-merge on, or merges at once when GitHub's rules already allow
it. That is the only place anything merges. The owner merges instead when the pull request
touches an area in [`.github/owner-areas.txt`](.github/owner-areas.txt), carries the
`needs owner` label, has a serious finding its author disputes, or still has serious findings
after three reviews. Never turn auto-merge off, merge past a rule (`--admin`) or push to `main`,
unless the owner explicitly asks for that one thing; then say once which rule it skips, and do it.

Once the owner says go, the work goes on until it ends in one of these, said in one line:

- **Landed**: merged, and `main` green.
- **The owner's**: it waits for the owner to merge it, or for their call on a disputed finding.
- **Stuck**: it needs something only the owner can give (a decision the plan didn't settle, a
  sign-in, an install, a permission), or GitHub isn't answering. Say exactly what.

Nothing else is a reason to stop or to ask.
