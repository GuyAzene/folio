<script lang="ts">
  import { ChevronRight, Plus } from "@lucide/svelte";
  import { flip } from "svelte/animate";
  import type { AssignmentView } from "../../src/desktop/api.ts";
  import {
    ASSIGNMENT_KINDS,
    ASSIGNMENT_STATUSES,
    assignmentBadges,
    DONE_FOLDS_AFTER_DAYS,
    type AssignmentKind,
    type AssignmentStatus,
  } from "../../src/library/assignments.ts";
  import AssignmentCard from "../components/AssignmentCard.svelte";
  import AssignmentSheet from "../components/AssignmentSheet.svelte";
  import Select from "../components/Select.svelte";
  import StatusIcon from "../components/StatusIcon.svelte";
  import StatusMenu from "../components/StatusMenu.svelte";
  import {
    KIND_LABEL,
    PENCIL,
    relativeDue,
    STATUS_COLUMN,
  } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * The student's coursework, as a board of To do, Doing, Submitted and Done, or as Upcoming: a
   * list by the day things are due. A card's status icon is how its status changes, along with
   * dragging, its right-click menu and the keyboard; late and overdue come from the dates.
   */
  const ALL = "all";
  let view = $state<"board" | "upcoming">(saved("folio.assignmentsView") ?? "board");
  let courseFilter = $state(ALL);
  let adding = $state(false);
  let title = $state("");
  let kind = $state<AssignmentKind>("problem_set");
  let course = $state("");
  let quick = $state<{ where: string; text: string } | null>(null);
  let showOlder = $state(false);
  let showHanded = $state(false);
  let dragging = $state<string | null>(null);
  let over = $state<AssignmentStatus | null>(null);
  let opened = $state<string | null>(null);
  let announcement = $state("");

  function saved(key: string): "board" | "upcoming" | null {
    try {
      const value = localStorage.getItem(key);
      return value === "board" || value === "upcoming" ? value : null;
    } catch {
      return null;
    }
  }
  function choose(next: "board" | "upcoming"): void {
    view = next;
    try {
      localStorage.setItem("folio.assignmentsView", next);
    } catch {
      // A per-device convenience.
    }
  }

  const visible = $derived(
    folio.assignments.filter((item) => courseFilter === ALL || item.courseId === courseFilter),
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
        older: status === "done" && !showOlder ? items.filter(folded).length : 0,
      };
    }),
  );
  const current = $derived(folio.assignments.find((item) => item.id === opened) ?? null);
  /** Where a quick add puts its card: the filtered course, else the first course. */
  const defaultCourse = $derived(courseFilter !== ALL ? courseFilter : (folio.courses[0]?.id ?? ""));

  // ── Upcoming: open work by the day it is due ───────────────────────────
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const endOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59).toISOString();

  interface Group {
    key: string;
    label: string;
    /** The day's number for a single day, Things-style; null for a range. */
    numeral: number | null;
    /** A day a quick add here is due on. */
    day: Date | null;
    items: AssignmentView[];
    danger?: boolean;
  }

  const groups = $derived.by((): Group[] => {
    const today = startOfDay(new Date());
    const open = visible.filter((item) => item.status === "todo" || item.status === "doing");
    const daysFrom = (item: AssignmentView) =>
      Math.round((startOfDay(new Date(item.dueAt!)).getTime() - today.getTime()) / 86_400_000);
    const sorted = (items: AssignmentView[]) =>
      [...items].sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
    const result: Group[] = [];
    const overdue = open.filter((item) => item.dueAt && assignmentBadges(item).overdue);
    if (overdue.length)
      result.push({ key: "overdue", label: "Overdue", numeral: null, day: null, items: sorted(overdue), danger: true });
    for (let offset = 0; offset < 7; offset++) {
      const day = new Date(today.getTime() + offset * 86_400_000);
      const items = open.filter(
        (item) => item.dueAt && !overdue.includes(item) && daysFrom(item) === offset,
      );
      // Today and tomorrow always show, so there is somewhere to add to.
      if (items.length || offset < 2)
        result.push({
          key: `day-${offset}`,
          label:
            offset === 0
              ? "Today"
              : offset === 1
                ? "Tomorrow"
                : day.toLocaleDateString(undefined, { weekday: "long" }),
          numeral: day.getDate(),
          day,
          items: sorted(items),
        });
    }
    const nextWeek = open.filter((item) => item.dueAt && daysFrom(item) >= 7 && daysFrom(item) < 14);
    if (nextWeek.length)
      result.push({ key: "next", label: "Next week", numeral: null, day: null, items: sorted(nextWeek) });
    const later = open.filter((item) => item.dueAt && daysFrom(item) >= 14);
    for (const [month, items] of Map.groupBy(later, (item) =>
      new Date(item.dueAt!).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    ))
      result.push({ key: `month-${month}`, label: month, numeral: null, day: null, items: sorted(items) });
    const undated = open.filter((item) => !item.dueAt);
    if (undated.length)
      result.push({ key: "undated", label: "No due date", numeral: null, day: null, items: undated });
    return result;
  });
  const handedIn = $derived(
    visible
      .filter((item) => item.status === "submitted" || (item.status === "done" && !folded(item)))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
  );

  // ── Changes ────────────────────────────────────────────────────────────
  async function add(): Promise<void> {
    const target = course || defaultCourse;
    if (!target || !title.trim()) return;
    if (await folio.createAssignment(target, title, kind)) {
      title = "";
      adding = false;
    }
  }

  async function quickAdd(start: { status?: AssignmentStatus; dueAt?: string }): Promise<void> {
    if (!quick?.text.trim() || !defaultCourse) return;
    const text = quick.text;
    quick = { where: quick.where, text: "" };
    await folio.createAssignment(defaultCourse, text, undefined, start);
  }

  function move(item: AssignmentView, status: AssignmentStatus): void {
    if (item.status === status) return;
    void folio.updateAssignment(item, { status });
    announcement = `Moved ${item.title} to ${STATUS_COLUMN[status]}`;
  }

  function drop(status: AssignmentStatus): void {
    const item = folio.assignments.find((candidate) => candidate.id === dragging);
    if (item) move(item, status);
    dragging = null;
    over = null;
  }

  /** Arrow keys walk the board: up and down a column, left and right across columns. */
  function walk(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-card]");
    if (!card) return;
    const lists = columns.map((column) => column.items.map((item) => item.id));
    const col = lists.findIndex((list) => list.includes(card.dataset.card!));
    const row = lists[col]!.indexOf(card.dataset.card!);
    let next: string | undefined;
    if (event.key === "ArrowUp") next = lists[col]![row - 1];
    else if (event.key === "ArrowDown") next = lists[col]![row + 1];
    else {
      const step = event.key === "ArrowRight" ? 1 : -1;
      for (let other = col + step; other >= 0 && other < 4 && !next; other += step)
        next = lists[other]![Math.min(row, lists[other]!.length - 1)];
    }
    if (!next) return;
    event.preventDefault();
    document.querySelector<HTMLElement>(`[data-card="${next}"]`)?.focus();
  }

  const quiet =
    "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-text-3 transition-colors hover:bg-hover hover:text-text";
</script>

{#snippet quickField(where: string, start: { status?: AssignmentStatus; dueAt?: string })}
  {#if quick?.where === where}
    <form
      class="flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 dark:bg-raised"
      onsubmit={(event) => {
        event.preventDefault();
        void quickAdd(start);
      }}
    >
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={quick.text}
        autofocus
        placeholder="New assignment"
        aria-label="New assignment"
        dir="auto"
        class="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-text-4"
        onkeydown={(event) => event.key === "Escape" && (quick = null)}
        onblur={() => !quick?.text.trim() && (quick = null)}
      />
    </form>
  {:else}
    <button
      type="button"
      class="{quiet} self-start"
      disabled={!defaultCourse}
      onclick={() => (quick = { where, text: "" })}
    >
      <Plus size={13} strokeWidth={2} />
      New assignment
    </button>
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col">
  <header class="flex flex-wrap items-center gap-2 px-8 pt-8 pb-4 max-sm:px-4">
    <h1 class="mr-2 text-[22px] leading-8 font-semibold tracking-[-0.02em] text-text">
      Assignments
    </h1>
    <div
      class="inline-grid grid-cols-2 gap-0.5 rounded-md bg-sunken p-0.5 text-[12px] font-medium dark:bg-raised"
      role="tablist"
    >
      {#each [["board", "Board"], ["upcoming", "Upcoming"]] as const as [value, name] (value)}
        <button
          role="tab"
          aria-selected={view === value}
          class="h-7 rounded-[5px] px-3 transition-colors {view === value
            ? 'bg-surface text-text shadow-1 dark:bg-hover'
            : 'text-text-3 hover:text-text'}"
          onclick={() => choose(value)}>{name}</button
        >
      {/each}
    </div>
    <span class="flex-1"></span>
    <Select
      label="Course"
      value={courseFilter}
      options={[
        { value: ALL, label: "All courses" },
        ...folio.courses.map((item) => ({ value: item.id, label: item.name, dot: PENCIL[item.color] })),
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
          options={folio.courses.map((item) => ({ value: item.id, label: item.name, dot: PENCIL[item.color] }))}
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

  <div class="sr-only" aria-live="polite">{announcement}</div>

  {#if view === "board"}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="scroll-quiet grid min-h-0 flex-1 auto-rows-min grid-cols-4 gap-5 overflow-y-auto px-8 pb-10 max-lg:grid-cols-2 max-sm:grid-cols-1 max-sm:px-4"
      onkeydown={walk}
    >
      {#each columns as column (column.status)}
        <section
          class="flex min-w-0 flex-col gap-2"
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
          <h2 class="group/head flex h-7 items-center gap-2 text-[12.5px] font-medium text-text-2">
            <StatusIcon status={column.status} />
            {STATUS_COLUMN[column.status]}
            <span class="font-normal text-text-4 tabular-nums">{column.items.length}</span>
            <span class="flex-1"></span>
            {#if column.status !== "done"}
              <button
                type="button"
                class="flex size-6 items-center justify-center rounded-md text-text-4 opacity-0 transition-opacity group-hover/head:opacity-100 hover:bg-hover hover:text-text focus-visible:opacity-100"
                aria-label="New assignment in {STATUS_COLUMN[column.status]}"
                disabled={!defaultCourse}
                onclick={() => (quick = { where: column.status, text: "" })}
              >
                <Plus size={13} strokeWidth={2} />
              </button>
            {/if}
          </h2>
          {#each column.items as item (item.id)}
            <div animate:flip={{ duration: 180 }}>
              <AssignmentCard
                {item}
                dragging={dragging === item.id}
                onopen={() => (opened = item.id)}
                onmove={(status) => move(item, status)}
                ondragstart={(event) => {
                  dragging = item.id;
                  event.dataTransfer?.setData("text/plain", item.id);
                }}
                ondragend={() => {
                  dragging = null;
                  over = null;
                }}
              />
            </div>
          {/each}
          {#if dragging && over === column.status}
            <div class="h-14 rounded-lg border border-dashed border-line-strong"></div>
          {/if}
          {#if column.status === "todo" || quick?.where === column.status}
            {@render quickField(column.status, { status: column.status })}
          {/if}
          {#if column.older}
            <button type="button" class="{quiet} self-start" onclick={() => (showOlder = true)}
              >{column.older} older</button
            >
          {/if}
        </section>
      {/each}
    </div>
  {:else}
    <div class="scroll-quiet min-h-0 flex-1 overflow-y-auto px-8 pb-12 max-sm:px-4">
      <div class="mx-auto flex max-w-[760px] flex-col gap-7">
        {#each groups as group (group.key)}
          <section class="flex flex-col gap-1">
            <h2 class="flex items-baseline gap-2.5 border-b border-line-subtle pb-1.5">
              {#if group.numeral !== null}
                <span class="text-[26px] leading-none font-semibold tracking-[-0.03em] text-text tabular-nums"
                  >{group.numeral}</span
                >
              {/if}
              <span
                class="text-[14px] font-medium {group.danger ? 'text-danger' : 'text-text-2'}"
                >{group.label}</span
              >
              <span class="text-[12px] text-text-4 tabular-nums">{group.items.length || ""}</span>
            </h2>
            {#each group.items as item (item.id)}
              {@const itemCourse = folio.course(item.courseId)}
              <div class="group flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover">
                <StatusMenu status={item.status} title={item.title} onchange={(status) => move(item, status)} />
                <button
                  type="button"
                  class="flex min-w-0 flex-1 flex-col text-left"
                  onclick={() => (opened = item.id)}
                >
                  <span class="truncate text-[14px] text-text" dir="auto">{item.title}</span>
                  <span class="flex min-w-0 items-center gap-1.5 text-[12px] text-text-3">
                    {#if itemCourse}
                      <span class="size-2 shrink-0 rounded-full" style:background={PENCIL[itemCourse.color]}></span>
                      <span class="truncate" dir="auto">{itemCourse.name}</span>
                      <span class="text-text-4">·</span>
                    {/if}
                    <span class="shrink-0">{KIND_LABEL[item.kind]}</span>
                  </span>
                </button>
                {#if item.steps.length}
                  <span class="shrink-0 text-[12px] text-text-3 tabular-nums"
                    >{item.steps.filter((step) => step.done).length}/{item.steps.length}</span
                  >
                {/if}
                <!-- Under a day's heading the day says when; elsewhere the row does. -->
                {#if item.dueAt && group.numeral === null}
                  <span
                    class="shrink-0 text-[12px] tabular-nums {assignmentBadges(item).overdue
                      ? 'font-medium text-danger'
                      : 'text-text-3'}">{relativeDue(item.dueAt, item.dueHasTime)}</span
                  >
                {/if}
              </div>
            {/each}
            {#if group.day}
              <div class="pl-1">
                {@render quickField(group.key, { dueAt: endOfDay(group.day) })}
              </div>
            {/if}
          </section>
        {/each}
        {#if handedIn.length}
          <section class="flex flex-col gap-1">
            <button
              type="button"
              class="flex items-center gap-2 border-b border-line-subtle pb-1.5 text-left text-[14px] font-medium text-text-2"
              aria-expanded={showHanded}
              onclick={() => (showHanded = !showHanded)}
            >
              <ChevronRight
                size={14}
                strokeWidth={1.75}
                class="transition-transform {showHanded ? 'rotate-90' : ''}"
              />
              Handed in
              <span class="text-[12px] font-normal text-text-4 tabular-nums">{handedIn.length}</span>
            </button>
            {#if showHanded}
              {#each handedIn as item (item.id)}
                <button
                  type="button"
                  class="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-hover"
                  onclick={() => (opened = item.id)}
                >
                  <StatusIcon status={item.status} />
                  <span class="min-w-0 flex-1 truncate text-[14px] text-text-2" dir="auto">{item.title}</span>
                  {#if item.grade.score !== null}
                    <span class="shrink-0 text-[12px] text-text-2 tabular-nums"
                      >{item.grade.score}{item.grade.max !== null ? `/${item.grade.max}` : ""}</span
                    >
                  {/if}
                </button>
              {/each}
            {/if}
          </section>
        {/if}
      </div>
    </div>
  {/if}
</div>

{#if current}
  <AssignmentSheet assignment={current} onclose={() => (opened = null)} />
{/if}
