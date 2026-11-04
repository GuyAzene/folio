import type { CourseTab } from "./course-tabs.ts";

/**
 * A tab's panes: one to three places side by side. A tab's history is a history of layouts, so
 * Back undoes the last navigation, opening or closing a pane included. Everything here is plain
 * data in, plain data out; state.svelte.ts holds the tabs.
 */

export type Location =
  | { view: "home" }
  | { view: "library" }
  | { view: "chats" }
  | { view: "assignments" }
  | { view: "jobs" }
  | { view: "trash" }
  | { view: "course"; courseId: string; tab: CourseTab }
  | {
      view: "document";
      documentId: string;
      page: number;
      /** The reader's zoom; 1 when unset. */
      zoom?: number;
    }
  /** The notebook: every note, or one course's, with one open beside the list. */
  | { view: "notes"; noteId: string | null; courseId: string | null }
  /** A course's study notes, open at "topic:<slug>", "session:<slug>", or the first session. */
  | { view: "study"; courseId: string; item: string | null }
  | { view: "chat"; chatId: string | null; courseId: string | null };

export type View = Location["view"];

export interface Pane {
  id: string;
  location: Location;
}

export interface Layout {
  panes: Pane[];
  /** Every pane's ID, the one used most recently first: the first is the active pane. */
  recent: string[];
  /** Each pane's share of the width, in pane order, adding up to 1. */
  sizes: number[];
  /** A pane shown alone while the others wait, or null. */
  maximized: string | null;
}

export interface Tab {
  id: string;
  history: Layout[];
  index: number;
}

export const MAX_PANES = 3;

/** The narrowest a pane may get, in pixels: a page needs more room than a chat or a note. */
export function minWidth(location: Location): number {
  return location.view === "document" ? 360 : 320;
}

export function single(location: Location, id: string): Layout {
  return { panes: [{ id, location }], recent: [id], sizes: [1], maximized: null };
}

export function activePane(layout: Layout): Pane {
  return layout.panes.find((pane) => pane.id === layout.recent[0]) ?? layout.panes[0]!;
}

export type PaneOf<V extends View> = Pane & { location: Extract<Location, { view: V }> };

/** The pane of a kind used last: the document a chat follows, the chat Explain goes to. */
export function lastUsed<V extends View>(layout: Layout, view: V): PaneOf<V> | undefined {
  for (const id of layout.recent) {
    const pane = layout.panes.find((candidate) => candidate.id === id);
    if (pane?.location.view === view) return pane as PaneOf<V>;
  }
  return undefined;
}

/** What a tab is called: the document in it, or else its active pane. */
export function mainPane(layout: Layout): Pane {
  return lastUsed(layout, "document") ?? activePane(layout);
}

export function activate(layout: Layout, paneId: string): Layout {
  if (layout.recent[0] === paneId || !layout.panes.some((pane) => pane.id === paneId))
    return layout;
  return { ...layout, recent: [paneId, ...layout.recent.filter((id) => id !== paneId)] };
}

export function withLocation(layout: Layout, paneId: string, location: Location): Layout {
  return {
    ...layout,
    panes: layout.panes.map((pane) => (pane.id === paneId ? { id: pane.id, location } : pane)),
  };
}

/**
 * Opens `location` in a new pane `id` beside the pane `of`, on its right unless asked for the
 * left, taking part of that pane's width. With three panes already, the one used least
 * recently (never `of`) gives way to it. The new pane becomes active unless `activate` is
 * false, when it comes second, as the pane used just before.
 */
export function openBeside(
  layout: Layout,
  location: Location,
  of: string,
  id: string,
  options: { side?: "left" | "right"; activate?: boolean } = {},
): Layout {
  const at = layout.panes.findIndex((pane) => pane.id === of);
  if (at < 0) return layout;
  const order = (recent: string[]) =>
    options.activate === false ? [recent[0]!, id, ...recent.slice(1)] : [id, ...recent];
  if (layout.panes.length >= MAX_PANES) {
    const spare = [...layout.recent].reverse().find((paneId) => paneId !== of)!;
    return {
      panes: layout.panes.map((pane) => (pane.id === spare ? { id, location } : pane)),
      recent: order(layout.recent.filter((paneId) => paneId !== spare)),
      sizes: layout.sizes,
      maximized: null,
    };
  }
  const index = options.side === "left" ? at : at + 1;
  const panes = [...layout.panes];
  panes.splice(index, 0, { id, location });
  const share = layout.sizes[at] ?? 1 / layout.panes.length;
  // A chat or a note beside a page takes less room than a second page.
  const part = share * (location.view === "document" ? 0.5 : 0.4);
  const sizes = [...layout.sizes];
  sizes[at] = share - part;
  sizes.splice(index, 0, part);
  return { panes, recent: order(layout.recent), sizes, maximized: null };
}

/** What can share a tab: a document, and the tutor, a note or another document beside it. */
export function besideDocument(location: Location): boolean {
  return location.view === "document" || location.view === "chat" || location.view === "notes";
}

/**
 * Side by side means a document with what the student keeps beside it. Any other place (a
 * course, Home, a list) fills the tab, and a split with no document left in it gives way to
 * its active pane.
 */
export function tidy(layout: Layout): Layout {
  if (layout.panes.length === 1) return layout;
  const active = activePane(layout);
  if (!besideDocument(active.location)) return single(active.location, active.id);
  let kept = layout;
  for (const pane of layout.panes)
    if (!besideDocument(pane.location)) kept = closePane(kept, pane.id);
  if (kept.panes.length > 1 && !kept.panes.some((pane) => pane.location.view === "document")) {
    const last = activePane(kept);
    return single(last.location, last.id);
  }
  return kept;
}

/** The layout without the pane; its neighbor takes its width. The last pane stays. */
export function closePane(layout: Layout, paneId: string): Layout {
  const at = layout.panes.findIndex((pane) => pane.id === paneId);
  if (at < 0 || layout.panes.length === 1) return layout;
  const sizes = [...layout.sizes];
  const [freed = 0] = sizes.splice(at, 1);
  // The pane on its left takes the room, or the one on its right for the first pane.
  sizes[Math.max(0, at - 1)]! += freed;
  return {
    panes: layout.panes.filter((pane) => pane.id !== paneId),
    recent: layout.recent.filter((id) => id !== paneId),
    sizes,
    maximized: layout.maximized === paneId ? null : layout.maximized,
  };
}

/** The layout without the panes that show something removed; null when none is left. */
export function withoutPanes(
  layout: Layout,
  showed: (location: Location) => boolean,
): Layout | null {
  let kept = layout;
  for (const pane of layout.panes)
    if (showed(pane.location)) {
      if (kept.panes.length === 1) return null;
      kept = closePane(kept, pane.id);
    }
  return kept;
}

/** The layout with each pane's place changed by `change`. */
export function mapPanes(layout: Layout, change: (location: Location) => Location): Layout {
  return {
    ...layout,
    panes: layout.panes.map((pane) => ({ id: pane.id, location: change(pane.location) })),
  };
}

/**
 * Moves the divider after pane `index` by `delta`, a share of the width, keeping both panes at
 * least their minimum shares. Unchanged when the two can't both fit.
 */
export function resize(sizes: number[], index: number, delta: number, mins: number[]): number[] {
  const left = sizes[index];
  const right = sizes[index + 1];
  if (left === undefined || right === undefined) return sizes;
  const total = left + right;
  const low = mins[index] ?? 0;
  const high = total - (mins[index + 1] ?? 0);
  if (low > high) return sizes;
  const next = Math.min(high, Math.max(low, left + delta));
  const resized = [...sizes];
  resized[index] = next;
  resized[index + 1] = total - next;
  return resized;
}

export function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

/** Saved shares, made to add up to 1; even ones when they don't fit the panes. */
export function validSizes(sizes: unknown, count: number): number[] {
  if (
    !Array.isArray(sizes) ||
    sizes.length !== count ||
    !sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0)
  )
    return evenSizes(count);
  const total = (sizes as number[]).reduce((sum, size) => sum + size, 0);
  return (sizes as number[]).map((size) => size / total);
}

type Valid = (location: unknown) => Location | null;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A layout saved with the workspace, each place checked by `valid`; null when none can open. */
export function restoreLayout(saved: unknown, valid: Valid, newId: () => string): Layout | null {
  const value = record(saved);
  const savedSizes = list(value.sizes);
  const panes: Pane[] = [];
  const sizes: unknown[] = [];
  for (const [index, entry] of list(value.panes).entries()) {
    if (panes.length === MAX_PANES) break;
    const location = valid(record(entry).location);
    if (!location) continue;
    const id = record(entry).id;
    panes.push({
      id: typeof id === "string" && id && !panes.some((pane) => pane.id === id) ? id : newId(),
      location,
    });
    sizes.push(savedSizes[index]);
  }
  if (!panes.length) return null;
  const ids = panes.map((pane) => pane.id);
  const recent = [
    ...new Set(list(value.recent).filter((id): id is string => ids.includes(id as string))),
  ];
  return {
    panes,
    recent: [...recent, ...ids.filter((id) => !recent.includes(id))],
    sizes: validSizes(sizes, panes.length),
    maximized:
      panes.length > 1 && ids.includes(value.maximized as string)
        ? (value.maximized as string)
        : null,
  };
}

/**
 * A tab saved before panes (until 2026-11-01), when the reader had a panel of its own: the
 * chat or note in it becomes a pane beside the document, and "Folio full screen" that pane
 * maximized. `courseOf` names a document's course, which a new chat beside it reads.
 */
export function fromV1(
  saved: unknown,
  valid: Valid,
  courseOf: (documentId: string) => string | null,
  newId: () => string,
): Layout | null {
  const location = valid(saved);
  if (!location) return null;
  const layout = single(location, newId());
  const old = record(saved);
  if (location.view !== "document" || old.panel === "closed") return layout;
  const beside = valid(
    old.side === "note"
      ? { view: "notes", noteId: old.noteId ?? null, courseId: null }
      : { view: "chat", chatId: old.chatId ?? null, courseId: courseOf(location.documentId) },
  );
  if (!beside) return layout;
  const id = newId();
  const opened = openBeside(layout, beside, layout.panes[0]!.id, id, { activate: false });
  return old.panel === "full" ? { ...activate(opened, id), maximized: id } : opened;
}

export interface Workspace {
  tabs: { id: string; layout: Layout }[];
  active: string | null;
  sidebarOpen: boolean | null;
}

/** Open tabs saved in workspace.json, in either version; null when none can open. */
export function readWorkspace(
  saved: unknown,
  valid: Valid,
  courseOf: (documentId: string) => string | null,
  newId: () => string,
): Workspace | null {
  const value = record(saved);
  if (value.version !== 1 && value.version !== 2) return null;
  const tabs: Workspace["tabs"] = [];
  for (const entry of list(value.tabs)) {
    const tab = record(entry);
    const layout =
      value.version === 1
        ? fromV1(tab.location, valid, courseOf, newId)
        : restoreLayout(tab.layout, valid, newId);
    if (!layout) continue;
    const id = typeof tab.id === "string" && !tabs.some((kept) => kept.id === tab.id);
    // A tab saved with a course or a list beside a lecture (until 2026-11-04) opens tidied.
    tabs.push({ id: id ? (tab.id as string) : newId(), layout: tidy(layout) });
  }
  if (!tabs.length) return null;
  return {
    tabs,
    active: tabs.some((tab) => tab.id === value.active) ? (value.active as string) : null,
    sidebarOpen: typeof value.sidebarOpen === "boolean" ? value.sidebarOpen : null,
  };
}
