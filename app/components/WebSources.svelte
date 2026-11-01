<script lang="ts">
  import { ChevronDown, Globe } from "@lucide/svelte";

  /**
   * The web pages a reply's searches found, folded into one quiet line. The reply links each
   * web claim where it makes it; this list is only there for whoever wants every page.
   */
  let { sources }: { sources: { url: string; title: string }[] } = $props();
  let open = $state(false);

  const site = (url: string) => new URL(url).hostname.replace(/^www\./, "");
</script>

<div class="flex flex-col">
  <button
    class="-ml-1 flex h-7 w-fit items-center gap-2 rounded-md px-1 text-[13px] text-text-3 hover:text-text-2"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <Globe size={13} strokeWidth={1.75} class="shrink-0" />
    <span
      >Searched the web · {sources.length}
      {sources.length === 1 ? "page" : "pages"}</span
    >
    <ChevronDown
      size={13}
      strokeWidth={2}
      class="transition-transform {open ? 'rotate-180' : ''}"
    />
  </button>
  {#if open}
    <div class="ml-1 flex flex-col gap-1 border-l border-line py-1 pl-3">
      {#each sources as source (source.url)}
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          title={source.url}
          class="flex min-w-0 items-baseline gap-2 text-[13px] leading-5 text-text-3 no-underline hover:text-text"
        >
          <span class="min-w-0 truncate text-text-2" dir="auto">{source.title}</span>
          <span class="shrink-0">{site(source.url)}</span>
        </a>
      {/each}
    </div>
  {/if}
</div>
