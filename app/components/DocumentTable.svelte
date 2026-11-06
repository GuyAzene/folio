<script lang="ts">
  import {
    CalendarDays,
    Check,
    Columns2,
    Ellipsis,
    FileText,
    Hash,
    PencilLine,
    RotateCw,
    Tag,
    Trash2,
    WandSparkles,
  } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import type { AssignmentView, DocumentView } from "../../src/desktop/api.ts";
  import { studied } from "../../src/library/categories.ts";
  import { relativeDue, ROLE_DOT } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import { assignmentBadges } from "../../src/library/assignments.ts";
  import AssignmentSheet from "./AssignmentSheet.svelte";
  import InlineName from "./InlineName.svelte";

  /**
   * A section of files as quiet rows: the name, then what matters about it in plain text (its
   * category where the section doesn't say it, when it's due, its pages). Renaming, numbering,
   * changing the category and the rest live in the row's ··· menu.
   */
  let {
    documents,
    title = null,
    showCategory = false,
    showDue = false,
    showStudy = false,
    empty = "Nothing here yet.",
  }: {
    documents: DocumentView[];
    /** The section's name, shown with its count above the rows. */
    title?: string | null;
    /** The category as text, where the section isn't one category. */
    showCategory?: boolean;
    showDue?: boolean;
    /** Lectures and recitations show while Folio is studying them. */
    showStudy?: boolean;
    empty?: string;
  } = $props();

  const menuItem =
    "flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover data-[disabled]:opacity-50";
  const menu =
    "z-50 min-w-[210px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none";

  /** The file whose name, or number, is being edited in place. */
  let renaming = $state<string | null>(null);
  let numbering = $state<string | null>(null);
  /** The assignment open in full, to change its due date and the rest. */
  let details = $state<AssignmentView | null>(null);

  function renumber(document: DocumentView, value: string): void {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 9999) {
      folio.error = "Write a whole number, such as 3.";
      return;
    }
    if (number !== document.number) void folio.updateDocument(document, { number });
  }
</script>

{#if documents.length}
  <section class="flex flex-col">
    {#if title}
      <h2 class="flex h-8 items-center gap-2 text-[13px] font-medium text-text-2" dir="auto">
        {title}<span class="font-normal text-text-4 tabular-nums">{documents.length}</span>
      </h2>
    {/if}
    <div class="-mx-2 flex flex-col">
      {#each documents as document (document.id)}
        {@const category = folio.categoryOf(document)}
        {@const work = showDue ? folio.assignmentFor(document.id) : undefined}
        <div
          role="button"
          tabindex="0"
          class="group flex h-10 cursor-default items-center gap-3 rounded-md px-2 transition-colors hover:bg-hover"
          onclick={(event) =>
            renaming !== document.id &&
            numbering !== document.id &&
            folio.openDocument(document.id, 1, {
              newTab: event.metaKey || event.ctrlKey,
              beside: event.altKey,
            })}
          onkeydown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter") folio.openDocument(document.id);
            else if (event.key === "F2") renaming = document.id;
          }}
        >
          <FileText size={15} strokeWidth={1.75} class="shrink-0 text-text-3" />
          <div class="flex min-w-0 flex-1 items-center gap-2.5">
            <InlineName
              value={document.title}
              bind:editing={
                () => renaming === document.id,
                (editing) => (renaming = editing ? document.id : null)
              }
              label="Rename {document.title}"
              class="text-text"
              onsave={(title) => folio.updateDocument(document, { title })}
            />
            {#if showStudy && studied(document) && folio.studying(document.id)}
              <span class="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-text-3">
                <span class="size-1.5 animate-pulse rounded-full bg-highlight"></span>Studying
              </span>
            {/if}
          </div>
          {#if numbering === document.id}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="flex w-[56px] shrink-0" onclick={(event) => event.stopPropagation()}>
              <InlineName
                value={String(document.number ?? "")}
                bind:editing={
                  () => numbering === document.id,
                  (editing) => (numbering = editing ? document.id : null)
                }
                max={4}
                label="Number of {document.title}"
                class="w-[56px] flex-none tabular-nums"
                onsave={(value) => renumber(document, value)}
              />
            </div>
          {/if}
          {#if showCategory}
            <span
              class="flex w-[120px] shrink-0 items-center gap-1.5 truncate text-[12.5px] text-text-3 max-sm:hidden"
              dir="auto"
            >
              <span class="size-1.5 shrink-0 rounded-full" style:background={ROLE_DOT[category.kind]}
              ></span>
              <span class="truncate">{category.name}</span>
            </span>
          {/if}
          {#if showDue}
            <span
              class="w-[96px] shrink-0 truncate text-right text-[12.5px] tabular-nums {work &&
              assignmentBadges(work).overdue
                ? 'font-medium text-danger'
                : 'text-text-3'}"
              >{work?.dueAt ? relativeDue(work.dueAt, work.dueHasTime) : ""}</span
            >
          {/if}
          <span class="w-[48px] shrink-0 text-right text-[12.5px] text-text-3 tabular-nums"
            >{document.pages ? `${document.pages} p.` : ""}</span
          >
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="shrink-0" onclick={(event) => event.stopPropagation()}>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="flex size-7 items-center justify-center rounded-md text-text-4 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-press hover:text-text focus-visible:opacity-100 data-[state=open]:bg-press data-[state=open]:text-text data-[state=open]:opacity-100"
                aria-label="More for {document.title}"
              >
                <Ellipsis size={15} strokeWidth={1.75} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  side="bottom"
                  align="end"
                  sideOffset={4}
                  onCloseAutoFocus={(event) =>
                    (renaming === document.id || numbering === document.id) &&
                    event.preventDefault()}
                  class={menu}
                >
                  <DropdownMenu.Item
                    class={menuItem}
                    onSelect={() => folio.openDocument(document.id, 1, { beside: true })}
                  >
                    <Columns2 size={14} strokeWidth={1.75} class="text-text-3" />
                    Open beside
                    <span class="ml-auto pl-3 text-[11px] text-text-4">{folio.keys("⌥-click")}</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator class="my-1.5 h-px bg-line-subtle" />
                  <DropdownMenu.Item class={menuItem} onSelect={() => (renaming = document.id)}>
                    <PencilLine size={14} strokeWidth={1.75} class="text-text-3" />
                    Rename
                  </DropdownMenu.Item>
                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger class="{menuItem} data-[state=open]:bg-hover">
                      <Tag size={14} strokeWidth={1.75} class="text-text-3" />
                      Category
                      <span class="ml-auto truncate pl-3 text-[12px] text-text-3" dir="auto"
                        >{category.name}</span
                      >
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.SubContent class={menu} sideOffset={6}>
                      {#each folio.categories as option (option.id)}
                        <DropdownMenu.Item
                          class={menuItem}
                          onSelect={() =>
                            option.id !== category.id &&
                            folio.updateDocument(document, { category: option.id })}
                        >
                          <span
                            class="size-1.5 shrink-0 rounded-full"
                            style:background={ROLE_DOT[option.kind]}
                          ></span>
                          <span class="min-w-0 flex-1 truncate" dir="auto">{option.name}</span>
                          {#if option.id === category.id}<Check
                              size={14}
                              strokeWidth={2}
                              class="shrink-0 text-text-2"
                            />{/if}
                        </DropdownMenu.Item>
                      {/each}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Sub>
                  <DropdownMenu.Item class={menuItem} onSelect={() => (numbering = document.id)}>
                    <Hash size={14} strokeWidth={1.75} class="text-text-3" />
                    Number
                    <span class="ml-auto pl-3 text-[12px] text-text-3 tabular-nums"
                      >{document.number ?? "—"}</span
                    >
                  </DropdownMenu.Item>
                  {#if document.named === "own" && folio.pattern(category)}
                    <DropdownMenu.Item
                      class={menuItem}
                      onSelect={() => folio.applyNaming({ documentIds: [document.id] })}
                    >
                      <WandSparkles size={14} strokeWidth={1.75} class="text-text-3" />
                      Name by pattern
                    </DropdownMenu.Item>
                  {/if}
                  {#if work}
                    <DropdownMenu.Item class={menuItem} onSelect={() => (details = work)}>
                      <CalendarDays size={14} strokeWidth={1.75} class="text-text-3" />
                      Due date and details
                    </DropdownMenu.Item>
                  {/if}
                  {#if studied(document)}
                    <DropdownMenu.Item
                      class={menuItem}
                      disabled={folio.studying(document.id)}
                      onSelect={() => folio.study(document.courseId, [document.id])}
                    >
                      <RotateCw size={14} strokeWidth={1.75} class="text-text-3" />
                      {folio.studied(document.id) ? "Study again" : "Study now"}
                    </DropdownMenu.Item>
                  {/if}
                  <DropdownMenu.Separator class="my-1.5 h-px bg-line-subtle" />
                  <DropdownMenu.Item
                    class="{menuItem} text-danger"
                    onSelect={() => folio.trashDocuments([document.id])}
                  >
                    <Trash2 size={14} strokeWidth={1.75} />
                    Move to Trash
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      {/each}
    </div>
  </section>
{:else if empty}
  <p class="py-10 text-center text-text-3">{empty}</p>
{/if}

{#if details}
  {@const current = folio.assignments.find((item) => item.id === details!.id) ?? details}
  <AssignmentSheet assignment={current} onclose={() => (details = null)} />
{/if}
