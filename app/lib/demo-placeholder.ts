import { visualTitle } from "../../src/visual.ts";

/** Runs each ```demo block found under `root`; returns what stops them. */
export type DemoRunner = (root: HTMLElement) => () => void;

/**
 * Where a demo can't run, such as in a picture of the note: a box with its title in place of each
 * ```demo block, the size a demo usually takes, so the rest of the note sits where it would.
 */
export const demoPlaceholders: DemoRunner = (root) => {
  for (const slot of root.querySelectorAll<HTMLElement>(".demo-slot[data-source]")) {
    let source = "";
    try {
      source = decodeURIComponent(slot.dataset.source ?? "");
    } catch {
      // Shown without its title.
    }
    const box = document.createElement("div");
    box.className = "demo-placeholder";
    const title = visualTitle(source);
    box.textContent = title ? `Demo: ${title}. It runs in Folio.` : "A demo. It runs in Folio.";
    slot.replaceChildren(box);
  }
  return () => {};
};
