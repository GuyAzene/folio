---
name: ship
description: Open the pull request for a proven Folio change and see it through CI and Claude's review, fixing serious findings and the notes worth fixing until it merges or waits for the owner. Use after prove; it runs the review loop with scripts/line.ts.
---

# Ship

1. Bring the branch up to date: `git fetch origin`, then rebase on `origin/main`. If `main`
   moved, run the checks again. Stage only this task's files, by path (`git add <paths>`).
2. Push the branch by name (`git push -u origin <branch>`, never `--all` or `--mirror`; after
   rebasing a branch you already pushed, `--force-with-lease`, never `--force`) and open the pull
   request with `gh pr create`:
   - The title becomes the commit on `main`: say what changes, plainly.
   - The description: what and why, **Done when**, and **How it was proven**. It's public.
   - Run [unslop](../unslop/SKILL.md) over the title, the description and the commit
     messages first.
   - Add the `needs owner` label if the owner asked to look before it merges.
   - Leave auto-merge off; the wait turns it on at the right moment.
3. Wait: `vp node scripts/line.ts ship`. Run it in the background where you can, and pass on each
   line it prints: a wait is never silent. It waits for CI and for a review of the newest commit,
   never an older one, then ends with what to do next.
4. Act on how it ended:
   - **0, done**: CI and the review gate passed, and it had GitHub merge it, through auto-merge
     or at once when GitHub's rules already allowed it. Go to
     [land](../land/SKILL.md).
   - **1, something to fix**: fix it in this branch, prove it again, push, and go back to 3.
     - Read the whole review comment, not only what the wait prints. An earlier serious finding
       stays open until a review finds it fixed.
     - A serious finding you think is wrong: reply on the pull request with why, and the test or
       line that shows it, add the `needs owner` label, and stop. The owner decides.
     - Notes: fix the ones that are right and within this pull request's scope. Don't change
       correct code just to satisfy the review. For each note you leave, reply on the pull request
       with why, then wait again with `--notes-answered <commit>`, the commit the wait names.
       After the third round, notes no longer hold it.
     - CI failed: read the failed job's log and fix the cause. Never re-run a check to get past
       it. If the cause is outside Folio, such as GitHub's own servers failing, say so with the
       log line, and stop.
   - **2, the owner's**: the owner merges it with GitHub's merge button. Tell them in one line
     why it's theirs, and stop. If they tell you to merge it, merge it normally
     (`gh pr merge <n> --squash --match-head-commit <sha>`) and go to [land](../land/SKILL.md).
   - **3, too long**, or **4, GitHub didn't answer**: say what it was waiting for, and stop.
5. The review gate gives a pull request three rounds. After the third with serious findings
   open, it's the owner's.

When CI commits new README pictures to the branch, pull before pushing again; the wait says so.

Never merge a pull request any other way than through the wait, or the normal merge the owner
asks for, never merge past a rule (`--admin`), never turn auto-merge off, and never push to
`main`, unless the owner explicitly asks for that one thing. Then say once which rule it skips,
and do it.

End with a short report: the pull request, the commit last reviewed, how many review rounds, the
checks that ran, the findings and notes fixed, those answered or disputed, and what's left. Say
plainly whether it passed, ran out of rounds, or ran out of time.
