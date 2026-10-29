<script lang="ts">
  import { ChevronRight, FileText } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { folio } from "../lib/state.svelte.ts";
  import { splitTitle, topicsInOrder } from "../lib/study.ts";

  /**
   * The course page's Study notes tab: the course's topics, each with the lectures and
   * recitations that teach it, or each studied document with the topics it feeds.
   */
  let { courseId }: { courseId: string } = $props();
  let mode = $state<"topics" | "documents">("topics");

  const notes = $derived(folio.studyNotes[courseId]);
  $effect(() => {
    void folio.knowledge[courseId]?.generation;
    untrack(() => void folio.loadStudyNotes(courseId));
  });

  const topics = $derived(
    new Map((notes?.topics ?? []).map((topic) => [topic.slug, topic])),
  );

  /** Topics in the order the course first teaches them. */
  const ordered = $derived(notes ? topicsInOrder(notes) : []);

  /** "Lecture 2" from the document's title. */
  function label(documentId: string): string {
    const title = folio.document(documentId)?.title;
    return title ? splitTitle(title).title : "Slides";
  }

  function open(item: string, event: MouseEvent): void {
    folio.openStudyNotes(courseId, item, {
      newTab: event.metaKey || event.ctrlKey,
    });
  }
</script>

{#if notes}
  <div
    class="mb-5 inline-grid grid-cols-2 gap-0.5 rounded-md bg-sunken p-0.5 text-[12px] font-medium dark:bg-raised"
    role="tablist"
  >
    {#each [["topics", "Topics"], ["documents", "By document"]] as const as [value, name] (value)}
      <button
        role="tab"
        aria-selected={mode === value}
        class="h-7 rounded-[5px] px-3 transition-colors {mode === value
          ? 'bg-surface text-text shadow-1 dark:bg-hover'
          : 'text-text-3 hover:text-text'}"
        onclick={() => (mode = value)}>{name}</button
      >
    {/each}
  </div>
  {#if mode === "topics"}
    <div class="flex flex-col">
      {#each ordered as topic (topic.slug)}
        <button
          class="group -mx-2 flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-hover"
          onclick={(event) => open(`topic:${topic.slug}`, event)}
        >
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate font-medium text-text" dir="auto"
              >{topic.title}</span
            >
            <span class="truncate text-[12px] text-text-3" dir="auto"
              >{topic.taughtIn
                .map((place) => label(place.documentId))
                .join(" · ")}</span
            >
          </span>
          <span class="shrink-0 text-[12px] whitespace-nowrap text-text-3"
            >{topic.sections.length}
            {topic.sections.length === 1 ? "section" : "sections"}</span
          >
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            class="shrink-0 text-text-4 rtl:rotate-180"
          />
        </button>
      {/each}
    </div>
  {:else}
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
  {/if}
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
