<script lang="ts">
  import { tabTitle } from "../lib/labels.ts";
  import { lastUsed, type Layout, type Pane } from "../lib/layout.ts";
  import { setPane } from "../lib/pane.ts";
  import { PLACE_ICONS } from "../lib/place-icons.ts";
  import { folio } from "../lib/state.svelte.ts";
  import AssignmentsBoard from "../views/AssignmentsBoard.svelte";
  import ChatView from "../views/ChatView.svelte";
  import ChatsHub from "../views/ChatsHub.svelte";
  import CourseView from "../views/CourseView.svelte";
  import DocumentView from "../views/DocumentView.svelte";
  import HomeView from "../views/HomeView.svelte";
  import JobsView from "../views/JobsView.svelte";
  import ListViews from "../views/ListViews.svelte";
  import NotesHub from "../views/NotesHub.svelte";
  import StudyView from "../views/StudyView.svelte";
  import TrashView from "../views/TrashView.svelte";
  import CourseTile from "./CourseTile.svelte";
  import PaneControls from "./PaneControls.svelte";

  /** One pane: the place it shows, and what its view knows of the pane (see pane.ts). */
  let {
    tabId,
    pane,
    layout,
    width,
  }: { tabId: string; pane: Pane; layout: Layout; width: number } = $props();

  const location = $derived(pane.location);
  const split = $derived(layout.panes.length > 1);
  const followed = $derived(lastUsed(layout, "document"));

  setPane({
    get id() {
      return pane.id;
    },
    get tabId() {
      return tabId;
    },
    get split() {
      return split;
    },
    get lead() {
      return split && layout.panes[0]?.id === pane.id && !layout.maximized;
    },
    get maximized() {
      return layout.maximized === pane.id;
    },
    get active() {
      return layout.recent[0] === pane.id;
    },
    get width() {
      return width;
    },
    get source() {
      return followed && followed.id !== pane.id ? followed : null;
    },
  });

  /** These draw their own header, with the pane's buttons at its end. */
  const OWN_HEADER = new Set(["document", "chat", "notes"]);
  const Icon = $derived(PLACE_ICONS[location.view]);
  const course = $derived(location.view === "course" ? folio.course(location.courseId) : undefined);
</script>

{#if split && !OWN_HEADER.has(location.view)}
  <div class="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle pr-2 pl-4">
    {#if course}<CourseTile {course} size={16} />{:else if Icon}<Icon
        size={14}
        strokeWidth={1.75}
        class="shrink-0 text-text-3"
      />{/if}
    <span class="min-w-0 flex-1 truncate font-medium text-text" dir="auto"
      >{tabTitle(location)}</span
    >
    <PaneControls />
  </div>
{/if}
<div class="relative flex min-h-0 flex-1 flex-col">
  {#if location.view === "home"}
    <HomeView paneId={pane.id} />
  {:else if location.view === "course"}
    <CourseView paneId={pane.id} courseId={location.courseId} tab={location.tab} />
  {:else if location.view === "document"}
    {#key location.documentId}
      <DocumentView paneId={pane.id} {location} />
    {/key}
  {:else if location.view === "notes"}
    <NotesHub paneId={pane.id} noteId={location.noteId} courseId={location.courseId} />
  {:else if location.view === "study"}
    <StudyView courseId={location.courseId} item={location.item} />
  {:else if location.view === "chats" || (location.view === "chat" && !split)}
    <!-- A chat on its own shows with the list of chats beside it. -->
    <ChatsHub paneId={pane.id} {location} />
  {:else if location.view === "chat"}
    <ChatView paneId={pane.id} {location} />
  {:else if location.view === "jobs"}
    <JobsView />
  {:else if location.view === "trash"}
    <TrashView />
  {:else if location.view === "assignments"}
    <AssignmentsBoard />
  {:else}
    <ListViews view={location.view} />
  {/if}
</div>
