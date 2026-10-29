<script lang="ts">
  import type { CourseView } from "../../src/desktop/api.ts";
  import { glyph, PENCIL } from "../lib/labels.ts";

  let {
    course,
    size = 18,
  }: { course: Pick<CourseView, "name" | "color">; size?: number } = $props();
</script>

<span
  class="inline-flex shrink-0 items-center justify-center font-serif text-white"
  style="width:{size}px;height:{size}px;border-radius:{Math.round(
    size * 0.28,
  )}px;background:{PENCIL[course.color]};font-size:{Math.round(
    size * 0.62,
  )}px;line-height:1"
  aria-hidden="true">{glyph(course)}</span
>
