<script lang="ts">
  import {
    ArrowUp,
    FileText,
    Quote,
    ScanText,
    Square,
    X,
  } from "@lucide/svelte";
  import type { Focus } from "../../src/desktop/api.ts";
  import {
    imageAttachment,
    MAX_IMAGES,
    picked,
    type Picked,
  } from "../lib/attachments.ts";
  import { estimateDirection, writtenDirection } from "../lib/direction.ts";
  import { shortTitle } from "../lib/titles.ts";
  import { folio, type Added } from "../lib/state.svelte.ts";
  import AttachMenu from "./AttachMenu.svelte";
  import CourseTile from "./CourseTile.svelte";
  import ModelPicker from "./ModelPicker.svelte";

  let {
    tabId,
    chatId,
    courseId,
    focus = null,
    large = false,
    slim = false,
    placeholder = "Message Folio",
    quote = $bindable(null),
    onbeforesend,
    onnewchat,
  }: {
    tabId: string;
    chatId: string | null;
    courseId: string | null;
    focus?: Focus | null;
    large?: boolean;
    /** One line at rest, as on a course page; the toolbar opens once the student starts. */
    slim?: boolean;
    placeholder?: string;
    quote?: { text: string; source: string } | null;
    /** Runs just before sending, for example to move from Home into the new chat. */
    onbeforesend?: () => void;
    /** Starts a new chat in this place, when the student picks another model. */
    onnewchat?: () => void;
  } = $props();

  let text = $state("");
  let field: HTMLTextAreaElement;
  let root: HTMLDivElement;
  let engaged = $state(false);
  /** What the student added with + (or by pasting or dropping an image); image bytes stay raw. */
  let attachments = $state.raw<Added[]>([]);

  const chat = $derived(folio.chatFor(chatId, tabId));
  /** The course the chat reads; null when it reads the whole library. */
  const chatCourse = $derived(
    chat ? (chat.kind === "course" ? chat.courseId : null) : courseId,
  );
  // Older plain chats read nothing, so nothing can be added to them.
  const canAttach = $derived(chat?.kind !== "chat");
  const visual = $derived(
    attachments.some(
      (item) => item.input.kind === "page" || item.input.kind === "image",
    ),
  );
  // Each line takes its own direction as it is typed; empty, the field follows the language
  // the student last wrote in, so the caret and placeholder start on the right side.
  const emptyDirection = $derived.by(() => {
    const last = chat?.messages.findLast((message) => message.role === "user");
    return (last && writtenDirection(estimateDirection(last.text))) || "ltr";
  });
  const running = $derived(folio.running(chat));
  const connected = $derived(folio.connection.connected);
  // A page or image can be sent on its own; a lecture or course needs a question.
  const canSend = $derived(
    connected && !running && (text.trim().length > 0 || !!quote || visual),
  );
  // Folded only while there is nothing to show: no draft, quote or attachment.
  const collapsed = $derived(
    slim &&
      !engaged &&
      !text &&
      !quote &&
      !attachments.length &&
      (!folio.ready || connected) &&
      !running,
  );

  function onfocusout(): void {
    // Wait for focus to land: a picker's menu opens outside the composer and should not fold it.
    setTimeout(() => {
      const active = document.activeElement;
      if (
        !root?.contains(active) &&
        !document.querySelector('[role="menu"], [data-attach-menu]')
      )
        engaged = false;
    });
  }

  export function focusInput(): void {
    field?.focus();
  }

  /** Adds pasted, dropped or chosen images, up to four per question. */
  export async function addImages(files: File[]): Promise<void> {
    if (!canAttach) return;
    const room =
      MAX_IMAGES -
      attachments.filter((item) => item.input.kind === "image").length;
    if (files.length > room)
      folio.error = `Add at most ${MAX_IMAGES} images to one question.`;
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        attachments = [...attachments, await imageAttachment(file)];
      } catch (error) {
        folio.error = error instanceof Error ? error.message : String(error);
      }
    }
    field?.focus();
  }

  function add(input: Picked): void {
    const item = picked(input);
    if (!attachments.some((existing) => existing.key === item.key))
      attachments = [...attachments, item];
    field?.focus();
  }

  function remove(key: string): void {
    attachments = attachments.filter((item) => item.key !== key);
    field?.focus();
  }

  function images(list: FileList | undefined | null): File[] {
    return [...(list ?? [])].filter((file) => file.type.startsWith("image/"));
  }

  function onpaste(event: ClipboardEvent): void {
    const files = images(event.clipboardData?.files);
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  }

  function ondrop(event: DragEvent): void {
    // Images join the question; anything else falls through, so a course page still imports PDFs.
    const files = images(event.dataTransfer?.files);
    if (!files.length || !canAttach) return;
    event.preventDefault();
    event.stopPropagation();
    void addImages(files);
  }

  $effect(() => {
    // Grow with the draft, up to a comfortable limit, then scroll inside.
    void text;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, large ? 280 : 220)}px`;
  });

  async function submit(): Promise<void> {
    if (!canSend) return;
    const draft = text;
    const quoted = quote;
    const sending = attachments;
    const message = quoted
      ? `> ${quoted.text.replace(/\n+/g, " ")}\n> (${quoted.source})\n\n${draft.trim() || "Explain this passage."}`
      : draft.trim() || "Explain this.";
    text = "";
    quote = null;
    attachments = [];
    onbeforesend?.();
    const sent = await folio.send(message, {
      tabId,
      chatId,
      courseId,
      focus,
      attachments: sending,
    });
    if (!sent) {
      text = draft;
      quote = quoted;
      attachments = sending;
    }
    field?.focus();
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  }
</script>

<div
  bind:this={root}
  class="flex w-full rounded-[14px] border border-line bg-surface shadow-[0_1px_2px_#18181b0a,0_6px_20px_-10px_#18181b26] transition-[border-color] duration-150 focus-within:border-line-strong dark:bg-raised {collapsed
    ? 'flex-row items-center'
    : 'flex-col'}"
  role="group"
  aria-label="Ask Folio"
  onfocusin={() => (engaged = true)}
  {onfocusout}
  ondragover={(event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  }}
  {ondrop}
>
  {#if folio.ready && !connected}
    <div
      class="flex items-center gap-3 rounded-t-[13px] border-b border-line-subtle bg-sunken px-3.5 py-2.5"
    >
      <span class="flex-1 text-text-2">
        {folio.connection.signingIn
          ? "Finish signing in with ChatGPT in your browser."
          : "Connect your ChatGPT account to start chatting."}
      </span>
      {#if folio.connection.signingIn}
        <button
          class="h-7 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium shadow-1 hover:bg-hover"
          onclick={() => folio.api.cancelSignIn()}>Cancel</button
        >
      {:else}
        <button
          class="h-7 rounded-md bg-ink px-2.5 text-[12px] font-medium text-on-ink shadow-1 hover:opacity-90"
          onclick={() => folio.api.signIn()}>Connect ChatGPT</button
        >
      {/if}
    </div>
  {/if}
  {#if quote}
    <div
      class="mx-3 mt-3 flex animate-[folio-fade_150ms_ease-out] gap-2.5 rounded-lg bg-sunken py-2 pr-1.5 pl-3 dark:bg-surface"
    >
      <Quote size={13} strokeWidth={2} class="mt-0.5 shrink-0 text-text-3" />
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="line-clamp-2 font-serif text-[14px] leading-5 text-text"
          >{quote.text}</span
        >
        <span class="text-[11px] text-text-3">{quote.source}</span>
      </div>
      <button
        class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
        aria-label="Remove quote"
        onclick={() => (quote = null)}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  {/if}
  {#if attachments.length}
    <div class="mx-3 mt-3 flex flex-wrap gap-1.5">
      {#each attachments as item (item.key)}
        {@const view = item.view}
        <span
          class="inline-flex h-8 max-w-[260px] min-w-0 animate-[folio-fade_150ms_ease-out] items-center gap-2 rounded-lg bg-sunken pr-1 pl-1.5 text-[12px] text-text-2 dark:bg-surface"
        >
          {#if view.kind === "image"}
            <img
              src={view.thumbnail}
              alt=""
              class="size-6 shrink-0 rounded-[5px] object-cover"
            />
            <span class="min-w-0 truncate" dir="auto">{view.name || "Image"}</span
            >
          {:else if view.kind === "page"}
            {@const document = folio.document(view.documentId)}
            <ScanText size={14} strokeWidth={1.75} class="ml-0.5 shrink-0" />
            <span class="shrink-0 tabular-nums">Page {view.page}</span>
            <span class="min-w-0 truncate text-text-3" dir="auto"
              >{document
                ? shortTitle(document.title, folio.course(document.courseId)?.name)
                : ""}</span
            >
          {:else if view.kind === "document"}
            {@const document = folio.document(view.documentId)}
            <FileText size={14} strokeWidth={1.75} class="ml-0.5 shrink-0" />
            <span class="min-w-0 truncate" dir="auto"
              >{document
                ? shortTitle(document.title, folio.course(document.courseId)?.name)
                : "Document"}</span
            >
          {:else}
            {@const added = folio.course(view.courseId)}
            {#if added}<CourseTile course={added} size={16} />{/if}
            <span class="min-w-0 truncate" dir="auto"
              >{added?.name ?? "Course"}</span
            >
          {/if}
          <button
            class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
            aria-label="Remove"
            onclick={() => remove(item.key)}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </span>
      {/each}
    </div>
  {/if}
  <textarea
    bind:this={field}
    bind:value={text}
    dir={text ? "auto" : emptyDirection}
    {onkeydown}
    {onpaste}
    rows="1"
    placeholder={quote
      ? "Ask about this passage, or press Enter to explain it"
      : visual && !attachments.some((item) => item.input.kind === "document" || item.input.kind === "course")
        ? "Ask about it, or press Enter to explain it"
        : placeholder}
    class="w-full resize-none bg-transparent px-4 text-[15px] leading-6 text-text outline-none placeholder:text-text-3 {collapsed
      ? 'min-h-[44px] py-2.5'
      : large
        ? 'min-h-[56px] pt-4'
        : 'min-h-[46px] pt-3'}"></textarea>
  <div
    class="flex items-center gap-1 {collapsed
      ? 'pr-1.5'
      : 'px-2.5 pt-1 pb-2.5'}"
  >
    {#if canAttach && !collapsed}
      <AttachMenu
        courseId={chatCourse}
        {focus}
        added={attachments.map((item) => item.key)}
        onpick={add}
        onimages={(files) => void addImages(files)}
      />
    {/if}
    {#if !collapsed}
      <span class="flex-1"></span>
      <ModelPicker
        chatModelId={chatId ? (chat?.modelId ?? null) : null}
        onnewchat={onnewchat ?? (() => folio.newChat(courseId))}
      />
    {/if}
    {#if running}
      <button
        class="inline-flex size-8 items-center justify-center rounded-full bg-ink text-on-ink transition-transform active:scale-95"
        aria-label="Stop"
        title="Stop (Esc)"
        onclick={() => folio.cancel(chatId)}
      >
        <Square size={11} fill="currentColor" strokeWidth={0} />
      </button>
    {:else}
      <button
        class="inline-flex size-8 items-center justify-center rounded-full transition-[background-color,transform] duration-150 active:scale-95 {canSend
          ? 'bg-ink text-on-ink'
          : 'bg-line text-surface dark:text-text-4'}"
        aria-label="Send"
        title="Send (Enter)"
        disabled={!canSend}
        onclick={submit}
      >
        <ArrowUp size={16} strokeWidth={2.25} />
      </button>
    {/if}
  </div>
</div>
