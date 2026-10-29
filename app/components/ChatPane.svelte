<script lang="ts">
  import type { Focus } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";
  import Composer from "./Composer.svelte";
  import FolioMark from "./FolioMark.svelte";
  import Thread from "./Thread.svelte";

  /** One conversation: the thread, its composer, and a quiet empty state before the first message. */
  let {
    tabId,
    chatId,
    courseId,
    focus = null,
    compact = false,
    emptyTitle = "What are we studying?",
    emptyNote = "",
    quote = $bindable(null),
    onnewchat,
  }: {
    tabId: string;
    chatId: string | null;
    courseId: string | null;
    focus?: Focus | null;
    compact?: boolean;
    emptyTitle?: string;
    emptyNote?: string;
    quote?: { text: string; source: string } | null;
    /** Starts a new chat in this place; defaults to a new chat tab view. */
    onnewchat?: () => void;
  } = $props();

  let composer = $state<Composer>();
  const chat = $derived(folio.chatFor(chatId, tabId));

  $effect(() => {
    if (chatId) void folio.loadChat(chatId);
  });

  export function focusInput(): void {
    composer?.focusInput();
  }
</script>

{#if chat && chat.messages.length}
  <Thread {chat} {compact} />
  <div
    class="mx-auto w-full {compact
      ? 'px-3 pb-3'
      : 'max-w-[720px] px-6 pb-5 max-sm:px-3 max-sm:pb-3'}"
  >
    <Composer
      bind:this={composer}
      bind:quote
      {tabId}
      {chatId}
      {courseId}
      {focus}
      {onnewchat}
    />
  </div>
{:else}
  <div
    class="flex min-h-0 flex-1 animate-[folio-fade_240ms_ease-out] flex-col items-center justify-center {compact
      ? 'px-3 pb-3'
      : 'px-6 pb-[12vh] max-sm:px-4'}"
  >
    <div
      class="flex w-full {compact ? '' : 'max-w-[680px]'} flex-col items-center"
    >
      {#if !compact}
        <FolioMark size={30} />
        <h1
          class="mt-5 text-center font-serif text-[32px] leading-[38px] font-normal tracking-[-0.02em] text-text max-sm:text-[26px] max-sm:leading-8"
        >
          {emptyTitle}
        </h1>
      {:else}
        <div
          class="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center"
        >
          <FolioMark size={24} />
          <p class="max-w-[260px] text-text-2">{emptyTitle}</p>
        </div>
      {/if}
      <div class="{compact ? '' : 'mt-8'} w-full">
        <Composer
          bind:this={composer}
          bind:quote
          {tabId}
          {chatId}
          {courseId}
          {focus}
          {onnewchat}
          large={!compact}
        />
      </div>
      {#if emptyNote}<p class="mt-3 text-center text-[12px] text-text-3">
          {emptyNote}
        </p>{/if}
    </div>
  </div>
{/if}
