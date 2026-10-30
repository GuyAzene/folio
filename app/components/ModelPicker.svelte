<script lang="ts">
  import {
    Check,
    ChevronDown,
    ChevronRight,
    KeyRound,
    Settings2,
  } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import type { ModelView } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";
  import ProviderMark from "./ProviderMark.svelte";

  /**
   * The model pill in the composer, grouped by connection: the ChatGPT plan, then each service
   * the student added a key for. A new chat uses the student's choice; a saved chat keeps the
   * model it started with, so picking another one starts a new chat. Earlier models wait under
   * "Older models", and OpenRouter's under the lab that made them.
   */
  let {
    chatModel = null,
    onnewchat,
  }: {
    /** The open chat's model reference, or null for a chat that has not started. */
    chatModel?: string | null;
    onnewchat?: () => void;
  } = $props();

  const current = $derived(chatModel ?? folio.modelChoice);
  const connection = $derived(folio.connectionFor(current));
  // The plan shows before it is connected; a key's models only once its key is in.
  const shown = $derived(
    folio.models.groups.filter(
      (group) => group.connection === "chatgpt" || group.connected,
    ),
  );
  const keyless = $derived(
    folio.models.connections.some(
      (each) => each.kind === "key" && !each.connected,
    ),
  );

  /** OpenRouter's models by the lab that made them, in the order they were picked. */
  function byLab(models: ModelView[]): [string, ModelView[]][] {
    const labs = new Map<string, ModelView[]>();
    for (const model of models)
      labs.set(model.lab ?? "", [...(labs.get(model.lab ?? "") ?? []), model]);
    return [...labs];
  }

  function pick(ref: string): void {
    folio.setModelChoice(ref);
    if (chatModel && ref !== chatModel) onnewchat?.();
  }

  const row =
    "flex h-8 cursor-default items-center gap-2 rounded-md pr-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover";
  const submenu =
    "z-50 w-[264px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none";
</script>

{#snippet modelItem(model: ModelView, indent = true)}
  <DropdownMenu.Item
    class="{row} {indent ? 'pl-[34px]' : 'pl-2.5'}"
    onSelect={() => pick(model.ref)}
  >
    <span class="flex-1 truncate">{model.name}</span>
    {#if !model.images}
      <span
        class="shrink-0 text-[11px] text-text-3"
        title="Reads page text only; it can't see slides or images"
        >Text only</span
      >
    {/if}
    <span class="flex w-4 shrink-0 justify-end">
      {#if model.ref === current}
        <Check size={14} strokeWidth={2.25} />
      {/if}
    </span>
  </DropdownMenu.Item>
{/snippet}

{#snippet more(label: string, models: ModelView[], mark?: string)}
  <DropdownMenu.Sub>
    <DropdownMenu.SubTrigger
      class="{row} pl-[34px] text-text-2 data-[highlighted]:text-text data-[state=open]:bg-hover"
    >
      {#if mark}
        <span class="-ml-[22px] flex w-[14px] justify-center"
          ><ProviderMark provider={mark} name={label} size={12} /></span
        >
      {/if}
      <span class="flex-1 truncate">{label}</span>
      {#if models.some((model) => model.ref === current)}
        <Check size={13} strokeWidth={2.25} class="shrink-0 text-text-3" />
      {:else}
        <span class="text-[11px] text-text-3">{models.length}</span>
      {/if}
      <ChevronRight size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
    </DropdownMenu.SubTrigger>
    <DropdownMenu.SubContent sideOffset={6} class={submenu}>
      {#each models as model (model.ref)}
        {@render modelItem(model, false)}
      {/each}
    </DropdownMenu.SubContent>
  </DropdownMenu.Sub>
{/snippet}

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="inline-flex h-8 max-w-[220px] min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-hover hover:text-text data-[state=open]:bg-hover data-[state=open]:text-text"
    aria-label="Choose a model"
  >
    <ProviderMark
      provider={connection?.id ?? "chatgpt"}
      name={connection?.name ?? ""}
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
      class="z-50 max-h-[min(560px,var(--bits-floating-available-height))] w-[288px] animate-[folio-scale_140ms_var(--ease-out-quint)] overflow-y-auto rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
    >
      {#if chatModel}
        <p class="px-2.5 pt-1.5 pb-2 text-[12px] leading-[18px] text-text-3">
          This chat keeps {folio.modelName(chatModel)}. Picking another model
          starts a new chat with it.
        </p>
      {/if}
      {#each shown as group, index (group.connection)}
        {#if index > 0}
          <DropdownMenu.Separator class="my-1.5 h-px bg-line-subtle" />
        {/if}
        <DropdownMenu.Group>
          <DropdownMenu.GroupHeading
            class="flex h-8 items-center gap-2 px-2.5 text-[12px] font-medium text-text-2"
          >
            <ProviderMark
              provider={group.connection}
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
              {:else}
                Not connected
              {/if}
            </span>
          </DropdownMenu.GroupHeading>
          {#if group.connection === "openrouter"}
            {#each byLab(group.models) as [lab, models] (lab)}
              {@render more(lab, models, lab)}
            {:else}
              <DropdownMenu.Item
                class="{row} pl-[34px] text-text-2 data-[highlighted]:text-text"
                onSelect={() => folio.openSettings("models")}
              >
                Choose OpenRouter models…
              </DropdownMenu.Item>
            {/each}
          {:else}
            {#each group.models.filter((model) => !model.older) as model (model.ref)}
              {@render modelItem(model)}
            {/each}
            {@const older = group.models.filter((model) => model.older)}
            {#if older.length}
              {@render more("Older models", older)}
            {/if}
          {/if}
        </DropdownMenu.Group>
      {/each}
      <DropdownMenu.Separator class="my-1.5 h-px bg-line-subtle" />
      {#if keyless}
        <DropdownMenu.Item
          class="{row} gap-2 pl-2.5 text-text-2 data-[highlighted]:text-text"
          onSelect={() => folio.openSettings("connections")}
        >
          <KeyRound size={14} strokeWidth={1.75} />
          Add an API key…
        </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Item
        class="{row} gap-2 pl-2.5 text-text-2 data-[highlighted]:text-text"
        onSelect={() => folio.openSettings("models")}
      >
        <Settings2 size={14} strokeWidth={1.75} />
        Models and connections
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
