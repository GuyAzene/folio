<script lang="ts">
  import type { VisualView } from "../../src/desktop/api.ts";
  import { staticSvg, svgImage } from "../../src/visual.ts";
  import { folio } from "../lib/state.svelte.ts";
  import ArtifactFrame from "./ArtifactFrame.svelte";

  /**
   * A drawing or demo the tutor showed. A still SVG is an image (it runs nothing); anything that
   * moves or responds runs in a sealed frame. While the tutor is still writing it, the card says
   * so; a visual Folio refused, or one the reply never finished, shows why.
   */
  let { visual, chatId }: { visual: VisualView; chatId: string | null } = $props();

  let problem = $state<string | null>(null);
  let copied = $state(false);
  const still = $derived(staticSvg(visual.source));
  const kilobytes = $derived(Math.max(1, Math.round(visual.source.length / 1024)));

  /** The visual as Markdown for a note: an SVG as itself, a demo as a ```demo block. */
  function markdown(): string {
    return visual.kind === "svg" ? visual.source : `\`\`\`demo\n${visual.source}\n\`\`\``;
  }

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(markdown());
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }

  function askToFix(): void {
    if (chatId)
      folio.offerQuestion(
        chatId,
        `The visual "${visual.title}" shows an error: ${problem ?? visual.error ?? "it does not work"}. Please fix it.`,
      );
  }
</script>

<figure class="visual" dir="ltr">
  {#if visual.state === "streaming"}
    <div class="visual-pending">
      Drawing {visual.title || "a visual"}… <span>{kilobytes} KB</span>
    </div>
  {:else if visual.state === "invalid"}
    <p class="visual-note">This visual couldn't be shown. {visual.error}</p>
  {:else if visual.state === "stopped"}
    <p class="visual-note">This visual wasn't finished.</p>
  {:else if still}
    <img class="visual-drawing" src={svgImage(visual.source, folio.shownTheme)} alt={visual.title} />
  {:else}
    <ArtifactFrame
      source={visual.source}
      title={visual.title}
      {chatId}
      onproblem={(message) => (problem = message)}
    />
  {/if}
  {#if visual.state === "ready"}
    <figcaption class="visual-caption">
      <span class="visual-title" dir="auto">{visual.title}</span>
      {#if problem}
        <span class="visual-problem">Error: {problem}</span>
        <button type="button" onclick={askToFix}>Ask the tutor to fix this</button>
      {/if}
      <button type="button" onclick={copy}>{copied ? "Copied" : "Copy"}</button>
    </figcaption>
  {/if}
</figure>
