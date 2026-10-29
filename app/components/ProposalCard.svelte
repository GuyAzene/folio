<script lang="ts">
  import { Check, NotebookPen } from "@lucide/svelte";
  import type { ProposalAction } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";

  /** An edit Folio suggested for a note. Nothing is written until the student keeps it. */
  let { id }: { id: string } = $props();
  let busy = $state(false);

  const proposal = $derived(folio.proposal(id));

  async function resolve(action: ProposalAction): Promise<void> {
    busy = true;
    await folio.resolveProposal(id, action);
    busy = false;
  }
</script>

{#if proposal}
  {@const pending = proposal.state === "pending"}
  <div
    class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-1 dark:bg-raised"
  >
    <div class="flex items-center gap-2">
      <NotebookPen size={15} strokeWidth={1.75} class="shrink-0 text-text-2" />
      <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-text">
        {proposal.noteId ? "Edit to" : "New note"}
        {proposal.noteTitle}
      </span>
      {#if !pending}
        <span
          class="inline-flex shrink-0 items-center gap-1 text-[12px] text-text-3"
        >
          {#if proposal.state === "discarded"}Discarded{:else}<Check
              size={12}
              strokeWidth={2}
              class="text-success"
            />
            {proposal.state === "kept" ? "Kept" : "Added below"}{/if}
        </span>
      {/if}
    </div>
    {#if proposal.reason}
      <p class="-mt-1 text-[13px] text-text-2">{proposal.reason}</p>
    {/if}

    <div
      class="flex max-h-[260px] flex-col overflow-y-auto rounded-lg border border-line-subtle text-[14px] leading-6 {pending
        ? ''
        : 'opacity-60'}"
    >
      {#if proposal.find}
        <div
          class="border-b border-line-subtle bg-danger-wash/60 px-3 py-2 whitespace-pre-wrap text-text-2 line-through decoration-danger/50"
        >
          {proposal.find}
        </div>
      {/if}
      <div class="flex gap-2.5 bg-highlight-wash/40 py-2 pr-3 pl-0">
        <span class="w-[3px] shrink-0 rounded-full bg-highlight"></span>
        <span class="min-w-0 whitespace-pre-wrap text-text"
          >{proposal.text}</span
        >
      </div>
    </div>

    {#if pending && proposal.stale}
      <p class="text-[13px] text-text-2">
        Your note changed after Folio drafted this, so it can't be kept as
        drafted. You can still add it below what's there now.
      </p>
    {/if}

    {#if pending}
      <div class="flex flex-wrap gap-2">
        {#if !proposal.stale}
          <button
            class="h-7 rounded-md bg-ink px-3 text-[13px] font-medium text-on-ink shadow-1 hover:opacity-90 disabled:opacity-50"
            disabled={busy}
            onclick={() => resolve("keep")}
          >
            {proposal.noteId ? "Keep" : "Create note"}
          </button>
        {/if}
        {#if proposal.noteId && (proposal.find || proposal.stale)}
          <button
            class="h-7 rounded-md border border-line bg-surface px-3 text-[13px] font-medium shadow-1 hover:bg-hover disabled:opacity-50 dark:bg-raised"
            disabled={busy}
            onclick={() => resolve("insert")}
          >
            Insert below
          </button>
        {/if}
        <button
          class="h-7 rounded-md px-3 text-[13px] font-medium text-text-2 hover:bg-hover hover:text-text disabled:opacity-50"
          disabled={busy}
          onclick={() => resolve("discard")}
        >
          Discard
        </button>
      </div>
    {:else if proposal.resultNoteId && folio.note(proposal.resultNoteId)}
      <button
        class="-mt-1 w-fit text-[13px] font-medium text-text-2 underline decoration-line-strong underline-offset-4 hover:text-text"
        onclick={() => folio.openNote(proposal.resultNoteId!)}
      >
        Open note
      </button>
    {/if}
  </div>
{/if}
