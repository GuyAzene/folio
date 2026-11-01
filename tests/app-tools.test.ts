import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Grants } from "../src/conversation.ts";
import type { Knowledge } from "../src/kb/knowledge.ts";
import {
  checkAction,
  perform,
  PendingActions,
  type AppAction,
  type AppControls,
} from "../src/library/app-actions.ts";
import { DEFAULT_CATEGORIES, type Category } from "../src/library/categories.ts";
import { ChatFiles } from "../src/library/chat-files.ts";
import { createRuntimes } from "../src/library/course-tools.ts";
import { LibraryOperations } from "../src/library/operations.ts";
import { LibraryStore } from "../src/library/store.ts";
import { SYNTHETIC_LECTURE, syntheticPdf } from "./fixtures/synthetic-pdf.ts";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true }).catch(async () => {
      await chmod(home, 0o700);
      await rm(home, { recursive: true, force: true });
    });
  }
});

/** A library with two courses, the tutor's controls over it, and Trash and studying recorded. */
async function setup() {
  const home = await mkdtemp(resolve(tmpdir(), "folio-app-tools-test-"));
  homes.push(home);
  const library = await LibraryStore.open({ home: resolve(home, "data") });
  const log: string[] = [];
  let categories: Category[] = structuredClone([...DEFAULT_CATEGORIES]);
  let naming: string | null = null;
  let roles = { teaching: "chatgpt/gpt-6.1-sol" } as AppControls extends {
    roles(): infer R;
  }
    ? R
    : never;
  const operations = new LibraryOperations({
    library,
    categories: () => categories,
    async saveCategories(next) {
      categories = structuredClone(next);
    },
    naming: () => naming,
    async saveNaming(pattern) {
      naming = pattern;
    },
    knowledge: {
      knowledge: async () => ({ sessions: [] }) as unknown as Knowledge,
      async revise() {},
    },
    async withdraw() {},
    studySoon: (courseId, ids) => ids.length && log.push(`study soon ${ids.length}`),
    syncAssignments() {},
    changed() {},
  });
  const files = new ChatFiles(resolve(home, "data"));
  const trashed = new Map<string, string>();
  const controls: AppControls = {
    library,
    operations,
    categories: () => categories,
    naming: () => naming,
    async trashDocument(id) {
      log.push(`trash ${id}`);
      trashed.set(`entry-${id}`, id);
      return `entry-${id}`;
    },
    async trashCourse(id) {
      log.push(`trash course ${id}`);
      return `entry-${id}`;
    },
    async restore(entry) {
      log.push(`restore ${entry}`);
    },
    roles: () => roles,
    async setModel(step, ref) {
      roles = { ...roles, [step]: ref };
    },
    async study(_courseId, ids) {
      log.push(`study ${ids.length}`);
    },
    async stopStudying() {},
    chatFile: (file) => files.path({ fileId: file.fileId, kind: file.fileKind }),
  };
  const pending = new PendingActions(resolve(home, "data"));
  const runtimes = createRuntimes(library, { files, app: { controls, pending } });
  const algorithms = await library.createCourse({ name: "Algorithms" });
  const complexity = await library.createCourse({ name: "Complexity" });
  const pdf = async (name: string) => {
    const path = resolve(home, name);
    await writeFile(path, syntheticPdf([[name], ...SYNTHETIC_LECTURE.slice(1)]));
    return path;
  };
  const add = async (courseId: string, name: string) =>
    (await library.importFile(courseId, await pdf(name))).document;
  return {
    home,
    library,
    controls,
    pending,
    runtimes,
    algorithms,
    complexity,
    files,
    pdf,
    add,
    log,
  };
}

function tool(tools: AgentTool[], name: string): AgentTool {
  const found = tools.find((each) => each.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

const run = (tools: AgentTool[], name: string, params: unknown) =>
  tool(tools, name).execute("call", params as never) as Promise<{
    content: { text: string }[];
    details: { action?: { summary: string; undo?: AppAction }; pending?: { id: string } };
  }>;

describe("the tutor's controls", () => {
  it("rename a file at once, with an Undo that puts it back", async () => {
    const { runtimes, algorithms, add, library, controls } = await setup();
    const r01 = await add(algorithms.id, "Notes 1.pdf");
    const { tools } = await runtimes.course(algorithms.id, "chat");
    const result = await run(tools, "edit_files", {
      documentIds: [r01.id],
      name: "Recitation 1",
      category: "recitation",
    });
    expect(result.details.action?.summary).toBe(
      "“Notes 1”: renamed it “Recitation 1”, made it a recitation",
    );
    expect((await library.document(r01.id)).title).toBe("Recitation 1");
    await perform(checkAction(result.details.action!.undo), controls);
    expect(await library.document(r01.id)).toMatchObject({
      title: "Notes 1",
      named: "own",
      category: "lecture",
    });
    // A second Undo finds the file changed from what the tutor left, and leaves it.
    await expect(perform(result.details.action!.undo!, controls)).rejects.toThrow("changed since");
  });

  it("keep a bigger change for the student's Apply, and refuse it once the files changed", async () => {
    const { runtimes, algorithms, complexity, add, library, pending, controls } = await setup();
    const lecture = await add(algorithms.id, "Lecture 1.pdf");
    // A course chat moves files only to a course it can read; a library chat to any.
    const { tools: course } = await runtimes.course(algorithms.id, "chat");
    await expect(
      run(course, "edit_files", { documentIds: [lecture.id], courseId: complexity.id }),
    ).rejects.toThrow("not part of this chat");
    const { tools } = await runtimes.library("chat");
    const result = await run(tools, "edit_files", {
      documentIds: [lecture.id],
      courseId: complexity.id,
    });
    const id = result.details.pending!.id;
    expect(result.content[0]!.text).toMatch(/^Waiting for the student/);
    expect((await library.document(lecture.id)).courseId).toBe(algorithms.id);
    // Renamed by the student meanwhile: applying now would act on a file that isn't as proposed.
    await library.updateDocument(lecture.id, { title: "Graphs" }, lecture.revision);
    const record = await pending.get(id);
    await expect(perform(record.action, controls)).rejects.toThrow("changed since");
    // Answered once only.
    await pending.resolve(id, async () => ({ state: "cancelled" }));
    await expect(pending.resolve(id, async () => ({ state: "applied" }))).rejects.toThrow(
      "already answered",
    );
    expect((await pending.untold("chat")).map((each) => each.state)).toEqual(["cancelled"]);
    expect(await pending.untold("chat")).toEqual([]);
  });

  it("ask before changing more than five files, and refuse emptying a course", async () => {
    const { runtimes, algorithms, add, log } = await setup();
    const documents = [];
    for (const n of [1, 2, 3, 4, 5, 6, 7]) documents.push(await add(algorithms.id, `L${n}.pdf`));
    const { tools } = await runtimes.course(algorithms.id, "chat");
    const six = documents.slice(0, 6).map((document) => document.id);
    expect(
      (await run(tools, "edit_files", { documentIds: six, number: 1 })).details.pending,
    ).toBeTruthy();
    expect((await run(tools, "trash_files", { documentIds: six })).details.pending).toBeTruthy();
    await expect(
      run(tools, "trash_files", { documentIds: documents.map((document) => document.id) }),
    ).rejects.toThrow("won't empty a course");
    const small = await run(tools, "trash_files", { documentIds: six.slice(0, 2) });
    expect(small.details.action?.summary).toBe("Moved 2 files to the Trash");
    expect(log.filter((line) => line.startsWith("trash "))).toHaveLength(2);
  });

  it("ask before renaming more than five files to a pattern, and only those it would change", async () => {
    const { runtimes, algorithms, add, controls } = await setup();
    const documents = [];
    for (const n of [1, 2, 3, 4, 5, 6]) documents.push(await add(algorithms.id, `L${n}.pdf`));
    const ids = documents.map((document) => document.id);
    const { tools } = await runtimes.course(algorithms.id, "chat");
    const none = await run(tools, "edit_files", { documentIds: ids, usePattern: true });
    expect(none.content[0]!.text).toMatch(/^Nothing to rename/);
    await controls.operations.setNaming("{category} {n}");
    const six = await run(tools, "edit_files", { documentIds: ids, usePattern: true });
    expect(six.details.pending).toBeTruthy();
    const two = await run(tools, "edit_files", { documentIds: ids.slice(0, 2), usePattern: true });
    expect(two.details.action?.summary).toBe("Renamed 2 files by the pattern");
  });

  it("keep a course chat to its own course's files", async () => {
    const { runtimes, algorithms, complexity, add } = await setup();
    const other = await add(complexity.id, "R01.pdf");
    const { tools } = await runtimes.course(algorithms.id, "chat");
    await expect(
      run(tools, "edit_files", { documentIds: [other.id], name: "Mine now" }),
    ).rejects.toThrow("not in this chat's course");
    await expect(run(tools, "trash_course", { courseId: complexity.id })).rejects.toThrow(
      "changes only its own course",
    );
  });

  it("move one course to the Trash per reply, and only on Apply", async () => {
    const { runtimes, algorithms, complexity, log } = await setup();
    const runtime = await runtimes.library("chat");
    const first = await run(runtime.tools, "trash_course", { courseId: algorithms.id });
    expect(first.details.pending).toBeTruthy();
    await expect(run(runtime.tools, "trash_course", { courseId: complexity.id })).rejects.toThrow(
      "one course to the Trash per reply",
    );
    runtime.beforeSend?.({ webSearch: true });
    expect(
      (await run(runtime.tools, "trash_course", { courseId: complexity.id })).details.pending,
    ).toBeTruthy();
    expect(log).toEqual([]);
  });

  it("read a file the student added, and add it to the course only when asked", async () => {
    const { runtimes, algorithms, files, pdf, library, log } = await setup();
    const file = await files.add(await pdf("Tirgul 3.pdf"));
    const grant = {
      kind: "file" as const,
      fileId: file.fileId,
      name: file.name,
      fileKind: file.kind,
      pages: file.pages,
    };
    const grants = (): Grants => ({ courses: [], documents: [], files: [grant] });
    const { tools } = await runtimes.course(algorithms.id, "chat", grants);
    const page = await run(tools, "read_page", { documentId: file.fileId, page: 1 });
    expect(page.content[0]!.text).toContain("A file the student added to this chat");
    expect(await library.listDocuments({ courseId: algorithms.id })).toEqual([]);
    const added = await run(tools, "add_file", { fileId: file.fileId });
    expect(added.details.action?.summary).toBe("Added “Tirgul 3” to Algorithms as a recitation");
    expect(log).toContain("study soon 1");
    // Without the student's file in the chat, the same ID reads nothing.
    const { tools: other } = await runtimes.course(algorithms.id, "other");
    await expect(run(other, "read_page", { documentId: file.fileId, page: 1 })).rejects.toThrow(
      "didn't add that file",
    );
    await expect(run(other, "add_file", { fileId: file.fileId })).rejects.toThrow(
      "didn't add that file",
    );
  });

  it("add a category at once, and wait for Apply to remove one or choose a model", async () => {
    const { runtimes, controls } = await setup();
    const { tools } = await runtimes.library("chat");
    const added = await run(tools, "edit_categories", {
      add: { name: "Lab", kind: "assignment", match: ["lab"], naming: "{category} {n}" },
    });
    expect(added.details.action?.summary).toBe("Added the category “Labs”");
    expect(controls.categories().at(-1)).toMatchObject({ id: "lab", naming: "{category} {n}" });
    expect((await run(tools, "edit_categories", { remove: "lab" })).details.pending).toBeTruthy();
    expect(
      (await run(tools, "set_model", { step: "reader", model: "chatgpt/gpt-6.1-terra" })).details
        .pending,
    ).toBeTruthy();
    expect(controls.roles().reader).toBeUndefined();
  });

  it("keep only the student's PDF and Markdown files, read-only and checked on every read", async () => {
    const { home, files, pdf } = await setup();
    const text = resolve(home, "notes.txt");
    await writeFile(text, "plain");
    await expect(files.add(text)).rejects.toThrow("PDF and Markdown");
    const fake = resolve(home, "fake.pdf");
    await writeFile(fake, "not a pdf");
    await expect(files.add(fake)).rejects.toThrow("is not a PDF");
    await symlink(fake, resolve(home, "link.pdf"));
    await expect(files.add(resolve(home, "link.pdf"))).rejects.toThrow("not a regular file");
    const kept = await files.add(await pdf("Lecture 9.pdf"));
    expect(await files.add(await pdf("Lecture 9.pdf"))).toEqual(kept);
    const path = files.path(kept);
    expect((await stat(path)).mode & 0o777).toBe(0o400);
    await chmod(path, 0o600);
    await writeFile(path, "changed");
    await expect(files.read(kept)).rejects.toThrow("changed outside Folio");
  });

  it("refuse an action from the window that isn't one", () => {
    expect(() => checkAction({ op: "delete_everything" })).toThrow("Folio can't do that.");
    expect(() => checkAction({ op: "trash_files", documentIds: ["../../etc"] })).toThrow();
  });
});
