---
name: build
description: Use while writing a Folio change, after isolate and before prove. Keeps code inside the boundaries docs/architecture.md describes, and says when shared work earns its own function or module, only for repeated mechanics or a concrete boundary, moved one caller at a time.
---

# Build

Build by the rules in [AGENTS.md](../../../AGENTS.md) and the boundaries in
[docs/architecture.md](../../../docs/architecture.md). Folio already has a structure. Follow it
before inventing one.

## Where code goes

- The main process owns the files, the model connection and every check on what a chat may read.
  The renderer (`app/`) shows things and asks through the typed API in `src/desktop/api.ts`. It
  never decides scope.
- Each part of Folio's domain has an owner: `src/library/` for courses, documents, notes and the
  Trash, `src/kb/` for study notes, `src/ingest/` for studying a lecture, `src/jobs/` for
  background jobs, and `src/conversation.ts` with `src/session-store.ts` for chats. A rule about
  the domain lives with its owner, not in each caller.
- Pi, the agent runner, and each model provider stay behind their small boundaries
  (`src/conversation.ts`, `src/agents.ts`, `src/connections.ts`). Code elsewhere doesn't reach past
  them into Pi's or a provider's details.

## Flows and shared operations

Keep what a flow means apart from how an operation gets done.

- The flow, such as an IPC handler, a command or a job step, owns the rules: what's allowed, the
  scope checks, the state changes, and which failures the student sees and how.
- A shared operation owns the mechanics, such as writing a file safely, calling a provider,
  running a process or rendering a page. It takes what it needs as parameters, returns a result
  the caller can act on, and makes failure explicit. It doesn't decide policy or change state its
  caller didn't hand it.

## When to extract

- Extract when two flows repeat the same mechanics, or when one caller gains something you can
  name: a seam for a test, a provider kept behind its boundary, a write kept in one place. Name
  the gain before adding the layer.
- Don't extract a single use with no such gain, or ahead of need.
- Prefer small operations a caller can combine over one function that does everything.
- Move one caller, run its tests, then move the rest. Keep the checks, state changes and errors
  each caller had.

## Signs it went wrong

- One large function hides all the control flow.
- An operation changes state its caller can't see, or nobody can say who saves.
- Sibling operations take arguments or report errors in different ways.
- A layer that nothing reuses and no test needs.

Next: [prove](../prove/SKILL.md).
