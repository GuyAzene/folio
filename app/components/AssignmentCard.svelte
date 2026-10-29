<script lang="ts">
  import { ContextMenu } from "bits-ui";
  import type { AssignmentView } from "../../src/desktop/api.ts";
  import {
    ASSIGNMENT_STATUSES,
    assignmentBadges,
    type AssignmentStatus,
  } from "../../src/library/assignments.ts";
  import { KIND_LABEL, PENCIL, relativeDue, STATUS_COLUMN } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import StatusIcon from "./StatusIcon.svelte";
  import StatusMenu from "./StatusMenu.svelte";

  /**
   * One assignment on the board. Its status icon is the control that changes the status; a card
   * also moves by dragging, by its right-click menu, and from the keyboard (1 to 4 set a status,
   * ⌘⇧← and → move it a column, S opens the status menu, Enter opens the card).
   */
  let {
    item,
    onopen,
    onmove,
    ondragstart,
    ondragend,
    dragging = false,
  }: {
    item: AssignmentView;
    onopen: () => void;
    onmove: (status: AssignmentStatus) => void;
    ondragstart: (event: DragEvent) => void;
    ondragend: () => void;
    dragging?: boolean;
  } = $props();

  let menuOpen = $state(false);
  const badges = $derived(assignmentBadges(item));
  const course = $derived(folio.course(item.courseId));
  const steps = $derived(item.steps.filter((step) => step.done).length);
  const handedIn = $derived(item.status === "submitted" || item.status === "done");
  const flag = $derived(
    badges.late ? "Late" : badges.extended ? "Extended" : badges.excused ? "Excused" : null,
  );

  function keydown(event: KeyboardEvent): void {
    const index = ASSIGNMENT_STATUSES.indexOf(item.status);
    if (event.key === "Enter") onopen();
    else if (event.key === "s" || event.key === "S") menuOpen = true;
    else if (/^[1-4]$/.test(event.key)) onmove(ASSIGNMENT_STATUSES[Number(event.key) - 1]!);
    else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "ArrowRight")
      onmove(ASSIGNMENT_STATUSES[Math.min(index + 1, 3)]!);
    else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "ArrowLeft")
      onmove(ASSIGNMENT_STATUSES[Math.max(index - 1, 0)]!);
    else return;
    event.preventDefault();
  }

  const menuItem =
    "flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover";
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <div
        {...props}
        role="button"
        tabindex="0"
        aria-label="{item.title}, {STATUS_COLUMN[item.status]}"
        data-card={item.id}
        draggable="true"
        class="group flex min-w-0 cursor-default flex-col gap-1.5 rounded-lg border border-line-subtle bg-surface px-3 py-2.5 shadow-card transition-[opacity,box-shadow,transform] duration-150 outline-none hover:-translate-y-px hover:shadow-1 focus-visible:border-line-strong dark:bg-raised {dragging
          ? 'opacity-40'
          : ''}"
        onclick={onopen}
        onkeydown={keydown}
        {ondragstart}
        {ondragend}
      >
        <div class="flex min-w-0 items-start gap-2">
          <span class="pt-0.5">
            <StatusMenu
              status={item.status}
              title={item.title}
              onchange={onmove}
              bind:open={menuOpen}
            />
          </span>
          <span
            class="min-w-0 flex-1 text-[13.5px] leading-5 font-medium break-words {item.status ===
            'done'
              ? 'text-text-3'
              : 'text-text'}"
            dir="auto">{item.title}</span
          >
        </div>
        <div class="flex min-w-0 items-center gap-1.5 pl-6 text-[12px] text-text-3">
          {#if course}
            <span
              class="size-2 shrink-0 rounded-full"
              style:background={PENCIL[course.color]}
            ></span>
            <span class="min-w-0 truncate" dir="auto">{course.name}</span>
            <span class="shrink-0 text-text-4">·</span>
          {/if}
          <span class="shrink-0">{KIND_LABEL[item.kind]}</span>
        </div>
        {#if (handedIn ? item.grade.score !== null : item.dueAt) || item.steps.length || flag}
          <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 pl-6 text-[12px] tabular-nums">
            {#if handedIn && item.grade.score !== null}
              <span class="font-medium text-text-2"
                >{item.grade.score}{item.grade.max !== null ? `/${item.grade.max}` : ""}</span
              >
            {:else if !handedIn && item.dueAt}
              <span class={badges.overdue ? "font-medium text-danger" : "text-text-2"}
                >{relativeDue(item.dueAt, item.dueHasTime)}</span
              >
            {/if}
            {#if item.steps.length}
              <span class="inline-flex items-center gap-1 text-text-3">
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" fill="none" stroke="var(--line-strong)" stroke-width="2" />
                  <circle
                    cx="8"
                    cy="8"
                    r="6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-dasharray="{(steps / item.steps.length) * 37.7} 37.7"
                    transform="rotate(-90 8 8)"
                  />
                </svg>
                {steps}/{item.steps.length}
              </span>
            {/if}
            {#if flag}<span class="text-text-3">{flag}</span>{/if}
          </div>
        {/if}
      </div>
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content
      class="z-50 min-w-[190px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
    >
      <ContextMenu.Item class={menuItem} onSelect={onopen}>Open</ContextMenu.Item>
      <ContextMenu.Separator class="my-1.5 h-px bg-line-subtle" />
      {#each ASSIGNMENT_STATUSES as status, index (status)}
        <ContextMenu.Item
          class={menuItem}
          disabled={status === item.status}
          onSelect={() => onmove(status)}
        >
          <StatusIcon {status} />
          <span class="flex-1">Move to {STATUS_COLUMN[status]}</span>
          <span class="font-mono text-[11px] text-text-4">{index + 1}</span>
        </ContextMenu.Item>
      {/each}
      <ContextMenu.Separator class="my-1.5 h-px bg-line-subtle" />
      <ContextMenu.Item
        class="{menuItem} text-danger"
        onSelect={() => folio.trashAssignment(item.id)}>Move to Trash</ContextMenu.Item
      >
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
