<script lang="ts">
  import { PanelLeft, X } from "@lucide/svelte";
  import { Tooltip } from "bits-ui";
  import CommandPalette from "./components/CommandPalette.svelte";
  import IconButton from "./components/IconButton.svelte";
  import NewCourseDialog from "./components/NewCourseDialog.svelte";
  import SettingsDialog from "./components/SettingsDialog.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import TabStrip from "./components/TabStrip.svelte";
  import { folio } from "./lib/state.svelte.ts";
  import ChatView from "./views/ChatView.svelte";
  import CourseView from "./views/CourseView.svelte";
  import DocumentView from "./views/DocumentView.svelte";
  import HomeView from "./views/HomeView.svelte";
  import JobsView from "./views/JobsView.svelte";
  import AssignmentsBoard from "./views/AssignmentsBoard.svelte";
  import ListViews from "./views/ListViews.svelte";
  import NotesHub from "./views/NotesHub.svelte";
  import NoteSwitcher from "./components/NoteSwitcher.svelte";
  import StudyView from "./views/StudyView.svelte";
  import TrashView from "./views/TrashView.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";

  let width = $state(1280);

  // Below this width the sidebar floats over the content instead of taking space beside it.
  const compact = $derived(width < 900);
  const docked = $derived(folio.sidebarOpen && !compact);

  let wasCompact: boolean | undefined;
  $effect(() => {
    if (wasCompact !== undefined && compact !== wasCompact)
      folio.sidebarOpen = !compact;
    wasCompact = compact;
  });

  // Choosing a place from the floating sidebar returns to the content.
  $effect(() => {
    void folio.location;
    if (compact) folio.sidebarOpen = false;
  });

  $effect(() => {
    if (!folio.notice) {
      folio.noticeAction = null;
      return;
    }
    // A notice with Undo stays long enough to use it.
    const timer = setTimeout(
      () => (folio.notice = null),
      folio.noticeAction ? 6000 : 3200,
    );
    return () => clearTimeout(timer);
  });

  function toggleSidebar(): void {
    folio.sidebarOpen = !folio.sidebarOpen;
    folio.persistLayout();
  }

  function onkeydown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const location = folio.location;
    if (mod && key === "k") {
      event.preventDefault();
      folio.paletteOpen = true;
    } else if (mod && key === "o" && !event.shiftKey) {
      event.preventDefault();
      folio.switcherOpen = true;
    } else if (mod && key === "n") {
      event.preventDefault();
      folio.newChat(location.view === "course" ? location.courseId : null);
    } else if (mod && key === "t") {
      event.preventDefault();
      folio.openTab();
    } else if (mod && key === "w") {
      event.preventDefault();
      folio.closeTab(folio.activeTabId);
    } else if (mod && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      const tab =
        event.key === "9"
          ? folio.tabs.at(-1)
          : folio.tabs[Number(event.key) - 1];
      if (tab) folio.selectTab(tab.id);
    } else if (mod && event.key === "[") {
      event.preventDefault();
      folio.back();
    } else if (mod && event.key === "]") {
      event.preventDefault();
      folio.forward();
    } else if (mod && event.key === "\\") {
      event.preventDefault();
      toggleSidebar();
    } else if (mod && key === "j" && location.view === "document") {
      event.preventDefault();
      folio.update({
        panel: location.panel === "closed" ? "docked" : "closed",
      });
    } else if (mod && event.key === ",") {
      event.preventDefault();
      folio.settingsOpen = true;
    } else if (
      event.key === "Escape" &&
      !folio.settingsOpen &&
      !folio.paletteOpen
    ) {
      const chatId =
        location.view === "chat" || location.view === "document"
          ? location.chatId
          : null;
      if (chatId && folio.running(folio.chatViews[chatId] ?? null))
        folio.cancel(chatId);
    }
  }
</script>

<svelte:window bind:innerWidth={width} {onkeydown} />

<Tooltip.Provider>
  <div class="relative flex h-full w-full overflow-hidden bg-bg">
    <div
      class="h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-[var(--ease-out-quint)]"
      style="width:{docked ? 260 : 0}px"
    >
      {#if !compact}
        <Sidebar />
      {/if}
    </div>

    <!--
      The frame around the page moves the window, like the tab strip's empty space. Not the drag
      utility: its user-select: none would reach every page inside.
    -->
    <main class="flex h-full [-webkit-app-region:drag] min-w-0 flex-1 p-2 {docked ? 'pl-0' : ''}">
      <section
        class="no-drag relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface shadow-1"
      >
        <TabStrip leftInset={!docked} />
        <div class="relative min-h-0 flex-1">
          {#if folio.ready}
            {#each folio.tabs as tab (tab.id)}
              {@const location = tab.history[tab.index]!}
              {#if tab.id === folio.activeTabId}
                <div class="absolute inset-0 flex flex-col">
                  {#if location.view === "home"}
                    <HomeView tabId={tab.id} />
                  {:else if location.view === "course"}
                    <CourseView
                      tabId={tab.id}
                      courseId={location.courseId}
                      tab={location.tab}
                    />
                  {:else if location.view === "document"}
                    {#key location.documentId}
                      <DocumentView tabId={tab.id} {location} />
                    {/key}
                  {:else if location.view === "notes"}
                    <NotesHub noteId={location.noteId} courseId={location.courseId} />
                  {:else if location.view === "study"}
                    <StudyView
                      courseId={location.courseId}
                      item={location.item}
                    />
                  {:else if location.view === "chat"}
                    <ChatView tabId={tab.id} {location} />
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
              {/if}
            {/each}
          {/if}
        </div>

        {#if folio.error || folio.notice}
          <div
            class="absolute bottom-4 left-1/2 z-10 flex max-w-[min(560px,calc(100%-32px))] -translate-x-1/2 animate-[folio-in_200ms_var(--ease-out-quint)] items-start gap-2 rounded-lg border bg-raised py-2 pr-1.5 pl-3 text-[13px] shadow-2 {folio.error
              ? 'border-danger/20'
              : 'border-line-subtle'}"
            role={folio.error ? "alert" : "status"}
          >
            <span
              class="mt-px size-1.5 shrink-0 translate-y-[5px] rounded-full {folio.error
                ? 'bg-danger'
                : 'bg-success'}"
            ></span>
            <span class="flex-1 text-text">{folio.error ?? folio.notice}</span>
            {#if !folio.error && folio.noticeAction}
              {@const action = folio.noticeAction}
              <button
                class="-my-0.5 h-6 shrink-0 rounded-md px-2 font-medium text-text hover:bg-hover"
                onclick={() => {
                  action.run();
                  folio.notice = null;
                }}>{action.label}</button
              >
            {/if}
            <button
              class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
              aria-label="Dismiss"
              onclick={() => ((folio.error = null), (folio.notice = null))}
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
        {/if}
      </section>
    </main>

    {#if compact && folio.sidebarOpen}
      <button
        class="no-drag absolute inset-0 z-20 animate-[folio-fade_150ms_ease-out] bg-[#18181b]/15 dark:bg-black/40"
        aria-label="Close sidebar"
        onclick={() => (folio.sidebarOpen = false)}
      ></button>
      <div
        class="no-drag absolute inset-y-0 left-0 z-30 animate-[folio-in_200ms_var(--ease-out-quint)] border-r border-line-subtle bg-bg shadow-3"
      >
        <Sidebar />
      </div>
    {/if}

    <!--
      One sidebar button, pinned beside the window controls: open or closed, it stays put. It
      comes last so that no drag region drawn after it (the tab strip's) can swallow its clicks.
    -->
    <div
      class="absolute top-[16.5px] z-40 {folio.platform === 'darwin'
        ? 'left-[80px]'
        : 'left-3'}"
    >
      <IconButton
        label={folio.sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        shortcut="⌘\"
        onclick={toggleSidebar}
      >
        <PanelLeft size={16} strokeWidth={1.75} />
      </IconButton>
    </div>
  </div>
  <SettingsDialog />
  <NewCourseDialog />
  <ConfirmDialog />
  <CommandPalette />
  <NoteSwitcher />
</Tooltip.Provider>
