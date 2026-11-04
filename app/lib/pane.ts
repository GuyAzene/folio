import { getContext, setContext } from "svelte";
import type { Location } from "./layout.ts";

/** What a view knows of the pane it is drawn in. */
export interface PaneContext {
  readonly id: string;
  readonly tabId: string;
  /** More than one pane in the tab: the pane shows its own Maximize and Close. */
  readonly split: boolean;
  /** The first pane of a split: the document the others sit beside, with no Close of its own. */
  readonly lead: boolean;
  readonly maximized: boolean;
  readonly active: boolean;
  /** The pane's width in pixels, for views that tighten when narrow. */
  readonly width: number;
  /** The document pane the tab's chats follow, when there is one and it isn't this pane. */
  readonly source: { id: string; location: Extract<Location, { view: "document" }> } | null;
}

const KEY = Symbol("pane");

export function setPane(pane: PaneContext): void {
  setContext(KEY, pane);
}

export function getPane(): PaneContext | undefined {
  return getContext<PaneContext | undefined>(KEY);
}
