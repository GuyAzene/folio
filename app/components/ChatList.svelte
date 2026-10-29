<script lang="ts">
  import { MessageSquare, Trash2 } from "@lucide/svelte";
  import type { ChatSummary } from "../../src/desktop/api.ts";
  import { formatDate } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import { groupChats } from "../lib/time.ts";
  import CourseTile from "./CourseTile.svelte";

  /** Chats grouped by when they were last used: the Chats page, and a course's Chats tab. */
  let {
    chats,
    showCourse = false,
    empty,
  }: { chats: ChatSummary[]; showCourse?: boolean; empty: string } = $props();

  const groups = $derived(groupChats(chats));
</script>

{#each groups as group (group.label)}
  <h2
    class="mt-6 mb-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase first:mt-0"
  >
    {group.label}
  </h2>
  {#each group.chats as chat (chat.id)}
    {@const course = folio.course(chat.courseId)}
    <div
      class="group -mx-2 flex h-10 w-[calc(100%+16px)] items-center rounded-md hover:bg-hover"
    >
      <button
        class="flex h-10 min-w-0 flex-1 items-center gap-3 px-2 text-left"
        onclick={(event) =>
          folio.navigate(
            { view: "chat", chatId: chat.id, courseId: chat.courseId },
            { newTab: event.metaKey || event.ctrlKey },
          )}
      >
        {#if showCourse && course}<CourseTile
            {course}
            size={18}
          />{:else}<MessageSquare
            size={16}
            strokeWidth={1.75}
            class="mx-px shrink-0 text-text-3"
          />{/if}
        <span class="min-w-0 flex-1 truncate font-medium text-text" dir="auto"
          >{chat.title}</span
        >
        {#if chat.status === "running"}<span
            class="size-1.5 shrink-0 rounded-full bg-highlight ring-2 ring-highlight/30"
          ></span>{/if}
        {#if showCourse}
          <span
            class="max-w-[160px] min-w-0 shrink truncate text-[12px] text-text-3 max-sm:hidden"
            dir="auto"
            >{course?.name ??
              (chat.kind === "library" ? "Your courses" : "No course")}</span
          >
        {/if}
        <span
          class="w-[72px] shrink-0 text-right text-[12px] whitespace-nowrap text-text-3"
          >{formatDate(chat.updatedAt)}</span
        >
      </button>
      <button
        type="button"
        class="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-text-4 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-press hover:text-danger focus-visible:opacity-100"
        title="Move to Trash"
        aria-label="Move {chat.title} to Trash"
        onclick={() => folio.trashChat(chat.id)}
      >
        <Trash2 size={14} strokeWidth={1.75} />
      </button>
    </div>
  {/each}
{:else}
  <div
    class="rounded-xl border border-dashed border-line-strong px-6 py-12 text-center text-text-3"
  >
    {empty}
  </div>
{/each}
