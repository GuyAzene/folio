<script lang="ts">
  import { Ellipsis, FileText, Lock, RotateCw, Trash2 } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import type { DocumentRole, DocumentView } from "../../src/desktop/api.ts";
  import {
    formatDate,
    ROLE_DOT,
    ROLE_LABEL,
    ROLES,
  } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import CourseTile from "./CourseTile.svelte";
  import { assignmentBadges } from "../../src/library/assignments.ts";
  import DatePicker from "./DatePicker.svelte";
  import Select from "./Select.svelte";

  let {
    documents,
    title = null,
    showCourse = false,
    showDue = false,
    showStudy = false,
    empty = "Nothing here yet.",
  }: {
    documents: DocumentView[];
    /** A section's name, shown with its count where the Name column heading would be. */
    title?: string | null;
    showCourse?: boolean;
    showDue?: boolean;
    /** Lectures and recitations show whether Folio has studied them or is studying them. */
    showStudy?: boolean;
    empty?: string;
  } = $props();

  const menuItem =
    "flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover data-[disabled]:opacity-50";

  const ROLE_OPTIONS = ROLES.map((role) => ({
    value: role,
    label: ROLE_LABEL[role],
    dot: ROLE_DOT[role],
  }));
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
      <span class="w-[150px] shrink-0">Role</span>
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
          folio.openDocument(document.id, 1, {
            newTab: event.metaKey || event.ctrlKey,
          })}
        onkeydown={(event) =>
          event.key === "Enter" && folio.openDocument(document.id)}
      >
        <div class="flex min-w-0 flex-1 items-center gap-2.5">
          <FileText size={15} strokeWidth={1.75} class="shrink-0 text-text-3" />
          <span class="truncate font-medium text-text" dir="auto"
            >{document.title}</span
          >
          <Lock
            size={11}
            strokeWidth={2}
            class="shrink-0 text-text-4 opacity-0 group-hover:opacity-100"
            aria-label="Original, read-only"
          />
          {#if showStudy && (document.role === "lecture" || document.role === "recitation")}
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
            label="Role"
            value={document.role}
            options={ROLE_OPTIONS}
            onchange={(role) =>
              folio.updateDocument(document, { role: role as DocumentRole })}
          />
        </div>
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
                class="z-50 min-w-[200px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
              >
                {#if (document.role === "lecture" || document.role === "recitation") && document.kind === "pdf"}
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
