---
name: prove
description: Show that a Folio change does what its "Done when" says, with checks that were actually run and evidence sized to the change. Use after building and before ship; for a bug, show the failure before the fix, and for what the student sees, a before and an after.
---

# Prove

Evidence is what ran, not what should work. Reading a test is not running it. Evidence comes on
top of the checks and never replaces them.

1. **Always**: `vp check`, `vp run check:ui` and `vp test`. Note what ran, what it said, and the
   commit it ran on (`git rev-parse --short HEAD`).
2. **A bug**: first write a test that fails because of the bug, run it, and keep its output.
   Then fix the bug and run the test again. The pull request shows both: that pair is the before
   and the after.
3. **What the student sees**: check it in the browser preview (`vp dev`). If it crosses the
   Electron bridge, also in a real window (`vp run desktop:build`, then `vp run test:electron`),
   since the preview skips that hop. Show a before and an after:
   - The README's scenes need nothing extra. CI retakes them and commits the ones that changed,
     and the pull request's "Files changed" shows each as GitHub's image diff.
   - For any other state, capture it in the preview at the same window size twice: from a
     worktree of `origin/main` for the before, and from this branch for the after. Name captures
     in order, with what they show: `01-precondition-course-open.png`, `02-note-saves-on-blur-passed.png`.
   - Keep captures and an `assertions.md` in `.artifacts/<task>/`, which git ignores. They are
     never committed and never uploaded to an outside host. The pull request lists each assertion
     as passed, failed or untested, with why.
4. **Saving, cancelling, resuming**: a test for each hard case the change touches, from the list
   in AGENTS.md.
5. **Not on screen, but measurable**: a number or an output pair, before and after, from a
   command anyone can rerun. For how the tutor behaves, the transcript lines that show the tool
   call and its answer.
6. Go through **Done when** item by item. Each one is shown, or marked as not shown, with why.
   Never present something you didn't run as evidence, or a capture from another commit as this
   one's.

Evidence is sized to the change. A change only to docs, the guide or the skills needs `vp check`,
the guide's tests, and a read of what changed, with its commands and links tried. It needs no
captures.

## Capture hygiene

- Only the preview's synthetic courses go on screen. Never real course material, an account, a key
  or anything of the owner's: captures and pull requests are public.
- Worktrees share ports. Before trusting what a port serves, check that it's your worktree's
  process (`lsof -i :<port>`).
- A check that fails sometimes is a bug, either in the test or in Folio. Fix it; never run it
  again until it passes.

Write it down under **How it was proven** in the pull request's description: the commit, the
commands and their results, the before and after, and anything not shown.

Next: [ship](../ship/SKILL.md).
