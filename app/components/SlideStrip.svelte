<script lang="ts" module>
  import * as pdfjs from "pdfjs-dist";
  import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  /** Thumbnails per document, rendered once per session and shared by every strip. */
  const thumbnails = new Map<string, Promise<string[]>>();

  async function render(
    read: (id: string) => Promise<Uint8Array>,
    documentId: string,
  ): Promise<string[]> {
    const pdf = await pdfjs.getDocument({ data: await read(documentId) })
      .promise;
    const urls: string[] = [];
    try {
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 160 / base.height });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvas, viewport }).promise;
        urls.push(canvas.toDataURL("image/jpeg", 0.8));
        page.cleanup();
      }
    } finally {
      void pdf.loadingTask.destroy();
    }
    return urls;
  }
</script>

<script lang="ts">
  import type { PageCoverageView } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * The document's own pages, small: unread pages wait greyed out, pages being read now carry a
   * blue ring, and a page with something to decide gets a marker. The student sees their
   * lecture being read, not a progress bar.
   */
  let {
    documentId,
    pages,
    active = [],
  }: {
    documentId: string;
    pages: PageCoverageView[];
    active?: number[];
  } = $props();

  let urls = $state<string[]>([]);
  $effect(() => {
    const id = documentId;
    let current = thumbnails.get(id);
    if (!current) {
      current = render((key) => folio.api.readDocument(key), id);
      thumbnails.set(id, current);
      current.catch(() => thumbnails.delete(id));
    }
    let live = true;
    current.then((rendered) => live && (urls = rendered)).catch(() => {});
    return () => (live = false);
  });

  // Up to ten pages a row, each at most 112px wide; longer documents wrap into more rows.
  const columns = $derived(Math.max(1, Math.min(pages.length, 10)));
  let ratio = $state(16 / 9);

  const STATE: Record<PageCoverageView["state"], string> = {
    pending: "not read yet",
    read: "read",
    escalated: "read, then looked at up close",
    represented: "written up",
    // Studies from before 2026-10-29 could end a page in these states; it was still written up.
    gap: "written up",
    unaccounted: "written up",
  };
</script>

<div
  class="grid gap-1.5"
  style="grid-template-columns:repeat({columns}, minmax(0, 1fr));max-width:{columns *
    112}px"
  aria-label="Pages"
>
  {#each pages as cell (cell.page)}
    {@const now = active.includes(cell.page)}
    {@const waiting = cell.state === "pending" && !now}
    <div
      class="relative overflow-hidden rounded-[5px] bg-sunken shadow-card transition-[opacity,filter,box-shadow] duration-500 {waiting
        ? 'opacity-35 grayscale'
        : ''} {now ? 'ring-2 ring-live ring-offset-1 ring-offset-surface' : ''}"
      style="aspect-ratio:{ratio}"
      title="Page {cell.page}: {now ? 'being read now' : STATE[cell.state]}"
    >
      {#if urls[cell.page - 1]}
        <img
          src={urls[cell.page - 1]}
          alt="Page {cell.page}"
          class="size-full object-cover"
          draggable="false"
          onload={(event) => {
            const image = event.currentTarget as HTMLImageElement;
            if (cell.page === 1)
              ratio = image.naturalWidth / image.naturalHeight;
          }}
        />
      {/if}
      {#if now}
        <span class="scan pointer-events-none absolute inset-0"></span>
      {/if}
    </div>
  {/each}
</div>

<style>
  /* A soft band passing over a page while a model reads it. */
  .scan {
    background: linear-gradient(
      180deg,
      transparent 0%,
      color-mix(in srgb, var(--color-live-line) 45%, transparent) 50%,
      transparent 100%
    );
    background-size: 100% 220%;
    animation: scan 1.8s ease-in-out infinite;
  }
  @keyframes scan {
    from {
      background-position: 0 120%;
    }
    to {
      background-position: 0 -120%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .scan {
      animation: none;
      background: color-mix(in srgb, var(--color-live-line) 25%, transparent);
    }
  }
</style>
