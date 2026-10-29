<script lang="ts">
  import { FileText, Paperclip, Plus, Trash2, X } from "@lucide/svelte";
  import { Dialog } from "bits-ui";
  import type { AssignmentView } from "../../src/desktop/api.ts";
  import {
    ASSIGNMENT_KINDS,
    ASSIGNMENT_STATUSES,
    assignmentBadges,
    type AssignmentKind,
    type AssignmentStatus,
  } from "../../src/library/assignments.ts";
  import { formatDate, KIND_LABEL, STATUS_COLUMN } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import DatePicker from "./DatePicker.svelte";
  import Select from "./Select.svelte";

  /**
   * One assignment in full: when it is due, what was handed out, the steps, what the student
   * handed in (each submission kept as it was), the grade and feedback that came back, and what
   * they would do differently. Text fields save when they lose focus.
   */
  let { assignment, onclose }: { assignment: AssignmentView; onclose: () => void } = $props();

  let step = $state("");
  let extending = $state(false);
  const badges = $derived(assignmentBadges(assignment));
  const course = $derived(folio.course(assignment.courseId));
  const solutions = $derived(
    folio.documents.filter(
      (document) => document.courseId === assignment.courseId && document.role === "solution",
    ),
  );
  const topics = $derived(folio.studyNotes[assignment.courseId]?.topics ?? []);
  const NONE = "none";

  const save = (patch: Parameters<typeof folio.updateAssignment>[1]) =>
    void folio.updateAssignment(assignment, patch);

  const number = (value: string) => (value.trim() === "" ? null : Math.max(0, Number(value)));

  function addStep(): void {
    if (!step.trim()) return;
    save({
      steps: [...assignment.steps, { id: crypto.randomUUID(), text: step.trim(), done: false }],
    });
    step = "";
  }

  $effect(() => {
    if (assignment.courseId) void folio.loadStudyNotes(assignment.courseId);
  });

  const box =
    "rounded-md border border-line-subtle bg-surface px-2.5 py-1.5 text-[14px] outline-none focus:border-line-strong dark:bg-raised";
  const field = `w-full ${box}`;
  const label = "text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase";
</script>

{#snippet file(item: { id: string; name: string; addedAt: string })}
  <button
    type="button"
    class="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line-subtle bg-sunken px-2 text-[12px] text-text-2 hover:border-line hover:text-text dark:bg-raised"
    title="Open {item.name}"
    onclick={() => folio.openAssignmentFile(assignment.id, item.id)}
  >
    <Paperclip size={12} strokeWidth={1.75} class="shrink-0" />
    <span class="min-w-0 truncate" dir="auto">{item.name}</span>
  </button>
{/snippet}

<Dialog.Root open onOpenChange={(open) => !open && onclose()}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-[#18181b]/10 dark:bg-black/40" />
    <Dialog.Content
      class="fixed top-2 right-2 bottom-2 z-50 flex w-[min(520px,calc(100vw-16px))] animate-[folio-in_200ms_var(--ease-out-quint)] flex-col overflow-hidden rounded-[14px] border border-line-subtle bg-raised shadow-3 outline-none"
    >
      <header class="flex items-start gap-2 border-b border-line-subtle px-5 pt-4 pb-3">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <Dialog.Title class="sr-only">{assignment.title}</Dialog.Title>
          <input
            value={assignment.title}
            aria-label="Title"
            dir="auto"
            class="w-full bg-transparent text-[18px] font-semibold tracking-[-0.01em] text-text outline-none"
            onchange={(event) => save({ title: event.currentTarget.value })}
          />
          <span class="truncate text-[12px] text-text-3" dir="auto">{course?.name}</span>
        </div>
        <button
          type="button"
          class="flex size-8 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-danger"
          aria-label="Move {assignment.title} to Trash"
          onclick={async () => {
            onclose();
            await folio.trashAssignment(assignment.id);
          }}
        >
          <Trash2 size={15} strokeWidth={1.75} />
        </button>
        <Dialog.Close
          class="flex size-8 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
          aria-label="Close"
        >
          <X size={16} strokeWidth={1.75} />
        </Dialog.Close>
      </header>

      <div class="scroll-quiet flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        <section class="flex flex-wrap items-center gap-2">
          <Select
            label="Status"
            value={assignment.status}
            options={ASSIGNMENT_STATUSES.map((value) => ({ value, label: STATUS_COLUMN[value] }))}
            onchange={(value) => save({ status: value as AssignmentStatus })}
          />
          <Select
            label="Kind"
            value={assignment.kind}
            options={ASSIGNMENT_KINDS.map((value) => ({ value, label: KIND_LABEL[value] }))}
            onchange={(value) => save({ kind: value as AssignmentKind })}
          />
          {#if badges.overdue}<span class="rounded bg-danger-wash px-1.5 py-0.5 text-[12px] text-danger"
              >Overdue</span
            >{/if}
          {#if badges.late}<span class="rounded bg-danger-wash px-1.5 py-0.5 text-[12px] text-danger"
              >Handed in late</span
            >{/if}
        </section>

        <section class="flex flex-col gap-1.5">
          <span class={label}>Due</span>
          <div class="flex flex-wrap items-center gap-2">
            <div class="w-[180px]">
              <DatePicker
                value={assignment.dueAt}
                onchange={(dueAt) => save({ dueAt, dueHasTime: false })}
              />
            </div>
            <input
              type="time"
              aria-label="Due time"
              class="h-7 rounded-md border border-line-subtle bg-surface px-2 text-[12px] text-text-2 dark:bg-raised"
              disabled={!assignment.dueAt}
              value={assignment.dueAt && assignment.dueHasTime
                ? new Date(assignment.dueAt).toTimeString().slice(0, 5)
                : ""}
              onchange={(event) => {
                if (!assignment.dueAt) return;
                const [hours, minutes] = event.currentTarget.value.split(":").map(Number);
                const due = new Date(assignment.dueAt);
                if (event.currentTarget.value) due.setHours(hours!, minutes!, 0, 0);
                else due.setHours(23, 59, 0, 0);
                save({ dueAt: due.toISOString(), dueHasTime: !!event.currentTarget.value });
              }}
            />
            {#if assignment.dueAt}
              <button
                type="button"
                class="h-7 rounded-md px-2 text-[12px] text-text-2 hover:bg-hover hover:text-text"
                onclick={() => (extending = !extending)}>Got an extension</button
              >
            {/if}
            <label class="inline-flex items-center gap-1.5 text-[12px] text-text-2">
              <input
                type="checkbox"
                checked={assignment.excused}
                onchange={(event) => save({ excused: event.currentTarget.checked })}
              />
              Excused
            </label>
          </div>
          {#if extending}
            <div class="flex items-center gap-2 text-[12px] text-text-3">
              New due date
              <div class="w-[180px]">
                <DatePicker
                  value={null}
                  label="New due date"
                  onchange={(extendTo) => {
                    if (extendTo) save({ extendTo });
                    extending = false;
                  }}
                />
              </div>
            </div>
          {/if}
          {#if badges.extended && assignment.originalDueAt}
            <span class="text-[12px] text-text-3"
              >Extended from {formatDate(assignment.originalDueAt)}</span
            >
          {/if}
        </section>

        <section class="flex flex-col gap-1.5">
          <span class={label}>Files</span>
          <div class="flex flex-wrap items-center gap-2">
            {#if assignment.documents.statement}
              {@const handout = folio.document(assignment.documents.statement)}
              <button
                type="button"
                class="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line-subtle bg-sunken px-2 text-[12px] text-text-2 hover:text-text dark:bg-raised"
                onclick={() => folio.openDocument(assignment.documents.statement!, 1)}
              >
                <FileText size={12} strokeWidth={1.75} class="shrink-0" />
                <span class="min-w-0 truncate" dir="auto">{handout?.title ?? "Handout"}</span>
              </button>
            {/if}
            {#if solutions.length}
              <Select
                label="Official solution"
                value={assignment.documents.solution ?? NONE}
                options={[
                  { value: NONE, label: "No official solution" },
                  ...solutions.map((document) => ({ value: document.id, label: document.title })),
                ]}
                onchange={(value) =>
                  save({
                    documents: {
                      ...assignment.documents,
                      solution: value === NONE ? null : value,
                    },
                  })}
              />
            {/if}
          </div>
        </section>

        <section class="flex flex-col gap-1.5">
          <span class={label}>Steps</span>
          {#each assignment.steps as item (item.id)}
            <label class="flex items-start gap-2 text-[14px]">
              <input
                type="checkbox"
                class="mt-1"
                checked={item.done}
                onchange={(event) =>
                  save({
                    steps: assignment.steps.map((other) =>
                      other.id === item.id ? { ...other, done: event.currentTarget.checked } : other,
                    ),
                  })}
              />
              <span class="min-w-0 flex-1 break-words {item.done ? 'text-text-3 line-through' : ''}" dir="auto"
                >{item.text}</span
              >
              <button
                type="button"
                class="text-text-4 hover:text-danger"
                aria-label="Remove step"
                onclick={() => save({ steps: assignment.steps.filter((other) => other.id !== item.id) })}
              >
                <X size={13} strokeWidth={1.75} />
              </button>
            </label>
          {/each}
          <form
            class="flex items-center gap-2"
            onsubmit={(event) => {
              event.preventDefault();
              addStep();
            }}
          >
            <input bind:value={step} placeholder="Add a step" aria-label="New step" dir="auto" class={field} />
            <button
              type="submit"
              class="flex size-8 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-hover"
              aria-label="Add step"><Plus size={14} strokeWidth={2} /></button
            >
          </form>
        </section>

        <section class="flex flex-col gap-1.5">
          <span class={label}>Submissions</span>
          {#each assignment.attempts as attempt, index (attempt.id)}
            <div class="flex flex-col gap-1.5 rounded-lg border border-line-subtle p-2.5">
              <span class="text-[12px] text-text-3"
                >{index === 0 ? "Handed in" : `Resubmitted (${index + 1})`} {formatDate(
                  attempt.submittedAt,
                )}</span
              >
              <div class="flex flex-wrap gap-1.5">
                {#each attempt.files as item (item.id)}{@render file(item)}{/each}
              </div>
            </div>
          {/each}
          <button
            type="button"
            class="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[13px] font-medium shadow-1 hover:bg-hover dark:bg-raised"
            onclick={() => folio.addAssignmentFiles(assignment, "attempt")}
          >
            <Plus size={14} strokeWidth={2} />
            {assignment.attempts.length ? "Add a resubmission" : "Add what you handed in"}
          </button>
        </section>

        <section class="flex flex-col gap-1.5">
          <span class={label}>Grade and feedback</span>
          <div class="flex items-center gap-2 text-[14px]">
            <input
              type="number"
              min="0"
              aria-label="Score"
              placeholder="Score"
              class="{box} w-[96px]"
              value={assignment.grade.score ?? ""}
              onchange={(event) =>
                save({ grade: { ...assignment.grade, score: number(event.currentTarget.value) } })}
            />
            <span class="whitespace-nowrap text-text-3">out of</span>
            <input
              type="number"
              min="0"
              aria-label="Maximum score"
              placeholder="100"
              class="{box} w-[96px]"
              value={assignment.grade.max ?? ""}
              onchange={(event) =>
                save({ grade: { ...assignment.grade, max: number(event.currentTarget.value) } })}
            />
          </div>
          <textarea
            rows="3"
            placeholder="What the feedback said"
            aria-label="Feedback"
            dir="auto"
            class={field}
            value={assignment.feedback.text}
            onchange={(event) => save({ feedbackText: event.currentTarget.value })}
          ></textarea>
          <div class="flex flex-wrap items-center gap-1.5">
            {#each assignment.feedback.files as item (item.id)}{@render file(item)}{/each}
            <button
              type="button"
              class="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-text-2 hover:bg-hover hover:text-text"
              onclick={() => folio.addAssignmentFiles(assignment, "feedback")}
            >
              <Plus size={12} strokeWidth={2} />
              Add returned work
            </button>
          </div>
        </section>

        <section class="flex flex-col gap-1.5">
          <span class={label}>For next time</span>
          <textarea
            rows="3"
            placeholder="What went wrong, and what you would do differently"
            aria-label="Reflection"
            dir="auto"
            class={field}
            value={assignment.reflection}
            onchange={(event) => save({ reflection: event.currentTarget.value })}
          ></textarea>
        </section>

        {#if topics.length}
          <section class="flex flex-col gap-1.5">
            <span class={label}>Topics it covers</span>
            <div class="flex flex-wrap items-center gap-1.5">
              {#each assignment.topics as slug (slug)}
                {@const topic = topics.find((candidate) => candidate.slug === slug)}
                <span
                  class="inline-flex h-7 items-center gap-1 rounded-md border border-line-subtle bg-surface pr-1 pl-2.5 text-[12px] dark:bg-raised"
                >
                  <button
                    type="button"
                    class="max-w-[200px] truncate hover:underline"
                    dir="auto"
                    onclick={() => folio.openStudyNotes(assignment.courseId, `topic:${slug}`)}
                    >{topic?.title ?? slug}</button
                  >
                  <button
                    type="button"
                    class="text-text-4 hover:text-danger"
                    aria-label="Remove topic"
                    onclick={() => save({ topics: assignment.topics.filter((other) => other !== slug) })}
                  >
                    <X size={12} strokeWidth={1.75} />
                  </button>
                </span>
              {/each}
              <Select
                label="Add a topic"
                value={NONE}
                options={[
                  { value: NONE, label: "Add a topic" },
                  ...topics
                    .filter((topic) => !assignment.topics.includes(topic.slug))
                    .map((topic) => ({ value: topic.slug, label: topic.title })),
                ]}
                onchange={(value) =>
                  value !== NONE && save({ topics: [...assignment.topics, value] })}
              />
            </div>
          </section>
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
