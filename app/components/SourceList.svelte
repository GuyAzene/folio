<script lang="ts">
  import { ChevronDown, FileText } from "@lucide/svelte";
  import type { SourceView } from "../../src/desktop/api.ts";
  import { runLabel, type PageRun } from "../lib/labels.ts";
  import { foldSources, groupSources, readSummary } from "../lib/sources.ts";
  import { folio } from "../lib/state.svelte.ts";
  import { shortTitle } from "../lib/titles.ts";

  /**
   * The pages a reply read, by document. A few show as chips; a long list folds into one line
   * that opens to a line per document. Every page opens with `chatId`'s chat beside it.
   */
  let {
    sources,
    chatId = null,
  }: { sources: SourceView[]; chatId?: string | null } = $props();
  let open = $state(false);

  const groups = $derived(
    groupSources(sources).map((group) => ({
      ...group,
      full: group.title,
      title: shortTitle(
        group.title,
        folio.course(folio.document(group.documentId)?.courseId)?.name,
      ),
    })),
  );
  const folded = $derived(foldSources(groups));

  const pages = (run: PageRun) =>
    `${run.first === run.last ? "Page" : "Pages"} ${runLabel(run)}`;
  const show = (documentId: string, run: PageRun) =>
    folio.openDocument(documentId, run.first, { chatId });
</script>

{#if !folded}
  <div class="flex flex-wrap gap-1.5">
    {#each groups as group (group.documentId)}
      {#each group.runs as run (run.first)}
        <button
          class="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-line-subtle bg-sunken px-2 text-[12px] whitespace-nowrap text-text-2 transition-colors hover:border-line hover:text-text dark:bg-raised"
          title="{group.full} · {pages(run)}"
          onclick={() => show(group.documentId, run)}
        >
          <FileText size={12} strokeWidth={1.75} class="shrink-0" />
          <span class="max-w-[240px] min-w-0 truncate" dir="auto">{group.title}</span>
          <span class="shrink-0">· {pages(run)}</span>
        </button>
      {/each}
    {/each}
  </div>
{:else}
  <div class="flex flex-col">
    <button
      class="-ml-1 flex h-7 w-fit items-center gap-2 rounded-md px-1 text-[13px] text-text-3 hover:text-text-2"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <FileText size={13} strokeWidth={1.75} class="shrink-0" />
      <span dir="auto">{readSummary(groups)}</span>
      <ChevronDown
        size={13}
        strokeWidth={2}
        class="transition-transform {open ? 'rotate-180' : ''}"
      />
    </button>
    {#if open}
      <div class="ml-1 flex flex-col gap-1 border-l border-line py-1 pl-3">
        {#each groups as group (group.documentId)}
          <!-- The title opens the first page read; each number or range opens where it starts. -->
          <p class="text-[13px] leading-5 text-text-3">
            <button
              class="text-text-2 hover:text-text"
              dir="auto"
              title="{group.full} · {pages(group.runs[0]!)}"
              onclick={() => show(group.documentId, group.runs[0]!)}>{group.title}</button
            >
            · {group.pages.length === 1 ? "page" : "pages"}
            {#each group.runs as run, index (run.first)}<button
                class="tabular-nums underline-offset-2 hover:text-text hover:underline"
                title="{group.full} · {pages(run)}"
                aria-label="{group.title}, {pages(run)}"
                onclick={() => show(group.documentId, run)}>{runLabel(run)}</button
              >{index < group.runs.length - 1 ? ", " : ""}{/each}
          </p>
        {/each}
      </div>
    {/if}
  </div>
{/if}
