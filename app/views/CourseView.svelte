<script lang="ts">
  import {
    Ellipsis,
    History,
    NotebookPen,
    Plus,
    Trash2,
    Upload,
  } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import ChatList from "../components/ChatList.svelte";
  import Composer from "../components/Composer.svelte";
  import CourseTile from "../components/CourseTile.svelte";
  import DocumentTable from "../components/DocumentTable.svelte";
  import StudyNotesList from "../components/StudyNotesList.svelte";
  import { COURSE_TABS, MATERIAL_SECTIONS } from "../lib/course-tabs.ts";
  import { formatDate } from "../lib/labels.ts";
  import { folio, type CourseTab } from "../lib/state.svelte.ts";

  let {
    tabId,
    courseId,
    tab,
  }: { tabId: string; courseId: string; tab: CourseTab } = $props();
  let dragging = $state(0);
  let ask = $state<Composer>();

  const course = $derived(folio.course(courseId));
  const documents = $derived(
    folio.documents.filter((document) => document.courseId === courseId),
  );
  const sections = $derived(
    MATERIAL_SECTIONS.map((section) => ({
      ...section,
      documents: documents.filter((document) =>
        section.roles.includes(document.role),
      ),
    })).filter((section) => section.documents.length),
  );
  const knowledge = $derived(folio.knowledge[courseId] ?? null);
  const teaching = $derived(
    documents.filter(
      (document) =>
        document.role === "lecture" || document.role === "recitation",
    ),
  );
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

  function ondrop(event: DragEvent): void {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    // Images join the question in the ask box; PDFs and Markdown are added to the course.
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length) void ask?.addImages(images);
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
    <div
      class="mx-auto flex w-full max-w-[960px] flex-col px-8 pt-10 pb-16 max-sm:px-4"
    >
      <div class="flex items-start gap-4">
        <CourseTile {course} size={44} />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <h1
            class="truncate text-[24px] leading-8 font-semibold tracking-[-0.015em] text-text"
            dir="auto"
          >
            {course.name}
          </h1>
          {#if details || teaching.length}
            <span
              class="flex flex-wrap items-center gap-x-2 gap-y-1 text-text-3"
            >
              {#if details}<span>{details}</span>{/if}
              {#if details && teaching.length}<span class="text-text-4">·</span
                >{/if}
              {#if teaching.length}
                <span class="inline-flex items-center gap-1.5">
                  <span
                    class="size-1.5 rounded-full {knowledge
                      ? 'bg-success'
                      : 'bg-line-strong'}"
                  ></span>
                  {knowledge
                    ? `Studied ${knowledge.sessions.length} of ${teaching.length}`
                    : "Not studied yet"}
                </span>
              {/if}
            </span>
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
          bind:this={ask}
          {tabId}
          chatId={null}
          {courseId}
          slim
          placeholder="Ask about {course.name}…"
          onbeforesend={() =>
            folio.navigate({ view: "chat", chatId: null, courseId })}
        />
      </div>

      <div
        class="mt-8 flex items-end gap-6 overflow-x-auto border-b border-line-subtle [scrollbar-width:none]"
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
            onclick={() => folio.update({ tab: candidate.tab })}
          >
            {candidate.label}
            <span class="text-[12px] font-normal text-text-3"
              >{counts[candidate.tab]}</span
            >
          </button>
        {/each}
      </div>

      <div class="mt-6">
        {#if tab === "study"}
          <StudyNotesList {courseId} />
        {:else if tab === "notes"}
          {#if notes.length}
            <div class="flex flex-col">
              {#each notes as note (note.id)}
                <div
                  class="group -mx-2 flex h-10 items-center rounded-md hover:bg-hover"
                >
                  <button
                    class="flex h-10 min-w-0 flex-1 items-center gap-3 px-2 text-left"
                    onclick={(event) =>
                      folio.openNote(note.id, {
                        newTab: event.metaKey || event.ctrlKey,
                      })}
                  >
                    <NotebookPen
                      size={15}
                      strokeWidth={1.75}
                      class="shrink-0 text-text-3"
                    />
                    <span
                      class="min-w-0 flex-1 truncate font-medium text-text"
                      dir="auto">{note.title}</span
                    >
                    <span class="text-[12px] text-text-3"
                      >{formatDate(note.updatedAt)}</span
                    >
                  </button>
                  <button
                    type="button"
                    class="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-text-4 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-press hover:text-danger focus-visible:opacity-100"
                    title="Move to Trash"
                    aria-label="Move {note.title} to Trash"
                    onclick={() => folio.trashNote(note.id)}
                  >
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                </div>
              {/each}
              {@render addRow("New note", () => folio.createNote(courseId))}
            </div>
          {:else}
            {@render emptyState(
              `Your own notes for ${course.name}, in Markdown. Quote a passage from the reader, or ask Folio to draft one for you to review.`,
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
          <div class="flex flex-col gap-4">
            {#each sections as section (section.title)}
              <DocumentTable
                title={section.title}
                documents={section.documents}
                showStudy={section.roles.includes("lecture") ||
                  section.roles.includes("recitation")}
                showDue={section.roles.includes("assignment")}
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
{/if}
