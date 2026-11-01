<script lang="ts">
  import { Check, Undo2 } from "@lucide/svelte";
  import type { ActionView } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * A change the tutor made to Folio, under the reply that made it. Undo puts it back while what
   * it changed is still as the tutor left it; Folio refuses otherwise.
   */
  let { action }: { action: ActionView } = $props();

  let undone = $state(false);
  let working = $state(false);
  const document = $derived(action.documentId ? folio.document(action.documentId) : undefined);
  const course = $derived(action.courseId ? folio.course(action.courseId) : undefined);

  async function undo(): Promise<void> {
    if (!action.undo || working) return;
    working = true;
    undone = await folio.undoChange(action.undo);
    working = false;
  }
</script>

<div
  class="flex max-w-full min-w-0 items-center gap-2.5 rounded-lg border border-line-subtle bg-sunken py-1.5 pr-1.5 pl-3 text-[13px] dark:bg-raised"
>
  <Check size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
  <span class="min-w-0 flex-1 truncate text-text-2" dir="auto" title={action.summary}
    >{action.summary}</span
  >
  {#if !undone && (document || course)}
    <button
      type="button"
      class="h-7 shrink-0 rounded-md px-2 text-[12px] font-medium whitespace-nowrap text-text-2 hover:bg-hover hover:text-text"
      onclick={(event) =>
        document
          ? folio.openDocument(document.id, 1, { newTab: event.metaKey || event.ctrlKey })
          : folio.navigate({ view: "course", courseId: course!.id, tab: "materials" })}
      >Open</button
    >
  {/if}
  {#if undone}
    <span class="shrink-0 px-2 text-[12px] text-text-3">Undone</span>
  {:else if action.undo}
    <button
      type="button"
      class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium whitespace-nowrap text-text-2 hover:bg-hover hover:text-text disabled:opacity-50"
      disabled={working}
      onclick={() => void undo()}
    >
      <Undo2 size={13} strokeWidth={1.75} />
      Undo
    </button>
  {/if}
</div>
