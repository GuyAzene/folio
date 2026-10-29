<script lang="ts">
  import { Check, ChevronDown, ChevronRight, Settings2 } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import type { ModelView } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";
  import ProviderMark from "./ProviderMark.svelte";

  /**
   * The model pill in the composer. A new chat uses the student's choice; a saved chat keeps
   * the model it started with, so picking another one starts a new chat. Earlier models wait
   * under "Older models".
   */
  let {
    chatModelId = null,
    onnewchat,
  }: {
    /** The open chat's model, or null for a chat that has not started. */
    chatModelId?: string | null;
    onnewchat?: () => void;
  } = $props();

  const current = $derived(chatModelId ?? folio.modelChoice);
  const subscription = $derived(
    folio.subscriptions.find((candidate) =>
      candidate.models.some((model) => model.id === current),
    ),
  );

  function pick(id: string): void {
    folio.setModelChoice(id);
    if (chatModelId && id !== chatModelId) onnewchat?.();
  }
</script>

{#snippet modelItem(model: ModelView, indent = true)}
  <DropdownMenu.Item
    class="flex h-8 cursor-default items-center gap-2 rounded-md pr-2.5 {indent
      ? 'pl-[34px]'
      : 'pl-2.5'} text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover"
    onSelect={() => pick(model.id)}
  >
    <span class="flex-1 truncate">{model.name}</span>
    {#if model.id === folio.defaultModel}
      <span class="shrink-0 text-[11px] text-text-3">Default</span>
    {/if}
    <span class="flex w-4 shrink-0 justify-end">
      {#if model.id === current}
        <Check size={14} strokeWidth={2.25} />
      {/if}
    </span>
  </DropdownMenu.Item>
{/snippet}

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="inline-flex h-8 max-w-[220px] min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-hover hover:text-text data-[state=open]:bg-hover data-[state=open]:text-text"
    aria-label="Choose a model"
  >
    <ProviderMark
      provider={subscription?.provider ?? "openai"}
      name={subscription?.name ?? ""}
      size={13}
    />
    <span class="truncate">{folio.modelName(current)}</span>
    <ChevronDown size={13} strokeWidth={2} class="shrink-0 text-text-3" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="top"
      align="end"
      sideOffset={8}
      class="z-50 w-[288px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
    >
      {#if chatModelId}
        <p class="px-2.5 pt-1.5 pb-2 text-[12px] leading-[18px] text-text-3">
          This chat keeps {folio.modelName(chatModelId)}. Picking another model
          starts a new chat with it.
        </p>
      {/if}
      {#each folio.subscriptions as group, index (group.provider)}
        {#if index > 0}
          <DropdownMenu.Separator class="my-1.5 h-px bg-line-subtle" />
        {/if}
        <DropdownMenu.Group>
          <DropdownMenu.GroupHeading
            class="flex h-8 items-center gap-2 px-2.5 text-[12px] font-medium text-text-2"
          >
            <ProviderMark
              provider={group.provider}
              name={group.name}
              size={14}
            />
            <span class="flex-1">{group.name}</span>
            <span
              class="inline-flex items-center gap-1.5 text-[11px] font-normal text-text-3"
            >
              {#if group.connected}
                <span class="size-1.5 rounded-full bg-success"></span>
                Connected
              {:else if group.available}
                Not connected
              {:else}
                Not available yet
              {/if}
            </span>
          </DropdownMenu.GroupHeading>
          {#each group.models.filter((model) => !model.older) as model (model.id)}
            {@render modelItem(model)}
          {/each}
          {@const older = group.models.filter((model) => model.older)}
          {#if older.length}
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger
                class="flex h-8 cursor-default items-center gap-2 rounded-md pr-2.5 pl-[34px] text-[13px] text-text-2 outline-none select-none data-[highlighted]:bg-hover data-[highlighted]:text-text data-[state=open]:bg-hover"
              >
                <span class="flex-1 truncate">Older models</span>
                <span class="text-[11px] text-text-3">{older.length}</span>
                <ChevronRight
                  size={14}
                  strokeWidth={1.75}
                  class="shrink-0 text-text-3"
                />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent
                sideOffset={6}
                class="z-50 w-[220px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
              >
                {#each older as model (model.id)}
                  {@render modelItem(model, false)}
                {/each}
              </DropdownMenu.SubContent>
            </DropdownMenu.Sub>
          {/if}
        </DropdownMenu.Group>
      {/each}
      <DropdownMenu.Separator class="my-1.5 h-px bg-line-subtle" />
      <DropdownMenu.Item
        class="flex h-8 cursor-default items-center gap-2 rounded-md px-2.5 text-[13px] text-text-2 outline-none select-none data-[highlighted]:bg-hover data-[highlighted]:text-text"
        onSelect={() => (folio.settingsOpen = true)}
      >
        <Settings2 size={14} strokeWidth={1.75} />
        Manage subscriptions
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
