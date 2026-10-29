<script lang="ts">
  import {
    Check,
    ChevronDown,
    Copy,
    FileText,
    ScanText,
  } from "@lucide/svelte";
  import type { ChatMessageView, VisualView } from "../../src/desktop/api.ts";
  import {
    estimateDirection,
    writtenDirection,
    type Direction,
  } from "../lib/direction.ts";
  import { shortTitle } from "../lib/titles.ts";
  import { diagramFence } from "../lib/diagram-actions.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { folio } from "../lib/state.svelte.ts";
  import CourseTile from "./CourseTile.svelte";
  import FolioMark from "./FolioMark.svelte";
  import ProposalCard from "./ProposalCard.svelte";
  import NoteEditCard from "./NoteEditCard.svelte";
  import VisualCard from "./VisualCard.svelte";

  /**
   * `chatId` lets a citation open its page with this chat beside it. `base` is the direction of
   * the question a reply answers, for reply blocks that have no words of their own.
   */
  let {
    message,
    chatId = null,
    base,
  }: {
    message: ChatMessageView;
    chatId?: string | null;
    base?: Direction;
  } = $props();
  let copied = $state(false);
  let showSteps = $state(false);

  type Part =
    | { kind: "text"; key: string; html: string }
    | { kind: "visual"; key: string; visual: VisualView };

  // Text before a visual no longer changes, so it is rendered once, not on every new word.
  const rendered = new Map<string, string>();
  function render(text: string, streaming: boolean): string {
    const key = `${streaming ? "s" : "c"}${text}`;
    let html = rendered.get(key);
    if (html === undefined) {
      html = renderMarkdown(text, { streaming, base });
      if (!streaming) rendered.set(key, html);
    }
    return html;
  }

  /**
   * A reply's text with its visuals in place: each visual sits where the tutor showed it, which
   * is always between two of its messages, so the text splits cleanly there.
   */
  const parts = $derived.by((): Part[] => {
    if (message.role !== "assistant") return [];
    const streaming = message.state === "streaming";
    const visuals = [...(message.visuals ?? [])].sort((a, b) => a.at - b.at);
    const out: Part[] = [];
    let from = 0;
    for (const visual of visuals) {
      const at = Math.min(Math.max(visual.at, from), message.text.length);
      const text = message.text.slice(from, at);
      if (text.trim()) out.push({ kind: "text", key: `t${from}`, html: render(text, false) });
      out.push({ kind: "visual", key: visual.id, visual });
      from = at;
    }
    const rest = message.text.slice(from);
    if (rest.trim() || !visuals.length)
      out.push({ kind: "text", key: `t${from}`, html: render(rest, streaming) });
    return out;
  });
  const steps = $derived(message.steps ?? []);
  const working = $derived(steps.some((step) => step.state === "running"));

  /** A quoted passage sent from the reader: "> text" lines, then "> (source)". */
  const quoted = $derived.by(() => {
    if (message.role !== "user" || !message.text.startsWith("> ")) return null;
    const lines = message.text.split("\n");
    const quoteLines: string[] = [];
    while (lines[0]?.startsWith("> ")) quoteLines.push(lines.shift()!.slice(2));
    const source = /^\((.*)\)$/.exec(quoteLines.at(-1) ?? "")?.[1];
    if (source) quoteLines.pop();
    return {
      text: quoteLines.join(" "),
      source,
      rest: lines.join("\n").trim(),
    };
  });

  const CLOSE: Record<string, string> = {
    "\\(": "\\)",
    "\\[": "\\]",
    $$: "$$",
    $: "$",
  };

  /**
   * Copying part of a reply puts each formula back as TeX, in the delimiters it arrived in, and
   * each diagram back as its Mermaid source.
   */
  function copyWithTex(event: ClipboardEvent): void {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData)
      return;
    const range = selection.getRangeAt(0).cloneRange();
    const wholeOf = (node: Node) =>
      (node instanceof Element ? node : node.parentElement)?.closest(".math, .diagram");
    // A selection that starts or ends inside a formula or diagram takes the whole of it.
    const first = wholeOf(range.startContainer);
    const last = wholeOf(range.endContainer);
    if (first) range.setStartBefore(first);
    if (last) range.setEndAfter(last);
    const fragment = range.cloneContents();
    const formulas = fragment.querySelectorAll<HTMLElement>(".math[data-tex]");
    const diagrams = fragment.querySelectorAll<HTMLElement>(".diagram[data-source]");
    if (!formulas.length && !diagrams.length) return;
    for (const diagram of diagrams) {
      const source = document.createElement("pre");
      source.textContent = diagramFence(decodeURIComponent(diagram.dataset.source ?? ""));
      diagram.replaceWith(source);
    }
    for (const formula of formulas) {
      const open = formula.dataset.open ?? "\\(";
      const source = document.createElement(formula.tagName.toLowerCase());
      source.textContent = `${open}${formula.dataset.tex ?? ""}${CLOSE[open] ?? open}`;
      formula.replaceWith(source);
    }
    // innerText keeps paragraph breaks; it needs the text laid out, so off screen.
    const holder = document.createElement("div");
    holder.setAttribute("aria-hidden", "true");
    holder.style.cssText = "position:fixed;left:-100000px;top:0;";
    holder.append(fragment);
    document.body.append(holder);
    const text = holder.innerText;
    holder.remove();
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  }

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(message.text);
    copied = true;
    setTimeout(() => (copied = false), 1400);
  }
</script>

<!-- Each line of a question keeps the direction of its first letter, as it was typed. -->
{#snippet lines(text: string)}
  {@const whole = writtenDirection(estimateDirection(text)) ?? "ltr"}
  <div class="flex flex-col">
    {#each text.split("\n") as line, index (index)}
      <span
        class="min-h-6 break-words whitespace-pre-wrap"
        dir={writtenDirection(estimateDirection(line)) ?? whole}>{line}</span
      >
    {/each}
  </div>
{/snippet}

{#if message.kind === "summary"}
  <div class="flex items-center gap-3 text-[12px] text-text-4" role="separator">
    <span class="h-px flex-1 bg-line-subtle"></span>
    Earlier messages were summarized for the tutor
    <span class="h-px flex-1 bg-line-subtle"></span>
  </div>
{:else if message.role === "user"}
  <div class="flex animate-[folio-in_220ms_var(--ease-out-quint)] justify-end">
    <div
      class="flex max-w-[85%] flex-col gap-2 rounded-[16px] rounded-br-[5px] border border-line-subtle bg-sunken px-4 py-2.5 text-[15px] leading-6 text-text select-text dark:bg-raised"
    >
      {#if quoted}
        <div
          class="flex gap-2.5 rounded-lg bg-surface py-2 pr-3 pl-0 dark:bg-surface"
        >
          <span class="w-[3px] shrink-0 rounded-full bg-highlight"></span>
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="font-serif text-[14px] leading-5 break-words" dir="auto"
              >{quoted.text}</span
            >
            {#if quoted.source}<span class="text-[11px] text-text-3"
                >{quoted.source}</span
              >{/if}
          </div>
        </div>
        {@render lines(quoted.rest)}
      {:else}
        {@render lines(message.text)}
      {/if}
    </div>
  </div>
  {#if message.attachments?.length}
    {@const chip =
      "inline-flex h-6 max-w-[240px] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] whitespace-nowrap text-text-3 transition-colors hover:bg-hover hover:text-text-2"}
    <!-- What the student added, under the question: each opens what it names. -->
    <div class="-mt-1 flex flex-wrap items-center justify-end gap-1">
      {#each message.attachments as attachment, index (index)}
        {#if attachment.kind === "image"}
          <img
            src={attachment.thumbnail}
            alt={attachment.name || "Image"}
            title={attachment.name || "Image"}
            class="h-12 max-w-[96px] rounded-md border border-line-subtle object-cover"
          />
        {:else if attachment.kind === "page"}
          {@const document = folio.document(attachment.documentId)}
          <button
            class={chip}
            title="Folio saw this page with the question"
            onclick={() =>
              folio.openDocument(attachment.documentId, attachment.page, {
                chatId,
              })}
          >
            <ScanText size={12} strokeWidth={1.75} class="shrink-0" />
            <span class="shrink-0">Page {attachment.page}</span>
            {#if document}
              <span class="min-w-0 truncate" dir="auto"
                >· {shortTitle(
                  document.title,
                  folio.course(document.courseId)?.name,
                )}</span
              >
            {/if}
          </button>
        {:else if attachment.kind === "document"}
          {@const document = folio.document(attachment.documentId)}
          <button
            class={chip}
            title="Added to this chat"
            onclick={() =>
              folio.openDocument(attachment.documentId, 1, { chatId })}
          >
            <FileText size={12} strokeWidth={1.75} class="shrink-0" />
            <span class="min-w-0 truncate" dir="auto"
              >{document
                ? shortTitle(document.title, folio.course(document.courseId)?.name)
                : "A removed document"}</span
            >
          </button>
        {:else}
          {@const course = folio.course(attachment.courseId)}
          <button
            class={chip}
            title="Added to this chat"
            onclick={() =>
              course &&
              folio.navigate({
                view: "course",
                courseId: course.id,
                tab: "materials",
              })}
          >
            {#if course}<CourseTile {course} size={12} />{/if}
            <span class="min-w-0 truncate" dir="auto"
              >{course?.name ?? "A removed course"}</span
            >
          </button>
        {/if}
      {/each}
    </div>
  {/if}
{:else}
  <div class="group flex animate-[folio-fade_200ms_ease-out] flex-col gap-2">
    {#if steps.length}
      <div class="flex flex-col">
        <button
          class="-ml-1 flex h-7 w-fit items-center gap-2 rounded-md px-1 text-[13px] text-text-3 hover:text-text-2"
          onclick={() => (showSteps = !showSteps)}
        >
          {#if working}<FolioMark size={14} working />{/if}
          <span>
            {working
              ? (steps.find((step) => step.state === "running")?.label ??
                "Working")
              : `Worked through ${steps.length} step${steps.length === 1 ? "" : "s"}`}
          </span>
          <ChevronDown
            size={13}
            strokeWidth={2}
            class="transition-transform {showSteps ? 'rotate-180' : ''}"
          />
        </button>
        {#if showSteps}
          <div
            class="ml-1 flex flex-col gap-1 border-l border-line pt-1 pb-1 pl-3"
          >
            {#each steps as step, index (index)}
              <span
                class="text-[13px] {step.state === 'failed'
                  ? 'text-danger'
                  : step.state === 'running'
                    ? 'text-text'
                    : 'text-text-2'}">{step.label}</span
              >
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    {#if message.state === "streaming" && !message.text && !message.visuals?.length && !working}
      <div class="flex h-7 items-center gap-2.5 text-text-3">
        <FolioMark size={18} working />
        <span>Thinking</span>
      </div>
    {:else if message.text || message.visuals?.length}
      <div
        class="prose-folio select-text"
        class:is-streaming={message.state === "streaming"}
        oncopy={copyWithTex}
      >
        {#each parts as part (part.key)}
          {#if part.kind === "visual"}
            <VisualCard visual={part.visual} {chatId} />
          {:else}
            <!-- Sanitized by DOMPurify in renderMarkdown. -->
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html part.html}
          {/if}
        {/each}
      </div>
    {/if}
    {#if message.sources?.length}
      <div class="flex flex-wrap gap-1.5">
        {#each message.sources as source (`${source.documentId}:${source.page}`)}
          {@const cited = folio.document(source.documentId)}
          <button
            class="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-line-subtle bg-sunken px-2 text-[12px] whitespace-nowrap text-text-2 transition-colors hover:border-line hover:text-text dark:bg-raised"
            title="{source.title} · Page {source.page}"
            onclick={() =>
              folio.openDocument(source.documentId, source.page, { chatId })}
          >
            <FileText size={12} strokeWidth={1.75} class="shrink-0" />
            <span class="max-w-[240px] min-w-0 truncate" dir="auto"
              >{shortTitle(source.title, folio.course(cited?.courseId)?.name)}</span
            >
            <span class="shrink-0">· Page {source.page}</span>
          </button>
        {/each}
      </div>
    {/if}
    {#each message.proposals ?? [] as id (id)}
      <ProposalCard {id} />
    {/each}
    {#each message.noteEdits ?? [] as edit, index (`${index}:${edit.noteId}:${edit.after}`)}
      <NoteEditCard {edit} />
    {/each}
    {#if message.state === "interrupted"}
      <span class="text-[12px] text-text-3">Stopped</span>
    {:else if message.state === "failed"}
      <span class="text-[13px] text-danger"
        >{message.error ?? "The reply failed."}</span
      >
    {/if}
    {#if message.state !== "streaming" && message.text}
      <div
        class="-ml-1.5 flex h-7 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
      >
        <button
          class="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-text-3 hover:bg-hover hover:text-text"
          onclick={copy}
        >
          {#if copied}<Check size={13} strokeWidth={2} /> Copied{:else}<Copy
              size={13}
              strokeWidth={1.75}
            /> Copy{/if}
        </button>
      </div>
    {/if}
  </div>
{/if}
