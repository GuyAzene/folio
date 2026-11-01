<script lang="ts">
  import { NotebookPen, Plus } from "@lucide/svelte";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * Notes to open beside a document: those that cite it first, then the course's others, newest
   * first, and a new note named after it. As a menu's rows or as a list in an empty pane.
   */
  let {
    documentId = null,
    courseId,
    menu = false,
    onpick,
    onnew,
  }: {
    documentId?: string | null;
    courseId: string | null;
    menu?: boolean;
    onpick: (noteId: string) => void;
    onnew: () => void;
  } = $props();

  const newest = <T extends { updatedAt?: string | null }>(a: T, b: T) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  const citing = $derived(
    documentId ? folio.notes.filter((note) => note.cites.includes(documentId)).sort(newest) : [],
  );
  const others = $derived(
    folio.notes
      .filter((note) => note.courseId === courseId && !citing.includes(note))
      .sort(newest)
      .slice(0, 8),
  );
  const row = $derived(
    menu
      ? "flex h-8 w-full cursor-default items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-text outline-none select-none hover:bg-hover"
      : "flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] text-text transition-colors hover:bg-hover",
  );
  const label = "px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase";
</script>

{#if citing.length}
  <div class={label}>Cite this document</div>
  {#each citing as note (note.id)}
    <button class={row} onclick={() => onpick(note.id)}>
      <NotebookPen size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
      <span class="min-w-0 flex-1 truncate" dir="auto">{note.title}</span>
    </button>
  {/each}
{/if}
{#if others.length}
  <div class={label}>{citing.length ? "Other notes in this course" : "Notes in this course"}</div>
  {#each others as note (note.id)}
    <button class={row} onclick={() => onpick(note.id)}>
      <NotebookPen size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
      <span class="min-w-0 flex-1 truncate" dir="auto">{note.title}</span>
    </button>
  {/each}
{/if}
{#if citing.length || others.length}<div class="my-1.5 h-px bg-line-subtle"></div>{/if}
<button class={row} onclick={onnew}>
  <Plus size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
  <span class="min-w-0 flex-1 truncate"
    >{documentId ? "New note on this document" : "New note"}</span
  >
</button>
