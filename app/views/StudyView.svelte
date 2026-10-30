<script lang="ts">
  import { FileText, Search } from "@lucide/svelte";
  import { untrack } from "svelte";
  import type {
    StudySessionView,
    StudyTopicView,
  } from "../../src/desktop/api.ts";
  import CourseTile from "../components/CourseTile.svelte";
  import { estimateDirection } from "../lib/direction.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { MATH_SPAN } from "../lib/math-syntax.ts";
  import { folio } from "../lib/state.svelte.ts";
  import { splitTitle, topicsInOrder } from "../lib/study.ts";

  /**
   * The study notes Folio wrote from a course's lectures, as published, organised by topic: a
   * topic gathers what every lecture and recitation says about it, each section citing the
   * slide pages it came from. Each document keeps an anchor page in slide order that points into
   * the topics it feeds, with what only it teaches and its notation.
   */
  let { courseId, item }: { courseId: string; item: string | null } = $props();
  let filter = $state("");
  /** The outline beside the page: every topic, or each document with the topics it feeds. */
  let mode = $state<"topics" | "documents">("topics");

  const course = $derived(folio.course(courseId));
  const notes = $derived(folio.studyNotes[courseId]);

  // A new version (studying more lectures, a rollback) reloads the notes.
  $effect(() => {
    void folio.knowledge[courseId]?.generation;
    untrack(() => void folio.loadStudyNotes(courseId));
  });

  const topics = $derived(
    new Map((notes?.topics ?? []).map((topic) => [topic.slug, topic])),
  );
  const selected = $derived.by(() => {
    if (!notes) return null;
    const [kind, slug] = item?.split(":") ?? [];
    const topic = kind === "topic" ? topics.get(slug ?? "") : undefined;
    if (topic) return { topic, session: undefined };
    const session =
      notes.sessions.find((candidate) => candidate.slug === slug) ??
      notes.sessions[0];
    return session ? { topic: undefined, session } : null;
  });

  /** Sessions and their topics, narrowed by the filter (titles and section titles). */
  const outline = $derived.by(() => {
    const query = filter.trim().toLocaleLowerCase();
    const matches = (topic: StudyTopicView) =>
      !query ||
      topic.title.toLocaleLowerCase().includes(query) ||
      topic.sections.some((section) =>
        section.title.toLocaleLowerCase().includes(query),
      );
    return (notes?.sessions ?? [])
      .map((session) => ({
        session,
        topics: session.topics
          .map((slug) => topics.get(slug))
          .filter(
            (topic): topic is StudyTopicView => !!topic && matches(topic),
          ),
      }))
      .filter(
        ({ session, topics }) =>
          topics.length ||
          !query ||
          session.title.toLocaleLowerCase().includes(query),
      );
  });

  /** Every topic, in the order the course teaches them, narrowed by the filter. */
  const topicList = $derived.by(() => {
    const query = filter.trim().toLocaleLowerCase();
    return (notes ? topicsInOrder(notes) : []).filter(
      (topic) =>
        !query ||
        topic.title.toLocaleLowerCase().includes(query) ||
        topic.sections.some((section) =>
          section.title.toLocaleLowerCase().includes(query),
        ),
    );
  });

  /** "Pages 2–3" for a run of pages. */
  function pageRange(pages: number[]): string {
    if (!pages.length) return "";
    const first = pages[0]!;
    const last = pages.at(-1)!;
    return first === last ? `Page ${first}` : `Pages ${first}–${last}`;
  }

  function sessionOf(slug: string): StudySessionView | undefined {
    return notes?.sessions.find((session) => session.slug === slug);
  }

  /** "Lecture 1" from "Lecture 1 Graph traversal"; the full title when it has no number. */
  function documentLabel(documentId: string): string {
    const title = folio.document(documentId)?.title;
    return title ? splitTitle(title).title : "Slides";
  }

  function open(next: string, event?: MouseEvent): void {
    folio.openStudyNotes(courseId, next, {
      newTab: !!event && (event.metaKey || event.ctrlKey),
    });
  }

  function openPage(documentId: string, page: number, event: MouseEvent): void {
    folio.openDocument(documentId, page, {
      newTab: event.metaKey || event.ctrlKey,
    });
  }

  const md = (text: string) => renderMarkdown(text);

  /** A section's direction, from its words (formulas aside), so its citations sit on its side. */
  function directionOf(...texts: string[]): "rtl" | "ltr" {
    return (
      estimateDirection(texts.join(" ").replace(MATH_SPAN, " ")).direction ??
      "ltr"
    );
  }
</script>

{#snippet pageChip(documentId: string, page: number)}
  <button
    class="inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-md border border-line-subtle bg-sunken px-2 font-sans text-[12px] leading-none whitespace-nowrap text-text-2 transition-colors hover:border-line hover:text-text dark:bg-raised"
    dir="ltr"
    title="Open the slides at page {page}"
    onclick={(event) => openPage(documentId, page, event)}
  >
    <FileText size={12} strokeWidth={1.75} class="shrink-0" />
    <span class="max-w-[240px] min-w-0 truncate" dir="auto"
      >{documentLabel(documentId)}</span
    >
    <span class="shrink-0">· Page {page}</span>
  </button>
{/snippet}

{#snippet topicLink(slug: string, title: string)}
  <button
    class="inline-flex h-7 max-w-full min-w-0 items-center rounded-md border border-line-subtle bg-surface px-2.5 font-sans text-[13px] font-medium whitespace-nowrap text-text-2 shadow-1 transition-colors hover:bg-hover hover:text-text dark:bg-raised"
    dir="auto"
    {title}
    onclick={(event) => open(`topic:${slug}`, event)}
    ><span class="truncate">{title}</span></button
  >
{/snippet}

{#snippet heading(text: string)}
  <h2
    class="!mt-10 font-sans !text-[11px] !leading-4 font-medium tracking-[0.06em] text-text-3 uppercase"
  >
    {text}
  </h2>
{/snippet}

{#if course}
  <div class="flex h-full min-h-0">
    <nav
      class="scroll-quiet flex w-[264px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-line-subtle px-3 py-4 max-md:hidden"
      aria-label="Study notes"
    >
      <div class="mb-2 flex items-center gap-2 px-1.5">
        <CourseTile {course} size={18} />
        <span class="min-w-0 flex-1 truncate font-medium text-text" dir="auto"
          >{course.name}</span
        >
      </div>
      <label
        class="mb-2 flex h-8 items-center gap-2 rounded-md border border-line-subtle bg-sunken px-2 text-text-3 focus-within:border-line-strong dark:bg-raised"
      >
        <Search size={14} strokeWidth={1.75} class="shrink-0" />
        <input
          bind:value={filter}
          placeholder="Filter topics"
          aria-label="Filter topics"
          dir="auto"
          class="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-4"
        />
      </label>
      <div
        class="mb-2 grid grid-cols-2 gap-0.5 rounded-md bg-sunken p-0.5 text-[12px] font-medium dark:bg-raised"
        role="tablist"
      >
        {#each [["topics", "Topics"], ["documents", "By document"]] as const as [value, label] (value)}
          <button
            role="tab"
            aria-selected={mode === value}
            class="h-7 rounded-[5px] transition-colors {mode === value
              ? 'bg-surface text-text shadow-1 dark:bg-hover'
              : 'text-text-3 hover:text-text'}"
            onclick={() => (mode = value)}>{label}</button
          >
        {/each}
      </div>
      {#if mode === "topics"}
        {#each topicList as topic (topic.slug)}
          {@const current = selected?.topic?.slug === topic.slug}
          <button
            class="flex flex-col rounded-md px-2 py-1.5 text-left transition-colors {current
              ? 'bg-selected shadow-1'
              : 'hover:bg-hover'}"
            onclick={(event) => open(`topic:${topic.slug}`, event)}
          >
            <span
              class="truncate text-[13px] {current
                ? 'font-medium text-text'
                : 'text-text-2'}"
              dir="auto">{topic.title}</span
            >
            <span class="truncate text-[11px] text-text-3" dir="auto"
              >{topic.taughtIn
                .map((place) => documentLabel(place.documentId))
                .join(" · ")}</span
            >
          </button>
        {:else}
          <span class="px-2 py-1 text-[13px] text-text-3">
            {notes ? "No topics match." : ""}
          </span>
        {/each}
      {:else}
      {#each outline as group (group.session.slug)}
        {@const active = selected?.session?.slug === group.session.slug}
        <button
          class="mt-2 flex flex-col rounded-md px-2 py-1.5 text-left transition-colors {active
            ? 'bg-selected shadow-1'
            : 'hover:bg-hover'}"
          onclick={(event) => open(`session:${group.session.slug}`, event)}
        >
          <span class="truncate text-[13px] font-medium text-text" dir="auto"
            >{documentLabel(group.session.documentId)}</span
          >
          <span class="truncate text-[12px] text-text-3" dir="auto"
            >{group.session.title}</span
          >
        </button>
        {#each group.topics as topic (topic.slug)}
          {@const current = selected?.topic?.slug === topic.slug}
          <button
            class="ml-2 flex h-7 items-center rounded-md border-l border-line-subtle pr-2 pl-3 text-left text-[13px] transition-colors {current
              ? 'border-l-ink bg-selected font-medium text-text shadow-1'
              : 'text-text-2 hover:bg-hover hover:text-text'}"
            onclick={(event) => open(`topic:${topic.slug}`, event)}
          >
            <span class="truncate" dir="auto">{topic.title}</span>
          </button>
        {/each}
      {:else}
        <span class="px-2 py-1 text-[13px] text-text-3">
          {notes ? "No topics match." : ""}
        </span>
      {/each}
      {/if}
    </nav>

    <div class="scroll-quiet min-w-0 flex-1 overflow-y-auto">
      {#if notes === null}
        <div
          class="mx-auto flex max-w-[480px] flex-col items-center gap-2 px-6 py-24 text-center"
        >
          <span class="font-medium text-text">No study notes yet</span>
          <span class="text-text-3">
            Folio studies {course.name}'s lectures and recitations as you add
            them. The notes appear here, by topic, with the slides they came from.
          </span>
        </div>
      {:else if selected?.topic}
        {@const topic = selected.topic}
        <article
          class="prose-folio prose-reading mx-auto max-w-[784px] px-8 pt-10 pb-24 font-serif text-[17px] leading-7 max-sm:px-4"
        >
          <p
            class="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-sans !text-[12px] !leading-4 text-text-3"
          >
            {topic.type === "technique" ? "Technique" : "Concept"}
            {#if topic.taughtIn.length}
              <span>· taught in</span>
              {#each topic.taughtIn as place, index (place.session)}
                <button
                  class="font-medium text-text-2 hover:text-text"
                  dir="auto"
                  onclick={(event) => open(`session:${place.session}`, event)}
                  >{documentLabel(place.documentId)}</button
                >{#if index < topic.taughtIn.length - 1}<span
                    class="text-text-4">·</span
                  >{/if}
              {/each}
            {/if}
          </p>
          <h1 class="!mt-2 font-sans" dir="auto">{topic.title}</h1>
          {#if topic.overview}
            <div class="text-text-2">
              <!-- Sanitized by DOMPurify in renderMarkdown. -->
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html md(topic.overview.text)}
            </div>
          {:else if topic.intuition}
            <div class="text-text-2">
              <!-- Sanitized by DOMPurify in renderMarkdown. -->
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html md(topic.intuition)}
            </div>
          {/if}
          {#if topic.prerequisites.length}
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="font-sans text-[12px] text-text-3">Builds on</span>
              {#each topic.prerequisites as link (link.slug)}
                {@render topicLink(link.slug, link.title)}
              {/each}
            </div>
          {/if}

          {#each topic.sections as section (section.handle)}
            <section
              class="!mt-10 flex flex-col gap-3"
              dir={directionOf(section.title, section.body)}
            >
              <h2 class="!mt-0 font-sans" dir="auto">{section.title}</h2>
              <div class="flex flex-col gap-3">
                <!-- Sanitized by DOMPurify in renderMarkdown. -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html md(section.body)}
              </div>
              {#if section.pages.length || section.alsoIn.length}
                <div class="flex flex-wrap gap-1.5">
                  {#each section.pages as page (page)}
                    {@render pageChip(section.documentId, page)}
                  {/each}
                  {#each section.alsoIn as other (other.handle)}
                    {#each other.pages as page (page)}
                      {@render pageChip(other.documentId, page)}
                    {/each}
                  {/each}
                </div>
              {/if}
              {#each section.alsoIn as other (other.handle)}
                <details class="font-sans text-[14px] leading-6">
                  <summary class="cursor-default text-text-3 hover:text-text-2">
                    How {documentLabel(other.documentId)} puts it
                  </summary>
                  <div class="mt-2 font-serif text-[16px] text-text-2">
                    <!-- Sanitized by DOMPurify in renderMarkdown. -->
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    {@html md(other.body)}
                  </div>
                </details>
              {/each}
              {#if section.questions.length}
                <div
                  class="rounded-lg border border-line-subtle bg-sunken px-4 py-3 font-sans text-[14px] leading-6 dark:bg-raised"
                >
                  <span class="text-[12px] font-medium text-text-3"
                    >Check yourself</span
                  >
                  <ul class="!mt-1 !pl-5">
                    {#each section.questions as question (question)}
                      <li dir="auto">
                        <!-- Sanitized by DOMPurify in renderMarkdown. -->
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                        {@html md(question)
                          .replace(/^<p[^>]*>/, "")
                          .replace(/<\/p>\s*$/, "")}
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </section>
          {/each}

          {#if topic.usedBy.length}
            {@render heading("Used in")}
            <div class="flex flex-wrap gap-1.5">
              {#each topic.usedBy as link (link.slug)}
                {@render topicLink(link.slug, link.title)}
              {/each}
            </div>
          {/if}
          {#if topic.related.length}
            {@render heading("Related")}
            <div class="flex flex-wrap gap-1.5">
              {#each topic.related as link (link.slug)}
                {@render topicLink(link.slug, link.title)}
              {/each}
            </div>
          {/if}
        </article>
      {:else if selected?.session}
        {@const session = selected.session}
        <article
          class="prose-folio prose-reading mx-auto max-w-[784px] px-8 pt-10 pb-24 font-serif text-[17px] leading-7 max-sm:px-4"
        >
          <p class="font-sans !text-[12px] !leading-4 text-text-3" dir="auto">
            {session.type === "recitation" ? "Recitation" : "Lecture"} ·
            {folio.document(session.documentId)?.title ?? session.title}
          </p>
          <h1 class="!mt-2 font-sans" dir="auto">{session.title}</h1>
          {#if session.covers}
            <!-- Sanitized by DOMPurify in renderMarkdown. -->
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html md(session.covers)}
          {/if}
          <div class="flex flex-wrap gap-1.5">
            {@render pageChip(session.documentId, 1)}
          </div>

          {#if session.outline.length}
            {@render heading("In slide order")}
            <div class="flex flex-col">
              {#each session.outline as row, index (`${index}:${row.topic}`)}
                {@const topic = topics.get(row.topic)}
                {#if topic}
                  <button
                    class="-mx-2 flex items-baseline gap-3 rounded-md px-2 py-2 text-left font-sans hover:bg-hover"
                    onclick={(event) => open(`topic:${row.topic}`, event)}
                  >
                    <span
                      class="w-[84px] shrink-0 text-[12px] whitespace-nowrap text-text-3 tabular-nums"
                      >{pageRange(row.pages)}</span
                    >
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="text-[15px] font-medium text-text" dir="auto"
                        >{topic.title}</span
                      >
                      {#if topic.taughtIn.length > 1}
                        <span class="text-[12px] text-text-3" dir="auto"
                          >Also in {topic.taughtIn
                            .filter((place) => place.session !== session.slug)
                            .map((place) => documentLabel(place.documentId))
                            .join(", ")}</span
                        >
                      {/if}
                    </span>
                  </button>
                {/if}
              {/each}
            </div>
          {/if}

          {#if session.onlyHere.length && notes && notes.sessions.length > 1}
            {@render heading(
              session.type === "recitation"
                ? "Only in this recitation"
                : "Only in this lecture",
            )}
            <div class="flex flex-wrap gap-1.5">
              {#each session.onlyHere as slug (slug)}
                {@const topic = topics.get(slug)}
                {#if topic}{@render topicLink(slug, topic.title)}{/if}
              {/each}
            </div>
          {/if}

          {#if session.notation.length}
            {@render heading("Notation")}
            <table class="font-sans text-[14px]">
              <tbody>
                {#each session.notation as entry (entry.symbol)}
                  <tr>
                    <td class="pr-4 align-top whitespace-nowrap">
                      <!-- Sanitized by DOMPurify in renderMarkdown. -->
                      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                      {@html md(entry.symbol)
                        .replace(/^<p[^>]*>/, "")
                        .replace(/<\/p>\s*$/, "")}
                    </td>
                    <td class="text-text-2" dir="auto">
                      <!-- Sanitized by DOMPurify in renderMarkdown. -->
                      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                      {@html md(entry.meaning)
                        .replace(/^<p[^>]*>/, "")
                        .replace(/<\/p>\s*$/, "")}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}

          {#if session.workedExamples.length}
            {@render heading("Worked examples")}
            <div class="flex flex-col gap-2">
              {#each session.workedExamples as example (`${example.page}:${example.title}`)}
                <div class="flex flex-wrap items-center gap-2">
                  <span dir="auto">{example.title}</span>
                  {@render pageChip(session.documentId, example.page)}
                </div>
              {/each}
            </div>
          {/if}

          {#if session.worthRemembering.length}
            {@render heading("Worth remembering")}
            <ul>
              {#each session.worthRemembering as point (point)}
                <!-- Sanitized by DOMPurify in renderMarkdown. -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                <li dir="auto">
                  {@html md(point).replace(/^<p[^>]*>|<\/p>\s*$/g, "")}
                </li>
              {/each}
            </ul>
          {/if}

          {#if session.openThreads.length}
            {@render heading("Left open")}
            <ul>
              {#each session.openThreads as point (point)}
                <!-- Sanitized by DOMPurify in renderMarkdown. -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                <li dir="auto">
                  {@html md(point).replace(/^<p[^>]*>|<\/p>\s*$/g, "")}
                </li>
              {/each}
            </ul>
          {/if}

        </article>
      {:else if notes === undefined}
        <div class="px-8 py-24 text-center text-text-3">Loading…</div>
      {/if}
    </div>
  </div>
{/if}
