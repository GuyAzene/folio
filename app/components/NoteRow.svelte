<script lang="ts">
  import { Pin } from "@lucide/svelte";
  import { ContextMenu } from "bits-ui";
  import type { NoteView } from "../../src/desktop/api.ts";
  import { noteTime, PENCIL } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * One note in a notes list, as in Apple Notes or Bear: its title, when it changed and the
   * start of its text (or the line a search matched), then its course and #tags. A tag filters
   * the list; right-click pins it, opens it in a new tab or moves it to the Trash.
   */
  let {
    note,
    selected = false,
    snippet = null,
    query = "",
    showCourse = true,
    roving = false,
    onopen,
    ontag,
  }: {
    note: NoteView;
    selected?: boolean;
    /** The line a search matched, shown in place of the note's opening text. */
    snippet?: string | null;
    query?: string;
    showCourse?: boolean;
    /** In a list walked with the arrow keys, only the selected row takes Tab. */
    roving?: boolean;
    onopen: (newTab: boolean) => void;
    ontag?: (tag: string) => void;
  } = $props();

  const course = $derived(folio.course(note.courseId));
  const pinned = $derived(folio.pinnedNotes.includes(note.id));
  const text = $derived(snippet ?? note.preview);

  /** The text split around the searched words, so they can be marked. */
  const parts = $derived.by(() => {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter((term) => term.length > 1)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!terms.length) return [{ text, match: false }];
    return text
      .split(new RegExp(`(${terms.join("|")})`, "iu"))
      .map((part, index) => ({ text: part, match: index % 2 === 1 }));
  });

  const menuItem =
    "flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover";
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <div
        {...props}
        role="button"
        tabindex={!roving || selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        aria-label={note.title}
        data-note={note.id}
        class="flex min-w-0 cursor-default flex-col gap-0.5 rounded-lg border px-3 py-2 outline-none transition-colors duration-150 focus-visible:border-line-strong {selected
          ? 'border-line-subtle bg-selected shadow-1'
          : 'border-transparent hover:bg-hover'}"
        onclick={(event) => onopen(event.metaKey || event.ctrlKey)}
        onkeydown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onopen(event.metaKey || event.ctrlKey);
        }}
      >
        <div class="flex min-w-0 items-center gap-1.5">
          <span
            class="min-w-0 flex-1 truncate text-[13.5px] leading-5 font-medium text-text"
            dir="auto">{note.title}</span
          >
          {#if pinned}
            <Pin size={11} strokeWidth={2} class="shrink-0 text-text-3" />
            <span class="sr-only">Pinned</span>
          {/if}
        </div>
        <p class="line-clamp-2 text-[12.5px] leading-[18px] break-words text-text-3">
          <span class="mr-1.5 text-text-2 tabular-nums">{noteTime(note.updatedAt)}</span><bdi
            >{#if text}{#each parts as part, index (index)}{#if part.match}<mark
                    class="rounded-[3px] bg-highlight/40 px-px text-text">{part.text}</mark
                  >{:else}{part.text}{/if}{/each}{:else}No additional text{/if}</bdi
          >
        </p>
        {#if (showCourse && course) || note.tags.length}
          <div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-text-3">
            {#if showCourse && course}
              <span
                class="size-1.5 shrink-0 rounded-full"
                style:background={PENCIL[course.color]}
              ></span>
              <span class="min-w-0 shrink truncate" dir="auto">{course.name}</span>
            {/if}
            {#each note.tags.slice(0, 3) as tag (tag)}
              <button
                type="button"
                class="max-w-[120px] shrink-0 truncate rounded px-1 text-text-3 transition-colors hover:bg-press hover:text-text"
                dir="auto"
                tabindex="-1"
                onclick={(event) => {
                  event.stopPropagation();
                  ontag?.(tag);
                }}>#{tag}</button
              >
            {/each}
          </div>
        {/if}
      </div>
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content
      class="z-50 min-w-[190px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
    >
      <ContextMenu.Item class={menuItem} onSelect={() => onopen(false)}>Open</ContextMenu.Item>
      <ContextMenu.Item class={menuItem} onSelect={() => onopen(true)}
        >Open in new tab</ContextMenu.Item
      >
      <ContextMenu.Item class={menuItem} onSelect={() => folio.togglePin(note.id)}
        >{pinned ? "Unpin" : "Pin"}</ContextMenu.Item
      >
      <ContextMenu.Separator class="my-1.5 h-px bg-line-subtle" />
      <ContextMenu.Item class="{menuItem} text-danger" onSelect={() => folio.trashNote(note.id)}
        >Move to Trash</ContextMenu.Item
      >
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
