<script lang="ts">
  import { Maximize2, Minimize2, X } from "@lucide/svelte";
  import { getPane } from "../lib/pane.ts";
  import { folio } from "../lib/state.svelte.ts";
  import IconButton from "./IconButton.svelte";

  /**
   * A pane's own buttons, at the end of its header, once its tab is split: on what sits beside
   * the document, not on the document itself, which closes with its tab.
   */
  const pane = getPane();
</script>

{#if pane?.split && !pane.lead}
  <span class="-mr-1 flex shrink-0 items-center">
    <IconButton
      label={pane.maximized ? "Show every pane" : "Maximize"}
      onclick={() => folio.toggleMaximized(pane.id)}
    >
      {#if pane.maximized}<Minimize2 size={14} strokeWidth={1.75} />{:else}<Maximize2
          size={14}
          strokeWidth={1.75}
        />{/if}
    </IconButton>
    <IconButton label="Close pane" shortcut="⌘W" onclick={() => folio.closePane(pane.id)}>
      <X size={14} strokeWidth={1.75} />
    </IconButton>
  </span>
{/if}
