<script lang="ts">
  import { Plus } from "@lucide/svelte";
  import Composer from "../components/Composer.svelte";
  import FolioMark from "../components/FolioMark.svelte";
  import { folio } from "../lib/state.svelte.ts";

  let { tabId }: { tabId: string } = $props();
  let composer = $state<Composer>();

  const greeting = $derived.by(() => {
    const hour = new Date().getHours();
    return hour < 5
      ? "Working late?"
      : hour < 12
        ? "Good morning."
        : hour < 18
          ? "Good afternoon."
          : "Good evening.";
  });

  export function focusInput(): void {
    composer?.focusInput();
  }
</script>

<!-- Courses live in the sidebar; Home is only the place to ask. -->
<div class="scroll-quiet flex h-full flex-col overflow-y-auto">
  <div
    class="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center px-6 pt-10 pb-[14vh] max-sm:px-4"
  >
    <FolioMark size={28} />
    <h1
      class="mt-5 font-serif text-[36px] leading-[42px] tracking-[-0.02em] text-text max-sm:text-[28px] max-sm:leading-9"
    >
      {greeting}
    </h1>
    <div class="mt-7">
      <Composer
        bind:this={composer}
        {tabId}
        chatId={null}
        courseId={null}
        large
        placeholder={folio.courses.length
          ? "Ask about any of your courses"
          : "Ask Folio anything"}
        onbeforesend={() =>
          folio.navigate({ view: "chat", chatId: null, courseId: null })}
      />
    </div>

    {#if folio.ready && !folio.courses.length}
      <button
        class="mt-4 flex h-14 items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong text-text-3 transition-colors hover:border-text-4 hover:text-text-2"
        onclick={() => (folio.newCourseOpen = true)}
      >
        <Plus size={16} strokeWidth={1.75} />
        <span class="font-medium">Add your first course</span>
      </button>
    {/if}
  </div>
</div>
