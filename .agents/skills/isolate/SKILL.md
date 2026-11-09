---
name: isolate
description: Use before the first edit to the Folio repository, for any feature, fix or docs change, even one line. Gives the task its own git worktree and branch from the latest main, keeps a worktree the environment already made for it, and checks open pull requests for overlap. Read-only questions, reviews and investigations need none.
---

# Isolate

One task is one worktree, one branch and one pull request. Nothing is built on `main`, and
nothing in another task's worktree. Read-only work uses the checkout as it is; once it leads to
an edit, isolate before that edit.

## Check existing isolation first

Look at `git worktree list`, `git status --short`, `git branch --show-current`, and what your
session was given.

- If your environment already made a worktree for this task, as Claude Code's desktop app does
  under `.claude/worktrees/`, keep its path and branch, and skip steps 3 to 5.
- In your session's own worktree, once its earlier task has merged and nothing is uncommitted,
  start this task's branch there instead of a new worktree:
  `git switch -c <agent>/<task> origin/main`, after steps 1 and 2, then install (step 6).
- A folder or branch name alone doesn't show that a worktree is this task's. Anything else gets
  every step.

## Steps

1. **Sync**: `git fetch --prune origin`. Then bring the main checkout, the first path
   `git worktree list` prints, up to date with `git -C <path> merge --ff-only origin/main`, if
   it's on `main` with nothing uncommitted. Sessions started there read the guide and the skills
   from it, and a checkout left behind hands them old rules.
2. **Overlap**: `gh pr list --state open`, then `gh pr diff <number> --name-only` for any that
   sound close, and read the overlapping diffs of shared files. Independent edits go ahead in your
   own worktree. Ask the owner only when the changes conflict in behaviour, need another task's
   unfinished work, or it's unclear whose they are. Look for uncommitted work in the other
   worktrees (`git -C <path> status --short` for each in `git worktree list`) without changing it.
3. **Name it**: a few words in kebab-case plus a short unique suffix, such as
   `notes-overflow-4f2a`. If `git worktree add` says the name exists, pick another; never force
   or reuse one.
4. **Create it** from the newest `main`, outside the checkout so it can't be committed by
   accident:

   ```sh
   git worktree add ../folio-<task> -b <agent>/<task> origin/main
   ```

   `<agent>` is `claude`, `codex` or `cursor`.

5. **Enter and check**:

   ```sh
   cd ../folio-<task>
   git branch --show-current   # must print <agent>/<task>, not main
   ```

6. **Install**: `vp install`, in a worktree your environment made too, since every change runs
   `vp check` and the tests, which need the dependencies. A change to the app also needs
   Electron's binary, which `vp install` leaves out: `vp node node_modules/electron/install.js`.
   A change only to docs, the guide or the skills doesn't need the binary.

## Remember

- Worktrees share `~/.folio` and ports. Tests use their own temporary `FOLIO_HOME`; don't run two
  development Folios at once, and check that a port answers your own process before trusting it.
- Each worktree has its own `package-lock.json`. Resolve a conflict in it by regenerating it with
  `vp install`, never by hand.
- Keep the worktree until the pull request merges or closes. Then remove it and its branch,
  unless your environment made the worktree and removes it itself, and sync as in step 1:

  ```sh
  git worktree remove ../folio-<task>
  git branch -D <agent>/<task>   # -D: after a squash merge, -d refuses
  ```

Next: build, by the rules in [AGENTS.md](../../../AGENTS.md), then
[prove](../prove/SKILL.md).
