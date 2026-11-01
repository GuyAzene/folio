<script lang="ts">
  import { CircleAlert, Hand, Undo2 } from "@lucide/svelte";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * A change the tutor proposed that waits for the student: nothing happens until Apply, which
   * checks it again first. Answered, it says how, and an applied change can be undone.
   */
  let { id }: { id: string } = $props();

  let working = $state(false);
  let undone = $state(false);
  const change = $derived(folio.proposedChange(id));

  async function answer(apply: boolean): Promise<void> {
    if (working) return;
    working = true;
    await folio.answerChange(id, apply);
    working = false;
  }

  async function undo(): Promise<void> {
    if (!change?.undo || working) return;
    working = true;
    undone = await folio.undoChange(change.undo);
    working = false;
  }

  const button =
    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium whitespace-nowrap disabled:opacity-50";
</script>

{#if change}
  <div
    class="flex max-w-full min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5 text-[13px] {change.state ===
    'pending'
      ? 'border-line bg-surface shadow-1 dark:bg-raised'
      : 'border-line-subtle bg-sunken dark:bg-raised'}"
  >
    <div class="flex min-w-0 items-start gap-2.5">
      {#if change.state === "failed"}
        <CircleAlert size={14} strokeWidth={1.75} class="mt-0.5 shrink-0 text-danger" />
      {:else}
        <Hand size={14} strokeWidth={1.75} class="mt-0.5 shrink-0 text-text-3" />
      {/if}
      <span class="min-w-0 flex-1 text-text" dir="auto">{change.summary}</span>
    </div>
    {#if change.state === "pending"}
      <div class="flex items-center justify-end gap-1.5">
        <span class="mr-auto text-[12px] text-text-3">Waits for you</span>
        <button
          type="button"
          class="{button} text-text-2 hover:bg-hover hover:text-text"
          disabled={working}
          onclick={() => void answer(false)}>Cancel</button
        >
        <button
          type="button"
          class="{button} bg-ink text-on-ink hover:opacity-90"
          disabled={working}
          onclick={() => void answer(true)}>Apply</button
        >
      </div>
    {:else}
      <div class="flex items-center gap-1.5">
        <span
          class="mr-auto text-[12px] {change.state === 'failed'
            ? 'text-danger'
            : 'text-text-3'}"
          dir="auto"
          >{change.state === "applied"
            ? undone
              ? "Applied, then undone"
              : "Applied"
            : change.state === "cancelled"
              ? "Cancelled"
              : (change.note ?? "Couldn't apply it")}</span
        >
        {#if change.state === "applied" && change.undo && !undone}
          <button
            type="button"
            class="{button} text-text-2 hover:bg-hover hover:text-text"
            disabled={working}
            onclick={() => void undo()}
          >
            <Undo2 size={13} strokeWidth={1.75} />
            Undo
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}
