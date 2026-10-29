<script lang="ts">
  import { Check } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import {
    ASSIGNMENT_STATUSES,
    type AssignmentStatus,
  } from "../../src/library/assignments.ts";
  import { STATUS_COLUMN } from "../lib/labels.ts";
  import StatusIcon from "./StatusIcon.svelte";

  /**
   * The status icon as the control that changes it: a click (or S on a focused card) opens the
   * four statuses, each with its number key. This replaces a separate status dropdown.
   */
  let {
    status,
    title,
    onchange,
    open = $bindable(false),
  }: {
    status: AssignmentStatus;
    title: string;
    onchange: (status: AssignmentStatus) => void;
    open?: boolean;
  } = $props();
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger
    class="-m-1 flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-hover data-[state=open]:bg-hover"
    aria-label="Status: {STATUS_COLUMN[status]}. Change the status of {title}"
    onclick={(event) => event.stopPropagation()}
  >
    <StatusIcon {status} />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      align="start"
      sideOffset={6}
      class="z-50 min-w-[180px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
      onkeydown={(event) => {
        const index = Number(event.key) - 1;
        const chosen = ASSIGNMENT_STATUSES[index];
        if (chosen) {
          event.preventDefault();
          onchange(chosen);
          open = false;
        }
      }}
    >
      {#each ASSIGNMENT_STATUSES as option, index (option)}
        <DropdownMenu.Item
          class="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover"
          onSelect={() => onchange(option)}
        >
          <StatusIcon status={option} />
          <span class="flex-1">{STATUS_COLUMN[option]}</span>
          {#if option === status}<Check size={13} strokeWidth={2.25} />{/if}
          <span class="w-3 text-right font-mono text-[11px] text-text-4">{index + 1}</span>
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
