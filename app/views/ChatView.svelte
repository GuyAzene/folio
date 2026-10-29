<script lang="ts">
  import { FileText } from "@lucide/svelte";
  import ChatPane from "../components/ChatPane.svelte";
  import CourseTile from "../components/CourseTile.svelte";
  import { shortTitle } from "../lib/titles.ts";
  import { folio, type Location } from "../lib/state.svelte.ts";

  let {
    tabId,
    location,
  }: { tabId: string; location: Extract<Location, { view: "chat" }> } =
    $props();
  let pane = $state<ChatPane>();
  const course = $derived(folio.course(location.courseId));
  const chat = $derived(folio.chatFor(location.chatId, tabId));
  /** Chats started without a course read the library; older plain chats read nothing. */
  const plain = $derived(chat?.kind === "chat");
  /** What the student added to the chat with +; Folio may read these too. */
  const addedCourses = $derived(
    (chat?.reads.courses ?? []).flatMap((id) => folio.course(id) ?? []),
  );
  const addedDocuments = $derived(
    (chat?.reads.documents ?? []).flatMap((id) => folio.document(id) ?? []),
  );
  const pill =
    "inline-flex h-[22px] max-w-[220px] min-w-0 items-center gap-1.5 rounded-md bg-sunken px-1.5 text-text-2 hover:text-text dark:bg-raised";

  export function focusInput(): void {
    pane?.focusInput();
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if course}
    <div
      class="flex min-h-9 shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-1.5 text-[12px] text-text-3"
    >
      <span>Folio reads</span>
      {#each [course, ...addedCourses] as read (read.id)}
        <button
          class={pill}
          onclick={() =>
            folio.navigate({
              view: "course",
              courseId: read.id,
              tab: "materials",
            })}
        >
          <CourseTile course={read} size={12} /><span
            class="min-w-0 truncate"
            dir="auto">{read.name}</span
          >
        </button>
      {/each}
      {#each addedDocuments as document (document.id)}
        <button
          class={pill}
          onclick={() =>
            folio.openDocument(document.id, 1, { chatId: location.chatId })}
        >
          <FileText size={11} strokeWidth={1.75} class="shrink-0" /><span
            class="min-w-0 truncate"
            dir="auto"
            >{shortTitle(
              document.title,
              folio.course(document.courseId)?.name,
            )}</span
          >
        </button>
      {/each}
      <span>and nothing else</span>
    </div>
  {/if}
  {#if plain}
    <div
      class="flex h-9 shrink-0 items-center justify-center text-[12px] text-text-3"
    >
      An earlier chat without course material
    </div>
  {/if}
  {#key location.chatId ?? `new:${tabId}`}
    <ChatPane
      bind:this={pane}
      {tabId}
      chatId={location.chatId}
      courseId={location.courseId}
      emptyTitle={course
        ? `What should we go over in ${course.name}?`
        : "What are we studying?"}
      emptyNote={course || !folio.courses.length
        ? ""
        : "Folio works out which course you mean from your question."}
    />
  {/key}
</div>
