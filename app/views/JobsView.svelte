<script lang="ts">
  import { Ellipsis } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import type { JobView } from "../../src/desktop/api.ts";
  import CourseTile from "../components/CourseTile.svelte";
  import StudyCard from "../components/StudyCard.svelte";
  import { folio } from "../lib/state.svelte.ts";
  import { explain, studyDocuments } from "../lib/study.ts";
  import { shortTitle } from "../lib/titles.ts";

  /**
   * Folio studies every lecture and recitation the student adds, and keeps each course's study
   * notes up to date; this page only lets them follow along. What is being studied now, each
   * with its slides and stages, then what comes next, in the order Folio will take it. A single line appears
   * only when something needs the student. Finished studies leave the page.
   */

  const PRIORITY: Record<JobView["origin"], number> = {
    student: 0,
    upload: 1,
    backlog: 2,
    restudy: 3,
  };

  const running = $derived(
    folio.jobs.filter((job) => job.status === "running"),
  );
  const next = $derived(
    folio.jobs
      .filter((job) => job.status === "queued")
      .toSorted(
        (a, b) =>
          PRIORITY[a.origin] - PRIORITY[b.origin] ||
          a.createdAt.localeCompare(b.createdAt),
      ),
  );
  /** Studies that stopped and wait for the student: paused, cut off, or out of plan. */
  const stuck = $derived(folio.jobs.filter((job) => job.resumable));
  const offline = $derived(next.some((job) => job.waitingFor === "connection"));
  const limited = $derived(
    stuck.some((job) =>
      /usage[_ ]limit|rate[_ ]limit|quota|429/i.test(problem(job) ?? ""),
    ),
  );

  function problem(job: JobView): string | null {
    return job.nodes.find((node) => node.parentId === null)?.note ?? null;
  }

  function titleOf(id: string): string {
    const document = folio.document(id);
    return document
      ? shortTitle(document.title, folio.course(document.courseId)?.name)
      : "A file";
  }

  // One clock for every card, ticking only while something runs.
  let now = $state(Date.now());
  $effect(() => {
    if (!running.length) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  async function resumeAll(): Promise<void> {
    for (const job of stuck) await folio.controlJob(job.id, "resume");
  }

  const menuItem =
    "flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover";
  const heading =
    "flex h-7 items-center gap-2 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase";
</script>

{#snippet actions(job: JobView, documentId: string | null)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="flex size-7 shrink-0 items-center justify-center rounded-md text-text-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-text focus-visible:opacity-100 data-[state=open]:bg-hover data-[state=open]:opacity-100"
      aria-label="More"
    >
      <Ellipsis size={15} strokeWidth={1.75} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align="end"
        sideOffset={6}
        class="z-50 min-w-[200px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
      >
        {#if documentId}
          <DropdownMenu.Item
            class={menuItem}
            onSelect={() => folio.openDocument(documentId)}
            >Open</DropdownMenu.Item
          >
        {/if}
        <DropdownMenu.Item
          class={menuItem}
          onSelect={() => folio.controlJob(job.id, "cancel")}
          >{job.status === "queued"
            ? "Don't study this"
            : "Stop studying this"}</DropdownMenu.Item
        >
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/snippet}

<div class="scroll-quiet h-full overflow-y-auto">
  <div
    class="mx-auto flex w-full max-w-[720px] flex-col px-8 pt-10 pb-16 max-sm:px-4"
  >
    <h1
      class="text-[24px] leading-8 font-semibold tracking-[-0.015em] text-text"
    >
      Studying
    </h1>
    <p class="mt-1 text-text-3">
      Folio studies every lecture and recitation you add, and keeps each
      course's study notes up to date.
    </p>

    {#if stuck.length || offline}
      <div
        class="mt-6 flex items-center gap-3 rounded-lg border border-line-subtle bg-sunken px-3.5 py-2.5 text-[13px] dark:bg-raised"
        role="status"
      >
        <span class="size-1.5 shrink-0 rounded-full bg-highlight"></span>
        <span class="min-w-0 flex-1 text-text-2">
          {#if offline && !stuck.length}
            Connect {folio.studyMissing ?? "ChatGPT"} and studying starts on its own.
          {:else if limited}
            Your ChatGPT plan reached its usage limit. Continue once it resets.
          {:else}
            {stuck.length === 1
              ? `${titleOf(stuck[0]!.documentIds[0] ?? "")} stopped before it finished.`
              : `${stuck.length} studies stopped before they finished.`}
            {#if problem(stuck[0]!)}{explain(problem(stuck[0]!)).replace(
                / ?Resume[^.]*\.$/,
                "",
              )}{/if}
          {/if}
        </span>
        {#if offline && !stuck.length}
          <button
            class="h-7 shrink-0 rounded-md bg-ink px-2.5 font-medium text-on-ink shadow-1 hover:opacity-90"
            onclick={() => folio.openSettings("connections")}>Connect</button
          >
        {:else}
          <button
            class="h-7 shrink-0 rounded-md bg-ink px-2.5 font-medium text-on-ink shadow-1 hover:opacity-90"
            onclick={resumeAll}>Continue</button
          >
        {/if}
      </div>
    {/if}

    {#if running.length}
      <section class="mt-8" aria-label="Now">
        <div class={heading}>Now</div>
        <div class="flex flex-col gap-2">
          {#each running as job (job.id)}
            {@const course = folio.course(job.courseId)}
            {#if job.kind === "regroup"}
              <div
                class="group flex items-center gap-3 rounded-xl border border-line-subtle bg-surface px-4 py-3 shadow-card dark:bg-raised"
              >
                {#if course}<CourseTile {course} size={28} />{/if}
                <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span class="truncate font-medium text-text" dir="auto"
                    >{course?.name ?? "Course"}</span
                  >
                  <span class="text-[12.5px] text-text-3"
                    >Updating the study notes</span
                  >
                  <span
                    class="relative h-1 overflow-hidden rounded-full bg-line-subtle"
                  >
                    <span
                      class="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-ink"
                    ></span>
                  </span>
                </div>
                {@render actions(job, null)}
              </div>
            {:else}
              {#each studyDocuments(job, (id) => folio.document(id)?.title ?? "Document") as study (study.documentId)}
                {#if study.status !== "done"}
                  <StudyCard {study} {now}>
                    {#snippet menu()}
                      {@render actions(job, study.documentId)}
                    {/snippet}
                  </StudyCard>
                {/if}
              {/each}
            {/if}
          {/each}
        </div>
      </section>
    {/if}

    {#if next.length}
      <section class="mt-8" aria-label="Next">
        <div class={heading}>
          Next <span class="font-normal tracking-normal tabular-nums"
            >{next.length}</span
          >
        </div>
        <div class="flex flex-col">
          {#each next as job (job.id)}
            {@const course = folio.course(job.courseId)}
            {#each job.kind === "regroup" ? [null] : job.documentIds as documentId (documentId ?? job.id)}
              <div
                class="group -mx-2 flex h-10 items-center gap-3 rounded-md px-2 hover:bg-hover"
              >
                {#if course}<CourseTile {course} size={18} />{/if}
                <span
                  class="min-w-0 truncate text-[13.5px] text-text"
                  dir="auto"
                  >{documentId
                    ? titleOf(documentId)
                    : "Update the study notes"}</span
                >
                {#if course}
                  <span
                    class="min-w-0 flex-1 truncate text-[12.5px] text-text-3"
                    dir="auto">{course.name}</span
                  >
                {:else}
                  <span class="flex-1"></span>
                {/if}
                {@render actions(job, documentId)}
              </div>
            {/each}
          {/each}
        </div>
      </section>
    {/if}

    {#if !running.length && !next.length && !stuck.length}
      <div class="mt-10 text-text-3">
        All caught up. Add a lecture or recitation to a course and Folio studies
        it right away.
      </div>
    {/if}
  </div>
</div>
