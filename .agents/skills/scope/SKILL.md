---
name: scope
description: The first step of any task that changes Folio, before any code. Ask the owner every question the task needs up front, then write down what done looks like, so the rest of the work runs without asking. Use whenever the owner hands over a feature, a fix or a change.
---

# Scope

The owner hands a task over and may then be away. A question asked halfway through waits until
they're back, so every question is asked now, while they're here.

1. Read what the task touches: the code, [AGENTS.md](../../../AGENTS.md),
   [docs/architecture.md](../../../docs/architecture.md), and the open pull requests
   (`gh pr list`) in case one already changes the same thing.
2. Ask everything you need in one message: what it should do, what it shouldn't, what the student
   sees, and the hard cases AGENTS.md names (cancellation, restart and resume, duplicate delivery,
   edit conflicts, scope boundaries) where they apply. Put your recommendation with each question,
   so the owner can just agree.
3. Ask whether the owner wants to look before it merges. If they do, the pull request gets the
   `needs owner` label when it opens.
4. Write **Done when**: a short list anyone could check, such as what the student can now do, the
   tests that show it, and the pictures that change. It opens the pull request's description,
   which is public: no course names, no personal details, no quotes from the owner.
5. Once the owner says go, don't ask again. The line ends in one of the states AGENTS.md lists,
   and nothing else is a reason to stop.

## Scaled to the change

- **Small** (a typo, README text, a comment): no questions. Say in one line what you'll change,
  and go, still isolated first.
- **Usual** (a fix or a feature): the steps above.
- **Large or unclear** (a new area of the app, a change to how data is saved): the steps above,
  plus a short written design for the owner to agree to before any code.

Next, before the first edit: [isolate](../isolate/SKILL.md).
