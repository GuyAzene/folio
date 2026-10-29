<script lang="ts">
  import { ChevronRight } from "@lucide/svelte";
  import type { NoteMentionsView } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * The bottom of a note, as in Obsidian: the course's other notes that link here, and those that
   * name this note without linking, each with the line that does. "Link" turns a plain mention
   * into a link, checked against the other note's revision like any save.
   */
  let { noteId, courseId }: { noteId: string; courseId: string } = $props();

  let mentions = $state<NoteMentionsView[]>([]);
  let unlinkedOpen = $state(false);
  let linking = $state<string | null>(null);

  const linked = $derived(mentions.filter((entry) => entry.linked.length));
  const unlinked = $derived(mentions.filter((entry) => entry.unlinked.length));

  // Any note of the course changing can change who mentions this one.
  const revisions = $derived(
    folio.notes
      .filter((note) => note.courseId === courseId)
      .map((note) => `${note.id}:${note.revision}`)
      .join(),
  );
  let loaded = false;
  $effect(() => {
    void revisions;
    const id = noteId;
    // The first load is at once; later ones wait for typing elsewhere to pause.
    const timer = setTimeout(
      async () => {
        const found = await folio.api.noteMentions(id).catch(() => null);
        if (found && id === noteId) mentions = found;
        loaded = true;
      },
      loaded ? 250 : 0,
    );
    return () => clearTimeout(timer);
  });

  async function link(entry: NoteMentionsView): Promise<void> {
    linking = entry.noteId;
    try {
      await folio.api.linkMention(entry.noteId, noteId, entry.revision);
      await folio.refreshLibrary();
      folio.notice = `Linked the mention in “${entry.title}”`;
    } catch (error) {
      folio.error = error instanceof Error ? error.message : "The mention could not be linked.";
    } finally {
      linking = null;
    }
  }

  const heading =
    "flex h-8 items-center gap-1.5 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase";
</script>

{#snippet entryRow(entry: NoteMentionsView, lines: { line: number; text: string }[], action: boolean)}
  <div class="rounded-lg border border-line-subtle bg-surface px-3 py-2 dark:bg-raised">
    <div class="flex min-w-0 items-center gap-2">
      <button
        class="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-text hover:underline"
        dir="auto"
        onclick={(event) =>
          folio.openNote(entry.noteId, { newTab: event.metaKey || event.ctrlKey })}
        >{entry.title}</button
      >
      {#if action}
        <button
          class="h-6 shrink-0 rounded-md border border-line px-2 text-[12px] font-medium text-text-2 transition-colors hover:bg-hover hover:text-text disabled:opacity-50"
          disabled={linking === entry.noteId}
          onclick={() => link(entry)}>Link</button
        >
      {/if}
    </div>
    {#each lines.slice(0, 3) as mention (mention.line)}
      <p class="mt-1 text-[12.5px] leading-[18px] break-words text-text-2" dir="auto">
        {mention.text}
      </p>
    {/each}
  </div>
{/snippet}

{#if linked.length || unlinked.length}
  <section
    class="mx-auto w-full max-w-[784px] px-8 pt-4 pb-[30vh] max-sm:px-4"
    aria-label="Mentions of this note"
  >
    <div class="border-t border-line-subtle pt-4">
      {#if linked.length}
        <div class={heading}>
          Linked mentions <span class="font-normal tracking-normal tabular-nums">{linked.length}</span>
        </div>
        <div class="flex flex-col gap-2">
          {#each linked as entry (entry.noteId)}
            {@render entryRow(entry, entry.linked, false)}
          {/each}
        </div>
      {/if}
      {#if unlinked.length}
        <button
          class="{heading} mt-3 w-full hover:text-text-2"
          aria-expanded={unlinkedOpen}
          onclick={() => (unlinkedOpen = !unlinkedOpen)}
        >
          <ChevronRight
            size={12}
            strokeWidth={2}
            class="transition-transform {unlinkedOpen ? 'rotate-90' : ''}"
          />
          Unlinked mentions
          <span class="font-normal tracking-normal tabular-nums">{unlinked.length}</span>
        </button>
        {#if unlinkedOpen}
          <div class="flex flex-col gap-2">
            {#each unlinked as entry (entry.noteId)}
              {@render entryRow(entry, entry.unlinked, true)}
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </section>
{:else}
  <div class="pb-[30vh]"></div>
{/if}
