<script lang="ts">
  import { Search, SquarePen, Trash2, X } from "@lucide/svelte";
  import { tick } from "svelte";
  import CourseFilter from "../components/CourseFilter.svelte";
  import IconButton from "../components/IconButton.svelte";
  import { PENCIL } from "../lib/labels.ts";
  import { getPane, setPane } from "../lib/pane.ts";
  import { folio, type Location } from "../lib/state.svelte.ts";
  import { groupChats } from "../lib/time.ts";
  import ChatView from "./ChatView.svelte";

  /**
   * Chats: every chat on the left, newest first under Today, Yesterday and so on, and the open
   * chat on the right; with none chosen, a new one. The list stays while a chat is read. A chat
   * about a lecture opens beside it from its own header. In a narrow window only the chat shows.
   */
  let {
    paneId,
    location,
  }: { paneId: string; location: Extract<Location, { view: "chat" | "chats" }> } = $props();

  const LIST = 280;
  const pane = getPane();
  const listed = $derived((pane?.width ?? 1000) >= 720);
  const courseId = $derived(folio.chatsCourse);
  const filterCourse = $derived(folio.course(courseId));
  const chatId = $derived(location.view === "chat" ? location.chatId : null);
  /** The chat on the right; with none chosen, a new one in the course shown. */
  const shown = $derived<Extract<Location, { view: "chat" }>>(
    location.view === "chat" ? location : { view: "chat", chatId: null, courseId },
  );

  // The chat on the right knows only its own width.
  setPane({
    get id() {
      return pane?.id ?? paneId;
    },
    get tabId() {
      return pane?.tabId ?? "";
    },
    get split() {
      return false;
    },
    get lead() {
      return false;
    },
    get maximized() {
      return false;
    },
    get active() {
      return pane?.active ?? true;
    },
    get width() {
      return (pane?.width ?? 1000) - (listed ? LIST : 0);
    },
    get source() {
      return null;
    },
  });

  let query = $state("");
  let list = $state<HTMLElement>();

  const chats = $derived(
    folio.chats
      .filter(
        (chat) =>
          (!courseId || chat.courseId === courseId) &&
          (!query.trim() || chat.title.toLowerCase().includes(query.trim().toLowerCase())),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
  const groups = $derived(groupChats(chats));

  function open(id: string, event?: MouseEvent): void {
    if (event?.metaKey || event?.ctrlKey) folio.openChat(id, { newTab: true });
    // ⌥-click opens it as it was: beside the lecture it was about.
    else if (event?.altKey) folio.openChat(id);
    else if (id !== chatId) {
      const summary = folio.chats.find((chat) => chat.id === id);
      folio.navigate({ view: "chat", chatId: id, courseId: summary?.courseId ?? null }, { paneId });
    }
  }

  function newChat(): void {
    if (location.view !== "chats") folio.navigate({ view: "chats" }, { paneId });
  }

  /** ↑ and ↓ move through the list, as in a mail app. */
  async function walk(event: KeyboardEvent): Promise<void> {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if ((event.target as HTMLElement).closest("input")) return;
    event.preventDefault();
    const index = chats.findIndex((chat) => chat.id === chatId);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = chats[Math.max(0, Math.min(chats.length - 1, index + step))];
    if (!next) return;
    open(next.id);
    await tick();
    list?.querySelector<HTMLElement>(`[data-chat="${next.id}"]`)?.focus();
  }
</script>

<div class="flex h-full min-h-0">
  {#if listed}
    <aside
      class="flex shrink-0 flex-col border-r border-line-subtle"
      style:width="{LIST}px"
      aria-label="Chats"
    >
      <div class="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4">
        <h1 class="min-w-0 flex-1 truncate font-semibold text-text" dir="auto">
          {filterCourse ? filterCourse.name : "Chats"}
        </h1>
        <CourseFilter value={courseId} onchange={(id) => (folio.chatsCourse = id)} />
        <IconButton label="New chat" shortcut="⌘N" onclick={newChat}>
          <SquarePen size={15} strokeWidth={1.75} />
        </IconButton>
      </div>

      <div class="shrink-0 px-3 pb-3">
        <label
          class="flex h-8 items-center gap-2 rounded-md bg-sunken px-2 text-text-3 transition-colors focus-within:bg-hover dark:bg-raised"
        >
          <Search size={14} strokeWidth={1.75} class="shrink-0" />
          <input
            bind:value={query}
            class="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-3"
            placeholder="Search chats"
            aria-label="Search chats"
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

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        bind:this={list}
        class="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        onkeydown={walk}
      >
        {#each groups as group (group.label)}
          <div
            class="flex h-7 items-center px-2 pt-2 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase first:pt-0"
          >
            {group.label}
          </div>
          {#each group.chats as chat (chat.id)}
            {@const course = folio.course(chat.courseId)}
            {@const selected = chat.id === chatId}
            <div
              class="group relative flex h-8 items-center rounded-md transition-colors {selected
                ? 'bg-press text-text'
                : 'text-text-2 hover:bg-hover hover:text-text'}"
            >
              <button
                class="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md pr-8 pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
                data-chat={chat.id}
                tabindex={selected || (!chatId && chat === chats[0]) ? 0 : -1}
                title={course ? `${chat.title} · ${course.name}` : chat.title}
                onclick={(event) => open(chat.id, event)}
              >
                {#if !courseId}
                  <span
                    class="size-1.5 shrink-0 rounded-full"
                    style:background={course ? PENCIL[course.color] : "var(--text-4)"}
                  ></span>
                {/if}
                <span class="min-w-0 flex-1 truncate" dir="auto">{chat.title}</span>
                {#if chat.status === "running"}
                  <span class="size-1.5 shrink-0 rounded-full bg-highlight ring-2 ring-highlight/30"
                  ></span>
                {/if}
              </button>
              <button
                type="button"
                class="absolute right-1 flex size-6 items-center justify-center rounded-md text-text-4 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-press hover:text-danger focus-visible:opacity-100"
                title="Move to Trash"
                aria-label="Move {chat.title} to Trash"
                onclick={() => folio.trashChat(chat.id)}
              >
                <Trash2 size={13} strokeWidth={1.75} />
              </button>
            </div>
          {/each}
        {:else}
          <p class="px-2 py-6 text-center text-[13px] leading-5 text-text-3">
            {query.trim()
              ? `No chats match “${query.trim()}”.`
              : filterCourse
                ? "No chats in this course yet."
                : "No chats yet. Ask on the right to start one."}
          </p>
        {/each}
      </div>
    </aside>
  {/if}

  <section class="relative flex min-w-0 flex-1 flex-col">
    <ChatView {paneId} location={shown} />
  </section>
</div>
