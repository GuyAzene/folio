import { mount, unmount } from "svelte";
import { visualTitle } from "../../src/visual.ts";
import ArtifactFrame from "../components/ArtifactFrame.svelte";

/**
 * Runs each ```demo block of a rendered note in its sealed frame. Use as an attachment on the
 * element whose HTML holds the note; it returns the cleanup that stops every demo it started.
 */
export function mountDemos(root: HTMLElement): () => void {
  const mounted: ReturnType<typeof mount>[] = [];
  for (const slot of root.querySelectorAll<HTMLElement>(".demo-slot[data-source]")) {
    let source: string;
    try {
      source = decodeURIComponent(slot.dataset.source ?? "");
    } catch {
      continue;
    }
    slot.replaceChildren();
    mounted.push(
      mount(ArtifactFrame, {
        target: slot,
        props: { source, title: visualTitle(source) ?? "Demo", chatId: null },
      }),
    );
  }
  return () => {
    for (const component of mounted) void unmount(component);
  };
}
