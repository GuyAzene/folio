<script lang="ts">
  import { demoPlaceholders, type DemoRunner } from "../lib/demo-placeholder.ts";
  import { linkedMarkdown, wikilinkTarget } from "../lib/editor/wikilinks.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { markWideMath } from "../lib/wide-math.ts";

  /**
   * A note's reading view: its Markdown drawn as the student reads it. The note view shows it in
   * Read mode, and a picture of the note for the tutor draws the very same thing.
   */
  let {
    content,
    linkLabel,
    courseId = null,
    demos = demoPlaceholders,
    onlink,
    sourceLines = false,
    article = $bindable(),
  }: {
    content: string;
    /** A page citation reads with its file's current name. */
    linkLabel: (target: string, shown: string) => string | null;
    /** The course the note belongs to, whose figures it shows. */
    courseId?: string | null;
    /** How ```demo blocks run; a picture of the note shows placeholders instead. */
    demos?: DemoRunner;
    /** Opens a link's note, topic, page or chat. */
    onlink?: (target: string, newTab: boolean) => void;
    /** Marks each block with its first source line, for a picture of the note. */
    sourceLines?: boolean;
    article?: HTMLElement;
  } = $props();

  const html = $derived(
    renderMarkdown(linkedMarkdown(content || "Nothing here yet.", linkLabel), {
      note: true,
      assets: courseId,
      sourceLines,
    }),
  );
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
  bind:this={article}
  class="prose-folio prose-reading mx-auto max-w-[784px] px-8 pt-10 pb-8 font-serif text-[17px] leading-7 max-sm:px-4"
  onclick={(event) => {
    const anchor = (event.target as Element).closest?.("a");
    const target = wikilinkTarget(anchor?.getAttribute("href") ?? null);
    if (!target || !onlink) return;
    event.preventDefault();
    onlink(target, event.metaKey || event.ctrlKey);
  }}
  {@attach (node) => {
    // Demos run again, and wide formulas are measured again, whenever the note's text changes.
    void html;
    const stop = demos(node);
    markWideMath(node);
    const resized = new ResizeObserver(() => markWideMath(node));
    resized.observe(node);
    return () => {
      stop();
      resized.disconnect();
    };
  }}
>
  <!-- Sanitized by DOMPurify in renderMarkdown. -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html html}
</article>
