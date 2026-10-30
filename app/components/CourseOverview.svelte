<script lang="ts">
  import { ArrowRight, FileText, MessageSquare, NotebookPen, Plus } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";
  import type { DocumentView } from "../../src/desktop/api.ts";
  import { noteTime, relativeDue, since } from "../lib/labels.ts";
  import { folio, type CourseTab } from "../lib/state.svelte.ts";
  import { shortTitle } from "../lib/titles.ts";
  import StatusIcon from "./StatusIcon.svelte";

  /**
   * A course at a glance: where the student stopped reading and a place to ask, with what is
   * due, the study notes and their own notes on the side. Studying is not counted here: Folio
   * studies every lecture and recitation, and a line shows only while it is at work.
   * Everything here opens the real thing; nothing is a copy of it.
   */
  let {
    courseId,
    ask,
    ontab,
  }: { courseId: string; ask: Snippet; ontab: (tab: CourseTab) => void } = $props();

  $effect(() => {
    void folio.knowledge[courseId];
    untrack(() => void folio.loadStudyNotes(courseId));
  });

  const course = $derived(folio.course(courseId));
  const documents = $derived(folio.documents.filter((item) => item.courseId === courseId));
  const byTitle = (a: DocumentView, b: DocumentView) =>
    a.title.localeCompare(b.title, undefined, { numeric: true });
  const lectures = $derived(documents.filter((item) => item.role === "lecture").sort(byTitle));
  const recitations = $derived(
    documents.filter((item) => item.role === "recitation").sort(byTitle),
  );
  /** Documents read on this device, most recent first. */
  const recent = $derived(
    documents
      .flatMap((document) => {
        const read = folio.reading[document.id];
        return read ? [{ document, ...read }] : [];
      })
      .sort((a, b) => b.at.localeCompare(a.at)),
  );
  /** What to read next when nothing was read yet: the first lecture not opened, or the first. */
  const start = $derived(
    lectures.find((item) => !folio.reading[item.id]) ?? lectures[0] ?? documents[0] ?? null,
  );
  const chats = $derived(
    folio.chats
      .filter((chat) => chat.courseId === courseId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 3),
  );
  const due = $derived(
    folio.assignments
      .filter(
        (item) =>
          item.courseId === courseId &&
          (item.status === "todo" || item.status === "doing") &&
          !item.excused,
      )
      .sort((a, b) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~"))
      .slice(0, 4),
  );
  const studyNotes = $derived(folio.studyNotes[courseId] ?? null);
  const notes = $derived(
    folio.notes
      .filter((note) => note.courseId === courseId)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, 4),
  );
  /** What Folio is studying in this course right now, and how much is waiting after it. */
  const studying = $derived.by(() => {
    const live = folio.jobs.filter(
      (job) => job.courseId === courseId && (job.status === "running" || job.status === "queued"),
    );
    if (!live.length) return null;
    const now = live.find((job) => job.status === "running" && job.kind === "ingest");
    const document = folio.document(now?.documentIds[0]);
    const waiting = live.filter((job) => job.status === "queued").length;
    return { document, updating: live.some((job) => job.kind === "regroup"), waiting };
  });

  const label = (document: DocumentView) => shortTitle(document.title, course?.name);

  const card =
    "rounded-xl border border-line-subtle bg-surface shadow-card dark:bg-raised";
  const heading =
    "flex h-7 items-center gap-2 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase";
  const more =
    "inline-flex items-center gap-1 text-[12px] font-medium text-text-3 normal-case tracking-normal transition-colors hover:text-text";
</script>

<div class="grid grid-cols-[minmax(0,1fr)_272px] gap-8 max-lg:grid-cols-1">
  <div class="flex min-w-0 flex-col gap-7">
    {#if studying}
      <!-- Folio's studying, followed quietly: only while it works on this course. -->
      <button
        class="-mb-3 flex h-9 items-center gap-2.5 self-start rounded-full border border-line-subtle bg-surface pr-3.5 pl-3 text-[12.5px] text-text-2 shadow-card transition-colors hover:text-text dark:bg-raised"
        onclick={() => folio.navigate({ view: "jobs" })}
      >
        <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-highlight"></span>
        <span class="min-w-0 truncate" dir="auto">
          {studying.document
            ? `Studying ${label(studying.document)}`
            : studying.updating
              ? "Updating the study notes"
              : "Studying soon"}{studying.waiting
            ? ` · ${studying.waiting} more after it`
            : ""}
        </span>
      </button>
    {/if}
    {#if recent[0]}
      {@const last = recent[0]}
      {@const pages = last.document.pages}
      <section class="{card} p-4" aria-label="Pick up where you left off">
        <div class={heading}>Pick up where you left off</div>
        <div class="mt-1 flex items-center gap-4">
          <span
            class="flex h-[52px] w-10 shrink-0 items-center justify-center rounded-md border border-line-subtle bg-bg text-text-3"
            ><FileText size={18} strokeWidth={1.5} /></span
          >
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="truncate text-[15px] font-medium text-text" dir="auto"
              >{label(last.document)}</span
            >
            <span class="text-[12.5px] text-text-3 tabular-nums"
              >Page {last.page}{pages ? ` of ${pages}` : ""} · {since(last.at)}</span
            >
            {#if pages}
              <span class="mt-1 h-1 max-w-[320px] overflow-hidden rounded-full bg-line-subtle">
                <span
                  class="block h-full rounded-full bg-ink"
                  style:width="{Math.min(100, (last.page / pages) * 100)}%"
                ></span>
              </span>
            {/if}
          </div>
          <button
            class="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 font-medium text-on-ink shadow-1 transition-opacity hover:opacity-90"
            onclick={(event) =>
              folio.openDocument(last.document.id, last.page, {
                newTab: event.metaKey || event.ctrlKey,
              })}>Resume <ArrowRight size={14} strokeWidth={2} /></button
          >
        </div>
        {#if recent.length > 1}
          <div class="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line-subtle pt-3">
            <span class="mr-1 text-[12px] text-text-3">Also</span>
            {#each recent.slice(1, 4) as item (item.document.id)}
              <button
                class="flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border border-line-subtle px-2.5 text-[12px] text-text-2 transition-colors hover:bg-hover hover:text-text"
                onclick={() => folio.openDocument(item.document.id, item.page)}
              >
                <span class="truncate" dir="auto">{label(item.document)}</span>
                <span class="shrink-0 text-text-3 tabular-nums">p. {item.page}</span>
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {:else if start}
      <section class="{card} flex items-center gap-4 p-4" aria-label="Start reading">
        <span
          class="flex h-[52px] w-10 shrink-0 items-center justify-center rounded-md border border-line-subtle bg-bg text-text-3"
          ><FileText size={18} strokeWidth={1.5} /></span
        >
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-[12px] text-text-3">Start reading</span>
          <span class="truncate text-[15px] font-medium text-text" dir="auto">{label(start)}</span>
        </div>
        <button
          class="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 font-medium text-on-ink shadow-1 transition-opacity hover:opacity-90"
          onclick={() => folio.openDocument(start.id)}
          >Open <ArrowRight size={14} strokeWidth={2} /></button
        >
      </section>
    {:else}
      <section
        class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong px-6 py-10 text-center"
      >
        <span class="max-w-[420px] text-text-3"
          >Drop lecture PDFs or Markdown files anywhere on this page. Folio studies lectures and
          recitations as they arrive.</span
        >
        <button
          class="flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover dark:bg-raised"
          onclick={() => folio.importFiles(courseId, "choose")}
        >
          <Plus size={14} strokeWidth={1.75} /> Add files
        </button>
      </section>
    {/if}

    <section aria-label="Ask">
      {@render ask()}
      {#if chats.length}
        <div class="mt-2 flex flex-col">
          {#each chats as chat (chat.id)}
            <button
              class="-mx-2 flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-text-2 transition-colors hover:bg-hover hover:text-text"
              onclick={(event) =>
                folio.navigate(
                  { view: "chat", chatId: chat.id, courseId },
                  { newTab: event.metaKey || event.ctrlKey },
                )}
            >
              <MessageSquare size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
              <span class="min-w-0 flex-1 truncate" dir="auto">{chat.title}</span>
              <span class="shrink-0 text-[12px] text-text-3">{noteTime(chat.updatedAt)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </section>

  </div>

  <aside class="flex min-w-0 flex-col gap-6" aria-label="This course">
    <section>
      <div class="{heading} justify-between">
        Due
        <button class={more} onclick={() => folio.navigate({ view: "assignments" })}
          >Board <ArrowRight size={12} strokeWidth={2} /></button
        >
      </div>
      {#each due as item (item.id)}
        <button
          class="-mx-2 flex min-h-9 w-[calc(100%+16px)] items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
          onclick={() => folio.navigate({ view: "assignments" })}
        >
          <StatusIcon status={item.status} />
          <span class="min-w-0 flex-1 truncate text-[13px] text-text" dir="auto">{item.title}</span>
          {#if item.dueAt}
            {@const late = Date.parse(item.dueAt) < Date.now()}
            <span
              class="shrink-0 text-[12px] tabular-nums {late ? 'font-medium text-danger' : 'text-text-3'}"
              >{relativeDue(item.dueAt, item.dueHasTime)}</span
            >
          {/if}
        </button>
      {:else}
        <p class="text-[12.5px] text-text-3">Nothing due.</p>
      {/each}
    </section>

    <section>
      <div class="{heading} justify-between">
        Study notes
        {#if studyNotes}
          <button class={more} onclick={() => ontab("study")}
            >All <ArrowRight size={12} strokeWidth={2} /></button
          >
        {/if}
      </div>
      {#if studyNotes?.topics.length}
        <p class="mb-1.5 text-[12.5px] text-text-3">
          {studyNotes.topics.length} topics from {studyNotes.sessions.length}
          {studyNotes.sessions.length === 1 ? "session" : "sessions"}
        </p>
        <div class="flex flex-wrap gap-1.5">
          {#each studyNotes.topics.slice(0, 8) as topic (topic.slug)}
            <button
              class="flex h-7 max-w-full items-center rounded-full border border-line-subtle px-2.5 text-[12px] text-text-2 transition-colors hover:bg-hover hover:text-text"
              onclick={() => folio.openStudyNotes(courseId, `topic:${topic.slug}`)}
              ><span class="truncate" dir="auto">{topic.title}</span></button
            >
          {/each}
        </div>
      {:else}
        <p class="text-[12.5px] leading-5 text-text-3">
          {lectures.length || recitations.length
            ? "Folio writes them as it studies the lectures and recitations."
            : "Add lectures and Folio writes them as it studies."}
        </p>
      {/if}
    </section>

    <section>
      <div class="{heading} justify-between">
        Notes
        <span class="flex items-center gap-3">
          <button class={more} onclick={() => folio.createNote(courseId)}
            ><Plus size={12} strokeWidth={2} /> New</button
          >
          {#if notes.length}
            <button class={more} onclick={() => ontab("notes")}
              >All <ArrowRight size={12} strokeWidth={2} /></button
            >
          {/if}
        </span>
      </div>
      {#each notes as note (note.id)}
        <button
          class="-mx-2 flex h-8 w-[calc(100%+16px)] items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-hover"
          onclick={(event) =>
            folio.openNote(note.id, { newTab: event.metaKey || event.ctrlKey, courseId })}
        >
          <NotebookPen size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
          <span class="min-w-0 flex-1 truncate text-[13px] text-text" dir="auto">{note.title}</span>
          <span class="shrink-0 text-[12px] text-text-3">{noteTime(note.updatedAt)}</span>
        </button>
      {:else}
        <p class="text-[12.5px] text-text-3">No notes yet.</p>
      {/each}
    </section>
  </aside>
</div>
