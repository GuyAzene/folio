<script lang="ts">
  import { ArrowDown } from "@lucide/svelte";
  import { tick } from "svelte";
  import type { ChatView } from "../../src/desktop/api.ts";
  import {
    estimateDirection,
    writtenDirection,
    type Direction,
  } from "../lib/direction.ts";
  import Message from "./Message.svelte";

  let { chat, compact = false }: { chat: ChatView; compact?: boolean } =
    $props();
  let scroller: HTMLDivElement;
  let pinned = $state(true);

  /** The direction of the question a reply answers: its fallback for blocks without words. */
  function baseFor(index: number): Direction | undefined {
    for (let at = index - 1; at >= 0; at--) {
      const message = chat.messages[at];
      if (message?.role === "user")
        return writtenDirection(estimateDirection(message.text)) ?? undefined;
    }
    return undefined;
  }

  function onscroll(): void {
    pinned =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }

  function toBottom(behavior: ScrollBehavior = "smooth"): void {
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior });
  }

  // A different chat opens at its latest message.
  $effect(() => {
    void chat.id;
    pinned = true;
    void tick().then(() => toBottom("instant"));
  });

  // While pinned, follow new messages, streaming text and visuals as they arrive.
  $effect(() => {
    void chat.messages.length;
    void chat.messages.at(-1)?.text;
    for (const visual of chat.messages.at(-1)?.visuals ?? []) void visual.state;
    if (pinned) void tick().then(() => toBottom("instant"));
  });
</script>

<div class="relative min-h-0 flex-1">
  <div
    bind:this={scroller}
    {onscroll}
    class="scroll-quiet h-full overflow-y-auto"
  >
    <div
      class="mx-auto flex w-full flex-col {compact
        ? 'gap-6 px-4 pt-4 pb-6'
        : 'max-w-[720px] gap-7 px-6 pt-6 pb-10 max-sm:px-4'}"
    >
      {#each chat.messages as message, index (index)}
        <Message {message} chatId={chat.id || null} base={baseFor(index)} />
      {/each}
    </div>
  </div>
  {#if !pinned}
    <button
      class="absolute bottom-3 left-1/2 inline-flex size-8 -translate-x-1/2 animate-[folio-fade_150ms_ease-out] items-center justify-center rounded-full border border-line bg-raised text-text-2 shadow-2 hover:text-text"
      aria-label="Jump to latest"
      onclick={() => toBottom()}
    >
      <ArrowDown size={15} strokeWidth={1.75} />
    </button>
  {/if}
</div>
