---
name: folio-isolate
description: Give a Folio task its own git worktree and branch from the latest main, after checking that no open pull request already changes the same thing. Use after plan and before writing code.
---

# Isolate

One task is one worktree, one branch and one pull request. Nothing is built on `main` itself.

1. Look first: `git worktree list`, `git status` and the current branch. If your environment
   already made a worktree for this task, keep working in it.
2. Otherwise start one from the newest `main`, outside the checkout:

   ```sh
   git fetch origin
   git worktree add ../folio-<task> -b <agent>/<task> origin/main
   cd ../folio-<task>
   vp install
   vp node node_modules/electron/install.js
   ```

   `<task>` is a few words in kebab-case; `<agent>` names who works on it (`claude`, `codex`,
   `cursor`).

3. Check for overlap: `gh pr list --state open`, then `gh pr diff <number> --name-only` for any
   that sound close. If another pull request changes the same behaviour, say so now and settle
   it with the owner; edits to the same file that don't interact can go ahead.

Worktrees share one `~/.folio`. Tests use their own temporary `FOLIO_HOME`; don't run two
development Folios at once.

Next: build, by the rules in [AGENTS.md](../../../AGENTS.md), then [folio-prove](../folio-prove/SKILL.md).
