import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopEvent, FolioApi, SendInput } from "../src/desktop/api.ts";
import { DEFAULT_CATEGORIES } from "../src/library/categories.ts";
import type { Layout, Location } from "../app/lib/layout.ts";

/**
 * The window's tabs as the student moves through them: the sidebar filling a tab, a file opened
 * beside the reading, and a first question whose pane gave way, or was the Chats list, before
 * its chat existed. A synthetic bridge stands in for the main process; nothing talks to a model.
 */

const course = { id: "course-1", name: "Algorithms", code: "CS 201", term: "", color: "blue" };
const document = (id: string, title: string, role: string) => ({
  id,
  courseId: course.id,
  title,
  role,
  category: null,
  kind: "pdf",
  pages: 4,
  number: 1,
  importedAt: new Date().toISOString(),
});
const lecture = document("lecture-1", "Lecture 1", "lecture");
const recitation = document("recitation-1", "Recitation 1", "recitation");

/** Sends wait here until a test answers them, as the main process would. */
let answers: ((chatId: string) => void)[] = [];
let sent: SendInput[] = [];
let emit: (event: DesktopEvent) => void = () => {};

const empty = async () => [];
const bridge = {
  bootstrap: async () => ({
    platform: "darwin",
    chats: [],
    unavailableChats: 0,
    models: {
      connections: [],
      groups: [],
      roles: {},
      problems: [],
      openrouter: [],
      categories: DEFAULT_CATEGORIES,
      naming: null,
    },
  }),
  onEvent: (listener: (event: DesktopEvent) => void) => {
    emit = listener;
    return () => {};
  },
  listCourses: async () => [course],
  listDocuments: async () => [lecture, recitation],
  listNotes: empty,
  listProposals: empty,
  listPending: empty,
  listAssignments: empty,
  listJobs: empty,
  listTrash: empty,
  listApprovals: empty,
  listSkills: async () => ({ skills: [], folders: [] }),
  mcpServers: async () => ({ servers: [] }),
  knowledge: async () => null,
  loadWorkspace: async () => null,
  saveWorkspace: async () => {},
  release: async () => ({ current: "0.0.0", newer: null, checks: false }),
  checkRelease: async () => ({ current: "0.0.0", newer: null, checks: false }),
  openChat: async () => {
    throw new Error("Reopening a chat never reads it again here.");
  },
  setFocus: async () => {},
  send: (input: SendInput) => {
    sent.push(input);
    return new Promise<{ chatId: string }>((resolve) =>
      answers.push((chatId) => resolve({ chatId })),
    );
  },
} as unknown as FolioApi;

let folio: typeof import("../app/lib/state.svelte.ts").folio;

beforeAll(async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {} }));
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  ({ folio } = await import("../app/lib/state.svelte.ts"));
  await folio.init(bridge);
});

beforeEach(() => {
  answers = [];
  sent = [];
  folio.closeTab(folio.activeTabId);
});

const places = (layout: Layout = folio.layout): Location[] =>
  layout.panes.map((pane) => pane.location);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Lecture 1 with a new chat beside it, as a lecture opens. */
function reading(): string {
  folio.openDocument(lecture.id);
  const chat = folio.layout.panes.find((pane) => pane.location.view === "chat")!;
  expect(places()).toEqual([
    { view: "document", documentId: lecture.id, page: 1 },
    { view: "chat", chatId: null, courseId: course.id },
  ]);
  return chat.id;
}

describe("the sidebar fills the tab", () => {
  it("opens a course over the lecture and its tutor, and Back brings both back", () => {
    const chatPane = reading();
    folio.activatePane(chatPane);
    folio.navigate({ view: "course", courseId: course.id, tab: "materials" }, { fill: true });
    expect(places()).toEqual([{ view: "course", courseId: course.id, tab: "materials" }]);
    folio.back();
    expect(places().map((place) => place.view)).toEqual(["document", "chat"]);
    expect(folio.layout.panes[1]!.id).toBe(chatPane);
  });

  it("opens a file beside the lecture the tab was reading, from the course page", () => {
    reading();
    folio.navigate({ view: "course", courseId: course.id, tab: "materials" }, { fill: true });
    folio.openDocument(recitation.id, 1, { beside: true });
    expect(places()).toEqual([
      { view: "document", documentId: lecture.id, page: 1 },
      { view: "document", documentId: recitation.id, page: 1 },
      { view: "chat", chatId: null, courseId: course.id },
    ]);
  });

  it("opens a file with its tutor when the tab read nothing yet", () => {
    folio.navigate({ view: "course", courseId: course.id, tab: "materials" }, { fill: true });
    folio.openDocument(recitation.id, 1, { beside: true });
    expect(places().map((place) => place.view)).toEqual(["document", "chat"]);
  });
});

describe("a first question on its way", () => {
  it("keeps going when its pane gives way, and Back shows its chat, asked once", async () => {
    const chatPane = reading();
    folio.setDraft(`new:${chatPane}`, { text: "and the next step?" });
    const asking = folio.send("Why is the start state accepting?", {
      paneId: chatPane,
      chatId: null,
      courseId: course.id,
      focus: null,
    });
    // The student opens the course from the sidebar before the chat exists.
    folio.navigate({ view: "course", courseId: course.id, tab: "materials" }, { fill: true });
    answers.shift()!("chat-1");
    expect(await asking).toBe("chat-1");
    expect(folio.chatViews["chat-1"]?.messages.at(-1)?.state).toBe("streaming");
    expect(folio.drafts["chat-1"]?.text).toBe("and the next step?");
    folio.back();
    expect(places()[1]).toEqual({ view: "chat", chatId: "chat-1", courseId: course.id });
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("turns the Chats list's new chat into that chat, once", async () => {
    folio.navigate({ view: "chats" }, { fill: true });
    const paneId = folio.activePane.id;
    const asking = folio.send("Quiz me on BFS", {
      paneId,
      chatId: null,
      courseId: course.id,
      focus: null,
    });
    // The chat's event arrives before the reply to the send: both adopt the same question.
    emit({ type: "chat", chat: { ...folio.pending[paneId]!, id: "chat-2" } });
    answers.shift()!("chat-2");
    await asking;
    expect(places()).toEqual([{ view: "chat", chatId: "chat-2", courseId: course.id }]);
    expect(folio.tabs[0]!.history.at(-1)).toBe(folio.layout);
    expect(folio.pending[paneId]).toBeUndefined();
  });

  it("leaves a pane alone that moved on to another chat", async () => {
    folio.navigate({ view: "chats" }, { fill: true });
    const paneId = folio.activePane.id;
    const asking = folio.send("What is a DFA?", {
      paneId,
      chatId: null,
      courseId: null,
      focus: null,
    });
    folio.navigate({ view: "chat", chatId: "chat-1", courseId: course.id }, { paneId });
    answers.shift()!("chat-3");
    await asking;
    expect(places()).toEqual([{ view: "chat", chatId: "chat-1", courseId: course.id }]);
  });
});
