<script lang="ts">
  import { ChevronDown, Hash, NotebookPen, Search, SquarePen, X } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import { tick } from "svelte";
  import type { NoteView as Note } from "../../src/desktop/api.ts";
  import CourseTile from "../components/CourseTile.svelte";
  import IconButton from "../components/IconButton.svelte";
  import NoteRow from "../components/NoteRow.svelte";
  import { noteGroup, PENCIL } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import NoteView from "./NoteView.svelte";

  /**
   * The notebook: every note on the left, newest first under Pinned, Today, Previous 7 days and
   * so on, and the open note on the right. Courses are the folders and #tags cut across them;
   * search reads the notes' text. A course's own notes are this view filtered to it.
   */
  let { noteId, courseId }: { noteId: string | null; courseId: string | null } = $props();

  let query = $state("");
  let tag = $state<string | null>(null);
  /** Search results, best first, with the line each matched; null while not searching. */
  let hits = $state<{ noteId: string; snippet: string }[] | null>(null);
  let list = $state<HTMLElement>();
  let searchToken = 0;

  const inCourse = $derived(
    folio.notes.filter((note) => !courseId || note.courseId === courseId),
  );
  const tagKey = (value: string) => value.toLocaleLowerCase();
  /** A tag also matches the tags nested under it, as #exam matches #exam/week1. */
  const tagged = $derived(
    tag
      ? inCourse.filter((note) =>
          note.tags.some(
            (candidate) =>
              tagKey(candidate) === tagKey(tag!) ||
              tagKey(candidate).startsWith(`${tagKey(tag!)}/`),
          ),
        )
      : inCourse,
  );
  /** Every tag in the course's notes (or all notes), most used first. */
  const tags = $derived.by(() => {
    const counts = new Map<string, { tag: string; count: number }>();
    for (const note of inCourse)
      for (const candidate of note.tags) {
        const entry = counts.get(tagKey(candidate)) ?? { tag: candidate, count: 0 };
        entry.count++;
        counts.set(tagKey(candidate), entry);
      }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  });

  const searching = $derived(query.trim().length > 0);
  const results = $derived(
    searching && hits
      ? hits.flatMap((hit) => {
          const note = tagged.find((candidate) => candidate.id === hit.noteId);
          return note ? [{ note, snippet: hit.snippet }] : [];
        })
      : null,
  );
  const groups = $derived.by(() => {
    const sorted = [...tagged].sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
    const out: { title: string; notes: Note[] }[] = [];
    const pinned = sorted.filter((note) => folio.pinnedNotes.includes(note.id));
    if (pinned.length) out.push({ title: "Pinned", notes: pinned });
    for (const note of sorted) {
      if (folio.pinnedNotes.includes(note.id)) continue;
      const title = noteGroup(note.updatedAt);
      const last = out.at(-1);
      if (last && last.title === title) last.notes.push(note);
      else out.push({ title, notes: [note] });
    }
    return out;
  });
  const visible = $derived(
    results ? results.map((result) => result.note) : groups.flatMap((group) => group.notes),
  );
  /** The open note: the one chosen, or else the newest in the list. */
  const shown = $derived(
    noteId && folio.note(noteId) ? noteId : (visible[0]?.id ?? null),
  );
  const filterCourse = $derived(folio.course(courseId));

  // Searching reads every note's text in the main process; a newer search wins.
  $effect(() => {
    const text = query.trim();
    const scope = courseId;
    // Saved notes change what matches, so a library refresh searches again.
    void folio.notes;
    if (!text) {
      hits = null;
      return;
    }
    const token = ++searchToken;
    const timer = setTimeout(async () => {
      const found = await folio.api.searchNotes(text, scope).catch(() => []);
      if (token === searchToken) hits = found;
    }, 120);
    return () => clearTimeout(timer);
  });

  function open(id: string, newTab = false): void {
    if (newTab) folio.openNote(id, { newTab: true });
    else if (id !== noteId) folio.navigate({ view: "notes", noteId: id, courseId });
  }

  function setCourse(id: string | null): void {
    folio.update({ courseId: id });
  }

  /** ↑ and ↓ move through the list, as in a mail or notes app. */
  async function walk(event: KeyboardEvent): Promise<void> {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if ((event.target as HTMLElement).closest("input")) return;
    event.preventDefault();
    const index = visible.findIndex((note) => note.id === shown);
    const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    open(next.id);
    await tick();
    list?.querySelector<HTMLElement>(`[data-note="${next.id}"]`)?.focus();
  }

  const courseForNew = $derived(
    courseId ?? (folio.courses.length === 1 ? folio.courses[0]!.id : null),
  );
  const menuItem =
    "flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover";
  const chip =
    "flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors";
</script>

{#snippet newNoteButton()}
  {#if courseForNew}
    <IconButton label="New note" onclick={() => folio.createNote(courseForNew!)}>
      <SquarePen size={15} strokeWidth={1.75} />
    </IconButton>
  {:else if folio.courses.length}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="flex size-7 shrink-0 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-hover hover:text-text data-[state=open]:bg-hover data-[state=open]:text-text"
        aria-label="New note"
        title="New note"
      >
        <SquarePen size={15} strokeWidth={1.75} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          class="z-50 max-w-[280px] min-w-[200px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
        >
          <div
            class="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase"
          >
            New note in
          </div>
          {#each folio.courses as course (course.id)}
            <DropdownMenu.Item class={menuItem} onSelect={() => folio.createNote(course.id)}>
              <CourseTile {course} size={16} />
              <span class="min-w-0 flex-1 truncate" dir="auto">{course.name}</span>
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  {/if}
{/snippet}

<div class="flex h-full min-h-0">
  <aside
    class="flex w-[300px] shrink-0 flex-col border-r border-line-subtle max-md:w-[232px]"
    aria-label="Notes"
  >
    <div class="flex h-11 shrink-0 items-center gap-1 pr-2 pl-4">
      <h1 class="min-w-0 flex-1 truncate font-semibold text-text" dir="auto">
        {filterCourse ? filterCourse.name : "Notes"}
      </h1>
      {#if tags.length}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex size-7 shrink-0 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-hover hover:text-text data-[state=open]:bg-hover data-[state=open]:text-text"
            aria-label="Filter by tag"
            title="Tags"
          >
            <Hash size={15} strokeWidth={1.75} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              class="z-50 max-h-[360px] max-w-[260px] min-w-[200px] animate-[folio-scale_140ms_var(--ease-out-quint)] overflow-y-auto rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
            >
              <div
                class="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase"
              >
                Tags
              </div>
              {#each tags as entry (entry.tag)}
                <DropdownMenu.Item
                  class={menuItem}
                  onSelect={() => (tag = tag === entry.tag ? null : entry.tag)}
                >
                  <span class="min-w-0 flex-1 truncate" dir="auto">#{entry.tag}</span>
                  <span class="shrink-0 text-[12px] text-text-3 tabular-nums">{entry.count}</span>
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {/if}
      {@render newNoteButton()}
    </div>

    <div class="shrink-0 px-3 pb-2">
      <label
        class="flex h-8 items-center gap-2 rounded-md border border-line-subtle bg-bg px-2 text-text-3 transition-colors focus-within:border-line-strong dark:bg-raised"
      >
        <Search size={14} strokeWidth={1.75} class="shrink-0" />
        <input
          bind:value={query}
          class="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-3"
          placeholder={filterCourse ? "Search this course's notes" : "Search notes"}
          aria-label="Search notes"
          dir="auto"
          onkeydown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              query = "";
            }
          }}
        />
        {#if query}
          <button
            type="button"
            class="flex size-5 shrink-0 items-center justify-center rounded text-text-3 hover:bg-hover hover:text-text"
            aria-label="Clear search"
            onclick={() => (query = "")}><X size={12} strokeWidth={2} /></button
          >
        {/if}
      </label>
    </div>

    {#if folio.courses.length > 1 || tag}
      <div
        class="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-2.5 [scrollbar-width:none]"
        role="toolbar"
        aria-label="Filter notes"
      >
        {#if tag}
          <button
            type="button"
            class="{chip} border-line-strong bg-selected text-text"
            aria-label="Stop filtering by #{tag}"
            onclick={() => (tag = null)}
          >
            <span class="max-w-[120px] truncate" dir="auto">#{tag}</span>
            <X size={12} strokeWidth={2} />
          </button>
        {/if}
        {#if folio.courses.length > 1}
          <button
            type="button"
            class="{chip} {courseId === null
              ? 'border-line-strong bg-selected text-text'
              : 'border-line-subtle text-text-2 hover:bg-hover'}"
            aria-pressed={courseId === null}
            onclick={() => setCourse(null)}>All</button
          >
          {#each folio.courses as course (course.id)}
            <button
              type="button"
              class="{chip} {courseId === course.id
                ? 'border-line-strong bg-selected text-text'
                : 'border-line-subtle text-text-2 hover:bg-hover'}"
              aria-pressed={courseId === course.id}
              onclick={() => setCourse(courseId === course.id ? null : course.id)}
            >
              <span class="size-2 shrink-0 rounded-full" style:background={PENCIL[course.color]}
              ></span>
              <span class="max-w-[140px] truncate" dir="auto">{course.name}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={list}
      class="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      onkeydown={walk}
    >
      {#if results}
        <div class="flex h-7 items-center px-2 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase">
          {results.length === 1 ? "1 result" : `${results.length} results`}
        </div>
        {#each results as result (result.note.id)}
          <NoteRow
            note={result.note}
            selected={result.note.id === shown}
            snippet={result.snippet}
            {query}
            showCourse={!courseId}
            roving
            onopen={(newTab) => open(result.note.id, newTab)}
            ontag={(value) => (tag = value)}
          />
        {:else}
          <p class="px-2 py-6 text-center text-[13px] text-text-3">
            No notes match “<bdi>{query.trim()}</bdi>”.
          </p>
        {/each}
      {:else if searching}
        <div class="h-7"></div>
      {:else}
        {#each groups as group (group.title)}
          <div
            class="flex h-7 items-center px-2 pt-2 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase first:pt-0"
          >
            {group.title}
          </div>
          {#each group.notes as note (note.id)}
            <NoteRow
              {note}
              selected={note.id === shown}
              showCourse={!courseId}
              roving
              onopen={(newTab) => open(note.id, newTab)}
              ontag={(value) => (tag = value)}
            />
          {/each}
        {:else}
          <p class="px-2 py-6 text-center text-[13px] leading-5 text-text-3">
            {tag
              ? `No notes tagged #${tag}${filterCourse ? " in this course" : ""}.`
              : filterCourse
                ? "No notes in this course yet."
                : "No notes yet."}
          </p>
        {/each}
      {/if}
    </div>
  </aside>

  <section class="min-w-0 flex-1">
    {#if shown}
      {#key shown}
        <NoteView noteId={shown} />
      {/key}
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <NotebookPen size={22} strokeWidth={1.5} class="text-text-3" />
        <div class="max-w-[360px] text-[13.5px] leading-6 text-text-2">
          Notes for every course, in Markdown. Write your own, add a passage from a lecture, or
          ask the tutor to write one. Every change can be undone.
        </div>
        {#if courseForNew}
          <button
            class="mt-1 h-8 rounded-md bg-ink px-3 font-medium text-on-ink shadow-1 hover:opacity-90"
            onclick={() => folio.createNote(courseForNew!)}>New note</button
          >
        {:else if folio.courses.length}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="mt-1 flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 font-medium text-on-ink shadow-1 hover:opacity-90"
              >New note <ChevronDown size={14} strokeWidth={2} /></DropdownMenu.Trigger
            >
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                sideOffset={6}
                class="z-50 max-w-[280px] min-w-[200px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
              >
                {#each folio.courses as course (course.id)}
                  <DropdownMenu.Item class={menuItem} onSelect={() => folio.createNote(course.id)}>
                    <CourseTile {course} size={16} />
                    <span class="min-w-0 flex-1 truncate" dir="auto">{course.name}</span>
                  </DropdownMenu.Item>
                {/each}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        {/if}
      </div>
    {/if}
  </section>
</div>
