<script lang="ts">
  import { FilePen, FilePlus, Undo2 } from "@lucide/svelte";
  import type { NoteEditView } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * A change the tutor made to one of the student's notes, under the reply that made it. Undo is
   * offered while the note is still as the tutor left it; after that, the note's History has it.
   */
  let { edit }: { edit: NoteEditView } = $props();

  const note = $derived(folio.note(edit.noteId));
  const current = $derived(note?.revision === edit.after);
  const verb = $derived(
    edit.action === "created" ? "Created" : edit.action === "renamed" ? "Renamed" : "Edited",
  );
</script>

<div
  class="flex max-w-full min-w-0 items-center gap-2.5 rounded-lg border border-line-subtle bg-sunken py-1.5 pr-1.5 pl-3 text-[13px] dark:bg-raised"
>
  {#if edit.action === "created"}
    <FilePlus size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
  {:else}
    <FilePen size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
  {/if}
  <span class="min-w-0 flex-1 truncate text-text-2">
    {verb}
    <span class="font-medium text-text" dir="auto">{note?.title ?? edit.title}</span>
  </span>
  {#if note}
    <button
      type="button"
      class="h-7 shrink-0 rounded-md px-2 text-[12px] font-medium whitespace-nowrap text-text-2 hover:bg-hover hover:text-text"
      onclick={(event) =>
        folio.openNote(edit.noteId, { newTab: event.metaKey || event.ctrlKey })}>Open</button
    >
    {#if current}
      <button
        type="button"
        class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium whitespace-nowrap text-text-2 hover:bg-hover hover:text-text"
        onclick={() => folio.undoNoteEdit(edit)}
      >
        <Undo2 size={13} strokeWidth={1.75} />
        Undo
      </button>
    {/if}
  {:else}
    <span class="shrink-0 px-2 text-[12px] text-text-3">In the Trash</span>
  {/if}
</div>
