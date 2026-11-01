<script lang="ts">
  import {
    ArrowDown,
    ArrowUp,
    ChevronRight,
    Plus,
    Trash2,
    WandSparkles,
  } from "@lucide/svelte";
  import { untrack } from "svelte";
  import type { Rename } from "../../src/library/naming.ts";
  import type { DocumentRole } from "../../src/desktop/api.ts";
  import {
    categoryId,
    KIND_LABEL,
    type Category,
  } from "../../src/library/categories.ts";
  import { ROLE_DOT } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import Select from "./Select.svelte";

  /**
   * The student's categories: what their degree calls its course files, in the order Materials
   * shows them, and what Folio does with each. Saved to config.json as they change.
   */
  let open = $state<string | null>(null);
  let name = $state("");
  let plural = $state("");
  let words = $state("");
  let naming = $state("");
  let libraryNaming = $state("");
  $effect(() => {
    libraryNaming = folio.models.naming ?? "";
  });
  /** Files whose name a pattern would change, refreshed after each change here. */
  let renames = $state<Rename[]>([]);

  async function refreshRenames(): Promise<void> {
    try {
      renames = (await folio.api.renames({})).filter(
        (rename) => rename.next !== rename.title,
      );
    } catch {
      renames = [];
    }
  }
  $effect(() => {
    // Again whenever the categories, the pattern or the files change.
    void [folio.categories, folio.models.naming, folio.documents];
    untrack(() => void refreshRenames());
  });

  /** How many files of a category a pattern would rename. */
  function renamesIn(categoryId: string): number {
    return renames.filter((rename) => {
      const document = folio.document(rename.documentId);
      return document && folio.categoryOf(document).id === categoryId;
    }).length;
  }

  function saveLibraryNaming(): void {
    const pattern = libraryNaming.trim() || null;
    if (pattern !== folio.models.naming) void folio.setNaming(pattern);
  }

  const KINDS: { value: DocumentRole; hint: string }[] = [
    { value: "lecture", hint: "Folio studies them and writes study notes." },
    {
      value: "recitation",
      hint: "Studied, and paired with the lecture of the same number.",
    },
    { value: "assignment", hint: "On the board, with a due date." },
    { value: "solution", hint: "Kept beside the assignment they solve." },
    { value: "asset", hint: "Kept as they are." },
  ];
  const kindOptions = KINDS.map((kind) => ({
    value: kind.value,
    label: KIND_LABEL[kind.value],
    dot: ROLE_DOT[kind.value],
  }));

  const counts = $derived.by(() => {
    const counted = new Map<string, number>();
    for (const document of folio.documents) {
      const { id } = folio.categoryOf(document);
      counted.set(id, (counted.get(id) ?? 0) + 1);
    }
    return counted;
  });

  function expand(category: Category): void {
    if (open === category.id) {
      open = null;
      return;
    }
    open = category.id;
    name = category.name;
    plural = category.plural;
    words = category.match.join(", ");
    naming = category.naming ?? "";
  }

  function save(id: string, patch: Partial<Category>): Promise<boolean> {
    return folio.setCategories(
      folio.categories.map((category) =>
        category.id === id ? { ...category, ...patch } : category,
      ),
    );
  }

  /** Saves the open category's text fields when one of them is left. */
  function saveText(category: Category): void {
    const match = words
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean);
    const patch = {
      name: name.trim() || category.name,
      plural: plural.trim() || category.plural,
      match,
      naming: naming.trim() || null,
    };
    if (
      patch.name === category.name &&
      patch.plural === category.plural &&
      match.join(",") === category.match.join(",") &&
      patch.naming === category.naming
    )
      return;
    void save(category.id, patch);
  }

  function move(index: number, by: number): void {
    const next = [...folio.categories];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    void folio.setCategories(next);
  }

  async function add(): Promise<void> {
    const id = categoryId(
      "New category",
      folio.categories.map((category) => category.id),
    );
    const category: Category = {
      id,
      name: "New category",
      plural: "New category",
      kind: "asset",
      match: [],
      naming: null,
    };
    if (await folio.setCategories([...folio.categories, category]))
      expand(category);
  }

  const field =
    "h-8 w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] outline-none transition-colors placeholder:text-text-4 focus:border-ink dark:bg-sunken";
  const iconButton =
    "inline-flex size-7 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text disabled:pointer-events-none disabled:opacity-40";
</script>

<section class="flex flex-col gap-1.5 pb-4">
  <span class="font-medium">Names</span>
  <span class="text-[12px] text-text-3"
    >New files are named by this pattern, unless their category has its own.
    Leave it empty to keep each file's own name.</span
  >
  <input
    class="{field} mt-1"
    bind:value={libraryNaming}
    maxlength={120}
    placeholder="{'{category}'} {'{n}'}"
    aria-label="Naming pattern"
    onblur={saveLibraryNaming}
    onkeydown={(event) => event.key === "Enter" && saveLibraryNaming()}
  />
  <span class="text-[12px] text-text-3"
    >Fields: {"{category}"}, {"{course}"}, {"{code}"}, {"{term}"}, {"{n}"} (the
    file's number), {"{n:2}"} (01), {"{name}"} (its file name). An empty field
    takes its separator with it.</span
  >
  {#if renames.length}
    <button
      class="mt-1 inline-flex h-8 items-center gap-1.5 self-start rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover dark:bg-raised"
      onclick={() => void folio.applyNaming({})}
    >
      <WandSparkles size={14} strokeWidth={1.75} />
      Rename {renames.length}
      {renames.length === 1 ? "file" : "files"} to match
    </button>
  {/if}
</section>

<div class="h-px bg-line-subtle"></div>

<section class="flex flex-col gap-1 pt-4">
  <span class="font-medium">Categories</span>
  <span class="text-[12px] text-text-3"
    >What your degree calls its course files, in the order Materials shows them.
    New files are sorted by the words in their names.</span
  >
</section>

<div class="mt-3 flex flex-col overflow-hidden rounded-xl border border-line">
  {#each folio.categories as category, index (category.id)}
    {@const count = counts.get(category.id) ?? 0}
    {@const expanded = open === category.id}
    <div class="border-b border-line-subtle last:border-b-0">
      <button
        class="flex h-10 w-full items-center gap-2.5 px-3 text-left hover:bg-hover"
        aria-expanded={expanded}
        onclick={() => expand(category)}
      >
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          class="shrink-0 text-text-3 transition-transform {expanded
            ? 'rotate-90'
            : ''}"
        />
        <span
          class="size-1.5 shrink-0 rounded-[2px]"
          style:background={ROLE_DOT[category.kind]}
        ></span>
        <span class="min-w-0 flex-1 truncate font-medium" dir="auto"
          >{category.plural}</span
        >
        <span class="shrink-0 text-[12px] text-text-3 max-sm:hidden"
          >{KIND_LABEL[category.kind]}</span
        >
        <span class="w-[52px] shrink-0 text-right text-[12px] text-text-3"
          >{count} {count === 1 ? "file" : "files"}</span
        >
      </button>
      {#if expanded}
        <div class="flex flex-col gap-3 border-t border-line-subtle bg-sunken px-4 py-3.5 dark:bg-surface">
          <div class="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <label class="flex min-w-0 flex-col gap-1">
              <span class="text-[12px] font-medium text-text-2">Name</span>
              <input
                class={field}
                bind:value={name}
                maxlength={40}
                dir="auto"
                placeholder="Recitation"
                onblur={() => saveText(category)}
                onkeydown={(event) =>
                  event.key === "Enter" && saveText(category)}
              />
            </label>
            <label class="flex min-w-0 flex-col gap-1">
              <span class="text-[12px] font-medium text-text-2">Plural</span>
              <input
                class={field}
                bind:value={plural}
                maxlength={40}
                dir="auto"
                placeholder="Recitations"
                onblur={() => saveText(category)}
                onkeydown={(event) =>
                  event.key === "Enter" && saveText(category)}
              />
            </label>
          </div>
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-[12px] font-medium text-text-2"
              >Words in file names</span
            >
            <input
              class={field}
              bind:value={words}
              dir="auto"
              placeholder="recitation, rec, R"
              onblur={() => saveText(category)}
              onkeydown={(event) =>
                event.key === "Enter" && saveText(category)}
            />
            <span class="text-[12px] text-text-3"
              >Separated by commas. A word of one or two letters counts before a
              number, like R in R01.</span
            >
          </label>
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-[12px] font-medium text-text-2">Naming</span>
            <input
              class={field}
              bind:value={naming}
              maxlength={120}
              dir="auto"
              placeholder={folio.models.naming ?? "Each file keeps its own name"}
              onblur={() => saveText(category)}
              onkeydown={(event) =>
                event.key === "Enter" && saveText(category)}
            />
            {#if renamesIn(category.id)}
              {@const count = renamesIn(category.id)}
              <button
                class="mt-1 inline-flex h-7 items-center gap-1.5 self-start rounded-md px-2 text-[12px] font-medium text-text-2 hover:bg-hover hover:text-text"
                onclick={() => void folio.applyNaming({ categoryId: category.id })}
              >
                <WandSparkles size={13} strokeWidth={1.75} />
                Rename {count}
                {count === 1 ? "file" : "files"} to match
              </button>
            {/if}
          </label>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="text-[12px] font-medium text-text-2"
                >What Folio does</span
              >
              <span class="text-[12px] text-text-3"
                >{count
                  ? "Fixed while files are in it. Make a new category to do something else."
                  : KINDS.find((kind) => kind.value === category.kind)?.hint}</span
              >
            </div>
            {#if count}
              <span class="text-[13px] text-text-2"
                >{KIND_LABEL[category.kind]}</span
              >
            {:else}
              <Select
                value={category.kind}
                options={kindOptions}
                label="What Folio does with {category.plural}"
                onchange={(kind) =>
                  void save(category.id, { kind: kind as DocumentRole })}
              />
            {/if}
          </div>
          <div class="flex items-center gap-1">
            <button
              class={iconButton}
              aria-label="Move {category.plural} up"
              disabled={index === 0}
              onclick={() => move(index, -1)}
            >
              <ArrowUp size={14} strokeWidth={1.75} />
            </button>
            <button
              class={iconButton}
              aria-label="Move {category.plural} down"
              disabled={index === folio.categories.length - 1}
              onclick={() => move(index, 1)}
            >
              <ArrowDown size={14} strokeWidth={1.75} />
            </button>
            <span class="flex-1"></span>
            <button
              class="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-danger hover:bg-hover disabled:pointer-events-none disabled:opacity-40"
              disabled={!!count || folio.categories.length === 1}
              title={count
                ? "Move its files to another category first"
                : undefined}
              onclick={() =>
                void folio.setCategories(
                  folio.categories.filter((each) => each.id !== category.id),
                )}
            >
              <Trash2 size={13} strokeWidth={1.75} />
              Remove
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/each}
</div>
<button
  class="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 font-medium text-text-2 hover:bg-hover hover:text-text"
  onclick={() => void add()}
>
  <Plus size={14} strokeWidth={1.75} />
  Add category
</button>
