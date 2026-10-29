<script lang="ts">
  import { Pause, Play } from "@lucide/svelte";
  import type { JobView } from "../../src/desktop/api.ts";
  import CourseTile from "../components/CourseTile.svelte";
  import StudyCard from "../components/StudyCard.svelte";
  import { formatDate, plural } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import { explain, studyDocuments } from "../lib/study.ts";

  // Work in progress first, then what waits on the plan or the student, then the rest.
  const ORDER: Record<JobView["status"], number> = {
    running: 0,
    queued: 0,
    waiting: 1,
    stopped: 2,
    failed: 2,
    done: 3,
  };
  const jobs = $derived(
    folio.jobs.toSorted(
      (a, b) =>
        ORDER[a.status] - ORDER[b.status] ||
        b.createdAt.localeCompare(a.createdAt),
    ),
  );

  let busy = $state<string | null>(null);
  async function control(
    job: JobView,
    action: "pause" | "resume" | "cancel" | "dismiss",
  ): Promise<void> {
    busy = job.id;
    await folio.controlJob(job.id, action);
    busy = null;
  }

  // One clock for every card, ticking only while something runs.
  let now = $state(Date.now());
  const ticking = $derived(folio.jobs.some((job) => job.status === "running"));
  $effect(() => {
    if (!ticking) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  /** "2 lectures", "a lecture and a recitation". */
  function what(job: JobView): string {
    const roles = job.documentIds.map((id) => folio.document(id)?.role);
    const lectures = roles.filter((role) => role === "lecture").length;
    const recitations = roles.filter((role) => role === "recitation").length;
    if (lectures && recitations)
      return `${plural(lectures, "lecture")} and ${plural(recitations, "recitation")}`;
    if (recitations) return plural(recitations, "recitation");
    return plural(lectures || roles.length, "lecture");
  }

  function heading(job: JobView): string {
    const course = folio.course(job.courseId)?.name ?? "your course";
    if (job.kind === "regroup")
      return job.status === "done"
        ? `${course}'s notes are grouped by topic`
        : job.status === "failed"
          ? "Couldn't group the notes"
          : `Grouping ${course}'s notes by topic`;
    switch (job.status) {
      case "running":
        return `Studying for ${course}`;
      case "queued":
        return job.waitingFor === "connection" ? "Waiting for ChatGPT" : "Up next";
      case "stopped":
        return job.resumable ? "Paused" : "Cancelled";
      case "failed":
        return "Couldn't finish";
      case "done":
        return `Added to ${course}`;
      default:
        return "Waiting for your plan";
    }
  }

  function subline(job: JobView): string {
    if (job.kind === "regroup") {
      const result = job.nodes.find((node) => node.role === "publish")?.task;
      if (job.status === "done")
        return `${result ?? "Grouped"} · Each lecture and recitation is studied again after new files.`;
      if (job.status === "failed") {
        const note = job.nodes.find((node) => node.parentId === null)?.note;
        return note ? explain(note) : "Resume tries again.";
      }
      return "A lecture and a recitation that teach the same thing will share one topic.";
    }
    switch (job.status) {
      case "queued":
        if (job.waitingFor === "connection")
          return `${what(job)} · Connect your ChatGPT account in Settings; studying starts on its own.`;
        return `${what(job)} · Starts when the studies ahead of it finish. The notes are added to the course when they're done.`;
      case "running":
        return `${what(job)} · You can keep working; the notes are added to the course when they're done.`;
      case "stopped":
        return job.resumable
          ? `${what(job)} · Resume picks up where it stopped. Finished steps aren't redone.`
          : what(job);
      case "failed": {
        const note = job.nodes.find((node) => node.parentId === null)?.note;
        return `${what(job)} · ${note ? `${explain(note)} ` : ""}Resume tries again from where it stopped. Finished steps aren't redone.`;
      }
      case "done":
        return `${what(job)} · ${formatDate(job.updatedAt)}`;
      default: {
        const note = job.nodes.find((node) => node.parentId === null)?.note;
        return note ? explain(note) : what(job);
      }
    }
  }

  const button =
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors disabled:opacity-50";
</script>

<div class="scroll-quiet h-full overflow-y-auto">
  <div
    class="mx-auto flex w-full max-w-[860px] flex-col px-8 pt-10 pb-16 max-sm:px-4"
  >
    <h1
      class="text-[24px] leading-8 font-semibold tracking-[-0.015em] text-text"
    >
      Studying
    </h1>
    <p class="mt-1 text-text-3">
      Lectures and recitations Folio is studying for you. When one finishes, its
      notes are added to the course.
    </p>

    {#each jobs as job (job.id)}
      {@const course = folio.course(job.courseId)}
      {@const live = job.status === "running" || job.status === "queued"}
      {@const settled = job.status === "done"}
      <section class="mt-10 flex flex-col gap-3">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
          {#if course}<CourseTile {course} size={28} />{/if}
          <div class="flex min-w-0 flex-1 flex-col">
            <h2
              class="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em] text-text"
            >
              {heading(job)}
            </h2>
            <p
              class="line-clamp-2 text-[12.5px] leading-[18px] break-words text-text-3"
              dir="auto"
            >
              {subline(job)}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            {#if job.resumable}
              <button
                type="button"
                class="{button} bg-ink text-on-ink shadow-1 hover:opacity-90"
                disabled={busy === job.id}
                onclick={() => control(job, "resume")}
              >
                <Play size={11} strokeWidth={0} fill="currentColor" /> Resume
              </button>
            {:else if live}
              <button
                type="button"
                class="{button} bg-surface text-text shadow-card hover:bg-hover dark:bg-raised"
                disabled={busy === job.id}
                onclick={() => control(job, "pause")}
              >
                <Pause size={11} strokeWidth={0} fill="currentColor" /> Pause
              </button>
            {/if}
            <button
              type="button"
              class="{button} text-text-2 hover:bg-hover hover:text-text"
              disabled={busy === job.id}
              onclick={() => control(job, live ? "cancel" : "dismiss")}
            >
              {live ? "Cancel" : "Dismiss"}
            </button>
          </div>
        </header>

        {#each studyDocuments(job, (id) => folio.document(id)?.title ?? "Document") as study (study.documentId)}
          <StudyCard {study} {now} finished={settled} />
        {/each}
      </section>
    {:else}
      <div
        class="mt-10 rounded-xl border border-dashed border-line-strong px-6 py-12 text-center text-text-3"
      >
        Nothing is being studied. Folio studies lectures and recitations as soon
        as you add them to a course.
      </div>
    {/each}
  </div>
</div>
