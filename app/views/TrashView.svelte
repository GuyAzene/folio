<script lang="ts">
  import {
    FileText,
    Folder,
    MessageSquare,
    NotebookPen,
    RotateCcw,
    Trash2,
  } from "@lucide/svelte";
  import type { Component } from "svelte";
  import type { TrashEntryView } from "../../src/desktop/api.ts";
  import { formatDate } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * Folio's Trash: what was removed in the last 30 days. Restore puts it back where it was;
   * Delete moves it on to the Mac's Trash, which is also where it goes by itself after 30 days.
   */
  const icons: Record<TrashEntryView["kind"], Component> = {
    document: FileText,
    note: NotebookPen,
    chat: MessageSquare,
    course: Folder,
  };

  function daysLeft(entry: TrashEntryView): string {
    const days = Math.max(
      0,
      Math.ceil((Date.parse(entry.expiresAt) - Date.now()) / 86_400_000),
    );
    return days <= 1 ? "Leaves tomorrow" : `${days} days left`;
  }

  function detail(entry: TrashEntryView): string {
    const kind = {
      document: "File",
      note: "Note",
      chat: "Chat",
      course: "Course",
    }[entry.kind];
    const parts = [kind];
    if (entry.kind !== "course" && entry.courseName)
      parts.push(entry.courseName);
    if (entry.contents) {
      const { documents, notes, chats } = entry.contents;
      const plural = (count: number, word: string) =>
        `${count} ${word}${count === 1 ? "" : "s"}`;
      parts.push(
        [
          plural(documents, "file"),
          plural(notes, "note"),
          plural(chats, "chat"),
        ].join(", "),
      );
    }
    if (entry.withStudyNotes) parts.push("study notes come back with it");
    return parts.join(" · ");
  }
</script>

<div class="scroll-quiet h-full overflow-y-auto">
  <div
    class="mx-auto flex w-full max-w-[860px] flex-col px-8 pt-10 pb-16 max-sm:px-4"
  >
    <div class="flex items-start gap-4">
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <h1
          class="text-[24px] leading-8 font-semibold tracking-[-0.015em] text-text"
        >
          Trash
        </h1>
        <span class="text-text-3">
          Removed files, notes, chats and courses stay here for 30 days, then
          move to your Mac's Trash.
        </span>
      </div>
      {#if folio.trash.length}
        <button
          class="flex h-8 shrink-0 items-center gap-2 rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover dark:bg-raised"
          onclick={() => folio.emptyTrash()}
        >
          <Trash2 size={14} strokeWidth={1.75} /> Empty Trash
        </button>
      {/if}
    </div>

    {#if folio.trash.length}
      <div
        class="mt-8 flex flex-col overflow-hidden rounded-xl border border-line"
      >
        {#each folio.trash as entry (entry.id)}
          {@const Icon = icons[entry.kind]}
          <div
            class="group flex min-h-14 items-center gap-3 border-b border-line-subtle px-4 py-2 last:border-b-0 hover:bg-hover"
          >
            <Icon size={15} strokeWidth={1.75} class="shrink-0 text-text-3" />
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-medium text-text" dir="auto"
                >{entry.title}</span
              >
              <span class="truncate text-[12px] text-text-3" dir="auto"
                >{detail(entry)}</span
              >
            </div>
            <span
              class="w-[120px] shrink-0 text-right text-[12px] text-text-3 max-sm:hidden"
              title="Removed {formatDate(entry.removedAt)}"
              >{daysLeft(entry)}</span
            >
            <button
              class="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium shadow-1 hover:bg-hover dark:bg-raised"
              onclick={() => folio.restoreFromTrash(entry.id)}
            >
              <RotateCcw size={12} strokeWidth={2} /> Restore
            </button>
            <button
              class="flex h-7 shrink-0 items-center rounded-md px-2 text-[12px] font-medium text-text-3 hover:bg-press hover:text-danger"
              title="Move to your Mac's Trash"
              onclick={() => folio.deleteFromTrash(entry.id)}>Delete</button
            >
          </div>
        {/each}
      </div>
    {:else}
      <div
        class="mt-8 flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-6 py-14 text-center text-text-3"
      >
        <Trash2 size={18} strokeWidth={1.75} />
        Nothing in the Trash.
      </div>
    {/if}
  </div>
</div>
