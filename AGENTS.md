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
  it may read; only the student can.
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
```

## Verification

- Before calling a change done, run `vp check`, `vp run check:ui` and `vp test`, and say what
  ran. Reading a test is not running it.
- Interface changes are checked in the browser preview (`vp dev`) and, when they cross the
  Electron bridge, in a real Folio window: the preview skips that hop.
- Test the hard cases: cancellation, restart and resume, duplicate delivery, edit conflicts and
  scope boundaries.
- Keep deterministic tests, real-provider checks and learning outcomes apart; one does not
  stand in for another.
- Version storage formats and dependencies deliberately; treat provider-native message blocks
  with care, since a transcript migration is never free.
