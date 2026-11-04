<script lang="ts">
  import { Plus, Search, X } from "@lucide/svelte";
  import CourseTile from "../components/CourseTile.svelte";
  import DocumentTable from "../components/DocumentTable.svelte";
  import Select from "../components/Select.svelte";
  import { materialSections } from "../lib/course-tabs.ts";
  import { ROLE_DOT } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * The Library: every course's files, one quiet section per course, in the sidebar's order.
   * A search and a category narrow it; each section adds files to its own course.
   */
  let { view }: { view: "library" } = $props();

  /** The filter's "everything" choice. */
  const ALL = "all";
  let categoryFilter = $state("");
  let query = $state("");

  const sections = $derived(
    folio.courses.flatMap((course) => {
      const matching = folio.documents.filter(
        (document) =>
          document.courseId === course.id &&
          (!categoryFilter || folio.categoryOf(document).id === categoryFilter) &&
          (!query.trim() || document.title.toLowerCase().includes(query.trim().toLowerCase())),
      );
      // In the course's own order: by category, then by number.
      const documents = materialSections(matching, folio.categories).flatMap(
        (section) => section.documents,
      );
      return documents.length ? [{ course, documents }] : [];
    }),
  );
  const filtering = $derived(!!categoryFilter || !!query.trim());
</script>

<div class="scroll-quiet h-full overflow-y-auto" data-view={view}>
  <div class="mx-auto flex w-full max-w-[880px] flex-col px-10 pt-12 pb-16 max-sm:px-5">
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="flex-1 text-[24px] leading-8 font-semibold tracking-[-0.015em] text-text">
        Library
      </h1>
      <label
        class="flex h-8 w-[240px] items-center gap-2 rounded-md bg-sunken px-2.5 text-text-3 transition-colors focus-within:bg-hover max-sm:w-full dark:bg-raised"
      >
        <Search size={14} strokeWidth={1.75} class="shrink-0" />
        <input
          bind:value={query}
          placeholder="Search files"
          aria-label="Search files"
          class="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-3"
          dir="auto"
          onkeydown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              query = "";
            }
          }}
        />
        {#if query}
          <button
            type="button"
            class="flex size-5 shrink-0 items-center justify-center rounded text-text-3 hover:bg-hover hover:text-text"
            aria-label="Clear search"
            onclick={() => (query = "")}><X size={12} strokeWidth={2} /></button
          >
        {/if}
      </label>
      <Select
        label="Category"
        value={categoryFilter || ALL}
        options={[
          { value: ALL, label: "All categories" },
          ...folio.categories.map((category) => ({
            value: category.id,
            label: category.plural,
            dot: ROLE_DOT[category.kind],
          })),
        ]}
        onchange={(value) => (categoryFilter = value === ALL ? "" : value)}
      />
    </div>

    <div class="mt-8 flex flex-col gap-9">
      {#each sections as section (section.course.id)}
        <section aria-label={section.course.name}>
          <div class="flex h-8 items-center gap-2.5">
            <button
              class="flex min-w-0 items-center gap-2.5 rounded-md text-left font-medium text-text transition-colors hover:text-text-2"
              onclick={(event) =>
                folio.navigate(
                  { view: "course", courseId: section.course.id, tab: "materials" },
                  { newTab: event.metaKey || event.ctrlKey },
                )}
            >
              <CourseTile course={section.course} size={18} />
              <span class="min-w-0 truncate" dir="auto">{section.course.name}</span>
            </button>
            <span class="shrink-0 text-[12px] text-text-4 tabular-nums">{section.documents.length}</span>
            <span class="flex-1"></span>
            <button
              class="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 whitespace-nowrap text-[12.5px] text-text-3 transition-colors hover:bg-hover hover:text-text"
              onclick={() => folio.importFiles(section.course.id, "choose")}
            >
              <Plus size={13} strokeWidth={2} /> Add files
            </button>
          </div>
          <div class="mt-1">
            <DocumentTable documents={section.documents} showCategory empty="" />
          </div>
        </section>
      {:else}
        <p class="py-16 text-center text-text-3">
          {filtering
            ? "No files match."
            : folio.courses.length
              ? "No files yet. Add a course's lectures from its page, or drop them on it."
              : "Add a course, then drop its lectures into it."}
        </p>
      {/each}
    </div>
  </div>
</div>
