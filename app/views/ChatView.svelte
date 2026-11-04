<script lang="ts">
  import { ChevronDown, FileText, MessageSquare, PanelLeft, SquarePen } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import ChatPane from "../components/ChatPane.svelte";
  import CourseTile from "../components/CourseTile.svelte";
  import FolioMark from "../components/FolioMark.svelte";
  import IconButton from "../components/IconButton.svelte";
  import PaneControls from "../components/PaneControls.svelte";
  import { getPane } from "../lib/pane.ts";
  import { shortTitle } from "../lib/titles.ts";
  import { folio, type Location } from "../lib/state.svelte.ts";

  /**
   * A chat in a pane. Beside a document it follows the page the student is on: each question
   * carries it, and the chat remembers it, so the chat reopens beside the document.
   */
  let {
    paneId,
    location,
  }: { paneId: string; location: Extract<Location, { view: "chat" }> } = $props();
  let pane = $state<ChatPane>();
  const place = getPane();

  const chat = $derived(folio.chatFor(location.chatId, paneId));
  /** The document pane beside this chat that it follows. */
  const source = $derived(place?.source ?? null);
  const sourceDocument = $derived(source ? folio.document(source.location.documentId) : undefined);
  /** A chat not started yet beside a document reads that document's course. */
  const courseId = $derived(
    location.chatId ? location.courseId : (sourceDocument?.courseId ?? location.courseId),
  );
  const course = $derived(folio.course(courseId));
  /** The course the chat reads, null for a library chat (which reads every course). */
  const chatCourse = $derived(chat ? (chat.kind === "course" ? chat.courseId : null) : courseId);
  /** The page in view, when this chat can read it. */
  const focus = $derived(
    source && sourceDocument && chatCourse === sourceDocument.courseId
      ? { documentId: sourceDocument.id, page: source.location.page }
      : null,
  );
  /** A course chat beside another course's document can't read it. */
  const elsewhere = $derived(
    !!sourceDocument && !!chatCourse && chatCourse !== sourceDocument.courseId,
  );
  const split = $derived(place?.split ?? false);
  const compact = $derived((place?.width ?? 1000) < 560);
  /** Chats started without a course read the library; older plain chats read nothing. */
  const plain = $derived(chat?.kind === "chat");
  /** What the student added to the chat with +; Folio may read these too. */
  const addedCourses = $derived((chat?.reads.courses ?? []).flatMap((id) => folio.course(id) ?? []));
  const addedDocuments = $derived(
    (chat?.reads.documents ?? []).flatMap((id) => folio.document(id) ?? []),
  );
  /** The document a chat open on its own was last beside, to bring back beside it. */
  const remembered = $derived(
    !source && location.chatId
      ? folio.document(folio.chats.find((summary) => summary.id === location.chatId)?.focus?.documentId)
      : undefined,
  );
  /** Earlier chats to go on with: about the document beside, else in this course. */
  const earlier = $derived(
    folio.chats
      .filter(
        (summary) =>
          summary.id !== location.chatId &&
          (sourceDocument
            ? summary.focus?.documentId === sourceDocument.id
            : !!courseId && summary.courseId === courseId),
      )
      .slice(0, 5),
  );
  const title = (document: { title: string; courseId: string }) =>
    shortTitle(document.title, folio.course(document.courseId)?.name);
  const pill =
    "inline-flex h-[22px] max-w-[220px] min-w-0 items-center gap-1.5 rounded-md bg-sunken px-1.5 text-text-2 hover:text-text dark:bg-raised";

  // The chat remembers the page beside it, so it reopens there.
  $effect(() => {
    const chatId = location.chatId;
    const at = focus;
    if (!chatId || !at || chat?.kind !== "course") return;
    const timer = setTimeout(() => folio.setFocus(chatId, at), 600);
    return () => clearTimeout(timer);
  });

  function newChat(): void {
    folio.navigate({ view: "chat", chatId: null, courseId: sourceDocument?.courseId ?? courseId }, {
      paneId,
    });
  }

  function open(chatId: string): void {
    const summary = folio.chats.find((candidate) => candidate.id === chatId);
    folio.navigate({ view: "chat", chatId, courseId: summary?.courseId ?? null }, { paneId });
  }

  export function focusInput(): void {
    pane?.focusInput();
  }
</script>

{#snippet earlierChats(menu: boolean)}
  {@const label = sourceDocument
    ? `Chats about ${title(sourceDocument)}`
    : "Earlier chats in this course"}
  {#if menu}
    {#if earlier.length}
      <div class="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase">
        {label}
      </div>
      {#each earlier as summary (summary.id)}
        <DropdownMenu.Item
          class="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover"
          onSelect={() => open(summary.id)}
        >
          <MessageSquare size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
          <span class="min-w-0 flex-1 truncate" dir="auto">{summary.title}</span>
        </DropdownMenu.Item>
      {/each}
      <div class="my-1.5 h-px bg-line-subtle"></div>
    {/if}
    <DropdownMenu.Item
      class="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover"
      onSelect={newChat}
    >
      <SquarePen size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
      <span class="min-w-0 flex-1 truncate">New chat</span>
    </DropdownMenu.Item>
  {:else if earlier.length && sourceDocument}
    <div class="mt-6 w-full">
      <div class="px-2 pb-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase">
        Continue a chat about {title(sourceDocument)}
      </div>
      {#each earlier as summary (summary.id)}
        <button
          class="flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] text-text transition-colors hover:bg-hover"
          onclick={() => open(summary.id)}
        >
          <MessageSquare size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
          <span class="min-w-0 flex-1 truncate" dir="auto">{summary.title}</span>
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col">
  {#if split}
    <div class="flex h-11 shrink-0 items-center gap-1.5 border-b border-line-subtle pr-2 pl-2.5">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 font-medium text-text transition-colors hover:bg-hover data-[state=open]:bg-hover"
          title="Earlier chats"
        >
          <FolioMark size={15} />
          <span class="min-w-0 truncate" dir="auto"
            >{location.chatId ? (chat?.title ?? "") : "New chat"}</span
          >
          <ChevronDown size={13} strokeWidth={2} class="shrink-0 text-text-3" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            class="z-50 max-h-[420px] w-[300px] animate-[folio-scale_140ms_var(--ease-out-quint)] overflow-y-auto rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
          >
            {@render earlierChats(true)}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <span class="flex-1"></span>
      {#if focus && source && sourceDocument}
        <!-- The document is right beside the chat: the page is what the chat starts from. -->
        <button
          class="{pill} shrink-0 text-[12px]"
          title="Folio starts from page {source.location.page} of {title(sourceDocument)}"
          onclick={() => {
            // Maximized, the chat gives the page its room back.
            if (place?.maximized) folio.toggleMaximized(paneId);
            folio.activatePane(source.id);
          }}
        >
          <FileText size={11} strokeWidth={1.75} class="shrink-0" />
          <span class="shrink-0 tabular-nums">p. {source.location.page}</span>
        </button>
      {:else if elsewhere && sourceDocument}
        <span
          class="min-w-0 truncate text-[12px] text-text-3"
          title="This chat reads {folio.course(chatCourse)?.name ?? 'another course'} only"
          >Can't read <bdi>{title(sourceDocument)}</bdi></span
        >
      {/if}
      <IconButton label="New chat" onclick={newChat}>
        <SquarePen size={14} strokeWidth={1.75} />
      </IconButton>
      <PaneControls />
    </div>
  {:else}
    <!-- A chat on its own: its name, what it may read, and the lecture it was about. -->
    <div class="@container flex h-12 shrink-0 items-center gap-2 pr-3 pl-5 text-[12px] text-text-3">
      <span class="min-w-[96px] flex-1 truncate text-[13px] font-medium text-text" dir="auto"
        >{location.chatId ? (chat?.title ?? "") : "New chat"}</span
      >
      {#if course}
        <span class="shrink-0 @max-[640px]:hidden" title="Folio reads these and nothing else"
          >Reads</span
        >
        {#each [course, ...addedCourses] as read (read.id)}
          <button
            class="{pill} shrink-0"
            title="Folio reads {read.name} and nothing else"
            onclick={() => folio.navigate({ view: "course", courseId: read.id, tab: "materials" })}
          >
            <CourseTile course={read} size={12} /><span
              class="max-w-[140px] min-w-0 truncate"
              dir="auto">{read.name}</span
            >
          </button>
        {/each}
        {#each addedDocuments as document (document.id)}
          <button
            class="{pill} shrink-0"
            onclick={() => folio.openDocument(document.id, 1, { chatId: location.chatId })}
          >
            <FileText size={11} strokeWidth={1.75} class="shrink-0" /><span
              class="max-w-[140px] min-w-0 truncate"
              dir="auto">{title(document)}</span
            >
          </button>
        {/each}
      {/if}
      {#if remembered}
        {@const page = folio.chats.find((summary) => summary.id === location.chatId)?.focus?.page}
        <button
          class="ml-1 flex h-7 max-w-[240px] min-w-[112px] shrink items-center gap-1.5 rounded-md border border-line px-2 text-[12px] font-medium text-text-2 transition-colors hover:bg-hover hover:text-text"
          title="Open the chat beside {remembered.title}, at the page it was on"
          onclick={() => folio.openDocument(remembered.id, page ?? 1, { chatId: location.chatId })}
        >
          <PanelLeft size={13} strokeWidth={1.75} class="shrink-0" /><span
            class="min-w-0 truncate"
            dir="auto">Open beside {title(remembered)}</span
          >
        </button>
      {/if}
    </div>
  {/if}
  {#if plain}
    <div class="flex h-9 shrink-0 items-center justify-center text-[12px] text-text-3">
      An earlier chat without course material
    </div>
  {/if}
  {#key location.chatId ?? `new:${paneId}`}
    <ChatPane
      bind:this={pane}
      {paneId}
      chatId={location.chatId}
      {courseId}
      {focus}
      {compact}
      onnewchat={newChat}
      emptyTitle={sourceDocument
        ? compact
          ? `Ask about ${sourceDocument.title}. Folio reads this course and starts from your page.`
          : `Let's go through ${sourceDocument.title}.`
        : course
          ? `What should we go over in ${course.name}?`
          : "What are we studying?"}
      emptyNote={sourceDocument && !compact
        ? "Folio reads only this course's documents."
        : course || !folio.courses.length || sourceDocument
          ? ""
          : "Folio works out which course you mean from your question."}
    >
      {#snippet empty()}{@render earlierChats(false)}{/snippet}
    </ChatPane>
  {/key}
</div>
