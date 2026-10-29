<script lang="ts">
  import type { AssignmentStatus } from "../../src/library/assignments.ts";

  /**
   * An assignment's status as a small graphite mark, the same on cards, column headers and in
   * menus: an empty ring to do, half filled while doing, three quarters once submitted, and a
   * check when done. The highlighter yellow stays out of it; it is for Folio's AI moments.
   */
  let { status, size = 14 }: { status: AssignmentStatus; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  class="shrink-0 {status === 'done' ? 'text-text-2' : 'text-text-3'}"
  aria-hidden="true"
>
  {#if status === "done"}
    <circle cx="8" cy="8" r="7" fill="currentColor" />
    <path
      d="M5 8.2 7.1 10.3 11 6"
      fill="none"
      stroke="var(--surface)"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {:else}
    <circle
      cx="8"
      cy="8"
      r="6.25"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
    />
    {#if status === "doing"}
      <path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />
    {:else if status === "submitted"}
      <path d="M8 3.5a4.5 4.5 0 1 1-4.5 4.5H8z" fill="currentColor" />
    {/if}
  {/if}
</svg>
