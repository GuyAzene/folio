<script lang="ts">
  import {
    ChevronDown,
    Lock,
    Maximize2,
    MessageSquare,
    Minimize2,
    NotebookPen,
    PanelRight,
    Plus,
    SquarePen,
    X,
    ZoomIn,
    ZoomOut,
  } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import { tick } from "svelte";
  import ChatPane from "../components/ChatPane.svelte";
  import CourseTile from "../components/CourseTile.svelte";
  import FolioMark from "../components/FolioMark.svelte";
  import IconButton from "../components/IconButton.svelte";
  import PdfReader from "../components/PdfReader.svelte";
  import { picked } from "../lib/attachments.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { ROLE_DOT, ROLE_LABEL } from "../lib/labels.ts";
  import { folio, type Location } from "../lib/state.svelte.ts";
  import NoteView from "./NoteView.svelte";

  let {
    tabId,
    location,
  }: { tabId: string; location: Extract<Location, { view: "document" }> } =
    $props();

  let zoom = $state(1);
  let width = $state(400);
  let selection = $state<{ text: string; page: number; rect: DOMRect } | null>(
    null,
  );
  let quote = $state<{ text: string; source: string } | null>(null);
  let pane = $state<ChatPane>();
  let sideNote = $state<NoteView>();
  let reader = $state<PdfReader>();
  let markdown = $state("");
  let focusTimer: ReturnType<typeof setTimeout> | undefined;

  const document = $derived(folio.document(location.documentId));
  const course = $derived(folio.course(document?.courseId));
  /** Folio's chat or a note beside the document. */
  const side = $derived(location.side ?? "chat");
  const shownNote = $derived(folio.note(location.noteId));
  /** The course's notes that cite this document, then its other notes, newest first. */
  const citing = $derived(
    folio.notes
      .filter((note) => document && note.cites.includes(document.id))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
  );
  const others = $derived(
    folio.notes
      .filter(
        (note) =>
          note.courseId === document?.courseId && !citing.includes(note),
      )
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, 8),
  );

  function showSide(next: "chat" | "note"): void {
    folio.update(
      {
        side: next,
        // Notes open on the note that cites this document, when there is one.
        noteId:
          next === "note" && !shownNote
            ? (folio.noteCiting(location.documentId)?.id ?? null)
            : location.noteId,
        panel: location.panel === "closed" ? "docked" : location.panel,
      },
      tabId,
    );
  }

  async function newNoteBeside(): Promise<void> {
    const noteId = await folio.createNoteBeside(location.documentId);
    if (noteId) folio.update({ side: "note", noteId }, tabId);
  }

  /**
   * Adds text to the note beside the document, opening one first: the note already open,
   * or the one that cites this document, or a new note named after it.
   */
  async function toNote(text: string): Promise<void> {
    if (!document) return;
    let noteId =
      side === "note" && shownNote
        ? shownNote.id
        : (folio.noteCiting(document.id)?.id ?? null);
    noteId ??= await folio.createNoteBeside(document.id);
    if (!noteId) return;
    folio.update(
      {
        side: "note",
        noteId,
        panel: location.panel === "closed" ? "docked" : location.panel,
      },
      tabId,
    );
    await tick();
    await sideNote?.insert(text);
  }

  function addPage(): void {
    if (document) void toNote(folio.citation(document.id, location.page));
  }
  const focus = $derived(
    document ? { documentId: document.id, page: location.page } : null,
  );

  $effect(() => {
    if (document?.kind === "markdown")
      void folio.api
        .readDocument(document.id)
        .then(
          (data) => (markdown = renderMarkdown(new TextDecoder().decode(data))),
        );
  });

  function onpage(page: number): void {
    folio.update({ page }, tabId);
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (document)
        folio.setFocus(location.chatId, { documentId: document.id, page });
    }, 600);
  }

  function setPanel(panel: "docked" | "full" | "closed"): void {
    folio.update({ panel }, tabId);
  }

  function ask(explain: boolean): void {
    if (!selection || !document) return;
    const { page } = selection;
    const passage = {
      text: selection.text,
      source: `${document.title}, page ${page}`,
    };
    selection = null;
    window.getSelection()?.removeAllRanges();
    if (location.panel === "closed") setPanel("docked");
    if (explain) {
      void folio.send(
        `> ${passage.text}\n> (${passage.source})\n\nExplain this passage.`,
        {
          tabId,
          chatId: location.chatId,
          courseId: document.courseId,
          focus,
          // Explain is about this page, so the tutor sees it; asking otherwise adds it only with +.
          attachments:
            document.kind === "pdf"
              ? [picked({ kind: "page", documentId: document.id, page })]
              : [],
        },
      );
    } else {
      quote = passage;
      queueMicrotask(() => pane?.focusInput());
    }
  }

  function quoteToNotes(): void {
    if (!selection || !document) return;
    const quoted = selection.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    void toNote(
      `${quoted}\n>\n> ${folio.citation(document.id, selection.page)}`,
    );
    selection = null;
    window.getSelection()?.removeAllRanges();
  }

  function startResize(event: PointerEvent): void {
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: PointerEvent) =>
      (width = Math.min(
        560,
        Math.max(320, startWidth + startX - moveEvent.clientX),
      ));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

{#snippet notePicker(menu: boolean)}
  {@const row = menu
    ? "flex h-8 w-full cursor-default items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-text outline-none select-none hover:bg-hover"
    : "flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] text-text transition-colors hover:bg-hover"}
  {@const label =
    "px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase"}
  {#if citing.length}
    <div class={label}>Cite this document</div>
    {#each citing as note (note.id)}
      <button
        class={row}
        onclick={() => folio.update({ side: "note", noteId: note.id }, tabId)}
      >
        <NotebookPen size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
        <span class="min-w-0 flex-1 truncate" dir="auto">{note.title}</span>
      </button>
    {/each}
  {/if}
  {#if others.length}
    <div class={label}>Other notes in this course</div>
    {#each others as note (note.id)}
      <button
        class={row}
        onclick={() => folio.update({ side: "note", noteId: note.id }, tabId)}
      >
        <NotebookPen size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
        <span class="min-w-0 flex-1 truncate" dir="auto">{note.title}</span>
      </button>
    {/each}
  {/if}
  <div class="my-1.5 h-px bg-line-subtle"></div>
  <button class={row} onclick={newNoteBeside}>
    <Plus size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
    <span class="min-w-0 flex-1 truncate">New note on this document</span>
  </button>
{/snippet}

{#if document}
  <div class="flex h-full min-h-0">
    {#if location.panel !== "full"}
      <div class="relative flex min-w-0 flex-1 flex-col">
        <div
          class="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle px-4"
        >
          {#if course}<CourseTile {course} size={16} />{/if}
          <span class="min-w-0 truncate font-medium text-text"
            >{document.title}</span
          >
          <span
            class="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[4px] bg-sunken px-1.5 text-[11px] font-medium text-text-2 dark:bg-raised"
          >
            <span
              class="size-1.5 rounded-[2px]"
              style="background:{ROLE_DOT[document.role]}"
            ></span>{ROLE_LABEL[document.role]}
          </span>
          <span
            class="inline-flex size-5 shrink-0 items-center justify-center text-text-4"
            title="Original file, never changed"
          >
            <Lock size={11} strokeWidth={2} aria-label="Original file, never changed" />
          </span>
          <span class="flex-1"></span>
          {#if document.kind === "pdf"}
            <span
              class="shrink-0 text-[12px] whitespace-nowrap text-text-3 tabular-nums"
              >{location.page} / {document.pages}</span
            >
            <IconButton
              label="Zoom out"
              onclick={() => (zoom = Math.max(0.5, zoom / 1.15))}
            >
              <ZoomOut size={15} strokeWidth={1.75} />
            </IconButton>
            <IconButton
              label="Zoom in"
              onclick={() => (zoom = Math.min(3, zoom * 1.15))}
            >
              <ZoomIn size={15} strokeWidth={1.75} />
            </IconButton>
          {/if}
          {#if document.kind === "pdf"}
            <IconButton
              label="Add this page to a note"
              onclick={addPage}
            >
              <NotebookPen size={15} strokeWidth={1.75} />
            </IconButton>
          {/if}
          {#if location.panel === "closed"}
            <IconButton
              label="Ask Folio"
              shortcut="⌘J"
              onclick={() => setPanel("docked")}
            >
              <PanelRight size={15} strokeWidth={1.75} />
            </IconButton>
          {/if}
        </div>
        <div class="relative min-h-0 flex-1">
          {#if document.kind === "pdf"}
            {#key document.id}
              <PdfReader
                bind:this={reader}
                {document}
                page={location.page}
                {zoom}
                {onpage}
                onselect={(next) => (selection = next)}
              />
            {/key}
          {:else}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
              class="scroll-quiet h-full overflow-y-auto"
              role="document"
              onmouseup={() => {
                const text = window
                  .getSelection()
                  ?.toString()
                  .replace(/\s+/g, " ")
                  .trim();
                const range = text
                  ? window.getSelection()?.getRangeAt(0)
                  : undefined;
                selection =
                  text && range
                    ? {
                        text: text.slice(0, 1200),
                        page: 1,
                        rect: range.getBoundingClientRect(),
                      }
                    : null;
              }}
            >
              <article
                class="prose-folio prose-reading mx-auto max-w-[720px] px-8 py-10 font-serif text-[17px] leading-7 select-text"
              >
                <!-- Sanitized by DOMPurify in renderMarkdown. -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html markdown}
              </article>
            </div>
          {/if}
          {#if selection}
            <div
              class="fixed z-30 flex animate-[folio-fade_120ms_ease-out] items-center gap-0.5 rounded-lg bg-ink p-1 shadow-2"
              style="left:{Math.max(
                12,
                selection.rect.left + selection.rect.width / 2 - 150,
              )}px;top:{Math.max(56, selection.rect.top - 46)}px"
            >
              <button
                class="flex h-7 items-center gap-1.5 rounded-md bg-white/10 px-2 text-[12px] font-medium text-on-ink"
                onclick={() => ask(true)}
              >
                <FolioMark size={14} /> Explain
              </button>
              <button
                class="flex h-7 items-center rounded-md px-2 text-[12px] font-medium text-on-ink/85 hover:bg-white/10"
                onclick={() => ask(false)}
              >
                Ask…
              </button>
              <button
                class="flex h-7 items-center rounded-md px-2 text-[12px] font-medium text-on-ink/85 hover:bg-white/10"
                onclick={quoteToNotes}
              >
                Quote to notes
              </button>
              <button
                class="flex h-7 items-center rounded-md px-2 text-[12px] font-medium text-on-ink/85 hover:bg-white/10"
                onclick={() => {
                  if (selection)
                    void navigator.clipboard.writeText(selection.text);
                  selection = null;
                }}
              >
                Copy
              </button>
            </div>
          {/if}
        </div>
      </div>
      {#if location.panel === "docked"}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="w-1 shrink-0 cursor-col-resize border-l border-line-subtle transition-colors hover:bg-line"
          onpointerdown={startResize}
        ></div>
      {/if}
    {/if}

    {#if location.panel !== "closed"}
      <div
        class="flex min-w-0 flex-col {location.panel === 'full'
          ? 'flex-1'
          : 'shrink-0'}"
        style={location.panel === "docked" ? `width:min(${width}px, 50%)` : ""}
      >
        <div
          class="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle pr-2 pl-4"
        >
          <div
            class="flex shrink-0 rounded-lg border border-line-subtle bg-bg p-0.5"
            role="tablist"
            aria-label="Beside the document"
          >
            {#each [{ value: "chat", label: "Folio" }, { value: "note", label: "Note" }] as option (option.value)}
              <button
                role="tab"
                aria-selected={side === option.value}
                class="flex h-[24px] items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors {side ===
                option.value
                  ? 'bg-surface text-text shadow-[0_1px_2px_#18181b14,0_0_0_1px_#18181b0a] dark:bg-selected'
                  : 'text-text-2 hover:text-text'}"
                onclick={() => showSide(option.value as "chat" | "note")}
              >
                {#if option.value === "chat"}<FolioMark size={14} />{:else}<NotebookPen
                    size={13}
                    strokeWidth={1.75}
                  />{/if}
                {option.label}
              </button>
            {/each}
          </div>
          {#if side === "chat"}
            <span class="min-w-0 flex-1 truncate font-medium text-text">
              {location.chatId
                ? (folio.chats.find((chat) => chat.id === location.chatId)
                    ?.title ?? "")
                : ""}
            </span>
            <IconButton
              label="New chat about this document"
              onclick={() => folio.update({ chatId: null }, tabId)}
            >
              <SquarePen size={14} strokeWidth={1.75} />
            </IconButton>
          {:else}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left font-medium text-text transition-colors hover:bg-hover data-[state=open]:bg-hover"
              >
                <span class="min-w-0 truncate" dir="auto"
                  >{shownNote?.title ?? "Choose a note"}</span
                >
                <ChevronDown size={13} strokeWidth={2} class="shrink-0 text-text-3" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={6}
                  class="z-50 max-h-[420px] w-[280px] animate-[folio-scale_140ms_var(--ease-out-quint)] overflow-y-auto rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
                >
                  {@render notePicker(true)}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          {/if}
          {#if location.panel === "docked"}
            <IconButton label="Full screen" onclick={() => setPanel("full")}>
              <Maximize2 size={14} strokeWidth={1.75} />
            </IconButton>
          {:else}
            <IconButton
              label="Back to the reader"
              onclick={() => setPanel("docked")}
            >
              <Minimize2 size={14} strokeWidth={1.75} />
            </IconButton>
          {/if}
          <IconButton
            label="Close Folio"
            shortcut="⌘J"
            onclick={() => setPanel("closed")}
          >
            <X size={14} strokeWidth={1.75} />
          </IconButton>
        </div>
        <!-- Docked, the document's own header beside the panel already says this. -->
        {#if location.panel === "full"}
          <div
            class="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-4 text-[12px] text-text-3"
          >
            <span class="shrink-0">Reading</span>
            {#if course}
              <span
                class="inline-flex h-[22px] max-w-[200px] min-w-0 shrink items-center gap-1.5 rounded-md bg-sunken px-1.5 whitespace-nowrap text-text-2 dark:bg-raised"
                ><CourseTile {course} size={12} /><span class="truncate" dir="auto"
                  >{course.name}</span
                ></span
              >
            {/if}
            <button
              class="inline-flex h-[22px] min-w-0 items-center gap-1 rounded-md bg-sunken px-1.5 whitespace-nowrap text-text-2 hover:text-text dark:bg-raised"
              onclick={() => setPanel("docked")}
            >
              <MessageSquare size={11} strokeWidth={1.75} class="shrink-0" />
              <span class="truncate" dir="auto"
                >{document.title}, page {location.page}</span
              >
            </button>
          </div>
        {/if}
        <div class="flex min-h-0 flex-1 flex-col">
          {#if side === "note"}
            {#if shownNote}
              {#key shownNote.id}
                <NoteView bind:this={sideNote} noteId={shownNote.id} compact />
              {/key}
            {:else}
              <div class="scroll-quiet min-h-0 flex-1 overflow-y-auto px-3 py-4">
                <p class="px-2 pb-3 text-[13px] leading-5 text-text-2">
                  Take notes beside {document.title}. A page you add from the
                  reader becomes a link back to it.
                </p>
                {@render notePicker(false)}
              </div>
            {/if}
          {:else}
          {#key location.chatId ?? `new:${tabId}`}
            <ChatPane
              bind:this={pane}
              bind:quote
              {tabId}
              chatId={location.chatId}
              courseId={document.courseId}
              {focus}
              compact={location.panel === "docked"}
              onnewchat={() => folio.update({ chatId: null }, tabId)}
              emptyTitle={location.panel === "docked"
                ? `Ask about ${document.title}. Folio reads this course and starts from your page.`
                : `Let's go through ${document.title}.`}
              emptyNote={location.panel === "full"
                ? "Folio reads only this course's documents."
                : ""}
            />
          {/key}
          {/if}
        </div>
      </div>
    {/if}
  </div>
{:else}
  <div class="flex h-full items-center justify-center text-text-3">
    This document is no longer in your library.
  </div>
{/if}
