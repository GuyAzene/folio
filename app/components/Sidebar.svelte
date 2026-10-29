<script lang="ts">
  import {
    BookOpen,
    Highlighter,
    House,
    ListChecks,
    MessagesSquare,
    NotebookPen,
    PanelLeft,
    Plus,
    Search,
    Settings,
    Trash2,
    SquarePen,
  } from "@lucide/svelte";
  import type { Component } from "svelte";
  import { folio, type Location } from "../lib/state.svelte.ts";
  import AppMark from "./AppMark.svelte";
  import CourseTile from "./CourseTile.svelte";
  import IconButton from "./IconButton.svelte";

  let { onhide }: { onhide: () => void } = $props();

  const here = $derived(folio.location);

  // Studying is a place only while it has something to show: work in progress, a question for
  // the student, or a paused run to resume. Finished runs stay reachable from ⌘K.
  const studyingShown = $derived(
    here.view === "jobs" ||
      folio.jobs.some(
        (job) =>
          job.status === "queued" ||
          job.status === "running" ||
          job.status === "waiting" ||
          job.resumable,
      ),
  );
  const places = $derived(
    (
      [
        { view: "home", label: "Home", icon: House },
        { view: "chats", label: "Chats", icon: MessagesSquare },
        { view: "library", label: "Library", icon: BookOpen },
        { view: "assignments", label: "Assignments", icon: ListChecks },
        { view: "jobs", label: "Studying", icon: Highlighter },
      ] satisfies { view: Location["view"]; label: string; icon: Component }[]
    ).filter((place) => place.view !== "jobs" || studyingShown),
  );
  const openCourseId = $derived(
    here.view === "course" || here.view === "study"
      ? here.courseId
      : here.view === "document"
        ? (folio.document(here.documentId)?.courseId ?? null)
        : here.view === "note"
          ? (folio.note(here.noteId)?.courseId ?? null)
          : here.view === "chat"
            ? here.courseId
            : null,
  );
  const dueSoon = $derived(
    folio.documents.filter(
      (document) =>
        document.role === "assignment" &&
        document.dueAt &&
        new Date(document.dueAt).getTime() - Date.now() < 7 * 86_400_000 &&
        new Date(document.dueAt).getTime() > Date.now(),
    ).length,
  );

  const jobsRunning = $derived(
    folio.jobs.filter((job) => job.status === "running").length,
  );
  const jobsWaiting = $derived(
    folio.jobs.filter((job) => job.status === "waiting").length,
  );
  /** Courses Folio is studying right now. */
  const studyingCourses = $derived(
    new Set(
      folio.jobs
        .filter((job) => job.status === "running" || job.status === "queued")
        .map((job) => job.courseId),
    ),
  );

  function go(location: Location, event: MouseEvent): void {
    folio.navigate(location, { newTab: event.metaKey || event.ctrlKey });
  }
</script>

<aside class="flex h-full w-[260px] flex-col select-none">
  <div
    class="drag flex h-12 shrink-0 items-center gap-2 pr-2.5 {folio.platform ===
    'darwin'
      ? 'pl-[84px]'
      : 'pl-4'}"
  >
    <AppMark size={18} />
    <span class="text-[13px] font-semibold tracking-[-0.01em]">Folio</span>
    <span class="flex-1"></span>
    <IconButton label="Hide sidebar" shortcut="⌘\" onclick={onhide}>
      <PanelLeft size={16} strokeWidth={1.75} />
    </IconButton>
  </div>

  <div class="flex gap-1.5 px-2.5 pt-1">
    <button
      class="flex h-8 flex-1 items-center gap-2 rounded-md border border-line-subtle bg-surface px-2 text-text-3 shadow-1 transition-colors hover:border-line hover:text-text-2"
      onclick={() => (folio.paletteOpen = true)}
    >
      <Search size={14} strokeWidth={1.75} />
      <span class="flex-1 text-left">Search or ask</span>
      <span class="font-mono text-[11px] text-text-4">⌘K</span>
    </button>
    <IconButton
      label="New chat"
      shortcut="⌘N"
      onclick={() => folio.newChat()}
      class="size-8"
    >
      <SquarePen size={15} strokeWidth={1.75} />
    </IconButton>
  </div>

  <nav class="scroll-quiet mt-3 min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
    {#each places as place (place.view)}
      {@const active = here.view === place.view}
      <button
        class="flex h-8 w-full items-center gap-2.5 rounded-md border px-2 transition-colors duration-150 {active
          ? 'border-line-subtle bg-selected text-text shadow-1'
          : 'border-transparent text-text-2 hover:bg-hover hover:text-text'}"
        onclick={(event) => go({ view: place.view } as Location, event)}
      >
        <place.icon size={15} strokeWidth={1.75} class="shrink-0" />
        <span class="min-w-0 flex-1 truncate text-left font-medium"
          >{place.label}</span
        >
        {#if place.view === "assignments" && dueSoon}
          <span class="shrink-0 text-[12px] whitespace-nowrap text-[#c25e0b]"
            >{dueSoon} due soon</span
          >
        {:else if place.view === "jobs"}
          {#if jobsWaiting}
            <span class="shrink-0 text-[12px] whitespace-nowrap text-text-2"
              >{jobsWaiting} needs you</span
            >
          {/if}
          {#if jobsRunning}
            <span
              class="mr-0.5 size-1.5 shrink-0 rounded-full bg-highlight ring-2 ring-highlight/30"
              title="{jobsRunning} running"
            ></span>
            <span class="sr-only">{jobsRunning} running</span>
          {/if}
        {/if}
      </button>
    {/each}

    {#if folio.needsYou.length}
      <div class="mt-5 flex h-6 items-center px-2">
        <span
          class="flex-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase"
          >Needs you</span
        >
      </div>
      {#each folio.needsYou as proposal (proposal.id)}
        <button
          class="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-text-2 transition-colors hover:bg-hover hover:text-text"
          title={proposal.reason || undefined}
          onclick={(event) =>
            go(
              {
                view: "chat",
                chatId: proposal.chatId,
                // A library chat may have suggested it; the chat, not the note, sets the scope.
                courseId:
                  folio.chats.find((chat) => chat.id === proposal.chatId)
                    ?.courseId ?? null,
              },
              event,
            )}
        >
          <span class="relative shrink-0">
            <NotebookPen size={15} strokeWidth={1.75} />
            <span
              class="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-highlight ring-2 ring-bg"
            ></span>
          </span>
          <span class="min-w-0 flex-1 truncate text-left"
            >{proposal.noteId ? "Review edit to" : "Review new note"}
            <bdi>{proposal.noteTitle}</bdi></span
          >
        </button>
      {/each}
    {/if}

    <div class="mt-5 flex h-6 items-center px-2">
      <span
        class="flex-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase"
        >Courses</span
      >
      <IconButton
        label="New course"
        onclick={() => (folio.newCourseOpen = true)}
        class="size-6"
      >
        <Plus size={14} strokeWidth={1.75} />
      </IconButton>
    </div>
    {#each folio.courses as course (course.id)}
      <!-- Selected anywhere inside the course: its page, a document, a note, its study notes or a chat. -->
      {@const open = course.id === openCourseId}
      <button
        class="flex h-8 w-full items-center gap-2.5 rounded-md border px-2 transition-colors duration-150 {open
          ? 'border-line-subtle bg-selected text-text shadow-1'
          : 'border-transparent text-text-2 hover:bg-hover hover:text-text'}"
        onclick={(event) =>
          go({ view: "course", courseId: course.id, tab: "materials" }, event)}
      >
        <CourseTile {course} />
        <span class="min-w-0 flex-1 truncate text-left font-medium" dir="auto"
          >{course.name}</span
        >
        {#if studyingCourses.has(course.id)}
          <span
            class="mr-0.5 size-1.5 shrink-0 rounded-full bg-highlight ring-2 ring-highlight/30"
            title="Folio is studying this course"
          ></span>
          <span class="sr-only">Folio is studying this course</span>
        {/if}
      </button>
    {:else}
      <button
        class="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-text-3 hover:bg-hover hover:text-text"
        onclick={() => (folio.newCourseOpen = true)}
      >
        <span
          class="inline-flex size-[18px] items-center justify-center rounded-[5px] border border-dashed border-line-strong"
          ><Plus size={11} strokeWidth={2} /></span
        >
        Add your first course
      </button>
    {/each}
  </nav>

  <div class="flex flex-col gap-1 px-2.5 pt-1 pb-2.5">
    {#if folio.ready && !folio.connection.connected}
      <button
        class="flex h-8 items-center gap-2.5 rounded-md px-2 text-left font-medium text-text transition-colors hover:bg-hover"
        onclick={() => (folio.settingsOpen = true)}
      >
        <span class="mx-[4.5px] size-1.5 rounded-full bg-text-4"></span>
        <span class="flex-1">Connect ChatGPT</span>
      </button>
    {/if}
    <button
      class="flex h-8 items-center gap-2.5 rounded-md border px-2 transition-colors {here.view ===
      'trash'
        ? 'border-line-subtle bg-selected text-text shadow-1'
        : 'border-transparent text-text-2 hover:bg-hover hover:text-text'}"
      onclick={(event) => go({ view: "trash" }, event)}
    >
      <Trash2 size={15} strokeWidth={1.75} />
      <span class="flex-1 text-left font-medium">Trash</span>
      {#if folio.trash.length}
        <span class="text-[12px] text-text-3">{folio.trash.length}</span>
      {/if}
    </button>
    <button
      class="group flex h-8 items-center gap-2.5 rounded-md px-2 text-text-2 transition-colors hover:bg-hover hover:text-text"
      onclick={() => (folio.settingsOpen = true)}
    >
      <Settings size={15} strokeWidth={1.75} />
      <span class="flex-1 text-left font-medium">Settings</span>
      <span
        class="font-mono text-[11px] text-text-4 opacity-0 transition-opacity group-hover:opacity-100"
        >⌘,</span
      >
    </button>
  </div>
</aside>
