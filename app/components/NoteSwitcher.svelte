<script lang="ts">
  import { NotebookPen, Plus } from "@lucide/svelte";
  import { Command, Dialog } from "bits-ui";
  import { noteTime, PENCIL } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * ⌘O, as in Obsidian: type part of a note's title to open it, or create a note with that title
   * when none has it. The open course's notes come first; ⌘↵ opens in a new tab.
   */
  let query = $state("");

  $effect(() => {
    if (folio.switcherOpen) query = "";
  });

  const here = $derived(folio.currentCourseId);
  const notes = $derived(
    [...folio.notes].sort(
      (a, b) =>
        Number(b.courseId === here) - Number(a.courseId === here) ||
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    ),
  );
  const title = $derived(query.replace(/\s+/g, " ").trim());
  const exists = $derived(
    notes.some(
      (note) =>
        note.title.toLocaleLowerCase() === title.toLocaleLowerCase() &&
        (!here || note.courseId === here),
    ),
  );
  /** Where a new note goes: the open course, or each course to choose from. */
  const targets = $derived(
    here ? folio.courses.filter((course) => course.id === here) : folio.courses,
  );

  function open(id: string, newTab: boolean): void {
    folio.switcherOpen = false;
    folio.openNote(id, { newTab });
  }

  function create(courseId: string): void {
    folio.switcherOpen = false;
    void folio.createNote(courseId, title);
  }

  let newTab = false;
  const item =
    "flex h-10 cursor-default items-center gap-3 rounded-md px-2.5 text-text data-[selected]:bg-hover";
</script>

<Dialog.Root bind:open={folio.switcherOpen}>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-40 animate-[folio-fade_120ms_ease-out] bg-[#18181b]/15 dark:bg-black/40"
    />
    <Dialog.Content
      class="fixed top-[14vh] left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line-subtle bg-raised shadow-3 outline-none"
    >
      <Dialog.Title class="sr-only">Open a note</Dialog.Title>
      <Command.Root class="flex animate-[folio-scale_160ms_var(--ease-out-quint)] flex-col" loop>
        <Command.Input
          bind:value={query}
          placeholder="Find or create a note"
          class="h-14 border-b border-line-subtle bg-transparent px-5 text-[16px] outline-none placeholder:text-text-3"
          dir="auto"
          onkeydown={(event: KeyboardEvent) => {
            newTab = event.metaKey || event.ctrlKey;
          }}
        />
        <Command.List class="scroll-quiet max-h-[min(400px,52vh)] overflow-y-auto p-1.5">
          <Command.Viewport>
            <Command.Empty class="px-3 py-6 text-center text-[13px] text-text-3">
              {folio.courses.length ? "No note has that title." : "Add a course to start taking notes."}
            </Command.Empty>
            {#each notes as note (note.id)}
              {@const course = folio.course(note.courseId)}
              <Command.Item
                value={`${note.title} ${note.id}`}
                keywords={[course?.name ?? ""]}
                onSelect={() => open(note.id, newTab)}
                class={item}
              >
                <NotebookPen size={15} strokeWidth={1.75} class="shrink-0 text-text-3" />
                <span class="min-w-0 flex-1 truncate" dir="auto">{note.title}</span>
                {#if course}
                  <span class="flex max-w-[40%] min-w-0 shrink items-center gap-1.5 text-[12px] text-text-3">
                    <span class="size-1.5 shrink-0 rounded-full" style:background={PENCIL[course.color]}
                    ></span>
                    <span class="truncate" dir="auto">{course.name}</span>
                  </span>
                {/if}
                <span class="w-16 shrink-0 text-right text-[12px] text-text-4 tabular-nums"
                  >{noteTime(note.updatedAt)}</span
                >
              </Command.Item>
            {/each}
            {#if title && !exists}
              {#each targets as course (course.id)}
                <Command.Item
                  value={`create ${title} ${course.id}`}
                  keywords={[title]}
                  forceMount
                  onSelect={() => create(course.id)}
                  class={item}
                >
                  <Plus size={15} strokeWidth={1.75} class="shrink-0 text-text-3" />
                  <span class="min-w-0 flex-1 truncate"
                    >Create “<bdi>{title}</bdi>”{targets.length > 1 ? " in " : ""}{#if targets.length > 1}<bdi
                        >{course.name}</bdi
                      >{/if}</span
                  >
                </Command.Item>
              {/each}
            {/if}
          </Command.Viewport>
        </Command.List>
        <div
          class="flex h-9 items-center gap-4 border-t border-line-subtle bg-sunken px-4 text-[12px] text-text-3 dark:bg-surface"
        >
          <span>↑↓ move</span><span>↵ open</span><span>⌘↵ new tab</span><span class="flex-1"
          ></span><span>esc close</span>
        </div>
      </Command.Root>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
