<script lang="ts">
  import { tick, untrack } from "svelte";

  /**
   * A name that becomes a text field to rename it. Enter or leaving the field saves; Escape
   * puts the name back. An empty or unchanged name saves nothing.
   */
  let {
    value,
    editing = $bindable(false),
    label,
    max = 160,
    class: className = "",
    onsave,
  }: {
    value: string;
    editing?: boolean;
    /** What the field renames, for screen readers: "Rename Lecture 2". */
    label: string;
    max?: number;
    class?: string;
    onsave: (name: string) => void;
  } = $props();

  let draft = $state("");
  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (!editing) return;
    draft = untrack(() => value);
    void tick().then(() => {
      input?.focus();
      input?.select();
    });
  });

  function finish(save: boolean): void {
    if (!editing) return;
    editing = false;
    const name = draft.trim();
    if (save && name && name !== value) onsave(name);
  }
</script>

{#if editing}
  <input
    bind:this={input}
    bind:value={draft}
    maxlength={max}
    aria-label={label}
    dir="auto"
    spellcheck="false"
    class="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 text-text outline-none focus:border-ink dark:bg-sunken {className}"
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    }}
    onblur={() => finish(true)}
  />
{:else}
  <span class="min-w-0 truncate {className}" dir="auto">{value}</span>
{/if}
