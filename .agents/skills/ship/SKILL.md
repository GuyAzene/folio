---
name: ship
description: Open the pull request for a proven Folio change, loop on Claude's review until nothing serious is left or three rounds have passed, then give the owner the link. Use after prove. Never merges unless the owner says so.
---

# Ship

1. **Commit and rebase.** Stage only this task's files, by path (`git add <paths>`), and commit
   with a clear message. Rebase onto the latest `origin/main`, and run the checks again if `main`
   moved.
2. **Push and open the pull request.** `git push -u origin <branch>`, never `--all` or
   `--mirror`; after rebasing a branch you already pushed, `--force-with-lease`, never `--force`.
   Open it with `gh pr create`:
   - The title becomes the commit on `main`: say what changes, plainly.
   - The description has **What and why**, **Done when** and **How it was proven**, with every
     claim backed by evidence, and any risk or follow-up. It's public.
   - Run [unslop](../unslop/SKILL.md) over the title, the description and the commit messages
     first.
3. **Wait for the round.** `vp node scripts/wait-for-review.ts`, in the background where you can,
   passing on each line it prints. It waits until every check on the newest commit has finished
   and Claude has reviewed that commit, then lists what failed, the serious findings still open
   and the notes.
4. **Fix and push again.** Read the whole review comment, not only what the wait prints.
   - Fix the serious findings, the failed checks, and the notes that are right and within this
     task. Don't change correct code just to satisfy the review.
   - For a finding you think is wrong, reply on the pull request with why, and the test or line
     that shows it.
   - A failed check: read its log and fix the cause. Never re-run a check to get past it.
   - Run the checks, push, and wait again. The next review covers only what changed since the
     last one, and rechecks the serious findings it left open. Bringing `main` in, by a merge or a
     rebase, gets the whole pull request reviewed again, which counts as a round, so do it only
     when you need to.
5. **Stop** when the newest commit passed every check and the review left nothing serious open,
   with each note fixed or answered; after three rounds; or when you're stuck, as when GitHub
   isn't answering or the review couldn't run twice. A run GitHub never started, with none of
   CI's jobs on the commit (`gh pr checks <n>`) or no review comment for it, gets started once
   by hand: `gh workflow run ci.yml --ref <branch>`, or `gh workflow run review.yml -f pr=<n>`.
   That doesn't re-run a check, since the run never began.
6. **Report.** The pull request's link, the commit last reviewed, how many rounds, the checks
   that ran, what was fixed, what was answered, and what's left. Say plainly whether it came out
   clean, ran out of rounds, or got stuck.

When CI commits new README pictures to the branch, pull before pushing again; the wait says so.

Don't merge the pull request unless the owner says so. When they do, check that every check on
the newest commit finished and passed, then `gh pr merge <n> --squash --match-head-commit <sha>`.
Never `--admin`, auto-merge or a push to `main`, unless the owner asks for that one thing; then
say once which rule it skips, and do it. Once it has merged, clean up as
[isolate](../isolate/SKILL.md) says.
