import { describe, expect, it } from "vite-plus/test";
import {
  activate,
  activePane,
  closePane,
  fromV1,
  lastUsed,
  mainPane,
  MAX_PANES,
  openBeside,
  readWorkspace,
  resize,
  restoreLayout,
  single,
  validSizes,
  withLocation,
  withoutPanes,
  type Layout,
  type Location,
} from "../app/lib/layout.ts";

const lecture: Location = { view: "document", documentId: "lecture", page: 3 };
const homework: Location = { view: "document", documentId: "homework", page: 1 };
const chat: Location = { view: "chat", chatId: "chat-1", courseId: "course" };
const note: Location = { view: "notes", noteId: "note-1", courseId: "course" };

let next = 0;
const newId = () => `pane-${++next}`;
const ids = (layout: Layout) => layout.panes.map((pane) => pane.id);
const close = (a: number[], b: number[]) =>
  a.forEach((value, index) => expect(value).toBeCloseTo(b[index]!, 6));

/** Places as Folio checks them on restore: only these documents and chats still exist. */
function valid(saved: unknown): Location | null {
  const place = saved as Location | null;
  if (!place || typeof place !== "object") return null;
  if (place.view === "document")
    return ["lecture", "homework"].includes(place.documentId)
      ? { view: "document", documentId: place.documentId, page: place.page }
      : null;
  if (place.view === "chat")
    return place.chatId && place.chatId !== "chat-1"
      ? null
      : { ...place, chatId: place.chatId ?? null };
  if (place.view === "notes")
    return { view: "notes", noteId: place.noteId ?? null, courseId: null };
  return place.view === "home" ? { view: "home" } : null;
}

describe("panes", () => {
  it("opens a chat beside a page with less room than the page, and makes it active", () => {
    const layout = openBeside(single(lecture, "a"), chat, "a", "b");
    expect(ids(layout)).toEqual(["a", "b"]);
    close(layout.sizes, [0.6, 0.4]);
    expect(activePane(layout).id).toBe("b");
    // Opened without taking the keyboard, it comes right after the active pane.
    const quiet = openBeside(single(lecture, "a"), chat, "a", "b", { activate: false });
    expect(quiet.recent).toEqual(["a", "b"]);
  });

  it("shares a page's room evenly with a second page, on either side", () => {
    const layout = openBeside(single(lecture, "a"), homework, "a", "b", { side: "left" });
    expect(ids(layout)).toEqual(["b", "a"]);
    close(layout.sizes, [0.5, 0.5]);
  });

  it("holds three panes at most: the one used least recently gives way, never the one opened from", () => {
    let layout = openBeside(single(lecture, "a"), chat, "a", "b");
    layout = openBeside(layout, homework, "a", "c");
    expect(ids(layout)).toEqual(["a", "c", "b"]);
    expect(layout.panes).toHaveLength(MAX_PANES);
    // b (the chat) was used before a; c is the newest. Opening beside a replaces b in place.
    layout = activate(layout, "a");
    layout = openBeside(layout, note, "a", "d");
    expect(ids(layout)).toEqual(["a", "c", "d"]);
    expect(layout.recent[0]).toBe("d");
    expect(layout.panes).toHaveLength(MAX_PANES);
    // The new pane takes the width of the one it replaced.
    expect(layout.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 6);
  });

  it("gives a closed pane's room to its neighbor and keeps the layout it came from", () => {
    const before = openBeside(openBeside(single(lecture, "a"), homework, "a", "b"), chat, "b", "c");
    const after = closePane(before, "b");
    expect(ids(after)).toEqual(["a", "c"]);
    expect(after.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 6);
    expect(after.sizes[0]).toBeCloseTo(before.sizes[0]! + before.sizes[1]!, 6);
    expect(after.recent).not.toContain("b");
    // Back returns to the layout before, which closing never changed.
    expect(ids(before)).toEqual(["a", "b", "c"]);
    // The first pane's room goes to the right; a tab's last pane stays.
    expect(closePane(before, "a").sizes[0]).toBeCloseTo(before.sizes[0]! + before.sizes[1]!, 6);
    expect(closePane(single(lecture, "a"), "a").panes).toHaveLength(1);
  });

  it("forgets a maximized pane once it closes", () => {
    const layout = { ...openBeside(single(lecture, "a"), chat, "a", "b"), maximized: "b" };
    expect(closePane(layout, "b").maximized).toBeNull();
    expect(closePane(layout, "a").maximized).toBe("b");
  });

  it("resizes between two panes but never below either one's minimum", () => {
    const mins = [0.3, 0.25];
    close(resize([0.6, 0.4], 0, 0.1, mins), [0.7, 0.3]);
    close(resize([0.6, 0.4], 0, 0.5, mins), [0.75, 0.25]);
    close(resize([0.6, 0.4], 0, -0.5, mins), [0.3, 0.7]);
    // A chat can take more than half the width.
    close(resize([0.6, 0.4], 0, -0.25, mins), [0.35, 0.65]);
    // Two panes that can't both fit stay as they are.
    expect(resize([0.5, 0.5], 0, 0.1, [0.6, 0.6])).toEqual([0.5, 0.5]);
    expect(resize([1], 0, 0.1, [0.3])).toEqual([1]);
  });

  it("follows the document used last, and the tab is named after it", () => {
    let layout = openBeside(single(lecture, "a"), chat, "a", "b");
    layout = openBeside(layout, homework, "a", "c");
    expect(lastUsed(layout, "document")?.id).toBe("c");
    layout = activate(layout, "a");
    expect(lastUsed(layout, "document")?.id).toBe("a");
    // Working in the chat keeps it following the lecture.
    layout = activate(layout, "b");
    expect(lastUsed(layout, "document")?.id).toBe("a");
    expect(mainPane(layout).id).toBe("a");
    // Closing the lecture leaves the homework to follow.
    expect(lastUsed(closePane(layout, "a"), "document")?.id).toBe("c");
    // A pane that turns into something else stops being followed.
    expect(lastUsed(withLocation(layout, "a", note), "document")?.id).toBe("c");
    expect(mainPane(single(chat, "z")).id).toBe("z");
  });

  it("closes the panes of something removed, and nothing is left of a layout of only those", () => {
    const layout = openBeside(single(lecture, "a"), chat, "a", "b");
    const gone = (place: Location) => place.view === "document" && place.documentId === "lecture";
    expect(ids(withoutPanes(layout, gone)!)).toEqual(["b"]);
    expect(withoutPanes(single(lecture, "a"), gone)).toBeNull();
    expect(withoutPanes(layout, () => false)).toBe(layout);
  });

  it("makes saved sizes add up, and shares evenly when they don't fit", () => {
    close(validSizes([3, 1], 2), [0.75, 0.25]);
    for (const saved of [[0.5], [0.5, -1], ["x", 1], null, [0.5, Number.NaN]])
      close(validSizes(saved, 2), [0.5, 0.5]);
  });
});

describe("saved layouts", () => {
  it("restores panes whose places still exist, with their sizes and order of use", () => {
    const saved = {
      panes: [
        { id: "a", location: lecture },
        { id: "gone", location: { view: "document", documentId: "removed", page: 1 } },
        { id: "b", location: chat },
      ],
      recent: ["b", "gone", "a", "b"],
      sizes: [0.5, 0.2, 0.3],
      maximized: "b",
    };
    const layout = restoreLayout(saved, valid, newId)!;
    expect(ids(layout)).toEqual(["a", "b"]);
    close(layout.sizes, [0.625, 0.375]);
    expect(layout.recent).toEqual(["b", "a"]);
    expect(layout.maximized).toBe("b");
  });

  it("repairs what a hand edit could break", () => {
    const saved = {
      panes: [
        { id: "a", location: lecture },
        { id: "a", location: homework },
        { location: chat },
        { id: "d", location: note },
      ],
      recent: "a",
      sizes: [1],
      maximized: "nobody",
    };
    const layout = restoreLayout(saved, valid, newId)!;
    expect(layout.panes).toHaveLength(MAX_PANES);
    expect(new Set(ids(layout)).size).toBe(MAX_PANES);
    expect([...layout.recent].sort()).toEqual([...ids(layout)].sort());
    close(layout.sizes, [1 / 3, 1 / 3, 1 / 3]);
    expect(layout.maximized).toBeNull();
    expect(
      restoreLayout({ panes: [{ id: "x", location: { view: "nowhere" } }] }, valid, newId),
    ).toBeNull();
    expect(restoreLayout("layout", valid, newId)).toBeNull();
    // One pane is never shown maximized.
    expect(
      restoreLayout({ panes: [{ id: "a", location: lecture }], maximized: "a" }, valid, newId)!
        .maximized,
    ).toBeNull();
  });

  it("turns the reader's panel saved before panes into a pane beside the document", () => {
    const old = { ...lecture, panel: "docked", chatId: "chat-1", side: "chat", noteId: null };
    const docked = fromV1(old, valid, () => "course", newId)!;
    expect(docked.panes.map((pane) => pane.location)).toEqual([lecture, chat]);
    expect(activePane(docked).location).toEqual(lecture);
    expect(docked.maximized).toBeNull();

    const full = fromV1({ ...old, panel: "full" }, valid, () => "course", newId)!;
    expect(full.maximized).toBe(full.panes[1]!.id);
    expect(activePane(full).location).toEqual(chat);

    const noted = fromV1({ ...old, side: "note", noteId: "note-1" }, valid, () => "course", newId)!;
    expect(noted.panes[1]!.location).toEqual({ view: "notes", noteId: "note-1", courseId: null });

    const closed = fromV1({ ...old, panel: "closed" }, valid, () => "course", newId)!;
    expect(closed.panes.map((pane) => pane.location)).toEqual([lecture]);

    // A chat that's gone leaves a new chat for the document's course in its place.
    const fresh = fromV1({ ...old, chatId: null }, valid, () => "course", newId)!;
    expect(fresh.panes[1]!.location).toEqual({ view: "chat", chatId: null, courseId: "course" });
    const lost = fromV1({ ...old, chatId: "removed" }, valid, () => "course", newId)!;
    expect(lost.panes).toHaveLength(1);

    expect(fromV1({ view: "home" }, valid, () => null, newId)!.panes).toHaveLength(1);
    expect(
      fromV1({ view: "document", documentId: "removed", page: 1 }, valid, () => null, newId),
    ).toBeNull();
  });

  it("reads either version of the workspace, keeping only tabs that can open", () => {
    const v1 = readWorkspace(
      {
        version: 1,
        tabs: [
          { id: "t1", location: { ...lecture, panel: "docked", chatId: null } },
          { id: "t2", location: { view: "document", documentId: "removed", page: 1 } },
          { id: "t1", location: { view: "home" } },
        ],
        active: "t2",
        sidebarOpen: false,
      },
      valid,
      () => "course",
      newId,
    )!;
    expect(v1.tabs.map((tab) => tab.layout.panes.length)).toEqual([2, 1]);
    expect(v1.tabs[0]!.id).toBe("t1");
    expect(v1.tabs[1]!.id).not.toBe("t1");
    expect(v1.active).toBeNull();
    expect(v1.sidebarOpen).toBe(false);

    const layout = openBeside(single(lecture, "a"), chat, "a", "b");
    const v2 = readWorkspace(
      { version: 2, tabs: [{ id: "t1", layout }], active: "t1" },
      valid,
      () => "course",
      newId,
    )!;
    expect(v2.tabs[0]!.layout).toEqual(layout);
    expect(v2.active).toBe("t1");
    expect(v2.sidebarOpen).toBeNull();

    for (const saved of [null, { version: 3, tabs: [] }, { version: 2, tabs: [{ layout: {} }] }])
      expect(readWorkspace(saved, valid, () => null, newId)).toBeNull();
  });
});
