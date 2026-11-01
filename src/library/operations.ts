import { basename } from "node:path";
import { withoutDocuments, type Knowledge } from "../kb/knowledge.ts";
import {
  categoriesInUse,
  categoriesProblem,
  categoryFor,
  categoryOf,
  guessCategory,
  namingProblem,
  type Category,
} from "./categories.ts";
import {
  applyPattern,
  nextNumber,
  numberFromName,
  titleFromName,
  uniqueTitle,
  type ImportItem,
  type NamingScope,
  type Rename,
} from "./naming.ts";

export type { ImportItem, NamingScope, Rename } from "./naming.ts";
import {
  checkId,
  DOCUMENT_ROLES,
  LibraryError,
  studied,
  type CourseInput,
  type CourseRecord,
  type DocumentPatch,
  type DocumentRecord,
  type DocumentRole,
  type LibraryStore,
} from "./store.ts";

export interface OperationsOptions {
  library: LibraryStore;
  /** The student's categories as config.json has them now. */
  categories(): Category[];
  /** Writes the categories to config.json. */
  saveCategories(categories: Category[]): Promise<void>;
  /** The library's naming pattern for categories without their own; null keeps files' names. */
  naming(): string | null;
  /** Writes the library's naming pattern to config.json. */
  saveNaming(pattern: string | null): Promise<void>;
  knowledge: {
    knowledge(courseId: string): Promise<Knowledge | null>;
    revise(
      courseId: string,
      change: (knowledge: Knowledge) => Knowledge,
      summary: string,
    ): Promise<unknown>;
  };
  /** Stops every study that reads this document, and waits until they have stopped. */
  withdraw(documentId: string): Promise<void>;
  /** Studies these documents after a moment in which a wrong category can still be fixed. */
  studySoon(courseId: string, documentIds: string[]): void;
  /** Gives new assignment documents their board cards. */
  syncAssignments(): void;
  /** Tells the window the library changed. */
  changed(): void;
}

export type Imported =
  | { name: string; document: DocumentRecord; duplicate: boolean }
  | { name: string; error: string };

/**
 * Every change to courses and files, with what follows from it: studying, study notes, the
 * board and names that follow a pattern. The window's controls and the tutor's tools both come
 * here, so neither can skip a step.
 */
export class LibraryOperations {
  readonly #options: OperationsOptions;

  constructor(options: OperationsOptions) {
    this.#options = options;
  }

  async createCourse(input: CourseInput): Promise<CourseRecord> {
    const course = await this.#options.library.createCourse(input);
    this.#options.changed();
    return course;
  }

  /**
   * Renames a course or changes its code, term or color. Its study notes keep their addresses,
   * and files named by a pattern that uses the course follow it.
   */
  async updateCourse(id: string, patch: CourseInput, revision: number): Promise<CourseRecord> {
    checkId(id);
    const course = await this.#options.library.updateCourse(id, patch, revision);
    await this.#follow({ courseId: id });
    this.#options.changed();
    return course;
  }

  /**
   * Saves the student's categories. A category some file is in can be renamed, reordered or
   * given new words, but it can't go or change its kind while the file is in it: that would
   * change what Folio does with the file behind the student's back. Files named by a pattern
   * follow a renamed category or a changed pattern.
   */
  async setCategories(next: Category[]): Promise<void> {
    const problem =
      categoriesProblem(next) ??
      categoriesInUse(
        this.#options.categories(),
        next,
        await this.#options.library.listDocuments(),
      );
    if (problem) throw new LibraryError(problem);
    await this.#options.saveCategories(next);
    await this.#follow({});
    this.#options.changed();
  }

  /** Sets the library's naming pattern; files already named by a pattern follow it. */
  async setNaming(pattern: string | null): Promise<void> {
    const clean = pattern?.trim() || null;
    const problem = namingProblem(clean);
    if (problem) throw new LibraryError(`${problem.charAt(0).toUpperCase()}${problem.slice(1)}.`);
    await this.#options.saveNaming(clean);
    await this.#follow({});
    this.#options.changed();
  }

  /**
   * Copies files into a course. Each goes in the category asked for, or else the one its name
   * points to; gets the number its name gives it, or the next in its category; and is named by
   * its category's pattern, when there is one. New lectures and recitations are studied after a
   * moment.
   */
  async importFiles(
    courseId: string,
    items: ImportItem[],
    into: { role?: DocumentRole; category?: string } = {},
  ): Promise<Imported[]> {
    checkId(courseId);
    if (into.role !== undefined && !DOCUMENT_ROLES.includes(into.role))
      throw new LibraryError("Unknown role.");
    const { library } = this.#options;
    const categories = this.#options.categories();
    const find = (id: string | undefined) =>
      id === undefined ? undefined : categories.find((category) => category.id === id);
    const chosen = into.category
      ? find(into.category)
      : into.role && categoryFor(into.role, categories);
    if (into.category && !chosen) throw new LibraryError("Unknown category.");
    const course = await library.course(courseId);
    const present = await library.listDocuments({ courseId });
    const results: Imported[] = [];
    const added: string[] = [];
    for (const item of items) {
      const file = typeof item === "string" ? { path: item } : item;
      const name = file.name ?? basename(file.path);
      try {
        const category =
          find(file.category) ??
          (chosen || guessCategory(name, /\.pdf$/i.test(name) ? "pdf" : "markdown", categories));
        if (file.category && category.id !== file.category)
          throw new LibraryError("Unknown category.");
        const number =
          file.number ??
          numberFromName(name, course.code) ??
          nextNumber(
            present
              .filter((other) => categoryOf(other, categories).id === category.id)
              .map((other) => other.number),
          );
        const pattern = this.#pattern(category);
        const title =
          file.title?.trim() ||
          (pattern &&
            uniqueTitle(
              applyPattern(pattern, values(course, category, number, name)),
              present.map((other) => other.title),
            ));
        const { document, duplicate } = await library.importFile(courseId, file.path, {
          ...(file.name ? { name: file.name } : {}),
          role: category.kind,
          category: category.id,
          number,
          ...(title ? { title } : {}),
          named: file.title?.trim() ? "own" : pattern ? "pattern" : "own",
        });
        results.push({ name, document, duplicate });
        if (!duplicate) {
          present.push(document);
          if (studied(document)) added.push(document.id);
        }
      } catch (error) {
        results.push({
          name,
          error: error instanceof Error && error.message ? error.message : "Something went wrong.",
        });
      }
    }
    this.#options.changed();
    this.#options.studySoon(courseId, added);
    this.#options.syncAssignments();
    return results;
  }

  /**
   * Renames a file, changes its number or category, moves it to another course or sets its due
   * date. A renamed file keeps its study notes, and so does one moved to another category of the
   * same kind; one that stops being studied, or leaves its course, loses them from that course,
   * and one that becomes a lecture or recitation is studied. A title given by hand is the file's
   * own from then on; a file named by its pattern follows its new number or category.
   */
  async updateDocument(
    id: string,
    change: DocumentPatch,
    revision: number,
  ): Promise<DocumentRecord> {
    checkId(id);
    const { library, knowledge } = this.#options;
    const before = await library.document(id);
    const patch = this.#categorized(before, change);
    if (patch.title !== undefined && patch.named === undefined) patch.named = "own";
    const moved = patch.courseId !== undefined && patch.courseId !== before.courseId;
    const after = { ...before, ...patch };
    // A lecture that stops being one, or leaves its course, stops being studied first, so
    // nothing reads it or publishes notes from it while it changes.
    const leaving = studied(before) && (!studied(after) || moved);
    if (leaving) await this.#options.withdraw(id);
    let document = await library.updateDocument(id, patch, revision);
    if (leaving) {
      const known = (await knowledge.knowledge(before.courseId))?.sessions.some(
        (session) => session.documentId === id,
      );
      if (known)
        await knowledge.revise(
          before.courseId,
          (current) => withoutDocuments(current, [id]),
          `${before.title} is no longer studied`,
        );
    }
    if (document.named === "pattern")
      document = (await this.#follow({ documentIds: [id] }))[0] ?? document;
    if (studied(document) && (!studied(before) || moved))
      this.#options.studySoon(document.courseId, [document.id]);
    if (document.role === "assignment" && before.role !== "assignment")
      this.#options.syncAssignments();
    this.#options.changed();
    return document;
  }

  /**
   * The files a pattern would rename: in the scope, with a pattern for their category, whose
   * name isn't already the one it gives.
   */
  async renames(scope: NamingScope): Promise<Rename[]> {
    const { library } = this.#options;
    const categories = this.#options.categories();
    const documents = await library.listDocuments({ courseId: scope.courseId });
    const courses = new Map<string, CourseRecord>();
    const titles = new Map<string, string[]>();
    for (const document of await library.listDocuments())
      titles.set(document.courseId, [...(titles.get(document.courseId) ?? []), document.title]);
    const inScope = documents
      .filter(
        (document) =>
          (!scope.categoryId || categoryOf(document, categories).id === scope.categoryId) &&
          (!scope.documentIds || scope.documentIds.includes(document.id)),
      )
      .sort(
        (a, b) => (a.number ?? 0) - (b.number ?? 0) || a.importedAt.localeCompare(b.importedAt),
      );
    const renames: Rename[] = [];
    for (const document of inScope) {
      const category = categoryOf(document, categories);
      const pattern = this.#pattern(category);
      if (!pattern) continue;
      let course = courses.get(document.courseId);
      if (!course) {
        course = await library.course(document.courseId);
        courses.set(course.id, course);
      }
      const taken = (titles.get(document.courseId) ?? []).filter(
        (title) => title !== document.title,
      );
      const next = uniqueTitle(
        applyPattern(
          pattern,
          values(course, category, document.number ?? null, document.originalName),
        ),
        taken,
      );
      // Later files in this rename see the name this one takes.
      titles.set(document.courseId, [...taken, next]);
      if (next !== document.title || document.named !== "pattern")
        renames.push({
          documentId: document.id,
          courseId: document.courseId,
          title: document.title,
          named: document.named ?? "own",
          next,
        });
    }
    return renames;
  }

  /**
   * Names the files in the scope by their category's pattern from now on. Returns what each was
   * called before, for Undo.
   */
  async applyNaming(scope: NamingScope): Promise<Rename[]> {
    const renames = await this.renames(scope);
    const done: Rename[] = [];
    for (const rename of renames)
      if (await this.#rename(rename.documentId, rename.next, "pattern")) done.push(rename);
    this.#options.changed();
    return done;
  }

  /** Puts back the names a pattern rename replaced, leaving any file renamed since as it is. */
  async undoNaming(renames: Rename[]): Promise<number> {
    let restored = 0;
    for (const rename of renames) {
      const document = await this.#options.library.document(rename.documentId).catch(() => null);
      if (!document || document.title !== rename.next) continue;
      if (await this.#rename(rename.documentId, rename.title, rename.named)) restored++;
    }
    this.#options.changed();
    return restored;
  }

  /**
   * Gives every file without a number one, once: the number its name gives it, or else the next
   * in its category of its course, in the order the files came in.
   */
  async numberAll(): Promise<number> {
    const { library } = this.#options;
    const categories = this.#options.categories();
    const documents = (await library.listDocuments()).sort((a, b) =>
      a.importedAt.localeCompare(b.importedAt),
    );
    const missing = documents.filter((document) => document.number === undefined);
    if (!missing.length) return 0;
    const codes = new Map<string, string>();
    for (const course of await library.listCourses()) codes.set(course.id, course.code);
    const group = (document: DocumentRecord) =>
      `${document.courseId}|${categoryOf(document, categories).id}`;
    const taken = new Map<string, (number | undefined)[]>();
    for (const document of documents)
      taken.set(group(document), [...(taken.get(group(document)) ?? []), document.number]);
    const numbers = new Map<string, number>();
    // Numbers from names first, so a file without one never takes a number another's name has.
    for (const document of missing) {
      const code = codes.get(document.courseId) ?? "";
      const named =
        numberFromName(document.title, code) ?? numberFromName(document.originalName, code);
      if (named === null) continue;
      numbers.set(document.id, named);
      taken.get(group(document))!.push(named);
    }
    for (const document of missing) {
      if (numbers.has(document.id)) continue;
      const next = nextNumber(taken.get(group(document))!);
      numbers.set(document.id, next);
      taken.get(group(document))!.push(next);
    }
    let numbered = 0;
    for (const document of missing) {
      try {
        await library.updateDocument(
          document.id,
          { number: numbers.get(document.id)! },
          document.revision,
        );
        numbered++;
      } catch {
        // Changed meanwhile: it gets its number at the next start.
      }
    }
    if (numbered) this.#options.changed();
    return numbered;
  }

  /** The pattern that names a category's files, or null when they keep their own names. */
  #pattern(category: Category): string | null {
    return category.naming ?? this.#options.naming();
  }

  /** Renames the files a pattern names whose name it would now change; returns them renamed. */
  async #follow(scope: NamingScope): Promise<DocumentRecord[]> {
    const renamed: DocumentRecord[] = [];
    for (const rename of await this.renames(scope)) {
      if (rename.named !== "pattern") continue;
      const document = await this.#rename(rename.documentId, rename.next, "pattern");
      if (document) renamed.push(document);
    }
    return renamed;
  }

  async #rename(
    id: string,
    title: string,
    named: "pattern" | "own",
  ): Promise<DocumentRecord | null> {
    try {
      const document = await this.#options.library.document(id);
      return await this.#options.library.updateDocument(id, { title, named }, document.revision);
    } catch {
      // Gone or changed meanwhile; a later change names it again.
      return null;
    }
  }

  /**
   * A change whose category and role agree: a category brings its kind as the role, and a role
   * alone moves the file to the first category of that kind, unless it is in one already.
   */
  #categorized(document: DocumentRecord, patch: DocumentPatch): DocumentPatch {
    const categories = this.#options.categories();
    if (patch.category !== undefined) {
      const category = categories.find((each) => each.id === patch.category);
      if (!category) throw new LibraryError("Unknown category.");
      return { ...patch, role: category.kind };
    }
    if (patch.role === undefined) return { ...patch };
    const current = categories.find((each) => each.id === document.category);
    return {
      ...patch,
      category: current?.kind === patch.role ? current.id : categoryFor(patch.role, categories).id,
    };
  }
}

/** What a pattern fills in for one file. */
function values(course: CourseRecord, category: Category, number: number | null, fileName: string) {
  return {
    category: category.name,
    course: course.name,
    code: course.code,
    term: course.term,
    number,
    name: titleFromName(fileName),
  };
}
