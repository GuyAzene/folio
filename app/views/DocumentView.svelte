<script lang="ts">
  import { Lock, NotebookPen, PanelRight, ZoomIn, ZoomOut } from "@lucide/svelte";
  import CourseTile from "../components/CourseTile.svelte";
  import FolioMark from "../components/FolioMark.svelte";
  import IconButton from "../components/IconButton.svelte";
  import InlineName from "../components/InlineName.svelte";
  import PaneControls from "../components/PaneControls.svelte";
  import PdfReader from "../components/PdfReader.svelte";
  import { picked } from "../lib/attachments.ts";
  import { draftKey } from "../lib/drafts.ts";
  import { lastUsed } from "../lib/layout.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { ROLE_DOT } from "../lib/labels.ts";
  import { folio, type Location } from "../lib/state.svelte.ts";

  /**
   * A course file in a pane. Explain and Ask… go to the tab's chat, and pages and quotes to its
   * note, opening either beside the document when the tab has none.
   */
  let {
    paneId,
    location,
  }: { paneId: string; location: Extract<Location, { view: "document" }> } = $props();

  let selection = $state<{ text: string; page: number; rect: DOMRect } | null>(null);
  let markdown = $state("");
  let renaming = $state(false);

  const document = $derived(folio.document(location.documentId));
  const course = $derived(folio.course(document?.courseId));
  const zoom = $derived(location.zoom ?? 1);
  /** Folio is already beside this document when the tab has a chat. */
  const chatOpen = $derived(!!lastUsed(folio.layoutOf(paneId) ?? folio.layout, "chat"));

  $effect(() => {
    if (document?.kind === "markdown")
      void folio.api
        .readDocument(document.id)
        .then((data) => (markdown = renderMarkdown(new TextDecoder().decode(data))));
  });

  function setZoom(next: number): void {
    folio.update({ zoom: Math.min(3, Math.max(0.5, next)) }, paneId);
  }

  /** Adds text to the note beside the document, opening one first (see noteBeside). */
  async function toNote(text: string): Promise<void> {
    const noteId = await folio.noteBeside(paneId);
    if (noteId) folio.insertIntoNote(noteId, text);
  }

  function addPage(): void {
    if (document) void toNote(folio.citation(document.id, location.page));
  }

  function askFolio(): void {
    const chatPane = folio.chatBeside(paneId);
    if (chatPane) folio.focusComposer(chatPane);
  }

  function ask(explain: boolean): void {
    if (!selection || !document) return;
    const { page } = selection;
    const passage = { text: selection.text, source: `${document.title}, page ${page}` };
    selection = null;
    window.getSelection()?.removeAllRanges();
    const chatPane = folio.chatBeside(paneId);
    if (!chatPane) return;
    const chat = folio.locationOf(chatPane);
    const chatId = chat.view === "chat" ? chat.chatId : null;
    if (explain)
      void folio.send(`> ${passage.text}\n> (${passage.source})\n\nExplain this passage.`, {
        paneId: chatPane,
        chatId,
        courseId: document.courseId,
        focus: { documentId: document.id, page },
        // Explain is about this page, so the tutor sees it; asking otherwise adds it only with +.
        attachments:
          document.kind === "pdf" ? [picked({ kind: "page", documentId: document.id, page })] : [],
      });
    else {
      folio.setDraft(draftKey(chatId, chatPane), { quote: passage });
      folio.focusComposer(chatPane);
    }
  }

  function quoteToNotes(): void {
    if (!selection || !document) return;
    const quoted = selection.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    void toNote(`${quoted}\n>\n> ${folio.citation(document.id, selection.page)}`);
    selection = null;
    window.getSelection()?.removeAllRanges();
  }
</script>

{#if document}
  <div class="relative flex h-full min-h-0 min-w-0 flex-col">
    <!-- A narrow pane keeps the name readable and lets the badge, lock and zoom go first. -->
    <div
      class="@container flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle pr-2 pl-4"
    >
      {#if course}<CourseTile {course} size={16} />{/if}
      {#if renaming}
        <InlineName
          value={document.title}
          bind:editing={renaming}
          label="Rename {document.title}"
          class="max-w-[360px] font-medium text-text"
          onsave={(title) => folio.updateDocument(document, { title })}
        />
      {:else}
        <button
          class="-mx-1 min-w-0 truncate rounded-md px-1 font-medium text-text hover:bg-hover"
          dir="auto"
          title="Rename"
          onclick={() => (renaming = true)}>{document.title}</button
        >
      {/if}
      <span
        class="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[4px] bg-sunken px-1.5 text-[11px] font-medium text-text-2 @max-[600px]:hidden dark:bg-raised"
      >
        <span class="size-1.5 rounded-[2px]" style="background:{ROLE_DOT[document.role]}"
        ></span>{folio.categoryOf(document).name}
      </span>
      <span
        class="inline-flex size-5 shrink-0 items-center justify-center text-text-4 @max-[600px]:hidden"
        title="Original file, never changed"
      >
        <Lock size={11} strokeWidth={2} aria-label="Original file, never changed" />
      </span>
      <span class="flex-1"></span>
      {#if document.kind === "pdf"}
        <span class="shrink-0 text-[12px] whitespace-nowrap text-text-3 tabular-nums"
          >{location.page} / {document.pages}</span
        >
        <IconButton
          label="Zoom out"
          class="@max-[460px]:hidden"
          onclick={() => setZoom(zoom / 1.15)}
        >
          <ZoomOut size={15} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label="Zoom in"
          class="@max-[460px]:hidden"
          onclick={() => setZoom(zoom * 1.15)}
        >
          <ZoomIn size={15} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Add this page to a note" onclick={addPage}>
          <NotebookPen size={15} strokeWidth={1.75} />
        </IconButton>
      {/if}
      <!-- The tutor beside the document, shown or hidden; the same as ⌘J. -->
      <IconButton
        label={chatOpen ? "Hide Folio" : "Ask Folio"}
        shortcut="⌘J"
        class={chatOpen ? "bg-press text-text" : ""}
        onclick={() => (chatOpen ? folio.toggleFolio() : askFolio())}
      >
        <PanelRight size={15} strokeWidth={1.75} />
      </IconButton>
      <PaneControls />
    </div>
    <div class="relative min-h-0 flex-1">
      {#if document.kind === "pdf"}
        {#key document.id}
          <PdfReader
            {document}
            page={location.page}
            {zoom}
            onpage={(page) => folio.update({ page }, paneId)}
            onselect={(next) => (selection = next)}
          />
        {/key}
      {:else}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="scroll-quiet h-full overflow-y-auto"
          role="document"
          onmouseup={() => {
            const text = window.getSelection()?.toString().replace(/\s+/g, " ").trim();
            const range = text ? window.getSelection()?.getRangeAt(0) : undefined;
            selection =
              text && range
                ? { text: text.slice(0, 1200), page: 1, rect: range.getBoundingClientRect() }
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
              if (selection) void navigator.clipboard.writeText(selection.text);
              selection = null;
            }}
          >
            Copy
          </button>
        </div>
      {/if}
    </div>
  </div>
{:else}
  <div class="flex h-full items-center justify-center text-text-3">
    This document is no longer in your library.
  </div>
{/if}
