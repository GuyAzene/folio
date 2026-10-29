<script lang="ts" module>
  export interface Option {
    value: string;
    label: string;
    /** A colour dot before the label, such as a document role's. */
    dot?: string;
  }
</script>

<script lang="ts">
  import { Check, ChevronDown } from "@lucide/svelte";
  import { Select } from "bits-ui";

  /**
   * Folio's one control for picking a value: a pill that opens a menu styled like every other
   * menu in the app. A "chip" sits inside a table row; a "field" stands in a toolbar.
   */
  let {
    value,
    options,
    onchange,
    label,
    variant = "field",
  }: {
    value: string;
    options: Option[];
    onchange: (value: string) => void;
    /** What the control chooses, for assistive technology. */
    label: string;
    variant?: "chip" | "field";
  } = $props();

  const current = $derived(options.find((option) => option.value === value));
  const items = $derived(
    options.map((option) => ({ value: option.value, label: option.label })),
  );
</script>

{#snippet dot(color: string)}
  <span class="size-1.5 shrink-0 rounded-[2px]" style:background={color}></span>
{/snippet}

<Select.Root
  type="single"
  {value}
  {items}
  onValueChange={(next) => {
    if (next && next !== value) onchange(next);
  }}
>
  <Select.Trigger
    aria-label={label}
    class="inline-flex max-w-full min-w-0 items-center gap-1.5 whitespace-nowrap transition-colors outline-none focus-visible:border-line-strong data-[state=open]:border-line-strong {variant ===
    'chip'
      ? 'h-6 rounded-md border border-line-subtle bg-sunken px-2 text-[12px] font-medium text-text-2 hover:border-line dark:bg-raised'
      : 'h-8 rounded-md border border-line-subtle bg-surface px-2.5 text-text-2 shadow-1 hover:border-line dark:bg-raised'}"
  >
    {#if current?.dot}{@render dot(current.dot)}{/if}
    <span class="truncate">{current?.label ?? ""}</span>
    <ChevronDown
      size={variant === "chip" ? 12 : 13}
      strokeWidth={2}
      class="shrink-0 text-text-3"
    />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      sideOffset={6}
      class="z-50 max-h-[min(320px,var(--bits-floating-available-height))] min-w-[max(160px,var(--bits-floating-anchor-width))] animate-[folio-scale_140ms_var(--ease-out-quint)] overflow-y-auto rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
    >
      <Select.Viewport>
        {#each options as option (option.value)}
          <Select.Item
            value={option.value}
            label={option.label}
            class="flex h-8 cursor-default items-center gap-2 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover"
          >
            {#snippet children({ selected })}
              {#if option.dot}{@render dot(option.dot)}{/if}
              <span class="min-w-0 flex-1 truncate" dir="auto"
                >{option.label}</span
              >
              <span class="flex w-4 shrink-0 justify-end">
                {#if selected}<Check size={14} strokeWidth={2.25} />{/if}
              </span>
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>
