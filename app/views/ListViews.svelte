<script lang="ts">
  import { Search, SquarePen, Upload } from "@lucide/svelte";
  import type { DocumentRole } from "../../src/desktop/api.ts";
  import ChatList from "../components/ChatList.svelte";
  import DocumentTable from "../components/DocumentTable.svelte";
  import { ROLE_LABEL, ROLES } from "../lib/labels.ts";
  import { folio } from "../lib/state.svelte.ts";

  /** Library, Chats and Assignments: the list-shaped places in the sidebar. */
  let { view }: { view: "library" | "chats" | "assignments" } = $props();

  let courseFilter = $state("");
  let roleFilter = $state<DocumentRole | "">("");
  let query = $state("");

  const library = $derived(
    folio.documents.filter(
      (document) =>
        (!courseFilter || document.courseId === courseFilter) &&
        (!roleFilter || document.role === roleFilter) &&
        (!query.trim() ||
          document.title.toLowerCase().includes(query.trim().toLowerCase())),
    ),
  );
  const assignments = $derived(
    folio.documents
      .filter((document) => document.role === "assignment")
      .sort((a, b) => (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9")),
  );
  const chats = $derived(
    folio.chats.filter(
      (chat) =>
        (!courseFilter || chat.courseId === courseFilter) &&
        (!query.trim() ||
          chat.title.toLowerCase().includes(query.trim().toLowerCase())),
    ),
  );
  const title = {
    library: "Library",
    chats: "Chats",
    assignments: "Assignments",
  };
</script>

<div class="scroll-quiet h-full overflow-y-auto">
  <div
    class="mx-auto flex w-full max-w-[960px] flex-col px-8 pt-10 pb-16 max-sm:px-4"
  >
    <div class="flex items-center gap-3">
      <h1
        class="flex-1 text-[24px] leading-8 font-semibold tracking-[-0.015em] text-text"
      >
        {title[view]}
      </h1>
      {#if view === "library"}
        <button
          class="flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover disabled:opacity-40 dark:bg-raised"
          disabled={!courseFilter}
          title={courseFilter ? "" : "Pick a course first"}
          onclick={() => folio.importFiles(courseFilter, "choose")}
        >
          <Upload size={14} strokeWidth={1.75} /> Add files
        </button>
      {:else if view === "chats"}
        <button
          class="flex h-8 items-center gap-2 rounded-md bg-ink px-3 font-medium text-on-ink shadow-1 hover:opacity-90"
          onclick={() => folio.newChat(courseFilter || null)}
        >
          <SquarePen size={14} strokeWidth={1.75} /> New chat
        </button>
      {/if}
    </div>

    {#if view === "library" || view === "chats"}
      <div class="mt-6 flex flex-wrap items-center gap-2">
        <label
          class="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-line-subtle bg-surface px-2.5 shadow-1 focus-within:border-line-strong dark:bg-raised"
        >
          <Search size={14} strokeWidth={1.75} class="text-text-3" />
          <input
            bind:value={query}
            placeholder={view === "library"
              ? "Filter documents"
              : "Filter chats"}
            class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-3"
          />
        </label>
        <select
          bind:value={courseFilter}
          class="h-8 rounded-md border border-line-subtle bg-surface px-2 text-text-2 shadow-1 dark:bg-raised"
          aria-label="Course"
        >
          <option value="">All courses</option>
          {#each folio.courses as course (course.id)}<option value={course.id}
              >{course.name}</option
            >{/each}
        </select>
        {#if view === "library"}
          <select
            bind:value={roleFilter}
            class="h-8 rounded-md border border-line-subtle bg-surface px-2 text-text-2 shadow-1 dark:bg-raised"
            aria-label="Role"
          >
            <option value="">All roles</option>
            {#each ROLES as role (role)}<option value={role}
                >{ROLE_LABEL[role]}</option
              >{/each}
          </select>
        {/if}
      </div>
    {/if}

    <div class="mt-6">
      {#if view === "library"}
        <DocumentTable
          documents={library}
          showCourse
          empty={folio.courses.length
            ? "No documents match."
            : "Add a course, then drop its lectures into it."}
        />
      {:else if view === "assignments"}
        <p class="-mt-2 mb-5 text-text-3">
          Every assignment across your courses. Set a due date and it shows in
          the sidebar when it's close.
        </p>
        <DocumentTable
          documents={assignments}
          showCourse
          showDue
          empty="No assignments yet. Files named like hw3.pdf are filed here, or change any file's role to Assignment."
        />
      {:else}
        <ChatList {chats} showCourse empty="No chats yet." />
      {/if}
    </div>
  </div>
</div>
