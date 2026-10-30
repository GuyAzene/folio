<script lang="ts">
  import { ArrowLeft, Check, FileCog, Search } from "@lucide/svelte";
  import {
    IMAGE_ROLES,
    type ModelRole,
    type ModelView,
  } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";
  import ProviderMark from "./ProviderMark.svelte";
  import Select, { type Option } from "./Select.svelte";

  /**
   * Which model does what: the tutor, web search, each step of studying and reading a syllabus.
   * The same choices live in config.json, which the student can also edit by hand; an entry
   * Folio can't use is listed here, and its default applies. Below them, which OpenRouter models
   * the composer offers.
   */
  const ROUTINES: {
    title: string;
    roles: { role: ModelRole; label: string; hint: string }[];
  }[] = [
    {
      title: "Teaching",
      roles: [
        {
          role: "teaching",
          label: "Tutor",
          hint: "New chats start on it; pick another in the composer.",
        },
      ],
    },
    {
      title: "Research",
      roles: [
        {
          role: "research",
          label: "Web search",
          hint: "Searches the web when the tutor needs more than your course.",
        },
      ],
    },
    {
      title: "Studying",
      roles: [
        { role: "planner", label: "Planner", hint: "Outlines a lecture before reading it." },
        { role: "reader", label: "Reader", hint: "Reads every slide." },
        { role: "closeup", label: "Close-up", hint: "Reads the hard parts of a slide again." },
        { role: "writer", label: "Writer", hint: "Writes the study notes." },
        { role: "checker", label: "Checker", hint: "Checks the notes against the slides." },
        { role: "topics", label: "Topics", hint: "Merges topics across lectures." },
      ],
    },
    {
      title: "Library",
      roles: [
        {
          role: "syllabus",
          label: "Syllabus",
          hint: "Fills in a new course from its syllabus.",
        },
      ],
    },
  ];

  /** Models a role may use: those of connected services, each able to do the work. */
  function options(role: ModelRole): Option[] {
    const current = folio.models.roles[role];
    const list: Option[] = [];
    for (const group of folio.models.groups) {
      if (!group.connected) continue;
      for (const model of group.models)
        if (model.images || !IMAGE_ROLES.includes(role))
          list.push({ value: model.ref, label: `${model.name} · ${group.name}` });
    }
    if (current && !list.some((option) => option.value === current)) {
      const connection = folio.connectionFor(current);
      list.unshift({
        value: current,
        label: `${folio.modelName(current)} · ${connection?.name ?? ""}${connection?.connected ? "" : " (not connected)"}`,
      });
    }
    return list;
  }

  /** Focuses a field as it appears; the dialog would otherwise keep focus on its first button. */
  function focusOnShow(node: HTMLInputElement): void {
    requestAnimationFrame(() => node.focus());
  }

  // ── OpenRouter's models ───────────────────────────────────────────────

  let choosing = $state(false);
  let catalog = $state<ModelView[]>([]);
  let query = $state("");
  const chosen = $derived(new Set(folio.models.openrouter));
  const shown = $derived.by(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = catalog.filter((model) =>
      words.every((word) =>
        `${model.lab} ${model.name} ${model.ref}`.toLowerCase().includes(word),
      ),
    );
    const labs = new Map<string, ModelView[]>();
    for (const model of matching)
      labs.set(model.lab ?? "", [...(labs.get(model.lab ?? "") ?? []), model]);
    return [...labs];
  });

  async function choose(): Promise<void> {
    choosing = true;
    if (!catalog.length) catalog = await folio.api.openrouterCatalog();
  }

  function toggle(model: ModelView): void {
    const id = model.ref.slice("openrouter/".length);
    const ids = folio.models.openrouter;
    void folio.setOpenRouterModels(
      ids.includes(id) ? ids.filter((each) => each !== id) : [...ids, id],
    );
  }
</script>

{#if choosing}
  <div class="flex items-center gap-2">
    <button
      class="inline-flex size-7 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
      aria-label="Back to models"
      onclick={() => (choosing = false)}
    >
      <ArrowLeft size={15} strokeWidth={1.75} />
    </button>
    <span class="font-medium">OpenRouter models</span>
    <span class="ml-auto text-[12px] text-text-3"
      >{folio.models.openrouter.length} in the composer</span
    >
  </div>
  <label
    class="mt-3 flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2.5 focus-within:border-line-strong"
  >
    <Search size={14} strokeWidth={1.75} class="shrink-0 text-text-3" />
    <input
      use:focusOnShow
      class="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
      placeholder="Search models or labs"
      aria-label="Search OpenRouter models"
      bind:value={query}
    />
  </label>
  <div class="mt-2 flex flex-col">
    {#each shown as [lab, models] (lab)}
      <div
        class="sticky top-0 z-10 flex h-8 items-center gap-2 bg-raised px-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase"
      >
        <ProviderMark provider={lab} name={lab} size={12} />
        {lab}
      </div>
      {#each models as model (model.ref)}
        {@const on = chosen.has(model.ref.slice("openrouter/".length))}
        <button
          class="flex h-8 items-center gap-2.5 rounded-md px-1 text-left text-[13px] hover:bg-hover"
          role="checkbox"
          aria-checked={on}
          onclick={() => toggle(model)}
        >
          <span
            class="flex size-4 shrink-0 items-center justify-center rounded-[4px] border {on
              ? 'border-ink bg-ink text-on-ink'
              : 'border-line-strong'}"
          >
            {#if on}<Check size={11} strokeWidth={3} />{/if}
          </span>
          <span class="min-w-0 flex-1 truncate">{model.name}</span>
          {#if !model.images}
            <span class="shrink-0 text-[11px] text-text-3">Text only</span>
          {/if}
        </button>
      {/each}
    {:else}
      <p class="py-6 text-center text-[13px] text-text-3">
        {catalog.length ? "No model matches." : "Loading OpenRouter's models…"}
      </p>
    {/each}
  </div>
{:else}
  {#if folio.models.problems.length}
    <div
      class="mb-4 flex flex-col gap-1 rounded-lg border border-line-subtle bg-sunken px-3.5 py-2.5 text-[12px] text-text-2 dark:bg-surface"
      role="status"
    >
      <span class="font-medium text-text"
        >Folio couldn't use some of config.json</span
      >
      {#each folio.models.problems as problem (problem)}
        <span>{problem}</span>
      {/each}
      <span class="text-text-3">Each of those uses its default until it's fixed.</span>
    </div>
  {/if}
  {#each ROUTINES as routine, index (routine.title)}
    {#if index > 0}<div class="my-3 h-px bg-line-subtle"></div>{/if}
    <section class="flex flex-col gap-2.5">
      <span
        class="text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase"
        >{routine.title}</span
      >
      {#each routine.roles as { role, label, hint } (role)}
        <div
          class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
        >
          <div class="flex min-w-0 flex-col gap-0.5">
            <span>{label}</span>
            <span class="text-[12px] text-text-3">{hint}</span>
          </div>
          <div class="flex shrink-0 sm:w-[248px] sm:justify-end">
            <Select
              value={folio.models.roles[role] ?? ""}
              options={options(role)}
              label="{label} model"
              onchange={(ref) => void folio.setRoleModel(role, ref)}
            />
          </div>
        </div>
      {/each}
    </section>
  {/each}
  <div class="my-3 h-px bg-line-subtle"></div>
  <section class="flex items-center justify-between gap-4">
    <div class="flex min-w-0 flex-col gap-0.5">
      <span>OpenRouter models</span>
      <span class="text-[12px] text-text-3"
        >{folio.models.openrouter.length} in the composer, grouped by lab.</span
      >
    </div>
    <button
      class="h-8 shrink-0 rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover"
      onclick={() => void choose()}>Choose…</button
    >
  </section>
  <div class="my-3 h-px bg-line-subtle"></div>
  <section class="flex items-center justify-between gap-4">
    <div class="flex min-w-0 flex-col gap-0.5">
      <span>config.json</span>
      <span class="text-[12px] text-text-3"
        >The same choices as a file you can edit or copy. It never holds your keys.</span
      >
    </div>
    <button
      class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover"
      onclick={() => void folio.api.revealConfig()}
    >
      <FileCog size={14} strokeWidth={1.75} />
      Show in Finder
    </button>
  </section>
{/if}
