import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { withDocumentsFrom, withoutDocuments } from "../kb/knowledge.ts";
import type { KnowledgeStore } from "../kb/store.ts";
import { historyFile } from "../notes.ts";
import type { SessionStore } from "../session-store.ts";
import type { CourseNotes } from "./notes.ts";
import { LibraryError, type LibraryStore } from "./store.ts";
import type { Trash, TrashEntry } from "./trash.ts";

/**
 * What removing something means in Folio. Each item moves into the Trash with what belongs to
 * it — a note with Folio's pending edits for it, a course with its files, notes, chats and
 * study notes — and comes back the same way. Removing a studied file also takes its study notes
 * out of the course (a new version), and restoring the file brings them back. A file being
 * studied stops being studied before it moves; a chat that is replying does not move.
 */
export interface RemovalOptions {
  library: LibraryStore;
  notes: CourseNotes;
  sessions: SessionStore;
  trash: Trash;
  knowledge?: KnowledgeStore;
  /**
   * Stops and forgets the studies of these documents, or of every file in this course, and
   * resolves once nothing is reading or publishing them any more.
   */
  stopStudying?: (scope: { documentIds: string[] } | { courseId: string }) => Promise<void>;
  /** Closes these chats, refusing if one is replying. */
  releaseChats?: (ids: string[]) => Promise<void>;
  /** Clears the job history of a removed course. */
  forgetJobs?: (courseId: string) => void;
}

export class Removal {
  readonly #options: RemovalOptions;

  constructor(options: RemovalOptions) {
    this.#options = options;
  }

  async removeDocument(id: string): Promise<TrashEntry> {
    const { library, trash, knowledge } = this.#options;
    const document = await library.document(id);
    await this.#options.stopStudying?.({ documentIds: [id] });
    const course = await library.course(document.courseId);
    const studied = (await knowledge?.knowledge(course.id))?.sessions.some(
      (session) => session.documentId === id,
    );
    const generation = studied ? knowledge!.current(course.id)!.generation : null;
    const entry = await trash.put({
      kind: "document",
      title: document.title,
      courseId: course.id,
      courseName: course.name,
      paths: [library.documentDirectory(id)],
      ...(generation ? { knowledge: { courseId: course.id, generation, documentIds: [id] } } : {}),
    });
    if (generation)
      try {
        await knowledge!.revise(
          course.id,
          (current) => withoutDocuments(current, [id]),
          `Removed ${document.title}`,
        );
      } catch (error) {
        await trash.restore(entry.id).catch(() => {});
        throw error;
      }
    return entry;
  }

  async removeNote(id: string): Promise<TrashEntry> {
    const { library, notes, trash } = this.#options;
    const note = await notes.read(id);
    const course = await library.course(note.courseId);
    const directory = library.courseDirectory(course.id);
    const history = historyFile(resolve(directory, "notes", `${id}.md`));
    // Folio's pending edits for the note go with it and come back with it.
    const pending = (await notes.listProposals(course.id)).filter(
      (proposal) => proposal.noteId === id && proposal.state === "pending",
    );
    return trash.put({
      kind: "note",
      title: note.title,
      courseId: course.id,
      courseName: course.name,
      paths: [
        resolve(directory, "notes", `${id}.md`),
        // Its earlier versions go with it, when it has any.
        ...((await lstat(history).catch(() => null)) ? [history] : []),
        ...pending.map((proposal) => resolve(directory, "proposals", `${proposal.id}.json`)),
      ],
    });
  }

  async removeChat(id: string): Promise<TrashEntry> {
    const { library, sessions, trash } = this.#options;
    const chat = (await sessions.list()).find((summary) => summary.id === id);
    if (!chat) throw new LibraryError("That chat is no longer in Folio.");
    await this.#options.releaseChats?.([id]);
    const courseId =
      chat.scope.courseId && chat.scope.courseId !== "demo" ? chat.scope.courseId : null;
    const course = courseId ? await library.course(courseId).catch(() => null) : null;
    return trash.put({
      kind: "chat",
      title: chat.title,
      courseId: course?.id ?? null,
      courseName: course?.name ?? null,
      paths: [resolve(sessions.directory, `${id}.json`)],
    });
  }

  async removeCourse(id: string): Promise<TrashEntry> {
    const { library, notes, sessions, trash, knowledge } = this.#options;
    const course = await library.course(id);
    await this.#options.stopStudying?.({ courseId: id });
    const documents = await library.listDocuments({ courseId: id });
    const chats = (await sessions.list()).filter((summary) => summary.scope.courseId === id);
    const noteCount = (await notes.list(id)).length;
    await this.#options.releaseChats?.(chats.map((chat) => chat.id));
    knowledge?.release(id);
    const entry = await trash.put({
      kind: "course",
      title: course.name,
      courseId: id,
      courseName: course.name,
      contents: { documents: documents.length, notes: noteCount, chats: chats.length },
      paths: [
        library.courseDirectory(id),
        ...documents.map((document) => library.documentDirectory(document.id)),
        ...chats.map((chat) => resolve(sessions.directory, `${chat.id}.json`)),
      ],
    });
    this.#options.forgetJobs?.(id);
    return entry;
  }

  /** Puts an entry back; a removed file's study notes come back into its course. */
  async restore(entryId: string): Promise<TrashEntry> {
    const { library, trash, knowledge } = this.#options;
    const entry = (await trash.list()).find((item) => item.id === entryId);
    if (!entry) throw new LibraryError("That is no longer in the Trash.");
    if (entry.kind !== "course" && entry.courseId) {
      const course = await library.course(entry.courseId).catch(() => null);
      if (!course)
        throw new LibraryError(
          `${entry.courseName ?? "Its course"} is in the Trash too. Restore the course first.`,
        );
    }
    await trash.restore(entryId);
    if (entry.knowledge && knowledge) {
      const { courseId, generation, documentIds } = entry.knowledge;
      const earlier = await knowledge.knowledgeAt(courseId, generation);
      if (earlier)
        await knowledge.revise(
          courseId,
          (current) => withDocumentsFrom(current, earlier, documentIds),
          `Restored ${entry.title}`,
        );
    }
    return entry;
  }
}
