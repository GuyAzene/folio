<script lang="ts">
  import { Check, ListFilter } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import { folio } from "../lib/state.svelte.ts";
  import CourseTile from "./CourseTile.svelte";

  /** A list column's course filter: a small menu in its header, rather than a row of chips. */
  let {
    value,
    onchange,
  }: { value: string | null; onchange: (courseId: string | null) => void } = $props();

  const item =
    "flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover";
</script>

{#if folio.courses.length > 1}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-hover hover:text-text data-[state=open]:bg-hover data-[state=open]:text-text {value
        ? 'text-text'
        : 'text-text-3'}"
      aria-label="Show one course"
      title="Show one course"
    >
      <ListFilter size={15} strokeWidth={1.75} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align="end"
        sideOffset={6}
        class="z-50 max-w-[300px] min-w-[220px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
      >
        <DropdownMenu.Item class={item} onSelect={() => onchange(null)}>
          <span class="flex size-4 shrink-0 items-center justify-center"></span>
          <span class="min-w-0 flex-1 truncate">All courses</span>
          {#if !value}<Check size={14} strokeWidth={2} class="shrink-0 text-text-2" />{/if}
        </DropdownMenu.Item>
        {#each folio.courses as course (course.id)}
          <DropdownMenu.Item class={item} onSelect={() => onchange(course.id)}>
            <CourseTile {course} size={16} />
            <span class="min-w-0 flex-1 truncate" dir="auto">{course.name}</span>
            {#if value === course.id}<Check
                size={14}
                strokeWidth={2}
                class="shrink-0 text-text-2"
              />{/if}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/if}
