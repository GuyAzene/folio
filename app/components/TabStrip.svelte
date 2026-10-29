<script lang="ts">
  import {
    BookMarked,
    Trash2,
    BookOpen,
    ChevronLeft,
    ChevronRight,
    FileText,
    House,
    ListChecks,
    MessageSquare,
    MessagesSquare,
    NotebookPen,
    PanelLeft,
    Plus,
    Highlighter,
    X,
  } from "@lucide/svelte";
  import { tabTitle } from "../lib/labels.ts";
  import { folio, type Location } from "../lib/state.svelte.ts";
  import CourseTile from "./CourseTile.svelte";
  import IconButton from "./IconButton.svelte";

  let { leftInset }: { leftInset: boolean } = $props();
  let dragging = $state<number | null>(null);

  const icons = {
    home: House,
    library: BookOpen,
    chats: MessagesSquare,
    assignments: ListChecks,
    jobs: Highlighter,
    document: FileText,
    note: NotebookPen,
    study: BookMarked,
    trash: Trash2,
    chat: MessageSquare,
  };

  function current(index: number): Location {
    const tab = folio.tabs[index]!;
    return tab.history[tab.index]!;
  }
</script>

<div
  class="drag flex h-11 shrink-0 items-center gap-1 border-b border-line-subtle pr-2 {leftInset
    ? folio.platform === 'darwin'
      ? 'pl-[84px]'
      : 'pl-2'
    : 'pl-2'}"
>
  {#if leftInset}
    <IconButton
      label="Show sidebar"
      shortcut="⌘\"
      onclick={() => (folio.sidebarOpen = true)}
    >
      <PanelLeft size={16} strokeWidth={1.75} />
    </IconButton>
  {/if}
  <IconButton
    label="Back"
    shortcut="⌘["
    disabled={folio.activeTab.index === 0}
    onclick={() => folio.back()}
  >
    <ChevronLeft size={16} strokeWidth={1.75} />
  </IconButton>
  <IconButton
    label="Forward"
    shortcut="⌘]"
    disabled={folio.activeTab.index >= folio.activeTab.history.length - 1}
    onclick={() => folio.forward()}
  >
    <ChevronRight size={16} strokeWidth={1.75} />
  </IconButton>

  <div
    class="no-drag ml-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
  >
    {#each folio.tabs as tab, index (tab.id)}
      {@const location = current(index)}
      {@const active = tab.id === folio.activeTabId}
      {@const course =
        location.view === "course"
          ? folio.course(location.courseId)
          : undefined}
      {@const Icon = location.view === "course" ? null : icons[location.view]}
      <div
        role="tab"
        tabindex="0"
        aria-selected={active}
        draggable="true"
        class="group flex h-[30px] max-w-[200px] min-w-[96px] shrink-0 cursor-default items-center gap-2 rounded-md border pr-1 pl-2.5 transition-colors {active
          ? 'border-line-subtle bg-sunken text-text shadow-1 dark:bg-selected'
          : 'border-transparent text-text-3 hover:bg-hover hover:text-text-2'} {dragging ===
        index
          ? 'opacity-50'
          : ''}"
        onclick={() => folio.selectTab(tab.id)}
        onauxclick={(event) => event.button === 1 && folio.closeTab(tab.id)}
        onkeydown={(event) => event.key === "Enter" && folio.selectTab(tab.id)}
        ondragstart={() => (dragging = index)}
        ondragend={() => (dragging = null)}
        ondragover={(event) => event.preventDefault()}
        ondrop={() => {
          if (dragging !== null && dragging !== index)
            folio.moveTab(dragging, index);
          dragging = null;
        }}
      >
        {#if course}
          <CourseTile {course} size={14} />
        {:else if Icon}
          <Icon size={13} strokeWidth={1.75} class="shrink-0" />
        {/if}
        <span
          class="min-w-0 flex-1 truncate text-[12.5px] font-medium"
          dir="auto">{tabTitle(location)}</span
        >
        <button
          class="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-3 opacity-0 group-hover:opacity-100 hover:bg-press hover:text-text {active
            ? 'opacity-100'
            : ''}"
          aria-label="Close tab"
          onclick={(event) => {
            event.stopPropagation();
            folio.closeTab(tab.id);
          }}
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
    {/each}
    <IconButton
      label="New tab"
      shortcut="⌘T"
      onclick={() => folio.openTab()}
      class="size-[30px]"
    >
      <Plus size={15} strokeWidth={1.75} />
    </IconButton>
  </div>
</div>
