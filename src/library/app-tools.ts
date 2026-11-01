import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import type { Grants } from "../conversation.ts";
import { MODEL_ROLES, type ModelRole } from "../desktop/api.ts";
import {
  perform,
  STEP_NAMES,
  type AppAction,
  type AppControls,
  type PendingActions,
} from "./app-actions.ts";
import { categoryId, categoryOf, studied, type Category } from "./categories.ts";
import { isFileId } from "./chat-files.ts";
import { checkId, LibraryError, PENCILS, type CourseRecord, type DocumentRecord } from "./store.ts";

/** Above this many files, a change waits for the student's Apply. */
export const ASK_ABOVE = 5;

export interface AppToolOptions {
  reach: { courseId: string | null; grants: () => Grants };
  chatId: string;
  app: AppControls;
  pending: PendingActions;
  /** A course the chat may name; a course chat's own, or one the student added. */
  courseIn(requested: unknown): Promise<CourseRecord>;
  /** What this reply has done so far: one course to the Trash per reply at most. */
  reply: { coursesTrashed: number };
}

/** What the tutor is told about how to change Folio. */
export const APP_RULE =
  "You can also change Folio itself, as the student would with its controls: edit_course, edit_files, add_file, trash_files, trash_course, edit_categories, set_model and study. Do it only when the student asks or agrees, and say in a sentence what changed. A small change happens at once and the student can undo it from its card. A bigger one waits for the student to press Apply in its card: say what you proposed and stop; never try another way. When Folio refuses, as it does for deleting things for good, pass on what it says; the student can do it in the app.";

const object = (properties: Record<string, TSchema>, required: string[] = []) =>
  Type.Object(
    Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => [
        key,
        required.includes(key) ? schema : Type.Optional(schema),
      ]),
    ),
    { additionalProperties: false },
  );

function only(request: unknown, allowed: string[], tool: string): Record<string, unknown> {
  if (typeof request !== "object" || request === null)
    throw new LibraryError(`Invalid ${tool} request.`);
  if (Object.keys(request).some((key) => !allowed.includes(key)))
    throw new LibraryError(`${tool} accepts only ${allowed.join(", ")}.`);
  return request as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new LibraryError(`Write ${field} of up to ${max} characters.`);
  return value.trim();
}

/**
 * The tools that change Folio: courses, files, categories, naming, models and studying. Each is
 * checked here against what the chat may touch: a course chat changes only its own course and
 * the files the student added to it; a library chat may change any course. Small changes run at
 * once with an Undo; bigger ones wait for the student's Apply; some are refused outright.
 */
export function appTools(options: AppToolOptions): AgentTool[] {
  const { reach, chatId, app, pending, reply } = options;
  const { library } = app;
  const wide = reach.courseId === null;
  const where = wide ? "any of the student's courses" : "this chat's course";

  /** A file the chat may change: in its course, or anywhere for a library chat. */
  async function fileIn(id: unknown): Promise<DocumentRecord> {
    checkId(id);
    const document = await library.document(id).catch(() => undefined);
    if (!document || (reach.courseId && document.courseId !== reach.courseId))
      throw new LibraryError(
        wide
          ? "That file is not in your library."
          : "That file is not in this chat's course, so this chat can't change it. A library chat can.",
      );
    return document;
  }

  async function filesIn(ids: unknown): Promise<DocumentRecord[]> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 200)
      throw new LibraryError("Name 1 to 200 files by their IDs from list_documents.");
    return Promise.all([...new Set(ids)].map(fileIn));
  }

  async function ownCourse(requested: unknown): Promise<CourseRecord> {
    if (reach.courseId && requested !== undefined && requested !== reach.courseId)
      throw new LibraryError(
        "This chat changes only its own course. A library chat can change any course.",
      );
    return options.courseIn(requested ?? reach.courseId);
  }

  function category(id: unknown): Category {
    const found = app.categories().find((each) => each.id === id);
    if (!found)
      throw new LibraryError(
        `Use one of these categories: ${app
          .categories()
          .map((each) => `${each.id} (${each.plural})`)
          .join(", ")}.`,
      );
    return found;
  }

  /** Does the action now, with Undo, or keeps it for the student's Apply. */
  async function act(ask: boolean, action: AppAction, proposal: string) {
    if (ask) {
      const record = await pending.create(chatId, proposal, action);
      return {
        content: [
          {
            type: "text" as const,
            text: `Waiting for the student: ${proposal}. They see a card with Apply and Cancel, and nothing changes until they press Apply. Tell them in a sentence, then stop.`,
          },
        ],
        details: { pending: { v: 1, id: record.id, summary: proposal } },
      };
    }
    const done = await perform(action, app);
    return {
      content: [
        {
          type: "text" as const,
          text: `Done: ${done.summary}. The student can undo it from its card.`,
        },
      ],
      details: {
        action: {
          v: 1,
          summary: done.summary,
          ...(done.undo ? { undo: done.undo } : {}),
          ...(done.courseId ? { courseId: done.courseId } : {}),
          ...(done.documentIds?.length === 1 ? { documentId: done.documentIds[0] } : {}),
        },
      },
    };
  }

  const editCourse: AgentTool = {
    name: "edit_course",
    label: "Change a course",
    description: `Create a course (leave out courseId and give its name) or change ${wide ? "a course's" : "this course's"} name, code, term or color. Its files, notes, chats and study notes stay as they are.`,
    parameters: object({
      courseId: Type.String({ description: "The course to change; leave out to create one." }),
      name: Type.String({ maxLength: 80 }),
      code: Type.String({ maxLength: 24, description: "Such as CS 201; empty to remove it." }),
      term: Type.String({ maxLength: 40, description: "Such as Spring 2026; empty to remove it." }),
      color: Type.String({ description: `One of ${PENCILS.join(", ")}.` }),
    }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const input = only(params, ["courseId", "name", "code", "term", "color"], "edit_course");
      const set: Record<string, unknown> = {};
      if (input.name !== undefined) set.name = text(input.name, "a name", 80);
      for (const key of ["code", "term"] as const)
        if (input[key] !== undefined) {
          if (typeof input[key] !== "string") throw new LibraryError(`Write the ${key} as text.`);
          set[key] = (input[key] as string).trim();
        }
      if (input.color !== undefined) {
        if (!PENCILS.includes(input.color as never))
          throw new LibraryError(`Use one of these colors: ${PENCILS.join(", ")}.`);
        set.color = input.color;
      }
      if (input.courseId === undefined) {
        if (!set.name) throw new LibraryError("Give the new course a name.");
        return act(false, { op: "create_course", input: set }, "");
      }
      const course = await ownCourse(input.courseId);
      if (!Object.keys(set).length) throw new LibraryError("Say what to change.");
      return act(false, { op: "edit_course", courseId: course.id, set }, "");
    },
  };

  const editFiles: AgentTool = {
    name: "edit_files",
    label: "Change files",
    description: `Rename a file, change files' numbers or category, name them by their category's pattern, or move them to another course, in ${where}. A file's number is what orders it in its category (its week, its place among the lectures); a naming pattern uses it. Renaming never studies a file again. More than ${ASK_ABOVE} files, a move to another course, or a change that drops a file's study notes waits for the student's Apply.`,
    parameters: object(
      {
        documentIds: Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 200,
          description: "File IDs from list_documents.",
        }),
        name: Type.String({ maxLength: 160, description: "A new name, for one file only." }),
        number: Type.Integer({ minimum: 0, maximum: 9999 }),
        category: Type.String({ description: "A category ID from the prompt's list." }),
        courseId: Type.String({ description: "A course to move the files to." }),
        usePattern: Type.Boolean({
          description: "True to name the files by their category's naming pattern from now on.",
        }),
      },
      ["documentIds"],
    ),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const input = only(
        params,
        ["documentIds", "name", "number", "category", "courseId", "usePattern"],
        "edit_files",
      );
      const documents = await filesIn(input.documentIds);
      if (input.usePattern === true) {
        if (Object.keys(input).length > 2)
          throw new LibraryError("Name files by the pattern on its own, then change the rest.");
        // Only names that would change count: there is nothing to ask about otherwise.
        const renames = (
          await app.operations.renames({ documentIds: documents.map((document) => document.id) })
        ).filter((rename) => rename.next !== rename.title);
        if (!renames.length)
          return {
            content: [
              {
                type: "text" as const,
                text: "Nothing to rename: those names already follow their category's pattern, or their category has none.",
              },
            ],
            details: {},
          };
        return act(
          renames.length > ASK_ABOVE,
          { op: "name_by_pattern", documentIds: renames.map((rename) => rename.documentId) },
          `Rename ${renames.length} files by their category's pattern`,
        );
      }
      const title = text(input.name, "a name", 160);
      if (title && documents.length > 1) throw new LibraryError("Rename one file at a time.");
      if (
        input.number !== undefined &&
        (!Number.isInteger(input.number) || Number(input.number) < 0)
      )
        throw new LibraryError("Write the number as a whole number, such as 3.");
      const target = input.category === undefined ? undefined : category(input.category);
      const course =
        input.courseId === undefined ? undefined : await options.courseIn(input.courseId);
      if (title === undefined && input.number === undefined && !target && !course)
        throw new LibraryError("Say what to change.");
      const moving = !!course && documents.some((document) => document.courseId !== course.id);
      const dropsNotes = documents.some(
        (document) =>
          studied(document) &&
          ((target && !studied({ role: target.kind, kind: document.kind })) || moving),
      );
      const changes = documents.map((document) => ({
        documentId: document.id,
        set: {
          ...(title ? { title } : {}),
          ...(input.number !== undefined ? { number: input.number as number } : {}),
          ...(target ? { category: target.id } : {}),
          ...(course ? { courseId: course.id } : {}),
        },
      }));
      const ask = documents.length > ASK_ABOVE || moving || dropsNotes;
      const what = [
        title && `rename it “${title}”`,
        input.number !== undefined &&
          `number ${documents.length === 1 ? "it" : "them"} ${Number(input.number)}`,
        target && `make ${documents.length === 1 ? "it" : "them"} ${target.plural.toLowerCase()}`,
        course && `move ${documents.length === 1 ? "it" : "them"} to ${course.name}`,
      ].filter(Boolean);
      const subject =
        documents.length === 1 ? `“${documents[0]!.title}”` : `${documents.length} files`;
      return act(
        ask,
        {
          op: "change_files",
          changes: ask
            ? changes.map((change, index) => ({
                ...change,
                // Applied later only if each file is still as it is now.
                expect: {
                  title: documents[index]!.title,
                  courseId: documents[index]!.courseId,
                  ...(documents[index]!.category ? { category: documents[index]!.category } : {}),
                },
              }))
            : changes,
        },
        `${subject}: ${what.join(", ")}${dropsNotes ? " (its study notes go with the change)" : ""}`,
      );
    },
  };

  const addFile: AgentTool = {
    name: "add_file",
    label: "Add a file to a course",
    description: `Add a PDF or Markdown file the student added to this chat to ${wide ? "a course" : "this course"}, when they ask. It goes in like a file added in Materials: a category (the one asked for, or the one its name points to), a number, its name, and studying when its category is studied. Reading a file never adds it.`,
    parameters: object(
      {
        fileId: Type.String({ description: "The fileId the student's message gave." }),
        courseId: Type.String({
          description: wide ? "The course to add it to." : "Leave out for this course.",
        }),
        category: Type.String({ description: "A category ID from the prompt's list." }),
        number: Type.Integer({ minimum: 0, maximum: 9999 }),
        name: Type.String({ maxLength: 160, description: "Its name, when not by the pattern." }),
      },
      ["fileId"],
    ),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const input = only(params, ["fileId", "courseId", "category", "number", "name"], "add_file");
      if (!isFileId(input.fileId))
        throw new LibraryError("Use the fileId from the student's message.");
      const file = reach.grants().files?.find((each) => each.fileId === input.fileId);
      if (!file) throw new LibraryError("The student didn't add that file to this chat.");
      const course = await options.courseIn(input.courseId ?? reach.courseId ?? undefined);
      const target = input.category === undefined ? undefined : category(input.category);
      if (
        input.number !== undefined &&
        (!Number.isInteger(input.number) || Number(input.number) < 0)
      )
        throw new LibraryError("Write the number as a whole number, such as 3.");
      return act(
        false,
        {
          op: "add_file",
          file: { fileId: file.fileId, name: file.name, fileKind: file.fileKind },
          courseId: course.id,
          ...(target ? { category: target.id } : {}),
          ...(input.number !== undefined ? { number: input.number as number } : {}),
          ...(input.name !== undefined ? { title: text(input.name, "a name", 160) } : {}),
        },
        "",
      );
    },
  };

  const trashFiles: AgentTool = {
    name: "trash_files",
    label: "Move files to the Trash",
    description: `Move files in ${where} to Folio's Trash, where they wait 30 days and can be restored; a studied file's study notes go with it. Up to ${ASK_ABOVE} at once happen at once; more wait for the student's Apply. All of a course's files at once, and deleting for good, are refused.`,
    parameters: object(
      {
        documentIds: Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 200,
          description: "File IDs from list_documents.",
        }),
      },
      ["documentIds"],
    ),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const input = only(params, ["documentIds"], "trash_files");
      const documents = await filesIn(input.documentIds);
      for (const courseId of new Set(documents.map((document) => document.courseId))) {
        const all = await library.listDocuments({ courseId });
        const taking = documents.filter((document) => document.courseId === courseId).length;
        if (taking > 1 && taking === all.length)
          throw new LibraryError(
            "Folio won't empty a course from a chat. The student can remove its files, or the course, from its page.",
          );
      }
      const ids = documents.map((document) => document.id);
      return act(
        ids.length > ASK_ABOVE,
        { op: "trash_files", documentIds: ids },
        `Move ${ids.length} files to the Trash`,
      );
    },
  };

  const trashCourse: AgentTool = {
    name: "trash_course",
    label: "Move a course to the Trash",
    description: `Move ${wide ? "a course" : "this chat's course"}, with its files, notes, chats and study notes, to Folio's Trash, where it waits 30 days. It always waits for the student's Apply, and only one course per reply.`,
    parameters: object({ courseId: Type.String() }, ["courseId"]),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const input = only(params, ["courseId"], "trash_course");
      const course = await ownCourse(input.courseId);
      if (reply.coursesTrashed >= 1)
        throw new LibraryError(
          "Folio moves one course to the Trash per reply from a chat. The student can remove more from each course's page.",
        );
      reply.coursesTrashed++;
      const files = (await library.listDocuments({ courseId: course.id })).length;
      return act(
        true,
        { op: "trash_course", courseId: course.id },
        `Move the course “${course.name}” to the Trash, with its ${files} ${files === 1 ? "file" : "files"}, notes and chats`,
      );
    },
  };

  const editCategories: AgentTool = {
    name: "edit_categories",
    label: "Change categories",
    description:
      "Change the student's categories of course files, shared by every course, or how files are named. One change per call: add a category; edit one's name, plural, words that place new files in it, or naming pattern; reorder them; remove one no file is in (waits for Apply); or set the library's naming pattern. Patterns use {category}, {course}, {code}, {term}, {n}, {n:2} and {name}. A category's kind (what Folio does with its files) is chosen when it is added and can't change while files are in it.",
    parameters: object({
      add: object(
        {
          name: Type.String({ maxLength: 40 }),
          plural: Type.String({ maxLength: 40 }),
          kind: Type.String({
            description:
              "lecture (studied), recitation (studied as practice, paired by number), assignment (on the board), solution, or asset (kept as files).",
          }),
          match: Type.Array(Type.String({ maxLength: 40 }), { maxItems: 20 }),
          naming: Type.String({ maxLength: 120 }),
        },
        ["name", "kind"],
      ),
      edit: object(
        {
          id: Type.String(),
          name: Type.String({ maxLength: 40 }),
          plural: Type.String({ maxLength: 40 }),
          match: Type.Array(Type.String({ maxLength: 40 }), { maxItems: 20 }),
          naming: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
        },
        ["id"],
      ),
      order: Type.Array(Type.String(), { description: "Every category ID, in the new order." }),
      remove: Type.String({ description: "The ID of a category no file is in." }),
      naming: Type.Union([Type.String({ maxLength: 120 }), Type.Null()], {
        description: "The library's naming pattern; null keeps files' own names.",
      }),
    }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const input = only(params, ["add", "edit", "order", "remove", "naming"], "edit_categories");
      const keys = Object.keys(input);
      if (keys.length !== 1) throw new LibraryError("Make one change per call.");
      const current = app.categories();
      const documents = await library.listDocuments();
      const following = (inCategory?: (category: Category) => boolean) =>
        documents.filter(
          (document) =>
            document.named === "pattern" &&
            (!inCategory || inCategory(categoryOf(document, current))),
        ).length;
      if ("naming" in input) {
        const followers = following((category) => category.naming === null);
        return act(
          followers > ASK_ABOVE,
          { op: "library_settings", naming: input.naming as string | null },
          input.naming
            ? `Name files “${input.naming as string}”, renaming ${followers} that follow the pattern`
            : "Let files keep their own names",
        );
      }
      if ("order" in input) {
        const order = input.order as string[];
        if (
          !Array.isArray(order) ||
          order.length !== current.length ||
          !current.every((each) => order.includes(each.id))
        )
          throw new LibraryError("List every category ID once, in the new order.");
        return act(
          false,
          {
            op: "library_settings",
            categories: order.map((id) => current.find((each) => each.id === id)!),
          },
          "",
        );
      }
      if ("remove" in input) {
        const removed = category(input.remove);
        const used = documents.filter(
          (document) => categoryOf(document, current).id === removed.id,
        );
        if (used.length)
          throw new LibraryError(
            `${used.length} ${used.length === 1 ? "file is" : "files are"} in ${removed.plural}. Move them to another category first.`,
          );
        return act(
          true,
          {
            op: "library_settings",
            categories: current.filter((each) => each.id !== removed.id),
          },
          `Remove the category “${removed.plural}”`,
        );
      }
      if ("add" in input) {
        const add = input.add as Record<string, unknown>;
        const name = text(add.name, "a name", 40)!;
        const added: Category = {
          id: categoryId(
            name,
            current.map((each) => each.id),
          ),
          name,
          plural: text(add.plural, "a plural", 40) ?? `${name}s`,
          kind: add.kind as Category["kind"],
          match: ((add.match as string[] | undefined) ?? [])
            .map((word) => word.trim())
            .filter(Boolean),
          naming: (add.naming as string | undefined)?.trim() || null,
        };
        return act(false, { op: "library_settings", categories: [...current, added] }, "");
      }
      const edit = input.edit as Record<string, unknown>;
      const before = category(edit.id);
      const after: Category = {
        ...before,
        ...(edit.name !== undefined ? { name: text(edit.name, "a name", 40)! } : {}),
        ...(edit.plural !== undefined ? { plural: text(edit.plural, "a plural", 40)! } : {}),
        ...(edit.match !== undefined
          ? { match: (edit.match as string[]).map((word) => word.trim()).filter(Boolean) }
          : {}),
        ...(edit.naming !== undefined
          ? { naming: (edit.naming as string | null)?.trim() || null }
          : {}),
      };
      const followers = following((category) => category.id === before.id);
      const renames = after.naming !== before.naming || after.name !== before.name ? followers : 0;
      return act(
        renames > ASK_ABOVE,
        {
          op: "library_settings",
          categories: current.map((each) => (each.id === before.id ? after : each)),
        },
        `Change “${before.plural}”, renaming ${followers} files that follow its pattern`,
      );
    },
  };

  const setModel: AgentTool = {
    name: "set_model",
    label: "Choose a step's model",
    description: `Choose which model does one of Folio's steps, written as connection/model (such as chatgpt/gpt-6.1-sol). Steps: ${MODEL_ROLES.map((step) => `${step} (${STEP_NAMES[step]})`).join(", ")}. It always waits for the student's Apply.`,
    parameters: object(
      {
        step: Type.String(),
        model: Type.String({ description: "connection/model, such as chatgpt/gpt-6.1-terra." }),
      },
      ["step", "model"],
    ),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const input = only(params, ["step", "model"], "set_model");
      if (!MODEL_ROLES.includes(input.step as ModelRole))
        throw new LibraryError(`Use one of these steps: ${MODEL_ROLES.join(", ")}.`);
      if (typeof input.model !== "string" || !/^[a-z-]+\/\S+$/.test(input.model))
        throw new LibraryError("Write the model as connection/model, such as chatgpt/gpt-6.1-sol.");
      const step = input.step as ModelRole;
      return act(
        true,
        { op: "set_model", step, model: input.model, expect: app.roles()[step] },
        `${STEP_NAMES[step]}: use ${input.model} instead of ${app.roles()[step]}`,
      );
    },
  };

  const study: AgentTool = {
    name: "study",
    label: "Study files",
    description: `Start studying lectures or recitations in ${where} (Folio writes study notes from them, in the background), or stop studying them.`,
    parameters: object(
      {
        documentIds: Type.Array(Type.String(), { minItems: 1, maxItems: 40 }),
        start: Type.Boolean({ description: "True to study them, false to stop." }),
      },
      ["documentIds", "start"],
    ),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const input = only(params, ["documentIds", "start"], "study");
      const documents = await filesIn(input.documentIds);
      const courses = new Set(documents.map((document) => document.courseId));
      if (courses.size > 1) throw new LibraryError("Study one course's files at a time.");
      const notStudied = documents.find((document) => !studied(document));
      if (notStudied)
        throw new LibraryError(
          `“${notStudied.title}” isn't in a studied category; Folio studies lectures and recitations in PDF.`,
        );
      return act(
        false,
        {
          op: "study",
          courseId: [...courses][0]!,
          documentIds: documents.map((document) => document.id),
          start: input.start === true,
        },
        "",
      );
    },
  };

  return [editCourse, editFiles, addFile, trashFiles, trashCourse, editCategories, setModel, study];
}
