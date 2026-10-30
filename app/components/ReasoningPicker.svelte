<script lang="ts">
  import { Check, ChevronDown, Gauge, Zap } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import {
    DEFAULT_THINKING,
    THINKING_LEVELS,
    type Thinking,
  } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * The reasoning pill beside the model pill: how long the tutor thinks, and whether it answers
   * on the faster tier. Both are one choice for every chat and apply from the next question; the
   * faster tier is OpenAI's, so it shows only for OpenAI models.
   */
  let { fastAvailable = true }: { fastAvailable?: boolean } = $props();
  const fast = $derived(fastAvailable && folio.fast);
  const NAMES: Record<Thinking, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  };

  const item =
    "flex min-h-8 cursor-default items-center gap-2 rounded-md px-2.5 py-1 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover";
  const heading =
    "px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase";
</script>

{#snippet choice(
  label: string,
  chosen: boolean,
  isDefault: boolean,
  onSelect: () => void,
  hint?: string,
)}
  <DropdownMenu.Item class={item} closeOnSelect={false} {onSelect}>
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="truncate">{label}</span>
      {#if hint}<span class="text-[11px] leading-4 text-text-3"
          >{hint}</span
        >{/if}
    </span>
    {#if isDefault}
      <span class="shrink-0 text-[11px] text-text-3">Default</span>
    {/if}
    <span class="flex w-4 shrink-0 justify-end">
      {#if chosen}<Check size={14} strokeWidth={2.25} />{/if}
    </span>
  </DropdownMenu.Item>
{/snippet}

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-hover hover:text-text data-[state=open]:bg-hover data-[state=open]:text-text"
    aria-label="Reasoning: {NAMES[folio.thinking]}{fast ? ', fast' : ''}"
  >
    <Gauge size={14} strokeWidth={1.75} class="shrink-0" />
    {NAMES[folio.thinking]}
    {#if fast}
      <Zap size={12} strokeWidth={2} class="shrink-0 text-highlight" />
    {/if}
    <ChevronDown size={13} strokeWidth={2} class="shrink-0 text-text-3" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="top"
      align="end"
      sideOffset={8}
      class="z-50 w-[248px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
    >
      <DropdownMenu.Group>
        <DropdownMenu.GroupHeading class={heading}
          >Reasoning</DropdownMenu.GroupHeading
        >
        {#each THINKING_LEVELS as level (level)}
          {@render choice(
            NAMES[level],
            level === folio.thinking,
            level === DEFAULT_THINKING,
            () => folio.setThinking(level),
          )}
        {/each}
      </DropdownMenu.Group>
      {#if fastAvailable}
      <DropdownMenu.Separator class="my-1.5 h-px bg-line-subtle" />
      <DropdownMenu.Group>
        <DropdownMenu.GroupHeading class={heading}
          >Speed</DropdownMenu.GroupHeading
        >
        {@render choice("Standard", !folio.fast, true, () =>
          folio.setFast(false),
        )}
        {@render choice(
          "Fast",
          folio.fast,
          false,
          () => folio.setFast(true),
          "Faster replies, costs more",
        )}
      </DropdownMenu.Group>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
