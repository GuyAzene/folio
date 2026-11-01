<script lang="ts">
  import { Plug } from "@lucide/svelte";
  import type { ApprovalDecision, ApprovalView } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * A call the tutor wants to make to one of the student's services, waiting for them: the
   * service, the tool and exactly what Folio will send. Nothing is sent until they allow it.
   */
  let { approval }: { approval: ApprovalView } = $props();

  let working = $state(false);
  let showAll = $state(false);
  const long = $derived(approval.args.split("\n").length > 8);

  async function answer(decision: ApprovalDecision): Promise<void> {
    if (working) return;
    working = true;
    await folio.answerApproval(approval.id, decision);
    working = false;
  }

  /** What the server says about its tool, in plain words; its own claim, not Folio's check. */
  const hint = $derived(
    approval.hints.readOnly === true
      ? `${approval.label} says this only reads`
      : approval.hints.destructive === true
        ? `${approval.label} says this can change or delete things`
        : approval.hints.readOnly === false
          ? `${approval.label} says this can change things`
          : "",
  );

  const button =
    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium whitespace-nowrap disabled:opacity-50";
</script>

<div
  class="flex max-w-full min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] shadow-1 dark:bg-raised"
  role="group"
  aria-label="Allow {approval.label} · {approval.tool}?"
>
  <div class="flex min-w-0 items-start gap-2.5">
    <Plug size={14} strokeWidth={1.75} class="mt-0.5 shrink-0 text-text-3" />
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-text"
        >Use <span class="font-medium">{approval.label}</span> ·
        <span class="font-medium" dir="ltr">{approval.tool}</span>?</span
      >
      {#if approval.description}
        <span class="line-clamp-2 text-[12px] text-text-3" dir="auto"
          >{approval.description}</span
        >
      {/if}
    </div>
  </div>
  <div class="flex flex-col gap-1">
    <span class="text-[11px] text-text-3">Folio will send</span>
    <pre
      class="scroll-quiet {showAll
        ? 'max-h-[320px]'
        : 'max-h-[132px]'} overflow-auto rounded-md bg-sunken px-2.5 py-1.5 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap text-text-2 dark:bg-surface"
      dir="ltr">{approval.args}</pre>
    {#if long}
      <button
        type="button"
        class="self-start text-[12px] text-text-3 hover:text-text"
        onclick={() => (showAll = !showAll)}>{showAll ? "Show less" : "Show all"}</button
      >
    {/if}
  </div>
  <div class="flex flex-wrap items-center justify-end gap-1.5">
    {#if hint}<span class="mr-auto text-[12px] text-text-3">{hint}</span>{/if}
    <button
      type="button"
      class="{button} text-text-2 hover:bg-hover hover:text-text"
      disabled={working}
      onclick={() => void answer("deny")}>Deny</button
    >
    <button
      type="button"
      class="{button} border border-line text-text hover:bg-hover"
      disabled={working}
      onclick={() => void answer("always")}>Always allow</button
    >
    <button
      type="button"
      class="{button} bg-ink text-on-ink hover:opacity-90"
      disabled={working}
      onclick={() => void answer("once")}>Allow once</button
    >
  </div>
</div>
