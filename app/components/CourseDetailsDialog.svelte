<script lang="ts">
  import { X } from "@lucide/svelte";
  import { Dialog } from "bits-ui";
  import type { CourseView, Pencil } from "../../src/desktop/api.ts";
  import { PENCIL, PENCILS } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import CourseTile from "./CourseTile.svelte";

  /**
   * A course's name, code, term and color. Renaming keeps everything else: its files, notes,
   * chats and study notes stay as they are.
   */
  let {
    course,
    open = $bindable(false),
  }: { course: CourseView; open?: boolean } = $props();

  let name = $state("");
  let code = $state("");
  let term = $state("");
  let color = $state<Pencil>("graphite");
  let saving = $state(false);

  $effect(() => {
    if (!open) return;
    name = course.name;
    code = course.code;
    term = course.term;
    color = course.color;
  });

  const changed = $derived(
    name.trim() !== course.name ||
      code.trim() !== course.code ||
      term.trim() !== course.term ||
      color !== course.color,
  );

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim() || saving) return;
    saving = true;
    try {
      if (changed)
        await folio.updateCourse(course, {
          name: name.trim(),
          code: code.trim(),
          term: term.trim(),
          color,
        });
      open = false;
    } finally {
      saving = false;
    }
  }

  const input =
    "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 outline-none transition-colors placeholder:text-text-4 focus:border-ink dark:bg-sunken";
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-40 animate-[folio-fade_150ms_ease-out] bg-[#18181b]/20 backdrop-blur-[2px] dark:bg-black/50"
    />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 animate-[folio-scale_180ms_var(--ease-out-quint)] flex-col overflow-hidden rounded-[20px] border border-line-subtle bg-raised shadow-3 outline-none"
    >
      <form class="flex min-h-0 flex-col" onsubmit={save}>
        <div
          class="scroll-quiet flex min-h-0 flex-col gap-5 overflow-y-auto p-6 max-sm:px-4"
        >
          <div class="flex items-center gap-3.5">
            <CourseTile course={{ name: name || course.name, color }} size={36} />
            <Dialog.Title
              class="min-w-0 flex-1 text-[18px] leading-6 font-semibold tracking-[-0.015em] text-text"
              >Edit course</Dialog.Title
            >
            <Dialog.Close
              type="button"
              class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line-subtle text-text-3 hover:bg-hover hover:text-text"
              aria-label="Close"
            >
              <X size={15} strokeWidth={1.75} />
            </Dialog.Close>
          </div>
          <Dialog.Description class="sr-only"
            >The course's name, code, term and color.</Dialog.Description
          >
          <label class="flex min-w-0 flex-col gap-1.5">
            <span class="text-[12px] font-medium text-text-2">Name</span>
            <input
              bind:value={name}
              required
              maxlength={80}
              dir="auto"
              class={input}
            />
          </label>
          <div class="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <label class="flex min-w-0 flex-col gap-1.5">
              <span class="text-[12px] font-medium text-text-2">Code</span>
              <input
                bind:value={code}
                maxlength={24}
                placeholder="CS 201"
                dir="auto"
                class={input}
              />
            </label>
            <label class="flex min-w-0 flex-col gap-1.5">
              <span class="text-[12px] font-medium text-text-2">Term</span>
              <input
                bind:value={term}
                maxlength={40}
                placeholder="Spring 2026"
                dir="auto"
                class={input}
              />
            </label>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-[12px] font-medium text-text-2">Color</span>
            <div class="flex flex-wrap gap-1.5">
              {#each PENCILS as pencil (pencil)}
                <button
                  type="button"
                  class="size-5 rounded-full transition-transform {color ===
                  pencil
                    ? 'scale-110 ring-2 ring-offset-2 ring-offset-raised'
                    : 'hover:scale-110'}"
                  style="background:{PENCIL[pencil]};--tw-ring-color:{PENCIL[
                    pencil
                  ]}"
                  aria-label={pencil}
                  aria-pressed={color === pencil}
                  onclick={() => (color = pencil)}
                ></button>
              {/each}
            </div>
          </div>
        </div>
        <div
          class="flex shrink-0 items-center justify-end gap-3 border-t border-line-subtle bg-sunken px-6 py-3.5 max-sm:px-4 dark:bg-surface"
        >
          <Dialog.Close
            type="button"
            class="h-9 shrink-0 rounded-full border border-line bg-surface px-4 font-medium shadow-1 hover:bg-hover dark:bg-raised"
            >Cancel</Dialog.Close
          >
          <button
            type="submit"
            disabled={!name.trim() || saving}
            class="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-ink px-4 font-medium text-on-ink shadow-2 transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
