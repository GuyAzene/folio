<script lang="ts">
  import {
    Check,
    FileText,
    FolderOpen,
    GraduationCap,
    Plus,
    X,
  } from "@lucide/svelte";
  import { Dialog } from "bits-ui";
  import type {
    DocumentRole,
    FolderScanView,
    Pencil,
    SyllabusDraft,
  } from "../../src/desktop/api.ts";
  import { PENCIL, PENCILS, ROLE_DOT, ROLE_LABEL } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";
  import FolioMark from "./FolioMark.svelte";

  type Start = "syllabus" | "folder" | "empty";

  let start = $state<Start>("syllabus");
  let name = $state("");
  let code = $state("");
  let term = $state("");
  let color = $state<Pencil>("blue");
  /** Fields Folio filled in; they stay marked until the student edits them. */
  let filled = $state<Record<"name" | "code" | "term", boolean>>({
    name: false,
    code: false,
    term: false,
  });
  let syllabus = $state<SyllabusDraft | null>(null);
  let folder = $state<FolderScanView | null>(null);
  /** Files the student unticked in the scanned folder. */
  let skipped = $state<Record<string, boolean>>({});
  let busy = $state<"reading" | "scanning" | "saving" | null>(null);
  let dragging = $state(false);

  const files = $derived(
    folder?.files.filter((file) => !skipped[file.path]) ?? [],
  );
  const roleCounts = $derived.by(() => {
    const counts = new Map<DocumentRole, number>();
    for (const file of files)
      counts.set(file.role, (counts.get(file.role) ?? 0) + 1);
    return [...counts];
  });
  const summary = $derived(
    [
      name.trim() || "New course",
      code.trim(),
      start === "folder" && folder
        ? `${files.length} file${files.length === 1 ? "" : "s"}`
        : start === "syllabus" && syllabus
          ? "with its syllabus"
          : start === "empty"
            ? "empty for now"
            : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );

  const starts: { start: Start; title: string; caption: string }[] = [
    {
      start: "syllabus",
      title: "From a syllabus",
      caption: "Folio reads it and fills in the course.",
    },
    {
      start: "folder",
      title: "From a folder",
      caption: "Folio sorts lectures, recitations and homework.",
    },
    {
      start: "empty",
      title: "Empty course",
      caption: "Name it and add files later.",
    },
  ];

  $effect(() => {
    if (!folio.newCourseOpen) return;
    start = "syllabus";
    name = "";
    code = "";
    term = folio.courses.at(-1)?.term ?? "";
    color = PENCILS[(folio.courses.length + 1) % PENCILS.length]!;
    filled = { name: false, code: false, term: false };
    syllabus = null;
    folder = null;
    skipped = {};
    busy = null;
  });

  function fill(details: {
    name?: string;
    code?: string;
    term?: string;
  }): void {
    for (const key of ["name", "code", "term"] as const) {
      const value = details[key]?.trim();
      if (!value) continue;
      if (key === "name") name = value;
      if (key === "code") code = value;
      if (key === "term") term = value;
      filled[key] = true;
    }
  }

  async function readSyllabus(path: string | null): Promise<void> {
    busy = "reading";
    try {
      const draft = await folio.api.readSyllabus(path);
      if (draft) {
        syllabus = draft;
        fill(draft);
      }
    } catch (error) {
      folio.error =
        error instanceof Error
          ? error.message
          : "The syllabus could not be read.";
    }
    busy = null;
  }

  async function scan(path: string | null): Promise<void> {
    busy = "scanning";
    try {
      const scanned = await folio.api.scanFolder(path);
      if (scanned) {
        folder = scanned;
        skipped = {};
        if (!name.trim()) fill({ name: scanned.folderName });
      }
    } catch (error) {
      folio.error =
        error instanceof Error
          ? error.message
          : "The folder could not be read.";
    }
    busy = null;
  }

  function ondrop(event: DragEvent): void {
    event.preventDefault();
    dragging = false;
    const file = event.dataTransfer?.files[0];
    const path = file ? folio.api.pathForFile(file) : "";
    if (!path) return;
    if (start === "folder") void scan(path);
    else {
      start = "syllabus";
      void readSyllabus(path);
    }
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim() || busy) return;
    busy = "saving";
    const course = await folio.createCourse({ name, code, term, color });
    busy = null;
    if (!course) return;
    folio.newCourseOpen = false;
    folio.navigate({ view: "course", courseId: course.id, tab: "materials" });
    if (start === "folder" && files.length)
      void folio.importFiles(
        course.id,
        files.map((file) => file.path),
      );
    else if (start === "syllabus" && syllabus)
      void folio.importFiles(course.id, [syllabus.path], "asset");
  }

  const input =
    "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 outline-none transition-colors placeholder:text-text-4 focus:border-ink dark:bg-sunken";
</script>

{#snippet details()}
  <div
    class="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 max-sm:grid-cols-1"
  >
    {#each [{ key: "name", label: "Name", placeholder: "Algorithms", max: 80 }, { key: "code", label: "Code", placeholder: "CS 201", max: 24 }, { key: "term", label: "Term", placeholder: "Spring 2026", max: 40 }] as field (field.key)}
      {@const key = field.key as "name" | "code" | "term"}
      <label class="flex min-w-0 flex-col gap-1.5">
        <span
          class="flex items-center gap-1.5 text-[12px] font-medium text-text-2"
        >
          {field.label}
          {#if filled[key]}<span
              class="size-1.5 rounded-full bg-highlight"
              title="Filled in by Folio"
            ></span>{/if}
        </span>
        {#if key === "name"}
          <input
            bind:value={name}
            required
            maxlength={field.max}
            placeholder={field.placeholder}
            oninput={() => (filled.name = false)}
            class="{input} {filled.name ? 'bg-highlight-wash/50' : ''}"
          />
        {:else if key === "code"}
          <input
            bind:value={code}
            maxlength={field.max}
            placeholder={field.placeholder}
            oninput={() => (filled.code = false)}
            class="{input} {filled.code ? 'bg-highlight-wash/50' : ''}"
          />
        {:else}
          <input
            bind:value={term}
            maxlength={field.max}
            placeholder={field.placeholder}
            oninput={() => (filled.term = false)}
            class="{input} {filled.term ? 'bg-highlight-wash/50' : ''}"
          />
        {/if}
      </label>
    {/each}
  </div>
  <div class="flex items-center gap-3">
    <span class="text-[12px] font-medium text-text-2">Color</span>
    <div class="flex gap-1.5">
      {#each PENCILS as pencil (pencil)}
        <button
          type="button"
          class="size-5 rounded-full transition-transform {color === pencil
            ? 'scale-110 ring-2 ring-offset-2 ring-offset-raised'
            : 'hover:scale-110'}"
          style="background:{PENCIL[pencil]};--tw-ring-color:{PENCIL[pencil]}"
          aria-label={pencil}
          aria-pressed={color === pencil}
          onclick={() => (color = pencil)}
        ></button>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet dropzone(
  icon: "file" | "folder",
  title: string,
  hint: string,
  action: string,
  onchoose: () => void,
)}
  <div
    class="flex items-center gap-4 rounded-xl border border-dashed px-4 py-4 transition-colors {dragging
      ? 'border-ink bg-hover'
      : 'border-line-strong'}"
  >
    <span
      class="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-sunken text-text-2 dark:bg-surface"
    >
      {#if icon === "file"}<FileText
          size={18}
          strokeWidth={1.75}
        />{:else}<FolderOpen size={18} strokeWidth={1.75} />{/if}
    </span>
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="font-medium text-text">{title}</span>
      <span class="text-[12px] text-text-3">{hint}</span>
    </div>
    <button
      type="button"
      class="h-8 shrink-0 rounded-full border border-line bg-surface px-3.5 font-medium shadow-1 hover:bg-hover dark:bg-raised"
      onclick={onchoose}>{action}</button
    >
  </div>
{/snippet}

<Dialog.Root bind:open={folio.newCourseOpen}>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-40 animate-[folio-fade_150ms_ease-out] bg-[#18181b]/20 backdrop-blur-[2px] dark:bg-black/50"
    />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-32px)] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 animate-[folio-scale_180ms_var(--ease-out-quint)] flex-col overflow-hidden rounded-[20px] border border-line-subtle bg-raised shadow-3 outline-none"
    >
      <form class="flex min-h-0 flex-col" onsubmit={create}>
        <div
          class="scroll-quiet flex min-h-0 flex-col gap-5 overflow-y-auto px-6 pt-6 pb-6 max-sm:px-4"
          role="region"
          aria-label="Course details"
          ondragover={(event) => {
            event.preventDefault();
            dragging = true;
          }}
          ondragleave={() => (dragging = false)}
          {ondrop}
        >
          <div class="flex items-start gap-4">
            <span
              class="inline-flex size-11 shrink-0 items-center justify-center rounded-[13px] bg-highlight-wash text-[#18181b]"
            >
              <GraduationCap size={20} strokeWidth={1.75} />
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <Dialog.Title
                class="text-[18px] leading-6 font-semibold tracking-[-0.015em] text-text"
                >New course</Dialog.Title
              >
              <Dialog.Description class="text-text-2"
                >Start from what you already have. Everything stays editable.</Dialog.Description
              >
            </div>
            <Dialog.Close
              type="button"
              class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line-subtle text-text-3 hover:bg-hover hover:text-text"
              aria-label="Close"
            >
              <X size={15} strokeWidth={1.75} />
            </Dialog.Close>
          </div>

          <div class="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
            {#each starts as option (option.start)}
              {@const selected = start === option.start}
              <button
                type="button"
                aria-pressed={selected}
                class="flex flex-col gap-3 rounded-2xl border bg-surface p-2 pb-3.5 text-left transition-[border-color,box-shadow,transform] duration-150 active:scale-[0.99] dark:bg-sunken {selected
                  ? 'border-ink shadow-[0_0_0_1px_var(--ink)]'
                  : 'border-line hover:border-line-strong'}"
                onclick={() => (start = option.start)}
              >
                <div
                  class="relative h-[118px] overflow-hidden rounded-xl"
                  style="background:{option.start === 'syllabus'
                    ? 'color-mix(in srgb, var(--highlight) 22%, var(--surface))'
                    : option.start === 'folder'
                      ? `color-mix(in srgb, ${PENCIL.blue} 13%, var(--surface))`
                      : `color-mix(in srgb, ${PENCIL[color]} 13%, var(--surface))`}"
                >
                  {#if option.start === "syllabus"}
                    <div
                      class="absolute inset-x-7 top-4 bottom-0 flex flex-col gap-2 rounded-t-lg bg-surface p-3 shadow-[0_1px_3px_#18181b1a] dark:bg-raised"
                    >
                      <div class="h-1.5 w-14 rounded-full bg-text/70"></div>
                      <div class="relative h-1.5 w-[85%] rounded-full bg-line">
                        <span
                          class="absolute -inset-y-[3px] -left-1 w-[72%] rounded-[3px] bg-highlight/80"
                        ></span>
                      </div>
                      <div class="h-1.5 w-[70%] rounded-full bg-line"></div>
                      <div class="h-1.5 w-[80%] rounded-full bg-line"></div>
                      <div class="h-1.5 w-[55%] rounded-full bg-line"></div>
                    </div>
                    <span
                      class="absolute right-3 bottom-3 rounded-[7px] shadow-2"
                    >
                      <FolioMark size={22} />
                    </span>
                  {:else if option.start === "folder"}
                    {#each [{ rotate: -12, x: -26, role: "lecture" }, { rotate: 0, x: 0, role: "recitation" }, { rotate: 12, x: 26, role: "assignment" }] as sheet (sheet.role)}
                      <div
                        class="absolute bottom-7 left-1/2 flex h-[64px] w-[48px] flex-col gap-1.5 rounded-md bg-surface p-2 shadow-[0_1px_3px_#18181b1f] transition-transform duration-300 dark:bg-raised"
                        style="transform:translateX(calc(-50% + {sheet.x}px)) rotate({sheet.rotate}deg)"
                      >
                        <span
                          class="size-1.5 rounded-[2px]"
                          style="background:{ROLE_DOT[
                            sheet.role as DocumentRole
                          ]}"
                        ></span>
                        <span class="h-1 w-full rounded-full bg-line"></span>
                        <span class="h-1 w-3/4 rounded-full bg-line"></span>
                      </div>
                    {/each}
                    <div
                      class="absolute bottom-0 left-1/2 h-11 w-[124px] -translate-x-1/2 rounded-t-xl"
                      style="background:color-mix(in srgb, {PENCIL.blue} 30%, var(--surface))"
                    ></div>
                  {:else}
                    <div
                      class="absolute inset-x-7 top-4 bottom-0 flex flex-col gap-2.5 rounded-t-lg bg-surface p-3 shadow-[0_1px_3px_#18181b1a] dark:bg-raised"
                    >
                      <div class="flex items-center gap-1.5">
                        <span
                          class="inline-flex size-4 items-center justify-center rounded-[4px] font-serif text-[9px] text-white"
                          style="background:{PENCIL[color]}"
                          >{(name.trim()[0] ?? "A").toUpperCase()}</span
                        >
                        <span class="h-1.5 w-14 rounded-full bg-text/70"></span>
                      </div>
                      <div class="flex gap-1.5">
                        <span class="h-1 w-6 rounded-full bg-text/60"></span>
                        <span class="h-1 w-6 rounded-full bg-line"></span>
                        <span class="h-1 w-6 rounded-full bg-line"></span>
                      </div>
                      <div
                        class="h-8 rounded-md border border-dashed border-line-strong"
                      ></div>
                    </div>
                  {/if}
                  {#if selected}
                    <span
                      class="absolute top-2 right-2 inline-flex size-5 animate-[folio-scale_160ms_var(--ease-out-quint)] items-center justify-center rounded-full bg-ink text-on-ink shadow-1"
                    >
                      <Check size={12} strokeWidth={3} />
                    </span>
                  {/if}
                </div>
                <div class="flex flex-col gap-0.5 px-1.5">
                  <span
                    class="flex items-center gap-1.5 text-[14px] font-semibold tracking-[-0.01em] text-text"
                  >
                    {option.title}
                    {#if option.start === "syllabus"}<span
                        class="rounded-[4px] bg-highlight px-1 py-px text-[10px] font-semibold text-[#18181b]"
                        >Folio</span
                      >{/if}
                  </span>
                  <span class="text-[12px] leading-[17px] text-text-3"
                    >{option.caption}</span
                  >
                </div>
              </button>
            {/each}
          </div>

          <div class="flex flex-col gap-4">
            {#if start === "syllabus"}
              {#if busy === "reading"}
                <div
                  class="flex items-center gap-3 rounded-xl bg-sunken px-4 py-4 dark:bg-surface"
                >
                  <FolioMark size={20} working />
                  <span class="text-text-2">Reading the syllabus…</span>
                </div>
              {:else if syllabus}
                <div
                  class="flex items-center gap-3 rounded-xl bg-sunken px-3.5 py-3 dark:bg-surface"
                >
                  <FileText
                    size={16}
                    strokeWidth={1.75}
                    class="shrink-0 text-text-3"
                  />
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate font-medium text-text"
                      >{syllabus.fileName}</span
                    >
                    <span class="text-[12px] text-text-3"
                      >{syllabus.read
                        ? "Folio filled in the details below. Check them before you create the course."
                        : syllabus.note}</span
                    >
                  </div>
                  <button
                    type="button"
                    class="shrink-0 text-[12px] font-medium text-text-2 hover:text-text"
                    onclick={() => readSyllabus(null)}>Change</button
                  >
                </div>
              {:else}
                {@render dropzone(
                  "file",
                  "Drop the syllabus here",
                  "PDF or Markdown. It's added to the course, untouched.",
                  "Choose file",
                  () => readSyllabus(null),
                )}
              {/if}
            {:else if start === "folder"}
              {#if busy === "scanning"}
                <div
                  class="flex items-center gap-3 rounded-xl bg-sunken px-4 py-4 dark:bg-surface"
                >
                  <FolioMark size={20} working />
                  <span class="text-text-2">Looking through the folder…</span>
                </div>
              {:else if folder}
                <div
                  class="flex flex-col gap-2.5 rounded-xl bg-sunken p-3.5 dark:bg-surface"
                >
                  <div class="flex items-center gap-3">
                    <FolderOpen
                      size={16}
                      strokeWidth={1.75}
                      class="shrink-0 text-text-3"
                    />
                    <span class="min-w-0 flex-1 truncate font-medium text-text"
                      >{folder.folderName}</span
                    >
                    <button
                      type="button"
                      class="shrink-0 text-[12px] font-medium text-text-2 hover:text-text"
                      onclick={() => scan(null)}>Change</button
                    >
                  </div>
                  {#if folder.files.length}
                    <div class="flex flex-wrap gap-1.5">
                      {#each roleCounts as [role, count] (role)}
                        <span
                          class="inline-flex h-6 items-center gap-1.5 rounded-full border border-line-subtle bg-surface px-2 text-[12px] text-text-2 dark:bg-raised"
                        >
                          <span
                            class="size-1.5 rounded-[2px]"
                            style="background:{ROLE_DOT[role]}"
                          ></span>
                          {count}
                          {ROLE_LABEL[role].toLowerCase()}{count === 1 ||
                          role === "asset"
                            ? ""
                            : "s"}
                        </span>
                      {/each}
                    </div>
                    <div
                      class="scroll-quiet -mx-1.5 flex max-h-[148px] flex-col overflow-y-auto"
                    >
                      {#each folder.files as file (file.path)}
                        <label
                          class="flex h-8 shrink-0 cursor-default items-center gap-2.5 rounded-md px-1.5 hover:bg-hover"
                        >
                          <input
                            type="checkbox"
                            checked={!skipped[file.path]}
                            onchange={(event) =>
                              (skipped[file.path] =
                                !event.currentTarget.checked)}
                            class="size-3.5 accent-[var(--ink)]"
                          />
                          <span
                            class="min-w-0 flex-1 truncate text-[13px] text-text"
                            >{file.name}</span
                          >
                          <span class="text-[12px] text-text-3"
                            >{ROLE_LABEL[file.role]}</span
                          >
                        </label>
                      {/each}
                    </div>
                    <span class="text-[12px] text-text-3">
                      Untick anything that isn't for this course. Folio copies
                      the rest in and never changes your folder.{folder.skipped
                        ? ` ${folder.skipped} other file${folder.skipped === 1 ? " isn't" : "s aren't"} PDF or Markdown.`
                        : ""}{folder.truncated
                        ? " Only the first 400 files are listed."
                        : ""}
                    </span>
                  {:else}
                    <span class="text-[12px] text-text-3"
                      >No PDFs or Markdown files here. Pick another folder, or
                      create the course and add files later.</span
                    >
                  {/if}
                </div>
              {:else}
                {@render dropzone(
                  "folder",
                  "Drop a course folder here",
                  "Folio finds the PDFs and Markdown and sorts them by type.",
                  "Choose folder",
                  () => scan(null),
                )}
              {/if}
            {/if}
            {@render details()}
          </div>
        </div>

        <div
          class="flex shrink-0 items-center gap-3 border-t border-line-subtle bg-sunken px-6 py-3.5 max-sm:px-4 dark:bg-surface"
        >
          <span class="min-w-0 flex-1 truncate text-text-3">{summary}</span>
          <Dialog.Close
            type="button"
            class="h-9 shrink-0 rounded-full border border-line bg-surface px-4 font-medium shadow-1 hover:bg-hover dark:bg-raised"
            >Cancel</Dialog.Close
          >
          <button
            type="submit"
            disabled={!name.trim() || !!busy}
            class="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-ink px-4 font-medium text-on-ink shadow-2 transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Plus size={15} strokeWidth={2} /> Create course
          </button>
        </div>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
