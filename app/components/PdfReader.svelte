<script lang="ts">
  import * as pdfjs from "pdfjs-dist";
  import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
  import "pdfjs-dist/web/pdf_viewer.css";
  import { onDestroy } from "svelte";
  import type { DocumentView } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";

  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  let {
    document,
    page,
    zoom = 1,
    onpage,
    onselect,
  }: {
    document: DocumentView;
    page: number;
    zoom?: number;
    onpage: (page: number) => void;
    onselect: (
      selection: { text: string; page: number; rect: DOMRect } | null,
    ) => void;
  } = $props();

  let scroller: HTMLDivElement;
  let pages = $state<{ number: number; width: number; height: number }[]>([]);
  let failed = $state<string | null>(null);
  let fit = $state(1);
  let pdf: pdfjs.PDFDocumentProxy | undefined;
  let baseWidth = 612;
  const rendered = new Map<
    number,
    { scale: number; task?: { cancel(): void } }
  >();
  let observer: IntersectionObserver | undefined;
  let reportedPage = 0;
  let restored = false;

  const scale = $derived(fit * zoom);

  async function load(id: string): Promise<void> {
    failed = null;
    try {
      const data = await folio.api.readDocument(id);
      pdf = await pdfjs.getDocument({ data, disableFontFace: false }).promise;
      const first = await pdf.getPage(1);
      baseWidth = first.getViewport({ scale: 1 }).width;
      const sizes: { number: number; width: number; height: number }[] = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const viewport = (
          number === 1 ? first : await pdf.getPage(number)
        ).getViewport({ scale: 1 });
        sizes.push({ number, width: viewport.width, height: viewport.height });
      }
      measure();
      pages = sizes;
    } catch (error) {
      failed =
        error instanceof Error
          ? error.message
          : "This PDF could not be opened.";
    }
  }

  function measure(): void {
    if (!scroller) return;
    fit = Math.min(
      1.6,
      Math.max(0.25, (scroller.clientWidth - 64) / baseWidth),
    );
  }

  async function render(element: HTMLElement, number: number): Promise<void> {
    if (!pdf || rendered.get(number)?.scale === scale) return;
    rendered.get(number)?.task?.cancel();
    const entry: { scale: number; task?: { cancel(): void } } = { scale };
    rendered.set(number, entry);
    const pageProxy = await pdf.getPage(number);
    const viewport = pageProxy.getViewport({ scale });
    const ratio = window.devicePixelRatio || 1;
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const task = pageProxy.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    });
    entry.task = task;
    try {
      await task.promise;
    } catch {
      return;
    }
    const text = window.document.createElement("div");
    text.className = "textLayer";
    element.replaceChildren(canvas, text);
    element.style.setProperty("--scale-factor", String(scale));
    element.style.setProperty("--user-unit", "1");
    element.style.setProperty("--total-scale-factor", String(scale));
    await new pdfjs.TextLayer({
      textContentSource: pageProxy.streamTextContent(),
      container: text,
      viewport,
    }).render();
  }

  function pageAction(element: HTMLElement, number: number) {
    element.dataset.page = String(number);
    observer?.observe(element);
    return {
      destroy() {
        observer?.unobserve(element);
      },
    };
  }

  function onscroll(): void {
    onselect(null);
    const top =
      scroller.getBoundingClientRect().top + scroller.clientHeight * 0.3;
    let current = 1;
    for (const element of scroller.querySelectorAll<HTMLElement>(
      "[data-page]",
    )) {
      if (element.getBoundingClientRect().top <= top)
        current = Number(element.dataset.page);
      else break;
    }
    if (current !== reportedPage) {
      reportedPage = current;
      onpage(current);
    }
  }

  function scrollToPage(
    number: number,
    behavior: ScrollBehavior = "smooth",
  ): void {
    const element = scroller?.querySelector<HTMLElement>(
      `[data-page="${number}"]`,
    );
    if (!element) return;
    reportedPage = number;
    scroller.scrollTo({ top: element.offsetTop - 16, behavior });
  }

  function onmouseup(): void {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim() ?? "";
    if (!selection || !text || !scroller.contains(selection.anchorNode)) return;
    const pageElement = (
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement
    )?.closest<HTMLElement>("[data-page]");
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    onselect({
      text: text.slice(0, 1200),
      page: Number(pageElement?.dataset.page ?? page),
      rect,
    });
  }

  $effect(() => {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            const element = entry.target as HTMLElement;
            void render(element, Number(element.dataset.page));
          }
      },
      { root: scroller, rootMargin: "800px 0px" },
    );
    // A resize reflows the pages, so a selection toolbar would point at stale coordinates.
    const resize = new ResizeObserver(() => {
      onselect(null);
      measure();
    });
    resize.observe(scroller);
    void load(document.id);
    return () => {
      observer?.disconnect();
      resize.disconnect();
    };
  });

  // Re-render visible pages when the scale changes.
  $effect(() => {
    void scale;
    for (const element of scroller?.querySelectorAll<HTMLElement>(
      "[data-page]",
    ) ?? []) {
      const box = element.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      if (box.bottom > view.top - 800 && box.top < view.bottom + 800)
        void render(element, Number(element.dataset.page));
    }
  });

  // Open at the saved page once the layout exists.
  $effect(() => {
    if (pages.length && !restored) {
      restored = true;
      requestAnimationFrame(() => scrollToPage(page, "instant"));
    }
  });

  // Citations and the page field ask the reader to go somewhere.
  $effect(() => {
    const jump = folio.jump;
    if (jump && jump.documentId === document.id && pages.length)
      scrollToPage(jump.page);
  });

  export function goTo(number: number): void {
    scrollToPage(number);
  }

  onDestroy(() => {
    void pdf?.loadingTask.destroy();
  });
</script>

<!-- Selecting text on a page offers Explain and Ask; it is not a control itself. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={scroller}
  class="scroll-quiet h-full overflow-auto bg-bg"
  {onscroll}
  {onmouseup}
  role="document"
>
  {#if failed}
    <div
      class="flex h-full items-center justify-center p-8 text-center text-danger"
    >
      {failed}
    </div>
  {:else}
    <div
      class="flex w-max min-w-full flex-col items-center-safe gap-4 px-8 py-6"
    >
      {#each pages as entry (entry.number)}
        <div
          use:pageAction={entry.number}
          class="relative shrink-0 bg-white shadow-[0_1px_3px_#18181b14,0_0_0_1px_#18181b0d]"
          style="width:{Math.floor(entry.width * scale)}px;height:{Math.floor(
            entry.height * scale,
          )}px"
        ></div>
      {/each}
    </div>
  {/if}
</div>

<style>
  :global(.textLayer ::selection) {
    background: rgb(43 89 195 / 0.28);
  }
</style>
