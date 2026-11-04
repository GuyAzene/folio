<script lang="ts">
  import { tabTitle } from "../lib/labels.ts";
  import { activePane, evenSizes, minWidth, resize, type Tab } from "../lib/layout.ts";
  import { folio } from "../lib/state.svelte.ts";
  import PaneView from "./PaneView.svelte";

  /**
   * A tab's panes side by side, with a divider to drag between each two. A maximized pane shows
   * alone; in a window too narrow for every pane, the active one shows with the others as
   * chips above it.
   */
  let { tab }: { tab: Tab } = $props();

  const DIVIDER = 5;
  let width = $state(0);

  const layout = $derived(tab.history[tab.index]!);
  const mins = $derived(layout.panes.map((pane) => minWidth(pane.location)));
  const crowded = $derived(
    width > 0 &&
      layout.panes.length > 1 &&
      width < mins.reduce((sum, min) => sum + min, 0) + DIVIDER * (layout.panes.length - 1),
  );
  const alone = $derived(
    layout.panes.find((pane) => pane.id === layout.maximized) ??
      (crowded ? activePane(layout) : null),
  );
  const shown = $derived(alone ? [alone] : layout.panes);
  /** Each pane's share of the room left once the dividers are drawn. */
  const room = $derived(Math.max(0, width - DIVIDER * (shown.length - 1)));

  function startResize(event: PointerEvent, index: number): void {
    event.preventDefault();
    const startX = event.clientX;
    const start = layout.sizes;
    const shares = mins.map((min) => min / Math.max(room, 1));
    const move = (moved: PointerEvent) =>
      folio.resizePanes(
        tab.id,
        resize(start, index, (moved.clientX - startX) / Math.max(room, 1), shares),
      );
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    // Dragging over a page or a chat must not select its text.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if crowded && !layout.maximized}
    <div
      class="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-line-subtle px-2 [scrollbar-width:none]"
      role="tablist"
      aria-label="Panes in this tab"
    >
      {#each layout.panes as pane (pane.id)}
        {@const active = pane.id === layout.recent[0]}
        <button
          role="tab"
          aria-selected={active}
          class="h-6 max-w-[180px] shrink-0 truncate rounded-md px-2 text-[12px] font-medium {active
            ? 'bg-selected text-text'
            : 'text-text-3 hover:bg-hover hover:text-text-2'}"
          dir="auto"
          onclick={() => folio.activatePane(pane.id)}>{tabTitle(pane.location)}</button
        >
      {/each}
    </div>
  {/if}
  <div class="flex min-h-0 flex-1" bind:clientWidth={width}>
    {#each shown as pane, index (pane.id)}
      {#if index > 0}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="group relative w-[5px] shrink-0 cursor-col-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panes"
          title="Drag to resize · double-click to share evenly"
          onpointerdown={(event) => startResize(event, index - 1)}
          ondblclick={() => folio.resizePanes(tab.id, evenSizes(layout.panes.length))}
        >
          <div
            class="absolute inset-y-0 left-[2px] w-px bg-line-subtle transition-colors group-hover:bg-line-strong"
          ></div>
        </div>
      {/if}
      {@const share = layout.sizes[layout.panes.indexOf(pane)] ?? 1}
      <!-- A click or keystroke anywhere in a pane makes it the one Folio's keys and sidebar act on. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="relative flex min-h-0 min-w-0 flex-col"
        style={shown.length > 1
          ? `flex: ${share} 1 0px; min-width: ${mins[layout.panes.indexOf(pane)]}px`
          : "flex: 1 1 0px"}
        data-pane={pane.id}
        onpointerdowncapture={() => folio.activatePane(pane.id)}
        onfocusin={() => folio.activatePane(pane.id)}
      >
        <PaneView tabId={tab.id} {pane} {layout} width={shown.length > 1 ? share * room : width} />
      </div>
    {/each}
  </div>
</div>
