import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  ChatSummary,
  DesktopEvent,
  FolioApi,
  ReleaseView,
  UpdateView,
} from "../src/desktop/api.ts";
import { DEFAULT_CATEGORIES } from "../src/library/categories.ts";

/**
 * Folio updating itself, as the window sees it: the release line follows what the main process
 * sends, Update and Restart reach the bridge, and Restart asks first while a reply is being
 * written, since restarting stops it. A synthetic bridge stands in for the main process.
 */

let emit: (event: DesktopEvent) => void = () => {};
let calls: string[] = [];
let refuse = false;
const view = (update: UpdateView | null): ReleaseView => ({
  version: "0.2.2",
  on: true,
  newer: { version: "0.3.0", url: "https://github.com/GuyAzene/folio/releases/tag/v0.3.0" },
  update,
});
const chat = (id: string, status: ChatSummary["status"]): ChatSummary => ({
  id,
  kind: "chat",
  title: id,
  updatedAt: new Date().toISOString(),
  status,
  courseId: null,
  focus: null,
});

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
  listCourses: empty,
  listDocuments: empty,
  listNotes: empty,
  listProposals: empty,
  listPending: empty,
  listAssignments: empty,
  listJobs: empty,
  listTrash: empty,
  listApprovals: empty,
  listSkills: async () => ({ skills: [], folders: [] }),
  mcpServers: async () => ({ servers: [] }),
  loadWorkspace: async () => null,
  saveWorkspace: async () => {},
  setWindowTheme: async () => {},
  release: async () => view({ step: "available" }),
  checkRelease: async () => view({ step: "available" }),
  updateFolio: async (version: string) => {
    calls.push(`update ${version}`);
    if (refuse) throw new Error("That release is no longer the newest; check again in Settings.");
    return view({ step: "downloading", percent: 0 });
  },
  restartToUpdate: async (version: string) => {
    calls.push(`restart ${version}`);
  },
} as unknown as FolioApi;

let folio: typeof import("../app/lib/state.svelte.ts").folio;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {} }));
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  ({ folio } = await import("../app/lib/state.svelte.ts"));
  await folio.init(bridge);
});

beforeEach(() => {
  calls = [];
  refuse = false;
  folio.error = null;
  folio.confirming = null;
  folio.chats = [];
  folio.release = view({ step: "available" });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the release line", () => {
  it("follows the download as the main process reports it", () => {
    emit({ type: "release", release: view({ step: "downloading", percent: 42 }) });
    expect(folio.release?.update).toEqual({ step: "downloading", percent: 42 });
    emit({ type: "release", release: view({ step: "ready" }) });
    expect(folio.release?.update).toEqual({ step: "ready" });
    expect(folio.announcedRelease?.version).toBe("0.3.0");
  });

  it("downloads the release the student clicked, and says when the main process refuses", async () => {
    await folio.updateFolio("0.3.0");
    expect(calls).toEqual(["update 0.3.0"]);
    expect(folio.release?.update).toEqual({ step: "downloading", percent: 0 });
    refuse = true;
    await folio.updateFolio("0.3.0");
    expect(folio.error).toContain("no longer the newest");
  });

  it("restarts at once when no reply is being written", async () => {
    folio.chats = [chat("a", "idle"), chat("b", "interrupted")];
    folio.restartToUpdate("0.3.0");
    await settle();
    expect(calls).toEqual(["restart 0.3.0"]);
    expect(folio.confirming).toBeNull();
  });

  it("asks first while a reply is being written, and restarts only when the student agrees", async () => {
    folio.chats = [chat("a", "running"), chat("b", "idle")];
    folio.restartToUpdate("0.3.0");
    await settle();
    expect(calls).toEqual([]);
    expect(folio.confirming?.title).toBe("Restart to update to Folio 0.3.0?");
    expect(folio.confirming?.body).toContain("A reply is still being written");
    expect(folio.confirming?.action).toBe("Restart");
    await folio.confirming!.run();
    expect(calls).toEqual(["restart 0.3.0"]);
  });

  it("counts every reply being written", () => {
    folio.chats = [chat("a", "running"), chat("b", "running")];
    folio.restartToUpdate("0.3.0");
    expect(folio.confirming?.body).toContain("2 replies are still being written");
    expect(folio.confirming?.body).toContain("Restarting stops them");
  });
});
