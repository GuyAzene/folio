<script lang="ts">
  import { ChevronDown, Plus } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import type { AssignmentView } from "../../src/desktop/api.ts";
  import {
    ASSIGNMENT_KINDS,
    ASSIGNMENT_STATUSES,
    assignmentBadges,
    DONE_FOLDS_AFTER_DAYS,
    type AssignmentKind,
    type AssignmentStatus,
  } from "../../src/library/assignments.ts";
  import AssignmentSheet from "../components/AssignmentSheet.svelte";
  import CourseTile from "../components/CourseTile.svelte";
  import Select from "../components/Select.svelte";
  import {
    formatAssignmentDue,
    KIND_LABEL,
    PENCIL,
    STATUS_COLUMN,
  } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * The student's coursework as a board: To do, Doing, Submitted and Done. Cards move by drag and
   * drop or by their status menu; late, overdue and extended are worked out from the dates. Done
   * keeps the last few weeks open and folds older work away, where it stays for exam review.
   */
  const ALL = "all";
  let courseFilter = $state(ALL);
  let adding = $state(false);
  let title = $state("");
  let kind = $state<AssignmentKind>("problem_set");
  let course = $state("");
  let showOlder = $state(false);
  let dragging = $state<string | null>(null);
  let over = $state<AssignmentStatus | null>(null);
  let opened = $state<string | null>(null);

  const visible = $derived(
    folio.assignments.filter(
      (item) => courseFilter === ALL || item.courseId === courseFilter,
    ),
  );
  const folded = (item: AssignmentView) =>
    item.status === "done" &&
    !!item.finishedAt &&
    Date.now() - Date.parse(item.finishedAt) > DONE_FOLDS_AFTER_DAYS * 86_400_000;
  const columns = $derived(
    ASSIGNMENT_STATUSES.map((status) => {
      const items = visible.filter((item) => item.status === status);
      return {
        status,
        items: status === "done" && !showOlder ? items.filter((item) => !folded(item)) : items,
        older: status === "done" ? items.filter(folded).length : 0,
      };
    }),
  );
  const current = $derived(folio.assignments.find((item) => item.id === opened) ?? null);

  async function add(): Promise<void> {
    const target = course || (courseFilter !== ALL ? courseFilter : folio.courses[0]?.id);
    if (!target || !title.trim()) return;
    const created = await folio.createAssignment(target, title, kind);
    if (created) {
      title = "";
      adding = false;
    }
  }

  function move(item: AssignmentView, status: AssignmentStatus): void {
    if (item.status !== status) void folio.updateAssignment(item, { status });
  }

  function drop(status: AssignmentStatus): void {
    const item = folio.assignments.find((candidate) => candidate.id === dragging);
    if (item) move(item, status);
    dragging = null;
    over = null;
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex flex-wrap items-center gap-2 px-8 pt-10 pb-5 max-sm:px-4">
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <h1 class="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-text">
        Assignments
      </h1>
      <p class="text-text-3">
        Everything you have to hand in, read or prepare, and what you got back.
      </p>
    </div>
    <Select
      label="Course"
      value={courseFilter}
      options={[
        { value: ALL, label: "All courses" },
        ...folio.courses.map((item) => ({
          value: item.id,
          label: item.name,
          dot: PENCIL[item.color],
        })),
      ]}
      onchange={(value) => (courseFilter = value)}
    />
    <button
      type="button"
      class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 text-[13px] font-medium whitespace-nowrap text-on-ink shadow-1 hover:opacity-90 disabled:opacity-50"
      disabled={!folio.courses.length}
      onclick={() => (adding = !adding)}
    >
      <Plus size={14} strokeWidth={2} />
      New
    </button>
  </header>

  {#if adding}
    <form
      class="mx-8 mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line-subtle bg-surface p-2 shadow-1 max-sm:mx-4 dark:bg-raised"
      onsubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={title}
        autofocus
        placeholder="What is it? A problem set, a reading, exam prep…"
        aria-label="Title"
        dir="auto"
        class="h-8 min-w-[200px] flex-1 rounded-md bg-transparent px-2 text-[14px] outline-none placeholder:text-text-4"
      />
      <Select
        label="Kind"
        value={kind}
        options={ASSIGNMENT_KINDS.map((value) => ({ value, label: KIND_LABEL[value] }))}
        onchange={(value) => (kind = value as AssignmentKind)}
      />
      {#if courseFilter === ALL && folio.courses.length > 1}
        <Select
          label="Course"
          value={course || folio.courses[0]!.id}
          options={folio.courses.map((item) => ({
            value: item.id,
            label: item.name,
            dot: PENCIL[item.color],
          }))}
          onchange={(value) => (course = value)}
        />
      {/if}
      <button
        type="submit"
        class="h-8 shrink-0 rounded-md bg-ink px-3 text-[13px] font-medium text-on-ink disabled:opacity-50"
        disabled={!title.trim()}>Add</button
      >
    </form>
  {/if}

  <div
    class="scroll-quiet grid min-h-0 flex-1 auto-rows-min grid-cols-4 gap-3 overflow-y-auto px-8 pb-10 max-lg:grid-cols-2 max-sm:grid-cols-1 max-sm:px-4"
  >
    {#each columns as column (column.status)}
      <section
        class="flex min-w-0 flex-col gap-2 rounded-xl p-2 transition-colors {over ===
        column.status
          ? 'bg-hover'
          : 'bg-sunken dark:bg-raised'}"
        aria-label={STATUS_COLUMN[column.status]}
        ondragover={(event) => {
          event.preventDefault();
          over = column.status;
        }}
        ondragleave={() => (over = null)}
        ondrop={(event) => {
          event.preventDefault();
          drop(column.status);
        }}
      >
        <h2 class="flex items-center gap-2 px-1.5 pt-1 text-[12px] font-medium text-text-2">
          {STATUS_COLUMN[column.status]}
          <span class="text-text-4">{column.items.length}</span>
        </h2>
        {#each column.items as item (item.id)}
          {@const badges = assignmentBadges(item)}
          {@const itemCourse = folio.course(item.courseId)}
          {@const steps = item.steps.filter((step) => step.done).length}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="group flex min-w-0 flex-col gap-2 rounded-lg border border-line-subtle bg-surface p-3 shadow-card transition-opacity dark:bg-bg {dragging ===
            item.id
              ? 'opacity-40'
              : ''}"
            draggable="true"
            ondragstart={(event) => {
              dragging = item.id;
              event.dataTransfer?.setData("text/plain", item.id);
            }}
            ondragend={() => {
              dragging = null;
              over = null;
            }}
          >
            <button
              type="button"
              class="min-w-0 text-left text-[14px] leading-5 font-medium break-words text-text hover:underline"
              dir="auto"
              onclick={() => (opened = item.id)}>{item.title}</button
            >
            <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-3">
              {#if itemCourse}
                <span class="inline-flex min-w-0 items-center gap-1.5">
                  <CourseTile course={itemCourse} size={14} />
                  <span class="max-w-[140px] truncate" dir="auto">{itemCourse.name}</span>
                </span>
              {/if}
              <span class="shrink-0">{KIND_LABEL[item.kind]}</span>
            </div>
            <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
              {#if item.dueAt}
                <span
                  class="rounded px-1.5 py-0.5 whitespace-nowrap {badges.overdue
                    ? 'bg-danger-wash text-danger'
                    : 'bg-sunken text-text-2 dark:bg-raised'}"
                  >{formatAssignmentDue(item.dueAt, item.dueHasTime)}</span
                >
              {/if}
              {#if badges.late}<span class="rounded bg-danger-wash px-1.5 py-0.5 text-danger"
                  >Late</span
                >{/if}
              {#if badges.extended}<span
                  class="rounded bg-sunken px-1.5 py-0.5 text-text-2 dark:bg-raised">Extended</span
                >{/if}
              {#if badges.excused}<span
                  class="rounded bg-sunken px-1.5 py-0.5 text-text-2 dark:bg-raised">Excused</span
                >{/if}
              {#if item.steps.length}<span class="text-text-3 tabular-nums"
                  >{steps}/{item.steps.length} steps</span
                >{/if}
              {#if item.grade.score !== null}<span class="text-text-2 tabular-nums"
                  >{item.grade.score}{item.grade.max !== null ? `/${item.grade.max}` : ""}</span
                >{/if}
              <span class="flex-1"></span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  class="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-3 hover:bg-hover hover:text-text data-[state=open]:bg-hover"
                  aria-label="Move {item.title}"
                >
                  {STATUS_COLUMN[item.status]}
                  <ChevronDown size={11} strokeWidth={2} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={4}
                    class="z-50 min-w-[150px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
                  >
                    {#each ASSIGNMENT_STATUSES as status (status)}
                      <DropdownMenu.Item
                        class="flex h-8 cursor-default items-center rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover"
                        onSelect={() => move(item, status)}>{STATUS_COLUMN[status]}</DropdownMenu.Item
                      >
                    {/each}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </div>
        {/each}
        {#if column.older}
          <button
            type="button"
            class="rounded-md px-1.5 py-1 text-left text-[12px] text-text-3 hover:text-text"
            onclick={() => (showOlder = true)}
            >Show {column.older} finished more than {DONE_FOLDS_AFTER_DAYS / 7} weeks ago</button
          >
        {/if}
      </section>
    {/each}
  </div>
</div>

{#if current}
  <AssignmentSheet assignment={current} onclose={() => (opened = null)} />
{/if}
