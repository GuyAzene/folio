<script lang="ts">
  import {
    BookOpen,
    Hand,
    Highlighter,
    House,
    ListChecks,
    MessagesSquare,
    NotebookPen,
    Plug,
    Plus,
    Search,
    Settings,
    SquarePen,
    Trash2,
    X,
  } from "@lucide/svelte";
  import type { Component } from "svelte";
  import { PENCIL } from "../lib/labels.ts";
  import { folio, type Location } from "../lib/state.svelte.ts";
  import AppMark from "./AppMark.svelte";
  import CourseTile from "./CourseTile.svelte";
  import IconButton from "./IconButton.svelte";


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
        { view: "notes", label: "Notes", icon: NotebookPen },
        { view: "library", label: "Library", icon: BookOpen },
        { view: "assignments", label: "Assignments", icon: ListChecks },
        { view: "jobs", label: "Studying", icon: Highlighter },
      ] satisfies { view: Location["view"]; label: string; icon: Component }[]
    ).filter((place) => place.view !== "jobs" || studyingShown),
  );
  /** A chat on its own shows in Chats, with the list beside it. */
  const inChats = $derived(
    here.view === "chats" || (here.view === "chat" && folio.layout.panes.length === 1),
  );
  const openCourseId = $derived(
    here.view === "course" || here.view === "study"
      ? here.courseId
      : here.view === "document"
        ? (folio.document(here.documentId)?.courseId ?? null)
        : here.view === "chat" && !inChats
          ? here.courseId
          : null,
  );
  /** Work still to hand in within a week, from the board's records. */
  const dueSoon = $derived(
    folio.assignments.filter(
      (item) =>
        (item.status === "todo" || item.status === "doing") &&
        !item.excused &&
        item.dueAt &&
        new Date(item.dueAt).getTime() - Date.now() < 7 * 86_400_000 &&
        new Date(item.dueAt).getTime() > Date.now(),
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

  /** Pinned notes that are still in the library, in the order they were pinned. */
  const pinned = $derived(
    folio.pinnedNotes.flatMap((id) => {
      const note = folio.note(id);
      return note ? [note] : [];
    }),
  );
  const shownNoteId = $derived(here.view === "notes" ? here.noteId : null);

  /** A place fills the tab; ⌘-click opens it in a new tab. */
  function go(location: Location, event: MouseEvent): void {
    folio.navigate(location, { newTab: event.metaKey || event.ctrlKey, fill: true });
  }
</script>

<aside class="flex h-full w-[260px] flex-col select-none">
  <!-- The sidebar button itself is pinned by the window controls (App), so it never moves. -->
  <div
    class="drag flex h-[61px] shrink-0 items-center gap-2 pr-2.5 {folio.platform ===
    'darwin'
      ? 'pl-[118px]'
      : 'pl-12'}"
  >
    <AppMark size={18} />
    <span class="text-[13px] font-semibold tracking-[-0.01em]">Folio</span>
  </div>

  <div class="flex gap-1.5 px-2.5 pt-1">
    <button
      class="flex h-8 flex-1 items-center gap-2 rounded-md bg-hover px-2 text-text-3 transition-colors hover:bg-press hover:text-text-2"
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
      {@const active = place.view === "chats" ? inChats : here.view === place.view}
      <button
        class="flex h-8 w-full items-center gap-2.5 rounded-md border px-2 transition-colors duration-150 {active
          ? 'border-transparent bg-press text-text'
          : 'border-transparent text-text-2 hover:bg-hover hover:text-text'}"
        onclick={(event) =>
          go(
            place.view === "notes"
              ? { view: "notes", noteId: null, courseId: null }
              : ({ view: place.view } as Location),
            event,
          )}
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

    {#if folio.needsYou.length || folio.waitingChanges.length || folio.approvals.length}
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
            folio.openChat(proposal.chatId, { newTab: event.metaKey || event.ctrlKey, fill: true })}
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
      {#each folio.approvals as approval (approval.id)}
        <button
          class="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-text-2 transition-colors hover:bg-hover hover:text-text"
          title="Folio waits for you to allow or deny this"
          onclick={(event) =>
            folio.openChat(approval.chatId, { newTab: event.metaKey || event.ctrlKey, fill: true })}
        >
          <span class="relative shrink-0">
            <Plug size={15} strokeWidth={1.75} />
            <span
              class="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-highlight ring-2 ring-bg"
            ></span>
          </span>
          <span class="min-w-0 flex-1 truncate text-left"
            >Allow {approval.label} · <bdi>{approval.tool}</bdi>?</span
          >
        </button>
      {/each}
      {#each folio.waitingChanges as change (change.id)}
        <button
          class="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-text-2 transition-colors hover:bg-hover hover:text-text"
          title={change.summary}
          onclick={(event) =>
            folio.openChat(change.chatId, { newTab: event.metaKey || event.ctrlKey, fill: true })}
        >
          <span class="relative shrink-0">
            <Hand size={15} strokeWidth={1.75} />
            <span
              class="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-highlight ring-2 ring-bg"
            ></span>
          </span>
          <span class="min-w-0 flex-1 truncate text-left" dir="auto"
            >{change.summary}</span
          >
        </button>
      {/each}
    {/if}

    {#if pinned.length}
      <div class="mt-5 flex h-6 items-center px-2">
        <span
          class="flex-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase"
          >Pinned</span
        >
      </div>
      {#each pinned as note (note.id)}
        {@const course = folio.course(note.courseId)}
        <button
          class="flex h-8 w-full items-center gap-2.5 rounded-md border px-2 transition-colors duration-150 {note.id ===
          shownNoteId
            ? 'border-transparent bg-press text-text'
            : 'border-transparent text-text-2 hover:bg-hover hover:text-text'}"
          onclick={(event) =>
            folio.openNote(note.id, { newTab: event.metaKey || event.ctrlKey, fill: true })}
        >
          <span class="flex size-[18px] shrink-0 items-center justify-center">
            <span
              class="size-2 rounded-full"
              style:background={course ? PENCIL[course.color] : "var(--text-4)"}
            ></span>
          </span>
          <span class="min-w-0 flex-1 truncate text-left" dir="auto"
            >{note.title}</span
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
          ? 'border-transparent bg-press text-text'
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
    {#if folio.ready && !folio.canUse(folio.modelChoice)}
      <button
        class="flex h-8 items-center gap-2.5 rounded-md px-2 text-left font-medium text-text transition-colors hover:bg-hover"
        onclick={() => folio.openSettings("connections")}
      >
        <span class="mx-[4.5px] size-1.5 rounded-full bg-text-4"></span>
        <span class="flex-1"
          >Connect {folio.connectionFor(folio.modelChoice)?.name ?? "a model"}</span
        >
      </button>
    {/if}
    {#if folio.announcedRelease}
      {@const release = folio.announcedRelease}
      <!-- Links to the release's page, which opens in the browser; Folio never downloads it. -->
      <div
        class="group relative flex h-8 items-center rounded-md transition-colors hover:bg-hover"
      >
        <a
          href={release.url}
          target="_blank"
          rel="noopener noreferrer"
          title="See what's new, in your browser"
          class="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 pr-8 font-medium text-text no-underline"
        >
          <span
            class="mx-[4.5px] size-1.5 shrink-0 rounded-full bg-highlight ring-2 ring-highlight/30"
          ></span>
          <span class="min-w-0 flex-1 truncate">Folio {release.version} is out</span>
        </a>
        <IconButton
          label="Hide until the next release"
          onclick={() => folio.dismissRelease(release.version)}
          class="absolute right-1 size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <X size={13} strokeWidth={2} />
        </IconButton>
      </div>
    {/if}
    <button
      class="flex h-8 items-center gap-2.5 rounded-md border px-2 transition-colors {here.view ===
      'trash'
        ? 'border-transparent bg-press text-text'
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
