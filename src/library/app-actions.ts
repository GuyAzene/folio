import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MODEL_ROLES, type ModelRole } from "../desktop/api.ts";
import { writeAtomic } from "../files.ts";
import { categoryOf, type Category } from "./categories.ts";
import type { Rename } from "./naming.ts";
import type { LibraryOperations } from "./operations.ts";
import {
  checkId,
  LibraryError,
  PENCILS,
  type CourseInput,
  type DocumentRecord,
  type LibraryStore,
} from "./store.ts";

/**
 * A change to Folio that the tutor makes, or that waits for the student's Apply, as plain data:
 * it can be saved with a chat, shown in a card, applied later and undone. Every action is
 * checked again when it runs, wherever it came from.
 */
export type AppAction =
  | { op: "create_course"; input: CourseInput }
  | { op: "edit_course"; courseId: string; set: CourseInput; expect?: CourseInput }
  | { op: "change_files"; changes: FileChange[] }
  | { op: "name_by_pattern"; documentIds: string[] }
  | { op: "undo_naming"; renames: Rename[] }
  | {
      op: "add_file";
      file: ChatFileRef;
      courseId: string;
      category?: string;
      number?: number;
      title?: string;
    }
  | { op: "trash_files"; documentIds: string[] }
  | { op: "trash_course"; courseId: string; onlyEmpty?: boolean }
  | { op: "restore"; entryIds: string[] }
  | {
      op: "library_settings";
      categories?: Category[];
      naming?: string | null;
      expect?: { categories: Category[]; naming: string | null };
    }
  | { op: "set_model"; step: ModelRole; model: string; expect?: string }
  | { op: "study"; courseId: string; documentIds: string[]; start: boolean };

/** What one file's change sets, and what it must still be for the change to apply. */
export interface FileChange {
  documentId: string;
  set: FileFields;
  expect?: FileFields;
}

export interface FileFields {
  title?: string;
  named?: "pattern" | "own";
  number?: number;
  category?: string;
  courseId?: string;
}

/** A file the student added to a chat, as the chat recorded it. */
export interface ChatFileRef {
  fileId: string;
  name: string;
  fileKind: "pdf" | "markdown";
}

/** What Folio can do on the tutor's behalf, wired by the app to the same code its controls use. */
export interface AppControls {
  library: LibraryStore;
  operations: LibraryOperations;
  categories(): Category[];
  naming(): string | null;
  /** Moves a file to Folio's Trash; returns the Trash entry's id. */
  trashDocument(id: string): Promise<string>;
  trashCourse(id: string): Promise<string>;
  restore(entryId: string): Promise<void>;
  roles(): Record<ModelRole, string>;
  /** Sets a step's model; refused when the model can't do it. */
  setModel(step: ModelRole, ref: string): Promise<void>;
  study(courseId: string, documentIds: string[]): Promise<void>;
  stopStudying(documentIds: string[]): Promise<void>;
  /** The path of a file a chat holds, to copy it into a course. */
  chatFile(file: ChatFileRef): string;
}

/** What an action did: a sentence for its card, what undoes it, and what it made. */
export interface Performed {
  summary: string;
  undo?: AppAction;
  courseId?: string;
  documentIds?: string[];
}

const FILE_KEYS = ["title", "named", "number", "category", "courseId"] as const;

function fields(document: DocumentRecord, keys: readonly (keyof FileFields)[]): FileFields {
  const result: FileFields = {};
  for (const key of keys)
    if (key === "named") result.named = document.named ?? "own";
    else if (document[key] !== undefined) (result as Record<string, unknown>)[key] = document[key];
  return result;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stale(what: string): never {
  throw new LibraryError(`${what} changed since, so Folio left it as it is.`);
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** Checks an action that came from outside the main process, such as an Undo from the window. */
export function checkAction(value: unknown): AppAction {
  const action = value as AppAction;
  if (typeof action !== "object" || action === null || typeof action.op !== "string")
    throw new LibraryError("Folio can't do that.");
  const ids = (list: unknown) => {
    if (!Array.isArray(list) || !list.length || list.length > 200)
      throw new LibraryError("Folio can't do that.");
    list.forEach(checkId);
  };
  switch (action.op) {
    case "create_course":
      break;
    case "edit_course":
    case "trash_course":
      checkId(action.courseId);
      break;
    case "change_files":
      ids(action.changes?.map((change) => change.documentId));
      break;
    case "name_by_pattern":
    case "trash_files":
      ids(action.documentIds);
      break;
    case "undo_naming":
      ids(action.renames?.map((rename) => rename.documentId));
      break;
    case "restore":
      ids(action.entryIds);
      break;
    case "add_file":
      checkId(action.courseId);
      break;
    case "library_settings":
      break;
    case "set_model":
      if (!MODEL_ROLES.includes(action.step)) throw new LibraryError("Unknown step.");
      break;
    case "study":
      checkId(action.courseId);
      ids(action.documentIds);
      break;
    default:
      throw new LibraryError("Folio can't do that.");
  }
  return action;
}

/** Does an action through the app's own operations, refusing one whose target changed since. */
export async function perform(action: AppAction, app: AppControls): Promise<Performed> {
  const { library, operations } = app;
  switch (action.op) {
    case "create_course": {
      const color = action.input.color;
      if (color !== undefined && !PENCILS.includes(color))
        throw new LibraryError(`Use one of these colors: ${PENCILS.join(", ")}.`);
      const course = await operations.createCourse(action.input);
      return {
        summary: `Created the course “${course.name}”`,
        undo: { op: "trash_course", courseId: course.id, onlyEmpty: true },
        courseId: course.id,
      };
    }
    case "edit_course": {
      const course = await library.course(action.courseId);
      const keys = Object.keys(action.set) as (keyof CourseInput)[];
      const before: CourseInput = {};
      for (const key of keys) (before as Record<string, unknown>)[key] = course[key];
      if (action.expect && !same(before, action.expect)) stale(`“${course.name}”`);
      const after = await operations.updateCourse(course.id, action.set, course.revision);
      const set: CourseInput = {};
      for (const key of keys) (set as Record<string, unknown>)[key] = after[key];
      return {
        summary:
          after.name !== course.name
            ? `Renamed the course “${course.name}” to “${after.name}”`
            : `Changed “${after.name}”: ${keys.join(", ")}`,
        undo: { op: "edit_course", courseId: course.id, set: before, expect: set },
        courseId: course.id,
      };
    }
    case "change_files": {
      const undo: FileChange[] = [];
      const lines: string[] = [];
      for (const change of action.changes) {
        const document = await library.document(change.documentId);
        const keys = FILE_KEYS.filter((key) => change.set[key] !== undefined);
        const before = fields(document, keys.includes("title") ? [...keys, "named"] : keys);
        // A file from before categories is in the first category of its role.
        if (keys.includes("category")) before.category = categoryOf(document, app.categories()).id;
        if (
          change.expect &&
          !same(fields(document, Object.keys(change.expect) as never), change.expect)
        )
          stale(`“${document.title}”`);
        const after = await operations.updateDocument(document.id, change.set, document.revision);
        undo.push({
          documentId: document.id,
          set: before,
          expect: fields(after, Object.keys(before) as never),
        });
        lines.push(describeChange(document, after, app.categories()));
      }
      return {
        summary: lines.length === 1 ? lines[0]! : `Changed ${plural(lines.length, "file")}`,
        undo: { op: "change_files", changes: undo },
        documentIds: action.changes.map((change) => change.documentId),
      };
    }
    case "name_by_pattern": {
      const renamed = await operations.applyNaming({ documentIds: action.documentIds });
      const changed = renamed.filter((rename) => rename.next !== rename.title);
      return {
        summary:
          changed.length === 1
            ? `Renamed “${changed[0]!.title}” to “${changed[0]!.next}”`
            : changed.length
              ? `Renamed ${plural(changed.length, "file")} by the pattern`
              : "Every name already follows the pattern",
        undo: renamed.length ? { op: "undo_naming", renames: renamed } : undefined,
        documentIds: action.documentIds,
      };
    }
    case "undo_naming": {
      const restored = await operations.undoNaming(action.renames);
      return { summary: `Put back ${plural(restored, "name")}` };
    }
    case "add_file": {
      const [result] = await operations.importFiles(action.courseId, [
        {
          path: app.chatFile(action.file),
          name: action.file.name,
          category: action.category,
          number: action.number,
          title: action.title,
        },
      ]);
      if (!result || "error" in result)
        throw new LibraryError(result?.error ?? "Nothing was added.");
      const course = await library.course(action.courseId);
      const category = categoryOf(result.document, app.categories());
      return {
        summary: result.duplicate
          ? `“${result.document.title}” was already in ${course.name}`
          : `Added “${result.document.title}” to ${course.name} as ${article(category.name)}`,
        undo: result.duplicate
          ? undefined
          : { op: "trash_files", documentIds: [result.document.id] },
        courseId: course.id,
        documentIds: [result.document.id],
      };
    }
    case "trash_files": {
      const titles: string[] = [];
      const entries: string[] = [];
      for (const id of action.documentIds) {
        const document = await library.document(id);
        entries.push(await app.trashDocument(id));
        titles.push(document.title);
      }
      return {
        summary:
          titles.length === 1
            ? `Moved “${titles[0]}” to the Trash`
            : `Moved ${plural(titles.length, "file")} to the Trash`,
        undo: { op: "restore", entryIds: entries },
      };
    }
    case "trash_course": {
      const course = await library.course(action.courseId);
      if (action.onlyEmpty && (await library.listDocuments({ courseId: course.id })).length)
        throw new LibraryError(
          `“${course.name}” has files now. Move it to the Trash from its page if you mean to.`,
        );
      const entry = await app.trashCourse(course.id);
      return {
        summary: `Moved the course “${course.name}” to the Trash`,
        undo: { op: "restore", entryIds: [entry] },
      };
    }
    case "restore": {
      for (const entry of action.entryIds) await app.restore(entry);
      return { summary: "Restored from the Trash" };
    }
    case "library_settings": {
      const before = { categories: app.categories(), naming: app.naming() };
      if (action.expect && !same(before, action.expect)) stale("Your categories");
      if (action.categories) await operations.setCategories(action.categories);
      if (action.naming !== undefined) await operations.setNaming(action.naming);
      const after = { categories: app.categories(), naming: app.naming() };
      return {
        summary: describeSettings(before, after),
        undo: { op: "library_settings", ...before, expect: after },
      };
    }
    case "set_model": {
      const before = app.roles()[action.step];
      if (action.expect !== undefined && before !== action.expect) stale("That step's model");
      await app.setModel(action.step, action.model);
      return {
        summary: `${STEP_NAMES[action.step]} now uses ${action.model}`,
        undo: { op: "set_model", step: action.step, model: before, expect: action.model },
      };
    }
    case "study": {
      if (action.start) await app.study(action.courseId, action.documentIds);
      else await app.stopStudying(action.documentIds);
      return {
        summary: action.start
          ? `Studying ${plural(action.documentIds.length, "file")}`
          : `Stopped studying ${plural(action.documentIds.length, "file")}`,
        courseId: action.courseId,
      };
    }
  }
}

/** Each step's name as Settings shows it. */
export const STEP_NAMES: Record<ModelRole, string> = {
  teaching: "Teaching",
  research: "Web search",
  planner: "Planning a lecture",
  reader: "Reading pages",
  closeup: "Close-ups",
  writer: "Writing study notes",
  checker: "Checking study notes",
  rechecker: "Rechecking corrections",
  topics: "Comparing topics",
  syllabus: "Reading a syllabus",
};

function article(name: string): string {
  return `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name.toLowerCase()}`;
}

function describeChange(
  before: DocumentRecord,
  after: DocumentRecord,
  categories: readonly Category[],
): string {
  const parts: string[] = [];
  if (after.title !== before.title) parts.push(`renamed it “${after.title}”`);
  if (after.number !== before.number) parts.push(`numbered it ${after.number}`);
  if (categoryOf(after, categories).id !== categoryOf(before, categories).id)
    parts.push(`made it ${article(categoryOf(after, categories).name)}`);
  if (after.courseId !== before.courseId) parts.push("moved it to another course");
  return parts.length ? `“${before.title}”: ${parts.join(", ")}` : `“${before.title}” is as asked`;
}

function describeSettings(
  before: { categories: Category[]; naming: string | null },
  after: { categories: Category[]; naming: string | null },
): string {
  const added = after.categories.filter(
    (category) => !before.categories.some((each) => each.id === category.id),
  );
  const removed = before.categories.filter(
    (category) => !after.categories.some((each) => each.id === category.id),
  );
  if (added.length === 1) return `Added the category “${added[0]!.plural}”`;
  if (removed.length === 1) return `Removed the category “${removed[0]!.plural}”`;
  if (before.naming !== after.naming)
    return after.naming ? `Files are named “${after.naming}”` : "Files keep their own names";
  return "Changed your categories";
}

/** A change waiting for the student's Apply, kept until they answer it. */
export interface PendingAction {
  v: 1;
  id: string;
  chatId: string;
  summary: string;
  action: AppAction;
  state: "pending" | "applied" | "cancelled" | "failed";
  /** Why it failed, or what applying it did. */
  note?: string;
  createdAt: string;
  resolvedAt?: string;
  /** Whether the tutor has been told how it was answered. */
  told?: boolean;
  /** What undoes it, once applied. */
  undo?: AppAction;
}

/** Changes the tutor proposed that wait for the student, in `pending/` in Folio's home. */
export class PendingActions {
  readonly directory: string;
  readonly #changed: () => void;
  #writing = Promise.resolve();

  /** `changed` is told after every change, so the window can show it. */
  constructor(home: string, changed: () => void = () => {}) {
    this.directory = resolve(home, "pending");
    this.#changed = changed;
  }

  async create(chatId: string, summary: string, action: AppAction): Promise<PendingAction> {
    const record: PendingAction = {
      v: 1,
      id: randomUUID(),
      chatId,
      summary,
      action,
      state: "pending",
      createdAt: new Date().toISOString(),
    };
    await this.#save(record);
    return record;
  }

  async get(id: string): Promise<PendingAction> {
    checkId(id);
    const text = await readFile(resolve(this.directory, `${id}.json`), "utf8").catch(() => {
      throw new LibraryError("That change is no longer waiting.");
    });
    return JSON.parse(text) as PendingAction;
  }

  async list(): Promise<PendingAction[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const records = await Promise.all(
      names
        .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
        .map((name) => this.get(name.slice(0, -5)).catch(() => null)),
    );
    return records
      .filter((record): record is PendingAction => record?.v === 1)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Answers a waiting change once; a second answer is refused. */
  async resolve(
    id: string,
    answer: (record: PendingAction) => Promise<Partial<PendingAction>>,
  ): Promise<PendingAction> {
    const run = this.#writing.then(async () => {
      const record = await this.get(id);
      if (record.state !== "pending") throw new LibraryError("That change was already answered.");
      const next: PendingAction = {
        ...record,
        ...(await answer(record)),
        resolvedAt: new Date().toISOString(),
      };
      await this.#save(next);
      return next;
    });
    this.#writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Answers the tutor hasn't been told of yet, in a chat; marks them told. */
  async untold(chatId: string): Promise<PendingAction[]> {
    const answered = (await this.list()).filter(
      (record) => record.chatId === chatId && record.state !== "pending" && !record.told,
    );
    for (const record of answered) await this.#save({ ...record, told: true });
    return answered;
  }

  async #save(record: PendingAction): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeAtomic(resolve(this.directory, `${record.id}.json`), `${JSON.stringify(record)}\n`);
    this.#changed();
  }
}
