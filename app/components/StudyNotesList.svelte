<script lang="ts">
  import { ChevronRight, FileText } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { folio } from "../lib/state.svelte.ts";
  import { splitTitle } from "../lib/study.ts";

  /** The course page's Study notes tab: each studied lecture with the topics it introduced. */
  let { courseId }: { courseId: string } = $props();

  const notes = $derived(folio.studyNotes[courseId]);
  $effect(() => {
    void folio.knowledge[courseId]?.generation;
    untrack(() => void folio.loadStudyNotes(courseId));
  });

  const topics = $derived(
    new Map((notes?.topics ?? []).map((topic) => [topic.slug, topic])),
  );

  function open(item: string, event: MouseEvent): void {
    folio.openStudyNotes(courseId, item, {
      newTab: event.metaKey || event.ctrlKey,
    });
  }
</script>

{#if notes}
  <div class="flex flex-col gap-6">
    {#each notes.sessions as session (session.slug)}
      {@const title = folio.document(session.documentId)?.title}
      <section class="flex flex-col">
        <button
          class="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-hover"
          onclick={(event) => open(`session:${session.slug}`, event)}
        >
          <FileText size={15} strokeWidth={1.75} class="shrink-0 text-text-3" />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate font-medium text-text" dir="auto"
              >{title ? splitTitle(title).title : session.title}</span
            >
            <span class="truncate text-[12px] text-text-3" dir="auto"
              >{session.title}</span
            >
          </span>
          <span class="shrink-0 text-[12px] text-text-3">
            {session.topics.length}
            {session.topics.length === 1 ? "topic" : "topics"}
            {#if session.leftOut.length}
              · {session.leftOut.length} left out
            {/if}
          </span>
        </button>
        <div class="ml-[7px] flex flex-col border-l border-line-subtle pl-4">
          {#each session.topics as slug (slug)}
            {@const topic = topics.get(slug)}
            {#if topic}
              <button
                class="group -mx-2 flex h-9 items-center gap-3 rounded-md px-2 text-left hover:bg-hover"
                onclick={(event) => open(`topic:${slug}`, event)}
              >
                <span
                  class="min-w-0 flex-1 truncate text-text-2 group-hover:text-text"
                  dir="auto">{topic.title}</span
                >
                <span class="shrink-0 text-[12px] text-text-3"
                  >{topic.sections.length}
                  {topic.sections.length === 1 ? "section" : "sections"}</span
                >
                <ChevronRight
                  size={14}
                  strokeWidth={1.75}
                  class="shrink-0 text-text-4 rtl:rotate-180"
                />
              </button>
            {/if}
          {/each}
        </div>
      </section>
    {/each}
  </div>
{:else if notes === null}
  <div
    class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong px-6 py-12 text-center"
  >
    <span class="max-w-[440px] text-text-3">
      When Folio studies this course's lectures and recitations, the notes it
      writes appear here by topic, each citing the slides it came from.
    </span>
  </div>
{/if}
