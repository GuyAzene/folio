<script lang="ts">
  // The app mark: an ink page with one highlighted line.
  let { size = 20 }: { size?: number } = $props();
</script>

<span
  class="inline-flex shrink-0 flex-col justify-center bg-[#18181b] dark:ring-1 dark:ring-white/10"
  style="width:{size}px;height:{size}px;border-radius:{size *
    0.28}px;gap:{size * 0.1}px;padding:0 {size * 0.22}px"
  aria-hidden="true"
>
  <span class="block h-[1.5px] w-[55%] rounded-full bg-white/40"></span>
  <span
    class="block w-full rounded-[1px] bg-highlight"
    style="height:{size * 0.13}px"
  ></span>
  <span class="block h-[1.5px] w-[75%] rounded-full bg-white/40"></span>
</span>
