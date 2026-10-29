<script lang="ts">
  import { FileText, Lock, Trash2 } from "@lucide/svelte";
  import type { DocumentRole, DocumentView } from "../../src/desktop/api.ts";
  import {
    formatDate,
    formatDue,
    ROLE_DOT,
    ROLE_LABEL,
    ROLES,
  } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import CourseTile from "./CourseTile.svelte";

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
    /** Lectures and recitations show whether Folio has studied them, with a Study action. */
    showStudy?: boolean;
    empty?: string;
  } = $props();

  function setDue(document: DocumentView, value: string): void {
    // A date input gives a local day; store it as the end of that day.
    const dueAt = value ? new Date(`${value}T23:59:00`).toISOString() : null;
    void folio.updateDocument(document, { dueAt });
  }
  function dueValue(iso: string | null): string {
    if (!iso) return "";
    const date = new Date(iso);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
</script>

{#if documents.length}
  <div class="flex flex-col overflow-hidden rounded-xl border border-line">
    <div
      class="flex h-8 items-center gap-4 border-b border-line-subtle bg-sunken px-4 text-[12px] font-medium text-text-3 dark:bg-raised"
    >
      {#if title}
        <span class="flex-1 text-text-2"
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
            {#if folio.studied(document.id)}
              <span
                class="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-text-3"
              >
                <span class="size-1.5 rounded-full bg-success"></span>Studied
              </span>
            {:else if folio.studying(document.id)}
              <span
                class="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-text-3"
              >
                <span class="size-1.5 animate-pulse rounded-full bg-highlight"
                ></span>Studying
              </span>
            {:else if document.kind === "pdf"}
              <button
                type="button"
                class="h-6 shrink-0 rounded-md px-2 text-[12px] font-medium text-text-2 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-press hover:text-text focus-visible:opacity-100"
                title="Folio reads every page and adds study notes to the course"
                onclick={(event) => {
                  event.stopPropagation();
                  void folio.study(document.courseId, [document.id]);
                }}>Study</button
              >
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
          <label
            class="relative inline-flex h-6 items-center gap-1.5 rounded-md border border-line-subtle bg-sunken pr-2 pl-2 hover:border-line dark:bg-raised"
          >
            <span
              class="size-1.5 rounded-[2px]"
              style="background:{ROLE_DOT[document.role]}"
            ></span>
            <span class="text-[12px] font-medium text-text-2"
              >{ROLE_LABEL[document.role]}</span
            >
            <select
              class="absolute inset-0 cursor-default opacity-0"
              aria-label="Role"
              value={document.role}
              onchange={(event) =>
                folio.updateDocument(document, {
                  role: (event.currentTarget as HTMLSelectElement)
                    .value as DocumentRole,
                })}
            >
              {#each ROLES as role (role)}<option value={role}
                  >{ROLE_LABEL[role]}</option
                >{/each}
            </select>
          </label>
        </div>
        {#if showDue}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="flex w-[166px] shrink-0 flex-col"
            onclick={(event) => event.stopPropagation()}
          >
            <input
              type="date"
              class="h-7 rounded-md border border-transparent bg-transparent px-1 text-[12px] text-text-2 hover:border-line focus:border-line-strong focus:outline-none"
              value={dueValue(document.dueAt)}
              aria-label="Due date"
              onchange={(event) =>
                setDue(
                  document,
                  (event.currentTarget as HTMLInputElement).value,
                )}
            />
            <span class="px-1 text-[11px] text-text-3"
              >{formatDue(document.dueAt)}</span
            >
          </div>
        {:else}
          <span class="w-[60px] shrink-0 text-text-2 max-sm:hidden"
            >{document.pages ?? "—"}</span
          >
          <span class="w-[90px] shrink-0 text-text-3 max-md:hidden"
            >{formatDate(document.importedAt)}</span
          >
        {/if}
        <button
          type="button"
          class="flex size-7 shrink-0 items-center justify-center rounded-md text-text-4 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-press hover:text-danger focus-visible:opacity-100"
          title="Move to Trash"
          aria-label="Move {document.title} to Trash"
          onclick={(event) => {
            event.stopPropagation();
            void folio.trashDocuments([document.id]);
          }}
        >
          <Trash2 size={14} strokeWidth={1.75} />
        </button>
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
