<script lang="ts">
  import { FileText, ImagePlus, Plus, ScanText } from "@lucide/svelte";
  import { Command, Popover } from "bits-ui";
  import type { DocumentView, Focus } from "../../src/desktop/api.ts";
  import type { Picked } from "../lib/attachments.ts";
  import { MATERIAL_SECTIONS } from "../lib/course-tabs.ts";
  import { searchScore, shortTitle } from "../lib/titles.ts";
  import { folio } from "../lib/state.svelte.ts";
  import CourseTile from "./CourseTile.svelte";

  /**
   * The composer's +: add the page in view, an image, a lecture or a course to the question.
   * Lectures, files and courses are found by searching, never listed up front; a course chat's
   * own materials come first among the results.
   */
  let {
    courseId,
    focus,
    added,
    onpick,
    onimages,
  }: {
    /** The chat's course; null for a chat that reads the whole library. */
    courseId: string | null;
    focus: Focus | null;
    /** Keys of what is already in the question, which the menu leaves out. */
    added: string[];
    onpick: (input: Picked) => void;
    onimages: (files: File[]) => void;
  } = $props();

  let open = $state(false);
  let query = $state("");
  let picker = $state<HTMLInputElement>();

  const reading = $derived(
    focus ? folio.document(focus.documentId) : undefined,
  );
  const pageKey = $derived(
    focus ? `page:${focus.documentId}:${focus.page}` : "",
  );
  const searching = $derived(query.trim().length > 0);
  const order = (document: DocumentView) =>
    (document.courseId === courseId ? 0 : 10) +
    MATERIAL_SECTIONS.findIndex((section) =>
      section.roles.includes(document.role),
    );
  const documents = $derived(
    folio.documents
      .filter((document) => !added.includes(`document:${document.id}`))
      .sort((a, b) => order(a) - order(b)),
  );
  const courses = $derived(
    folio.courses.filter(
      (candidate) =>
        candidate.id !== courseId && !added.includes(`course:${candidate.id}`),
    ),
  );

  $effect(() => {
    if (open) query = "";
  });

  function pick(input: Picked): void {
    open = false;
    onpick(input);
  }

  const item =
    "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-text outline-none select-none data-[selected]:bg-hover";
  const heading =
    "px-2.5 pt-2.5 pb-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase";
</script>

{#snippet documentRow(document: DocumentView)}
  {@const home = folio.course(document.courseId)}
  {@const showCourse = document.courseId !== courseId}
  <Command.Item
    value={`${document.title} ${home?.name ?? ""} ${home?.code ?? ""} ${document.id}`}
    onSelect={() => pick({ kind: "document", documentId: document.id })}
    class={item}
  >
    <FileText size={15} strokeWidth={1.75} class="shrink-0 text-text-3" />
    <!-- The chat's course, or the course named beside it, already says which course. -->
    <span class="min-w-0 flex-1 truncate" dir="auto"
      >{shortTitle(document.title, home?.name)}</span
    >
    {#if showCourse && home}
      <span
        class="flex max-w-[150px] shrink-0 items-center gap-1.5 text-[12px] text-text-3"
        ><CourseTile course={home} size={12} /><span
          class="min-w-0 truncate"
          dir="auto">{home.name}</span
        ></span
      >
    {/if}
  </Command.Item>
{/snippet}

<Popover.Root bind:open>
  <Popover.Trigger
    class="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-text-2 transition-colors hover:bg-hover hover:text-text data-[state=open]:bg-hover data-[state=open]:text-text"
    aria-label="Add to your question"
    title="Add a page, an image, a lecture or a course"
  >
    <Plus size={17} strokeWidth={1.75} />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      side="top"
      align="start"
      sideOffset={8}
      data-attach-menu
      class="z-50 w-[340px] animate-[folio-scale_140ms_var(--ease-out-quint)] overflow-hidden rounded-xl border border-line-subtle bg-raised shadow-3 outline-none"
    >
      <Command.Root loop filter={searchScore}>
        <Command.Input
          bind:value={query}
          placeholder="Search lectures, files and courses…"
          class="h-11 w-full border-b border-line-subtle bg-transparent px-3.5 text-[13px] outline-none placeholder:text-text-3"
        />
        <Command.List class="scroll-quiet max-h-[340px] overflow-y-auto p-1.5">
          <Command.Viewport>
            <Command.Empty
              class="px-2.5 py-6 text-center text-[13px] text-text-3"
              >Nothing in your library matches.</Command.Empty
            >
            <Command.Group>
              <Command.GroupItems>
                {#if reading?.kind === "pdf" && focus && !added.includes(pageKey)}
                  <Command.Item
                    value="this page current slide"
                    keywords={[`page ${focus.page}`]}
                    onSelect={() =>
                      pick({
                        kind: "page",
                        documentId: focus.documentId,
                        page: focus.page,
                      })}
                    class={item}
                  >
                    <ScanText
                      size={15}
                      strokeWidth={1.75}
                      class="shrink-0 text-text-3"
                    />
                    <span class="flex-1">This page</span>
                    <span
                      class="shrink-0 text-[12px] text-text-3 tabular-nums"
                      title={reading.title}>Page {focus.page}</span
                    >
                  </Command.Item>
                {/if}
                <Command.Item
                  value="image picture photo screenshot upload"
                  onSelect={() => {
                    open = false;
                    picker?.click();
                  }}
                  class={item}
                >
                  <ImagePlus
                    size={15}
                    strokeWidth={1.75}
                    class="shrink-0 text-text-3"
                  />
                  <span class="flex-1">Image…</span>
                  <span class="text-[12px] text-text-3">or paste ⌘V</span>
                </Command.Item>
              </Command.GroupItems>
            </Command.Group>

            {#if !searching}
              <p class="px-2.5 pt-2 pb-1.5 text-[12px] text-text-3">
                Search to add a lecture, file or course.
              </p>
            {:else}
              {#if documents.length}
                <Command.Group>
                  <Command.GroupHeading class={heading}
                    >Lectures and files</Command.GroupHeading
                  >
                  <Command.GroupItems>
                    {#each documents as document (document.id)}
                      {@render documentRow(document)}
                    {/each}
                  </Command.GroupItems>
                </Command.Group>
              {/if}
              {#if courses.length}
                <Command.Group>
                  <Command.GroupHeading class={heading}
                    >Courses</Command.GroupHeading
                  >
                  <Command.GroupItems>
                    {#each courses as candidate (candidate.id)}
                      <Command.Item
                        value={`${candidate.name} ${candidate.code} ${candidate.id}`}
                        onSelect={() =>
                          pick({ kind: "course", courseId: candidate.id })}
                        class={item}
                      >
                        <CourseTile course={candidate} size={16} />
                        <span class="min-w-0 flex-1 truncate" dir="auto"
                          >{candidate.name}</span
                        >
                        <span class="text-[12px] text-text-3"
                          >{candidate.code}</span
                        >
                      </Command.Item>
                    {/each}
                  </Command.GroupItems>
                </Command.Group>
              {/if}
            {/if}
          </Command.Viewport>
        </Command.List>
      </Command.Root>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<input
  bind:this={picker}
  type="file"
  accept="image/png,image/jpeg,image/webp,image/gif"
  multiple
  class="hidden"
  onchange={(event) => {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length) onimages(files);
  }}
/>
