<script lang="ts">
  import {
    Check,
    ChevronRight,
    CircleAlert,
    LoaderCircle,
    Pause,
  } from "@lucide/svelte";
  import { quintOut } from "svelte/easing";
  import { slide } from "svelte/transition";
  import { formatElapsed, formatTokens, plural } from "../lib/labels.ts";
  import type { StudyDocument } from "../lib/study.ts";
  import ProviderMark from "./ProviderMark.svelte";
  import SlideStrip from "./SlideStrip.svelte";

  /**
   * One lecture or recitation being studied, after Elicit's report status: the slides, four
   * plain stages with what each produced, and the model on the current one. Finished documents
   * fold to one line of results.
   */
  let {
    study,
    now,
    finished = false,
  }: {
    study: StudyDocument;
    /** The page's ticking clock, shared by every card. */
    now: number;
    /** The whole job has finished, so this card starts folded. */
    finished?: boolean;
  } = $props();

  let unfolded = $state<boolean | null>(null);
  const open = $derived(unfolded ?? !finished);
  let showActivity = $state(false);

  const elapsed = $derived(
    study.start === null ? "" : formatElapsed((study.end ?? now) - study.start),
  );

  /** "8 pages · 6 topics", from what the document recorded. */
  const results = $derived.by(() => {
    const outcome = study.outcome;
    if (!outcome) return plural(study.pages.length, "page");
    return [
      plural(outcome.pages ?? study.pages.length, "page"),
      outcome.topics !== undefined && plural(outcome.topics, "topic"),
    ]
      .filter(Boolean)
      .join(" · ");
  });
</script>

<article class="rounded-xl bg-surface shadow-card dark:bg-raised">
  <button
    type="button"
    class="flex w-full items-center gap-3 px-5 py-4 text-left"
    aria-expanded={open}
    onclick={() => (unfolded = !open)}
  >
    <span class="min-w-0 flex-1 truncate text-[14px] leading-5" dir="auto">
      <span class="font-semibold text-text">{study.title}</span>
      {#if study.subtitle}<span class="text-text-3">
          · {study.subtitle}</span
        >{/if}
    </span>
    {#if study.status === "done"}
      <span class="shrink-0 text-[12.5px] text-text-2 tabular-nums"
        >{results}</span
      >
    {:else if study.status === "failed" || study.problem}
      <span
        class="flex shrink-0 items-center gap-1.5 text-[12.5px] text-danger"
      >
        <CircleAlert size={13} strokeWidth={2} /> Couldn't finish
      </span>
    {:else if study.status === "stopped"}
      <span class="shrink-0 text-[12.5px] text-text-3">Paused</span>
    {:else if study.status === "queued"}
      <span class="shrink-0 text-[12.5px] text-text-3">Waiting to start</span>
    {:else if elapsed}
      <span class="shrink-0 text-[12.5px] text-text-3 tabular-nums"
        >{elapsed}</span
      >
    {/if}
    <ChevronRight
      size={14}
      strokeWidth={2}
      class="shrink-0 text-text-4 transition-transform duration-200 {open
        ? 'rotate-90'
        : ''}"
    />
  </button>

  {#if open}
    <div
      class="px-5 pb-4"
      transition:slide={{ duration: 220, easing: quintOut }}
    >
      <SlideStrip
        documentId={study.documentId}
        pages={study.pages}
        active={study.activePages}
      />

      {#if study.stages.length}
        <ol class="mt-4 flex flex-col">
          {#each study.stages as stage, index (stage.label)}
            <li class="flex items-start gap-3">
              <span class="flex flex-col items-center self-stretch">
                <span
                  class="grid size-[18px] shrink-0 place-items-center rounded-full {stage.state ===
                  'done'
                    ? 'bg-done-wash text-done'
                    : stage.state === 'running'
                      ? 'bg-live-wash text-live'
                      : stage.state === 'failed'
                        ? 'bg-danger-wash text-danger'
                        : 'border border-line-strong'}"
                >
                  {#if stage.state === "done"}
                    <Check size={11} strokeWidth={3} />
                  {:else if stage.state === "running"}
                    <LoaderCircle
                      size={11}
                      strokeWidth={2.75}
                      class="animate-spin"
                    />
                  {:else if stage.state === "failed"}
                    <span class="text-[11px] leading-none font-bold">!</span>
                  {/if}
                </span>
                {#if index < study.stages.length - 1}
                  <span
                    class="my-0.5 w-px flex-1 {stage.state === 'done'
                      ? 'bg-done/40'
                      : 'bg-line'}"
                  ></span>
                {/if}
              </span>
              <span
                class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 pb-3 text-[13px] leading-[18px]"
              >
                <span
                  class={stage.state === "pending"
                    ? "text-text-3"
                    : "font-medium text-text"}>{stage.label}</span
                >
                <span
                  class="ml-auto flex min-w-0 shrink items-center gap-1.5 text-[12.5px] whitespace-nowrap text-text-3 tabular-nums"
                >
                  {#if stage.detail}<span class="truncate">{stage.detail}</span
                    >{/if}
                  {#if stage.model}
                    {#if stage.detail}<span aria-hidden="true">·</span>{/if}
                    <span class="flex items-center gap-1 text-text-2">
                      {#if stage.provider}<ProviderMark
                          provider={stage.provider}
                          name={stage.model}
                          size={11}
                        />{/if}
                      {stage.model}
                    </span>
                  {/if}
                </span>
              </span>
            </li>
          {/each}
        </ol>
      {/if}

      {#if study.problem}
        <div
          class="mt-1 rounded-lg bg-danger-wash px-3 py-2 text-[12.5px] leading-[18px] text-text"
        >
          {study.problem.message}
          {#if study.problem.detail && study.problem.detail !== study.problem.message}
            <details class="mt-1 text-[11.5px] text-text-3">
              <summary class="cursor-default">Details</summary>
              <p class="mt-0.5 font-mono break-words">{study.problem.detail}</p>
            </details>
          {/if}
        </div>
      {/if}

      {#if study.activity.length}
        <div
          class="mt-2 flex items-center justify-between text-[12px] text-text-3"
        >
          <span class="tabular-nums"
            >{study.tokens
              ? `${formatTokens(study.tokens)} tokens on your plan`
              : ""}</span
          >
          <button
            type="button"
            class="flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-hover hover:text-text"
            aria-expanded={showActivity}
            onclick={() => (showActivity = !showActivity)}
          >
            {showActivity ? "Hide activity" : "Show activity"}
            <ChevronRight
              size={12}
              strokeWidth={2}
              class="transition-transform duration-200 {showActivity
                ? 'rotate-90'
                : ''}"
            />
          </button>
        </div>
        {#if showActivity}
          <ul
            class="mt-2 flex flex-col border-t border-line-subtle pt-2"
            transition:slide={{ duration: 200, easing: quintOut }}
          >
            {#each study.activity as item (item.id)}
              <li
                class="flex items-center gap-2.5 py-1 text-[12.5px] leading-[18px]"
              >
                <span class="grid w-3.5 shrink-0 place-items-center">
                  {#if item.status === "running"}
                    <LoaderCircle
                      size={12}
                      strokeWidth={2.5}
                      class="animate-spin text-live"
                    />
                  {:else if item.status === "done"}
                    <Check size={12} strokeWidth={2.5} class="text-done" />
                  {:else if item.status === "failed"}
                    <CircleAlert
                      size={12}
                      strokeWidth={2.25}
                      class="text-danger"
                    />
                  {:else if item.status === "stopped"}
                    <Pause
                      size={10}
                      strokeWidth={0}
                      fill="currentColor"
                      class="text-text-3"
                    />
                  {:else}
                    <span class="size-1.5 rounded-full bg-line-strong"></span>
                  {/if}
                </span>
                <span class="min-w-0 flex-1 truncate text-text-2"
                  >{item.title}</span
                >
                <span class="flex shrink-0 items-center gap-1 text-text-3">
                  {#if item.provider}<ProviderMark
                      provider={item.provider}
                      name={item.model}
                      size={11}
                    />{/if}
                  {item.model}
                </span>
                <span
                  class="w-[64px] shrink-0 text-right text-text-3 tabular-nums"
                  >{item.tokens ? formatTokens(item.tokens) : ""}</span
                >
                <span
                  class="w-[52px] shrink-0 text-right text-text-3 tabular-nums"
                  >{item.start !== null &&
                  (item.end !== null || item.status === "running")
                    ? formatElapsed((item.end ?? now) - item.start)
                    : ""}</span
                >
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  {/if}
</article>
