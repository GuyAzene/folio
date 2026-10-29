<script lang="ts">
  import { Tooltip } from "bits-ui";
  import type { Snippet } from "svelte";

  let {
    label,
    shortcut,
    onclick,
    disabled = false,
    class: className = "",
    children,
  }: {
    label: string;
    shortcut?: string;
    onclick?: () => void;
    disabled?: boolean;
    class?: string;
    children: Snippet;
  } = $props();
</script>

<Tooltip.Root delayDuration={400}>
  <Tooltip.Trigger
    {disabled}
    {onclick}
    aria-label={label}
    class="no-drag inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-3 transition-colors duration-150 hover:bg-hover hover:text-text active:bg-press disabled:pointer-events-none disabled:opacity-40 {className}"
  >
    {@render children()}
  </Tooltip.Trigger>
  <Tooltip.Portal>
    <Tooltip.Content
      sideOffset={6}
      class="z-50 flex animate-[folio-fade_120ms_ease-out] items-center gap-2 rounded-md bg-ink px-2 py-1 text-[12px] font-medium text-on-ink shadow-2"
    >
      {label}
      {#if shortcut}<span class="font-mono text-[11px] opacity-60"
          >{shortcut}</span
        >{/if}
    </Tooltip.Content>
  </Tooltip.Portal>
</Tooltip.Root>
