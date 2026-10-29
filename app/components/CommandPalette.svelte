<script lang="ts">
  import {
    BookOpen,
    FileText,
    House,
    ListChecks,
    MessageSquare,
    NotebookPen,
    Plus,
    Settings,
    SquarePen,
    Highlighter,
  } from "@lucide/svelte";
  import { Command, Dialog } from "bits-ui";
  import { folio } from "../lib/state.svelte.ts";
  import CourseTile from "./CourseTile.svelte";
  import FolioMark from "./FolioMark.svelte";

  let query = $state("");

  $effect(() => {
    if (folio.paletteOpen) query = "";
  });

  function run(action: () => void): void {
    folio.paletteOpen = false;
    action();
  }

  async function ask(): Promise<void> {
    const text = query.trim();
    if (!text) return;
    folio.paletteOpen = false;
    folio.newChat(null);
    await folio.send(text, {
      tabId: folio.activeTabId,
      chatId: null,
      courseId: null,
      focus: null,
    });
  }

  const item =
    "flex h-9 cursor-default items-center gap-3 rounded-md px-2.5 text-text data-[selected]:bg-hover";
  const heading =
    "px-2.5 pt-3 pb-1.5 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase";
</script>

<Dialog.Root bind:open={folio.paletteOpen}>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-40 animate-[folio-fade_120ms_ease-out] bg-[#18181b]/15 dark:bg-black/40"
    />
    <Dialog.Content
      class="fixed top-[14vh] left-1/2 z-50 w-[min(620px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line-subtle bg-raised shadow-3 outline-none"
    >
      <Dialog.Title class="sr-only">Search or ask</Dialog.Title>
      <Command.Root
        class="flex animate-[folio-scale_160ms_var(--ease-out-quint)] flex-col"
        loop
      >
        <Command.Input
          bind:value={query}
          placeholder="Search courses, documents, notes and chats, or ask Folio"
          class="h-14 border-b border-line-subtle bg-transparent px-5 text-[16px] outline-none placeholder:text-text-3"
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void ask();
            }
          }}
        />
        <Command.List
          class="scroll-quiet max-h-[min(420px,56vh)] overflow-y-auto p-1.5"
        >
          <Command.Viewport>
            {#if query.trim()}
              <Command.Item
                value={`ask ${query}`}
                keywords={[query]}
                onSelect={ask}
                class={item}
              >
                <FolioMark size={18} />
                <span class="min-w-0 flex-1 truncate"
                  >Ask Folio “<bdi>{query.trim()}</bdi>”</span
                >
                <span class="font-mono text-[11px] text-text-3">⌘↵</span>
              </Command.Item>
            {/if}
            <Command.Group>
              <Command.GroupHeading class={heading}>Go to</Command.GroupHeading>
              <Command.GroupItems>
                <Command.Item
                  value="Home"
                  onSelect={() => run(() => folio.navigate({ view: "home" }))}
                  class={item}
                  ><House
                    size={15}
                    strokeWidth={1.75}
                    class="text-text-3"
                  />Home</Command.Item
                >
                <Command.Item
                  value="Library"
                  onSelect={() =>
                    run(() => folio.navigate({ view: "library" }))}
                  class={item}
                  ><BookOpen
                    size={15}
                    strokeWidth={1.75}
                    class="text-text-3"
                  />Library</Command.Item
                >
                <Command.Item
                  value="Assignments"
                  onSelect={() =>
                    run(() => folio.navigate({ view: "assignments" }))}
                  class={item}
                  ><ListChecks
                    size={15}
                    strokeWidth={1.75}
                    class="text-text-3"
                  />Assignments</Command.Item
                >
                <Command.Item
                  value="Studying"
                  onSelect={() => run(() => folio.navigate({ view: "jobs" }))}
                  class={item}
                  ><Highlighter
                    size={15}
                    strokeWidth={1.75}
                    class="text-text-3"
                  />Studying</Command.Item
                >
              </Command.GroupItems>
            </Command.Group>
            {#if folio.courses.length}
              <Command.Group>
                <Command.GroupHeading class={heading}
                  >Courses</Command.GroupHeading
                >
                <Command.GroupItems>
                  {#each folio.courses as course (course.id)}
                    <Command.Item
                      value={`course ${course.name} ${course.code}`}
                      onSelect={() =>
                        run(() =>
                          folio.navigate({
                            view: "course",
                            courseId: course.id,
                            tab: "materials",
                          }),
                        )}
                      class={item}
                    >
                      <CourseTile {course} size={16} /><span class="flex-1"
                        >{course.name}</span
                      ><span class="text-[12px] text-text-3">{course.code}</span
                      >
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}
            {#if folio.documents.length}
              <Command.Group>
                <Command.GroupHeading class={heading}
                  >Documents</Command.GroupHeading
                >
                <Command.GroupItems>
                  {#each folio.documents as document (document.id)}
                    <Command.Item
                      value={`document ${document.title} ${folio.course(document.courseId)?.name ?? ""} ${document.id}`}
                      onSelect={() =>
                        run(() => folio.openDocument(document.id))}
                      class={item}
                    >
                      <FileText
                        size={15}
                        strokeWidth={1.75}
                        class="text-text-3"
                      /><span class="min-w-0 flex-1 truncate" dir="auto"
                        >{document.title}</span
                      ><span class="text-[12px] text-text-3"
                        >{folio.course(document.courseId)?.name}</span
                      >
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}
            {#if folio.notes.length}
              <Command.Group>
                <Command.GroupHeading class={heading}
                  >Notes</Command.GroupHeading
                >
                <Command.GroupItems>
                  {#each folio.notes as note (note.id)}
                    <Command.Item
                      value={`note ${note.title} ${folio.course(note.courseId)?.name ?? ""} ${note.id}`}
                      onSelect={() => run(() => folio.openNote(note.id))}
                      class={item}
                    >
                      <NotebookPen
                        size={15}
                        strokeWidth={1.75}
                        class="text-text-3"
                      /><span class="min-w-0 flex-1 truncate" dir="auto"
                        >{note.title}</span
                      ><span class="text-[12px] text-text-3"
                        >{folio.course(note.courseId)?.name}</span
                      >
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}
            {#if folio.chats.length}
              <Command.Group>
                <Command.GroupHeading class={heading}
                  >Chats</Command.GroupHeading
                >
                <Command.GroupItems>
                  {#each folio.chats.slice(0, 40) as chat (chat.id)}
                    <Command.Item
                      value={`chat ${chat.title} ${chat.id}`}
                      onSelect={() =>
                        run(() =>
                          folio.navigate({
                            view: "chat",
                            chatId: chat.id,
                            courseId: chat.courseId,
                          }),
                        )}
                      class={item}
                    >
                      <MessageSquare
                        size={15}
                        strokeWidth={1.75}
                        class="text-text-3"
                      /><span class="min-w-0 flex-1 truncate" dir="auto"
                        >{chat.title}</span
                      >
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}
            <Command.Group>
              <Command.GroupHeading class={heading}
                >Actions</Command.GroupHeading
              >
              <Command.GroupItems>
                <Command.Item
                  value="New chat"
                  onSelect={() => run(() => folio.newChat())}
                  class={item}
                  ><SquarePen
                    size={15}
                    strokeWidth={1.75}
                    class="text-text-3"
                  /><span class="flex-1">New chat</span><span
                    class="font-mono text-[11px] text-text-3">⌘N</span
                  ></Command.Item
                >
                <Command.Item
                  value="New course"
                  onSelect={() => run(() => (folio.newCourseOpen = true))}
                  class={item}
                  ><Plus size={15} strokeWidth={1.75} class="text-text-3" />New
                  course</Command.Item
                >
                <Command.Item
                  value="Settings"
                  onSelect={() => run(() => (folio.settingsOpen = true))}
                  class={item}
                  ><Settings
                    size={15}
                    strokeWidth={1.75}
                    class="text-text-3"
                  /><span class="flex-1">Settings</span><span
                    class="font-mono text-[11px] text-text-3">⌘,</span
                  ></Command.Item
                >
              </Command.GroupItems>
            </Command.Group>
          </Command.Viewport>
        </Command.List>
        <div
          class="flex h-9 items-center gap-4 border-t border-line-subtle bg-sunken px-4 text-[12px] text-text-3 dark:bg-surface"
        >
          <span>↑↓ move</span><span>↵ open</span><span>⌘↵ ask Folio</span><span
            class="flex-1"
          ></span><span>esc close</span>
        </div>
      </Command.Root>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
