<script lang="ts">
  // Folio's agent mark: a highlighted page with ink lines. While working, the lines re-write.
  let { size = 20, working = false }: { size?: number; working?: boolean } =
    $props();
  const lines = [0.42, 0.72, 0.56];
</script>

<span
  class="inline-flex shrink-0 flex-col justify-center bg-highlight"
  style="width:{size}px;height:{size}px;border-radius:{size *
    0.28}px;gap:{Math.max(1.5, size * 0.09)}px;padding:0 {size * 0.24}px"
  aria-hidden="true"
>
  {#each lines as width, index (index)}
    <span
      class="block origin-left rounded-full bg-[#18181b]"
      style="width:{width * 100}%;height:{Math.max(
        1.5,
        size * 0.075,
      )}px;{working
        ? `animation:folio-write 1.1s ${index * 0.18}s ease-in-out infinite`
        : ''}"
    ></span>
  {/each}
</span>
