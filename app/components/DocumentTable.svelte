<script lang="ts">
  import {
    Ellipsis,
    FileText,
    Lock,
    PencilLine,
    RotateCw,
    Trash2,
    WandSparkles,
  } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import type { DocumentView } from "../../src/desktop/api.ts";
  import { studied } from "../../src/library/categories.ts";
  import { formatDate, ROLE_DOT } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import CourseTile from "./CourseTile.svelte";
  import { assignmentBadges } from "../../src/library/assignments.ts";
  import DatePicker from "./DatePicker.svelte";
  import InlineName from "./InlineName.svelte";
  import Select from "./Select.svelte";

  let {
    documents,
    title = null,
    showCourse = false,
    showDue = false,
    showStudy = false,
    showNumber = false,
    empty = "Nothing here yet.",
  }: {
    documents: DocumentView[];
    /** A section's name, shown with its count where the Name column heading would be. */
    title?: string | null;
    showCourse?: boolean;
    showDue?: boolean;
    /** Lectures and recitations show whether Folio has studied them or is studying them. */
    showStudy?: boolean;
    /** Each file's number in its category, which a naming pattern uses; it can be edited. */
    showNumber?: boolean;
    empty?: string;
  } = $props();

  const menuItem =
    "flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover data-[disabled]:opacity-50";

  /** The file whose name, or number, is being edited in place. */
  let renaming = $state<string | null>(null);
  let numbering = $state<string | null>(null);

  function renumber(document: DocumentView, value: string): void {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 9999) {
      folio.error = "Write a whole number, such as 3.";
      return;
    }
    if (number !== document.number) void folio.updateDocument(document, { number });
  }

  const categoryOptions = $derived(
    folio.categories.map((category) => ({
      value: category.id,
      label: category.name,
      dot: ROLE_DOT[category.kind],
    })),
  );
</script>

{#if documents.length}
  <div class="flex flex-col overflow-hidden rounded-xl border border-line">
    <div
      class="flex h-8 items-center gap-4 border-b border-line-subtle bg-sunken px-4 text-[12px] font-medium text-text-3 dark:bg-raised"
    >
      {#if title}
        <span class="min-w-0 flex-1 truncate text-text-2" dir="auto"
          >{title}<span class="ml-1.5 font-normal text-text-4"
            >{documents.length}</span
          ></span
        >
      {:else}
        <span class="flex-1">Name</span>
      {/if}
      {#if showCourse}<span class="w-[160px] shrink-0 max-md:hidden"
          >Course</span
        >{/if}
      <span class="w-[150px] shrink-0">Category</span>
      {#if showNumber}<span class="w-[44px] shrink-0">No.</span>{/if}
      {#if showDue}<span class="w-[166px] shrink-0">Due</span>{:else}<span
          class="w-[60px] shrink-0 max-sm:hidden">Pages</span
        ><span class="w-[90px] shrink-0 max-md:hidden">Added</span>{/if}
      <span class="w-7 shrink-0"></span>
    </div>
    {#each documents as document (document.id)}
      {@const course = folio.course(document.courseId)}
      <div
        role="button"
        tabindex="0"
        class="group flex h-11 cursor-default items-center gap-4 border-b border-line-subtle px-4 transition-colors last:border-b-0 hover:bg-hover"
        onclick={(event) =>
          renaming !== document.id &&
          folio.openDocument(document.id, 1, {
            newTab: event.metaKey || event.ctrlKey,
          })}
        onkeydown={(event) => {
          if (event.key === "Enter") folio.openDocument(document.id);
          else if (event.key === "F2") renaming = document.id;
        }}
      >
        <div class="flex min-w-0 flex-1 items-center gap-2.5">
          <FileText size={15} strokeWidth={1.75} class="shrink-0 text-text-3" />
          <InlineName
            value={document.title}
            bind:editing={
              () => renaming === document.id,
              (editing) => (renaming = editing ? document.id : null)
            }
            label="Rename {document.title}"
            class="font-medium text-text"
            onsave={(title) => folio.updateDocument(document, { title })}
          />
          <Lock
            size={11}
            strokeWidth={2}
            class="shrink-0 text-text-4 opacity-0 group-hover:opacity-100"
            aria-label="Original, read-only"
          />
          {#if showStudy && studied(document)}
            {#if folio.studying(document.id)}
              <span
                class="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-text-3"
              >
                <span class="size-1.5 animate-pulse rounded-full bg-highlight"
                ></span>Studying
              </span>
            {/if}
          {/if}
        </div>
        {#if showCourse}
          <div class="flex w-[160px] shrink-0 items-center gap-2 max-md:hidden">
            {#if course}<CourseTile {course} size={16} /><span
                class="truncate text-text-2"
                dir="auto">{course.name}</span
              >{/if}
          </div>
        {/if}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="w-[150px] shrink-0"
          onclick={(event) => event.stopPropagation()}
        >
          <Select
            variant="chip"
            label="Category"
            value={folio.categoryOf(document).id}
            options={categoryOptions}
            onchange={(category) => folio.updateDocument(document, { category })}
          />
        </div>
        {#if showNumber}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="flex w-[44px] shrink-0"
            onclick={(event) => event.stopPropagation()}
          >
            {#if numbering === document.id}
              <InlineName
                value={String(document.number ?? "")}
                bind:editing={
                  () => numbering === document.id,
                  (editing) => (numbering = editing ? document.id : null)
                }
                max={4}
                label="Number of {document.title}"
                class="w-[44px] flex-none tabular-nums"
                onsave={(value) => renumber(document, value)}
              />
            {:else}
              <button
                class="-mx-1 h-6 rounded-md px-1 text-text-2 tabular-nums hover:bg-press"
                title="Change its number"
                onclick={() => (numbering = document.id)}
                >{document.number ?? "—"}</button
              >
            {/if}
          </div>
        {/if}
        {#if showDue}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="flex w-[166px] shrink-0 items-center"
            onclick={(event) => event.stopPropagation()}
          >
            {#if folio.assignmentFor(document.id)}
              {@const work = folio.assignmentFor(document.id)!}
              <DatePicker
                value={work.dueAt}
                overdue={assignmentBadges(work).overdue}
                label="Due date of {document.title}"
                onchange={(dueAt) =>
                  folio.updateAssignment(work, { dueAt, dueHasTime: false })}
              />
            {/if}
          </div>
        {:else}
          <span class="w-[60px] shrink-0 text-text-2 max-sm:hidden"
            >{document.pages ?? "—"}</span
          >
          <span class="w-[90px] shrink-0 text-text-3 max-md:hidden"
            >{formatDate(document.importedAt)}</span
          >
        {/if}
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
                class="z-50 min-w-[200px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
              >
                <DropdownMenu.Item
                  class={menuItem}
                  onSelect={() => (renaming = document.id)}
                >
                  <PencilLine size={14} strokeWidth={1.75} class="text-text-3" />
                  Rename
                </DropdownMenu.Item>
                {#if document.named === "own" && folio.pattern(folio.categoryOf(document))}
                  <DropdownMenu.Item
                    class={menuItem}
                    onSelect={() =>
                      folio.applyNaming({ documentIds: [document.id] })}
                  >
                    <WandSparkles
                      size={14}
                      strokeWidth={1.75}
                      class="text-text-3"
                    />
                    Name by pattern
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
                  <DropdownMenu.Separator class="my-1.5 h-px bg-line-subtle" />
                {/if}
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
{:else}
  <div
    class="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong px-6 py-12 text-center text-text-3"
  >
    {empty}
  </div>
{/if}
