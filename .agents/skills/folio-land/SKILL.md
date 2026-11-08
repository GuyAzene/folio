---
name: folio-land
description: Finish a Folio task after ship. Wait until its pull request has merged and main's CI on the merge is green, then clean up the worktree and branch. If main turns red, fixing it comes first. Use after ship ends with done.
---

# Land

A task is done when its pull request has merged and `main` is still green, not when it merges.

1. Wait: `vp node scripts/line.ts land`, in the background where you can, passing on each line.
   It waits for the merge, then for every job of `main`'s CI on it, the nightly builds included.
2. Act on how it ended:
   - **0, landed**: remove the task's worktree (`git worktree remove <path>`) and its branch
     (`git branch -D <branch>`, since a squash merge makes `-d` refuse), unless your environment
     made the worktree and removes it itself. Then tell the owner in one line.
   - **1, main isn't green**: stop the line. Before any other work, find the cause in the failed
     jobs' logs and fix it in a new pull request from `main`, through the whole line.
   - **2, closed without merging**: tell the owner, and stop.
   - **3** or **4**: say what it was waiting for, and stop.

Don't reinstall Folio after a merge: an open Folio would be interrupted. The owner asks when they
want it (`vp run desktop:install`).
