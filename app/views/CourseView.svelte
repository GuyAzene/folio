<script lang="ts">
  import { ArrowRight, Ellipsis, History, PencilLine, Plus, Trash2, Upload } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import ChatList from "../components/ChatList.svelte";
  import CourseDetailsDialog from "../components/CourseDetailsDialog.svelte";
  import Composer from "../components/Composer.svelte";
  import CourseTile from "../components/CourseTile.svelte";
  import DocumentTable from "../components/DocumentTable.svelte";
  import NoteRow from "../components/NoteRow.svelte";
  import StudyNotesList from "../components/StudyNotesList.svelte";
  import { COURSE_TABS, materialSections } from "../lib/course-tabs.ts";
  import { relativeDue } from "../lib/labels.ts";
  import { shortTitle } from "../lib/titles.ts";
  import { folio, type CourseTab } from "../lib/state.svelte.ts";

  let {
    paneId,
    courseId,
    tab,
  }: { paneId: string; courseId: string; tab: CourseTab } = $props();
  let dragging = $state(0);
  let composer = $state<Composer>();
  let editing = $state(false);

  const course = $derived(folio.course(courseId));
  const documents = $derived(
    folio.documents.filter((document) => document.courseId === courseId),
  );
  const sections = $derived(materialSections(documents, folio.categories));
  const knowledge = $derived(folio.knowledge[courseId] ?? null);
  const notes = $derived(
    folio.notes.filter((note) => note.courseId === courseId),
  );
  const chats = $derived(
    folio.chats.filter((chat) => chat.courseId === courseId),
  );
  const details = $derived(
    course ? [course.code, course.term].filter(Boolean).join(" · ") : "",
  );
  const counts = $derived<Record<CourseTab, number>>({
    materials: documents.length,
    study: knowledge?.pages ?? 0,
    notes: notes.length,
    chats: chats.length,
  });

  /** Work still to do in this course, soonest first. */
  const due = $derived(
    folio.assignments
      .filter(
        (item) =>
          item.courseId === courseId &&
          (item.status === "todo" || item.status === "doing") &&
          !item.excused,
      )
      .sort((a, b) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~")),
  );
  /** What Folio is studying in this course right now, and how much waits after it. */
  const studying = $derived.by(() => {
    const live = folio.jobs.filter(
      (job) => job.courseId === courseId && (job.status === "running" || job.status === "queued"),
    );
    if (!live.length) return null;
    const now = live.find((job) => job.status === "running" && job.kind === "ingest");
    const document = folio.document(now?.documentIds[0]);
    const waiting = live.filter((job) => job.status === "queued").length;
    const what = document
      ? `Studying ${shortTitle(document.title, course?.name)}`
      : live.some((job) => job.kind === "regroup")
        ? "Updating the study notes"
        : "Studying soon";
    return waiting ? `${what} · ${waiting} more after it` : what;
  });

  function ondrop(event: DragEvent): void {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    // Images join the question in the ask box; PDFs and Markdown are added to the course.
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length) void composer?.addImages(images);
    const paths = files
      .filter((file) => !file.type.startsWith("image/"))
      .map((file) => folio.api.pathForFile(file))
      .filter(Boolean);
    if (paths.length) void folio.importFiles(courseId, paths);
  }
</script>

{#snippet addRow(label: string, onclick: () => void)}
  <button
    class="-mx-2 mt-1 flex h-10 items-center gap-3 rounded-md px-2 text-left text-text-3 hover:bg-hover hover:text-text-2"
    {onclick}
  >
    <Plus size={15} strokeWidth={1.75} class="shrink-0" />
    {label}
  </button>
{/snippet}

{#snippet emptyState(text: string, label: string, onclick: () => void)}
  <div
    class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong px-6 py-12 text-center"
  >
    <span class="max-w-[420px] text-text-3">{text}</span>
    <button
      class="flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover dark:bg-raised"
      {onclick}
    >
      <Plus size={14} strokeWidth={1.75} />
      {label}
    </button>
  </div>
{/snippet}

{#if course}
  <div
    class="scroll-quiet relative h-full overflow-y-auto"
    role="region"
    aria-label={course.name}
    ondragenter={(event) => {
      event.preventDefault();
      dragging++;
    }}
    ondragleave={() => (dragging = Math.max(0, dragging - 1))}
    ondragover={(event) => event.preventDefault()}
    ondropcapture={() => (dragging = 0)}
    {ondrop}
  >
    <div class="mx-auto flex w-full max-w-[880px] flex-col px-10 pt-12 pb-16 max-sm:px-5">
      <div class="flex items-start gap-4">
        <CourseTile {course} size={40} />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <h1
            class="truncate text-[24px] leading-8 font-semibold tracking-[-0.015em] text-text"
            dir="auto"
          >
            {course.name}
          </h1>
          {#if details || studying}
            <p class="flex min-w-0 items-center gap-1.5 text-text-3">
              {#if details}<span class="truncate" dir="auto">{details}</span>{/if}
              {#if studying}
                {#if details}<span aria-hidden="true">·</span>{/if}
                <button
                  class="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-text"
                  onclick={() => folio.navigate({ view: "jobs" })}
                >
                  <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-highlight"></span>
                  <span class="truncate" dir="auto">{studying}</span>
                </button>
              {/if}
            </p>
          {/if}
          {#if due[0]}
            {@const next = due[0]}
            {@const late = !!next.dueAt && Date.parse(next.dueAt) < Date.now()}
            <button
              class="group mt-1 flex min-w-0 items-center gap-1.5 self-start text-left text-[13px] text-text-2 transition-colors hover:text-text"
              onclick={() => folio.navigate({ view: "assignments" })}
            >
              <span class={late ? "font-medium text-danger" : "text-text-3"}
                >{next.dueAt ? `Due ${relativeDue(next.dueAt, next.dueHasTime)}` : "To do"}</span
              >
              <span class="text-text-4" aria-hidden="true">·</span>
              <span class="min-w-0 truncate" dir="auto">{next.title}</span>
              {#if due.length > 1}
                <span class="shrink-0 text-text-3">and {due.length - 1} more</span>
              {/if}
              <ArrowRight
                size={12}
                strokeWidth={2}
                class="shrink-0 text-text-4 opacity-0 transition-opacity group-hover:opacity-100"
              />
            </button>
          {/if}
        </div>
        <div class="flex shrink-0 gap-1.5">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-text-3 transition-colors duration-150 hover:bg-hover hover:text-text active:bg-press data-[state=open]:bg-hover data-[state=open]:text-text"
              aria-label="More for {course.name}"
            >
              <Ellipsis size={16} strokeWidth={1.75} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="bottom"
                align="end"
                sideOffset={6}
                class="z-50 min-w-[240px] animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
              >
                <DropdownMenu.Item
                  class="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover"
                  onSelect={() => (editing = true)}
                >
                  <PencilLine size={14} strokeWidth={1.75} class="text-text-3" />
                  Edit course
                </DropdownMenu.Item>
                <DropdownMenu.Separator class="my-1.5 h-px bg-line-subtle" />
                {#if knowledge?.canRollBack}
                  <DropdownMenu.Item
                    class="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover"
                    onSelect={() => folio.rollbackKnowledge(courseId)}
                  >
                    <History size={14} strokeWidth={1.75} class="text-text-3" />
                    Restore previous study notes
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator class="my-1.5 h-px bg-line-subtle" />
                {/if}
                <DropdownMenu.Item
                  class="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-danger outline-none select-none data-[highlighted]:bg-hover"
                  onSelect={() => folio.trashCourse(courseId)}
                >
                  <Trash2 size={14} strokeWidth={1.75} />
                  Move course to Trash
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      <div class="mt-7">
        <Composer
          bind:this={composer}
          {paneId}
          chatId={null}
          {courseId}
          slim
          placeholder="Ask about {course.name}…"
          onbeforesend={() => folio.navigate({ view: "chat", chatId: null, courseId })}
        />
      </div>

      <div
        class="mt-9 flex items-end gap-6 overflow-x-auto border-b border-line-subtle [scrollbar-width:none]"
        role="tablist"
      >
        {#each COURSE_TABS as candidate (candidate.tab)}
          {@const active = candidate.tab === tab}
          <button
            role="tab"
            aria-selected={active}
            class="flex shrink-0 items-center gap-1.5 border-b-2 pb-2.5 font-medium transition-colors {active
              ? 'border-ink text-text'
              : 'border-transparent text-text-3 hover:text-text-2'}"
            onclick={() => folio.update({ tab: candidate.tab }, paneId)}
          >
            {candidate.label}
            <span class="text-[12px] font-normal text-text-3">{counts[candidate.tab]}</span>
          </button>
        {/each}
      </div>

      <div class="mt-5">
        {#if tab === "study"}
          <StudyNotesList {courseId} />
        {:else if tab === "notes"}
          {#if notes.length}
            <div class="-mx-3 flex flex-col">
              {#each notes as note (note.id)}
                <NoteRow
                  {note}
                  showCourse={false}
                  onopen={(newTab) => folio.openNote(note.id, { newTab, courseId })}
                  ontag={() => folio.openNote(note.id, { courseId })}
                />
              {/each}
            </div>
            <div class="flex flex-col">
              {@render addRow("New note", () => folio.createNote(courseId))}
            </div>
          {:else}
            {@render emptyState(
              `Notes for ${course.name}, in Markdown. Write your own, quote a passage from the reader, or ask the tutor to write or change one for you; every change can be undone.`,
              "New note",
              () => folio.createNote(courseId),
            )}
          {/if}
        {:else if tab === "chats"}
          <ChatList
            {chats}
            empty="No chats in this course yet. Ask above to start one."
          />
        {:else if sections.length}
          <div class="flex flex-col gap-6">
            {#each sections as section (section.category.id)}
              <DocumentTable
                title={section.category.plural}
                documents={section.documents}
                showStudy={section.category.kind === "lecture" ||
                  section.category.kind === "recitation"}
                showDue={section.category.kind === "assignment"}
              />
            {/each}
          </div>
          {@render addRow("Add files", () =>
            folio.importFiles(courseId, "choose"),
          )}
        {:else}
          {@render emptyState(
            "Drop lecture PDFs or Markdown files here. Originals are copied in and never modified.",
            "Add files",
            () => folio.importFiles(courseId, "choose"),
          )}
        {/if}
      </div>
    </div>

    {#if dragging}
      <div
        class="pointer-events-none absolute inset-3 flex animate-[folio-fade_120ms_ease-out] items-center justify-center rounded-2xl border-2 border-dashed border-line-strong bg-surface/85 backdrop-blur-[2px]"
      >
        <div class="flex flex-col items-center gap-2">
          <Upload size={22} strokeWidth={1.75} class="text-text-2" />
          <span class="font-medium text-text">Drop to add to {course.name}</span
          >
          <span class="text-[12px] text-text-3"
            >PDF and Markdown · originals are never modified</span
          >
        </div>
      </div>
    {/if}
  </div>
  <CourseDetailsDialog {course} bind:open={editing} />
{/if}
