<script lang="ts">
  import { AlertDialog } from "bits-ui";
  import { folio } from "../lib/state.svelte.ts";

  /** Asks before something hard to undo: removing a whole course, deleting from the Trash. */
  let working = $state(false);
  const question = $derived(folio.confirming);

  async function confirm(): Promise<void> {
    if (!question || working) return;
    working = true;
    try {
      await question.run();
      folio.confirming = null;
    } catch (error) {
      folio.error =
        error instanceof Error ? error.message : "Something went wrong.";
      folio.confirming = null;
    } finally {
      working = false;
    }
  }
</script>

<AlertDialog.Root
  open={!!question}
  onOpenChange={(open) => !open && !working && (folio.confirming = null)}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay
      class="fixed inset-0 z-40 animate-[folio-fade_150ms_ease-out] bg-[#18181b]/20 backdrop-blur-[2px] dark:bg-black/50"
    />
    <AlertDialog.Content
      class="fixed top-1/2 left-1/2 z-50 flex w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 animate-[folio-scale_180ms_var(--ease-out-quint)] flex-col gap-2 rounded-[16px] border border-line-subtle bg-raised p-5 shadow-3 outline-none"
    >
      {#if question}
        <AlertDialog.Title
          class="text-[16px] leading-6 font-semibold tracking-[-0.01em] break-words text-text"
          dir="auto">{question.title}</AlertDialog.Title
        >
        <AlertDialog.Description
          class="text-[13px] leading-5 break-words text-text-2"
          dir="auto">{question.body}</AlertDialog.Description
        >
        <div class="mt-3 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover dark:bg-raised"
            disabled={working}>Cancel</AlertDialog.Cancel
          >
          <AlertDialog.Action
            class="h-8 rounded-md bg-danger px-3 font-medium text-white shadow-1 hover:opacity-90 disabled:opacity-60"
            disabled={working}
            onclick={confirm}>{question.action}</AlertDialog.Action
          >
        </div>
      {/if}
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
