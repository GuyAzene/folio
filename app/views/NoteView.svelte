<script lang="ts">
  import { DropdownMenu, ToggleGroup } from "bits-ui";
  import { onDestroy, tick, untrack } from "svelte";
  import { History, Trash2 } from "@lucide/svelte";
  import type { NoteVersionView } from "../../src/desktop/api.ts";
  import CourseTile from "../components/CourseTile.svelte";
  import IconButton from "../components/IconButton.svelte";
  import {
    createNoteEditor,
    type NoteEditor,
  } from "../lib/editor/note-editor.ts";
  import { formatDate } from "../lib/labels.ts";
  import { mountDemos } from "../lib/demo-slots.ts";
  import { linkedMarkdown, wikilinkTarget } from "../lib/editor/wikilinks.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { folio } from "../lib/state.svelte.ts";

  /** The student's own Markdown note. Saves as they type; never overwrites edits made elsewhere. */
  let { noteId }: { noteId: string } = $props();

  type Status =
    "loading" | "saved" | "editing" | "saving" | "conflict" | "missing";

  let content = $state("");
  let revision = $state("");

  /** What `[[` offers in this note: the course's other notes, then its study-notes topics. */
  function linkTargets() {
    const course = note?.courseId;
    if (!course) return [];
    return [
      ...folio.notes
        .filter((other) => other.courseId === course && other.id !== noteId)
        .map((other) => ({ target: other.title, label: other.title, detail: "Note" })),
      ...(folio.studyNotes[course]?.topics ?? []).map((topic) => ({
        target: `topic:${topic.slug}`,
        label: topic.title,
        detail: "Study notes",
      })),
    ];
  }

  /** Opens a link's note or topic; a title no note has yet says so. */
  function openLink(target: string, newTab: boolean): void {
    const course = note?.courseId;
    if (!course) return;
    if (target.startsWith("topic:")) {
      folio.openStudyNotes(course, target, { newTab });
      return;
    }
    const key = target.trim().toLocaleLowerCase();
    const linked = folio.notes.find(
      (other) => other.courseId === course && other.title.toLocaleLowerCase() === key,
    );
    if (linked) folio.openNote(linked.id, { newTab });
    else folio.error = `There is no note called “${target}” in this course yet.`;
  }
  /** The note's kept earlier versions, loaded when the History menu opens. */
  let versions = $state<NoteVersionView[]>([]);
  let status = $state<Status>("loading");
  /** Live preview (Obsidian's default), Markdown source, or the reading view. */
  let mode = $state<"edit" | "source" | "read">("edit");
  let editor: NoteEditor | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> | undefined;

  const note = $derived(folio.note(noteId));
  const course = $derived(folio.course(note?.courseId));

  async function load(): Promise<void> {
    try {
      const loaded = await folio.api.readNote(noteId);
      content = loaded.content;
      revision = loaded.note.revision;
      editor?.setDoc(content);
      status = "saved";
    } catch {
      status = "missing";
    }
  }
  void load();

  // A save elsewhere (Folio keeping an edit, another app) reloads a note with no unsaved typing,
  // and stops autosave for one that has some.
  $effect(() => {
    const latest = note?.revision;
    if (!latest || !revision || latest === revision || saving) return;
    if (status === "saved") void load();
    else if (status === "editing") status = "conflict";
  });

  function edited(doc: string): void {
    content = doc;
    oninput();
  }

  // The editor is created once per showing; typing does not recreate it.
  function mountEditor(node: HTMLElement) {
    return untrack(() => {
      editor = createNoteEditor(node, {
        doc: content,
        live: mode === "edit",
        placeholder:
          "Start writing. # for a heading, - for a list, $x^2$ for math.",
        onChange: edited,
        onBlur: () => void save(),
        onSave: () => void save(),
        onRead: () => (mode = "read"),
        links: { targets: linkTargets, open: openLink },
      });
      return () => {
        editor?.destroy();
        editor = undefined;
      };
    });
  }

  $effect(() => {
    const live = mode === "edit";
    untrack(() => editor?.setLive(live));
  });

  // ⌘E toggles reading, as in Obsidian; the editor handles it while it has focus.
  async function onkeydown(event: KeyboardEvent): Promise<void> {
    if (event.defaultPrevented || mode !== "read") return;
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() !== "e" || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    mode = "edit";
    await tick();
    editor?.focus();
  }

  function oninput(): void {
    if (status === "conflict") return;
    status = "editing";
    clearTimeout(timer);
    timer = setTimeout(() => void save(), 700);
  }

  async function save(): Promise<void> {
    if (status !== "editing") return;
    // One save at a time: each needs the revision the previous one produced.
    if (saving) {
      await saving;
      return save();
    }
    clearTimeout(timer);
    status = "saving";
    const draft = content;
    saving = folio.api.saveNote(noteId, draft, revision).then(
      (saved) => {
        revision = saved.revision;
        status = content === draft ? "saved" : "editing";
      },
      () => {
        status = "conflict";
      },
    );
    await saving;
    saving = undefined;
    // Typing during the save left more to save.
    if ((status as Status) === "editing")
      timer = setTimeout(() => void save(), 700);
  }

  async function useSaved(): Promise<void> {
    clearTimeout(timer);
    await load();
  }

  /** The student chose their version over the one saved elsewhere. */
  async function keepMine(): Promise<void> {
    try {
      revision = (await folio.api.readNote(noteId)).note.revision;
      status = "editing";
      await save();
    } catch (error) {
      folio.error =
        error instanceof Error ? error.message : "The note could not be saved.";
    }
  }

  onDestroy(() => {
    clearTimeout(timer);
    void save();
  });

  const label: Record<Status, string> = {
    loading: "",
    saved: "Saved",
    editing: "Edited",
    saving: "Saving…",
    conflict: "Not saved",
    missing: "",
  };
</script>

<svelte:window {onkeydown} />

{#if status === "missing"}
  <div class="flex h-full items-center justify-center text-text-3">
    This note is no longer in your library.
  </div>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <div
      class="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle px-4"
    >
      {#if course}<CourseTile {course} size={16} />{/if}
      <span class="min-w-0 truncate font-medium text-text"
        >{note?.title ?? "Note"}</span
      >
      <span
        class="shrink-0 text-[12px] whitespace-nowrap {status === 'conflict'
          ? 'text-danger'
          : 'text-text-3'}"
      >
        {status === "saved" && note?.updatedAt
          ? `${label.saved} · ${formatDate(note.updatedAt)}`
          : label[status]}
      </span>
      <span class="flex-1"></span>
      <DropdownMenu.Root
        onOpenChange={async (open) => {
          if (open) versions = await folio.noteHistory(noteId).catch(() => []);
        }}
      >
        <DropdownMenu.Trigger
          class="flex size-7 shrink-0 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-hover hover:text-text data-[state=open]:bg-hover data-[state=open]:text-text"
          aria-label="Earlier versions"
          title="Earlier versions"
        >
          <History size={14} strokeWidth={1.75} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="bottom"
            align="end"
            sideOffset={6}
            class="z-50 max-h-[360px] w-[300px] animate-[folio-scale_140ms_var(--ease-out-quint)] overflow-y-auto rounded-xl border border-line-subtle bg-raised p-1.5 shadow-3 outline-none"
          >
            <div
              class="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase"
            >
              Earlier versions
            </div>
            {#each versions as version (version.revision + version.at)}
              <DropdownMenu.Item
                class="flex cursor-default flex-col rounded-md px-2.5 py-1.5 text-[13px] text-text outline-none select-none data-[highlighted]:bg-hover"
                onSelect={async () => {
                  // Typing not saved yet is saved first, so it too can be brought back.
                  await save();
                  await folio.restoreNote(noteId, version.revision, revision);
                }}
              >
                <span class="truncate" dir="auto">{version.title}</span>
                <span class="text-[11px] text-text-3"
                  >{formatDate(version.at)} · before {version.author === "tutor"
                    ? "the tutor's change"
                    : "your edits"}</span
                >
              </DropdownMenu.Item>
            {:else}
              <p class="px-2.5 py-2 text-[12px] text-text-3">
                Earlier versions appear here as the note changes.
              </p>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <IconButton
        label="Move note to Trash"
        class="hover:text-danger"
        onclick={async () => {
          // Unsaved typing is saved first, so restoring brings back the latest text.
          await save();
          await folio.trashNote(noteId);
        }}
      >
        <Trash2 size={14} strokeWidth={1.75} />
      </IconButton>
      <ToggleGroup.Root
        type="single"
        value={mode}
        onValueChange={(value) => value && (mode = value as typeof mode)}
        class="flex shrink-0 rounded-lg border border-line-subtle bg-bg p-0.5"
      >
        {#each [{ value: "edit", label: "Edit" }, { value: "source", label: "Source" }, { value: "read", label: "Read" }] as option (option.value)}
          <ToggleGroup.Item
            value={option.value}
            class="h-[24px] rounded-md px-2.5 text-[12px] font-medium text-text-2 transition-colors data-[state=on]:bg-surface data-[state=on]:text-text data-[state=on]:shadow-[0_1px_2px_#18181b14,0_0_0_1px_#18181b0a] dark:data-[state=on]:bg-selected"
          >
            {option.label}
          </ToggleGroup.Item>
        {/each}
      </ToggleGroup.Root>
    </div>

    {#if status === "conflict"}
      <div
        class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-subtle bg-sunken px-4 py-2.5 text-[13px] dark:bg-raised"
        role="alert"
      >
        <span class="min-w-0 flex-1 text-text-2">
          This note changed somewhere else, so Folio didn't save over it. Your
          text is still here.
        </span>
        <button
          class="h-7 rounded-md border border-line bg-surface px-2.5 font-medium shadow-1 hover:bg-hover dark:bg-raised"
          onclick={useSaved}
        >
          Use the saved version
        </button>
        <button
          class="h-7 rounded-md bg-ink px-2.5 font-medium text-on-ink shadow-1 hover:opacity-90"
          onclick={keepMine}
        >
          Keep mine
        </button>
      </div>
    {/if}

    {#if mode === "read"}
      <div class="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <article
          class="prose-folio prose-reading mx-auto max-w-[784px] px-8 py-10 font-serif text-[17px] leading-7 max-sm:px-4"
          onclick={(event) => {
            const anchor = (event.target as Element).closest?.("a");
            const target = wikilinkTarget(anchor?.getAttribute("href") ?? null);
            if (!target) return;
            event.preventDefault();
            openLink(target, event.metaKey || event.ctrlKey);
          }}
          {@attach (node) => {
            // Demos run again whenever the note's text changes.
            void content;
            return mountDemos(node);
          }}
        >
          <!-- Sanitized by DOMPurify in renderMarkdown. -->
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html renderMarkdown(linkedMarkdown(content || "Nothing here yet."), {
            note: true,
          })}
        </article>
      </div>
    {:else if status !== "loading"}
      <div class="min-h-0 flex-1" {@attach mountEditor}></div>
    {/if}
  </div>
{/if}
