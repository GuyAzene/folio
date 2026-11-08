---
name: folio-prove
description: Show that a Folio change does what its "Done when" says, with checks that were actually run and evidence sized to the change. Use after building and before ship; for a bug, show the failure before the fix.
---

# Prove

Evidence is what ran, not what should work. Reading a test is not running it.

1. **Always**: `vp check`, `vp run check:ui` and `vp test`. Note what ran and what it said.
2. **A bug**: first write a test that fails because of the bug, run it, and keep its output.
   Then fix the bug and run the test again. The pull request shows both.
3. **What the student sees**: check it in the browser preview (`vp dev`). If it crosses the
   Electron bridge, also in a real window (`vp run desktop:build`, then `vp run test:electron`),
   since the preview skips that hop.
4. **Saving, cancelling, resuming**: a test for each hard case the change touches, from the list
   in AGENTS.md.
5. Go through **Done when** item by item. Each one is shown, or marked as not shown, with why.
   Never present something you didn't run as evidence.

Write it down under **How it was proven** in the pull request's description: the commands, their
results, and anything not shown. A README edit needs only `vp check`.

A check that fails sometimes is a bug, either in the test or in Folio. Fix it; never run it again
until it passes.

Next: [folio-ship](../folio-ship/SKILL.md).
