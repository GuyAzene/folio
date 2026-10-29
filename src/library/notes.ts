import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { privateDirectory, writeAtomic } from "../files.ts";
import {
  MISSING_NOTE,
  NoteConflictError,
  readNoteFile,
  readNoteHistory,
  writeNoteFile,
  type NoteAuthor,
  type NoteFile,
  type NoteHistoryEntry,
} from "../notes.ts";
import { checkId, LibraryError, type LibraryStore } from "./store.ts";
import { linkFirstMention, matchNote, type Mention, mentionsOf } from "./note-meta.ts";

export interface CourseNote extends NoteFile {
  id: string;
  courseId: string;
  title: string;
}

export const PROPOSAL_STATES = ["pending", "kept", "inserted", "discarded"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];
export type ProposalAction = "keep" | "insert" | "discard";

/**
 * An edit Folio drafted for one of the student's notes. Drafting writes nothing; the student
 * keeps, inserts or discards it, and keeping applies only to the version it was drafted from.
 */
export interface ProposalRecord {
  version: 1;
  id: string;
  courseId: string;
  chatId: string;
  /** Null when Folio proposes a new note. */
  noteId: string | null;
  /** The new note's title. */
  title: string | null;
  /** The note's revision when the edit was drafted. */
  baseRevision: string | null;
  /** The passage to replace; null adds the text at the end. */
  find: string | null;
  text: string;
  reason: string;
  state: ProposalState;
  createdAt: string;
  resolvedAt: string | null;
  /** The note the student kept the edit in. */
  resultNoteId: string | null;
}

export interface ProposalInput {
  noteId?: string | null;
  title?: string | null;
  find?: string | null;
  text: string;
  reason?: string;
}

export class ProposalStaleError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROPOSAL_CHARACTERS = 20_000;
const STALE = "Your note changed after Folio drafted this edit. Nothing was changed.";

/** A note's title is its first line, without a Markdown heading mark. */
export function noteTitle(content: string): string {
  const line = content.split("\n").find((candidate) => candidate.trim()) ?? "";
  return (
    line
      .replace(/^#{1,6}\s+/, "")
      .trim()
      .slice(0, 120) || "Untitled note"
  );
}

/** `[[Old]]` and `[[Old|shown text]]` links point at the new title; nothing else changes. */
export function relinkTitle(content: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(
    new RegExp(`\\[\\[\\s*${escaped}\\s*(\\|[^\\]]*)?\\]\\]`, "giu"),
    (_match, shown: string | undefined) => `[[${to}${shown ?? ""}]]`,
  );
}

export function appended(content: string, text: string): string {
  if (!content.trim()) return `${text.trim()}\n`;
  return `${content.replace(/\s*$/, "")}\n\n${text.trim()}\n`;
}

function occurrences(content: string, passage: string): number {
  let count = 0;
  for (let at = content.indexOf(passage); at !== -1; at = content.indexOf(passage, at + 1)) count++;
  return count;
}

function validProposal(value: unknown): value is ProposalRecord {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const id = (candidate: unknown) => typeof candidate === "string" && UUID.test(candidate);
  const optional = (candidate: unknown) => candidate === null || typeof candidate === "string";
  return (
    p.version === 1 &&
    id(p.id) &&
    id(p.courseId) &&
    id(p.chatId) &&
    (p.noteId === null || id(p.noteId)) &&
    optional(p.title) &&
    optional(p.baseRevision) &&
    optional(p.find) &&
    typeof p.text === "string" &&
    typeof p.reason === "string" &&
    PROPOSAL_STATES.includes(p.state as ProposalState) &&
    typeof p.createdAt === "string" &&
    optional(p.resolvedAt) &&
    (p.resultNoteId === null || id(p.resultNoteId))
  );
}

/**
 * The student's Markdown notes, one file per note under the course's `notes/` folder, plus the
 * edits Folio has proposed for them. Saves are revision-checked so edits made in other apps are
 * never overwritten.
 */
export class CourseNotes {
  readonly #library: LibraryStore;

  constructor(library: LibraryStore) {
    this.#library = library;
  }

  async list(courseId?: string): Promise<CourseNote[]> {
    const courses = courseId
      ? [await this.#library.course(courseId)]
      : await this.#library.listCourses();
    const notes: CourseNote[] = [];
    for (const course of courses) {
      const directory = await this.#directory(course.id, "notes");
      for (const name of await readdir(directory)) {
        const id = name.replace(/\.md$/, "");
        if (!name.endsWith(".md") || !UUID.test(id)) continue;
        try {
          notes.push(await this.#read(course.id, id));
        } catch {
          // Unreadable notes are preserved on disk and simply not listed.
        }
      }
    }
    return notes.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  async read(noteId: string): Promise<CourseNote> {
    return this.#read(await this.#courseOf(noteId), noteId);
  }

  async create(courseId: string, title: string, content = ""): Promise<CourseNote> {
    await this.#library.course(courseId);
    const heading = title.replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled note";
    const id = randomUUID();
    await writeNoteFile(
      resolve(await this.#directory(courseId, "notes"), `${id}.md`),
      appended(`# ${heading}\n`, content),
      MISSING_NOTE,
    );
    return this.#read(courseId, id);
  }

  /** Saves the note from `expectedRevision`; the version it replaces is kept for undo. */
  async save(
    noteId: string,
    content: string,
    expectedRevision: string,
    author: NoteAuthor = { kind: "student" },
    /** Keep the replaced version however recently the student saved. */
    always = false,
  ): Promise<CourseNote> {
    const courseId = await this.#courseOf(noteId);
    await writeNoteFile(this.#file(courseId, noteId), content, expectedRevision, author, always);
    return this.#read(courseId, noteId);
  }

  /** The note's earlier versions, newest first. */
  async history(noteId: string): Promise<NoteHistoryEntry[]> {
    const courseId = await this.#courseOf(noteId);
    return (await readNoteHistory(this.#file(courseId, noteId))).reverse();
  }

  /**
   * Brings back an earlier version as a new one, so the version it replaces can itself be
   * brought back. Refused when the note changed since `expectedRevision`.
   */
  async restore(
    noteId: string,
    revision: string,
    expectedRevision: string,
    author: NoteAuthor = { kind: "student" },
  ): Promise<CourseNote> {
    const earlier = (await this.history(noteId)).find((entry) => entry.revision === revision);
    if (!earlier) throw new LibraryError("That version of the note is no longer kept.");
    // A restore is always kept, so it can itself be undone.
    return this.save(noteId, earlier.content, expectedRevision, author, true);
  }

  /** The course's notes with this title, ignoring case and spacing. */
  async withTitle(courseId: string, title: string): Promise<CourseNote[]> {
    const key = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    return (await this.list(courseId)).filter((note) => key(note.title) === key(title));
  }

  /**
   * Renames a note by rewriting its first line, the title, then rewrites `[[Old title]]` links
   * in the course's other notes, each from the version it has now. Returns the renamed note and
   * the notes whose links changed.
   */
  async rename(
    noteId: string,
    title: string,
    expectedRevision: string,
    author: NoteAuthor = { kind: "student" },
  ): Promise<{ note: CourseNote; relinked: CourseNote[] }> {
    const current = await this.read(noteId);
    const heading = title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!heading) throw new LibraryError("Give the note a title.");
    const lines = current.content.split("\n");
    const first = lines.findIndex((line) => line.trim());
    if (first === -1) lines.unshift(`# ${heading}`);
    else lines[first] = `# ${heading}`;
    const note = await this.save(noteId, lines.join("\n"), expectedRevision, author);
    const old = current.title;
    const relinked: CourseNote[] = [];
    if (old !== heading)
      for (const other of await this.list(current.courseId)) {
        if (other.id === noteId) continue;
        const next = relinkTitle(other.content, old, heading);
        if (next !== other.content)
          relinked.push(await this.save(other.id, next, other.revision, author));
      }
    return { note, relinked };
  }

  /** Notes matching a search, best first, then most recently changed. */
  async search(query: string, courseId?: string): Promise<{ note: CourseNote; snippet: string }[]> {
    const found = (await this.list(courseId)).flatMap((note) => {
      const match = matchNote(note.content, note.title, query);
      return match ? [{ note, ...match }] : [];
    });
    return found
      .sort(
        (a, b) =>
          b.score - a.score || (b.note.updatedAt ?? "").localeCompare(a.note.updatedAt ?? ""),
      )
      .map(({ note, snippet }) => ({ note, snippet }));
  }

  /** The course's other notes that link to this one or name it in plain text. */
  async mentions(
    noteId: string,
  ): Promise<{ note: CourseNote; linked: Mention[]; unlinked: Mention[] }[]> {
    const target = await this.read(noteId);
    return (await this.list(target.courseId)).flatMap((note) => {
      if (note.id === noteId) return [];
      const found = mentionsOf(note.content, target.title);
      return found.linked.length || found.unlinked.length ? [{ note, ...found }] : [];
    });
  }

  /** Links the first plain mention of `targetId`'s title in `sourceId`, from `expectedRevision`. */
  async linkMention(
    sourceId: string,
    targetId: string,
    expectedRevision: string,
  ): Promise<CourseNote> {
    const [source, target] = await Promise.all([this.read(sourceId), this.read(targetId)]);
    if (source.courseId !== target.courseId)
      throw new LibraryError("Notes link only within their course.");
    const next = linkFirstMention(source.content, target.title);
    if (next === null)
      throw new LibraryError(`“${source.title}” no longer mentions “${target.title}”.`);
    return this.save(sourceId, next, expectedRevision);
  }

  /** Adds text at the end of the note as it is now; nothing already there is replaced. */
  async append(noteId: string, text: string): Promise<CourseNote> {
    const current = await this.read(noteId);
    return this.save(noteId, appended(current.content, text), current.revision);
  }

  async listProposals(courseId?: string): Promise<ProposalRecord[]> {
    const courses = courseId
      ? [await this.#library.course(courseId)]
      : await this.#library.listCourses();
    const proposals: ProposalRecord[] = [];
    for (const course of courses) {
      const directory = await this.#directory(course.id, "proposals");
      for (const name of await readdir(directory)) {
        if (!name.endsWith(".json") || !UUID.test(name.replace(/\.json$/, ""))) continue;
        try {
          const value: unknown = JSON.parse(await readFile(resolve(directory, name), "utf8"));
          if (validProposal(value) && value.courseId === course.id) proposals.push(value);
        } catch {
          // Unreadable proposals are preserved on disk and simply not listed.
        }
      }
    }
    return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async proposal(id: string): Promise<ProposalRecord> {
    checkId(id);
    const found = (await this.listProposals()).find((proposal) => proposal.id === id);
    if (!found) throw new LibraryError("That suggested edit no longer exists.");
    return found;
  }

  /** Records a proposed edit after checking it against the course and the note. Writes no note. */
  async propose(courseId: string, chatId: string, input: ProposalInput): Promise<ProposalRecord> {
    checkId(chatId);
    await this.#library.course(courseId);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw new LibraryError("A suggested edit needs text.");
    if (text.length > MAX_PROPOSAL_CHARACTERS)
      throw new LibraryError("A suggested edit can be at most 20,000 characters.");
    const reason = (input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    let noteId: string | null = null;
    let baseRevision: string | null = null;
    let find: string | null = null;
    let title: string | null = null;
    if (input.noteId) {
      checkId(input.noteId);
      if ((await this.#courseOf(input.noteId).catch(() => null)) !== courseId)
        throw new LibraryError("That note is not in this course.");
      const note = await this.#read(courseId, input.noteId);
      noteId = note.id;
      baseRevision = note.revision;
      if (input.find) {
        if (occurrences(note.content, input.find) !== 1)
          throw new LibraryError(
            "The passage to replace must appear exactly once in the note. Read the note again and quote it exactly.",
          );
        find = input.find;
      }
    } else {
      if (input.find) throw new LibraryError("A new note has no passage to replace.");
      title = (input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled note";
    }
    const proposal: ProposalRecord = {
      version: 1,
      id: randomUUID(),
      courseId,
      chatId,
      noteId,
      title,
      baseRevision,
      find,
      text,
      reason,
      state: "pending",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resultNoteId: null,
    };
    await writeAtomic(await this.#proposalFile(proposal), `${JSON.stringify(proposal, null, 2)}\n`);
    return proposal;
  }

  /** Whether the note changed since the edit was drafted, so keeping it is no longer safe. */
  async stale(proposal: ProposalRecord): Promise<boolean> {
    if (proposal.state !== "pending" || !proposal.noteId) return false;
    const note = await this.read(proposal.noteId).catch(() => undefined);
    return note?.revision !== proposal.baseRevision;
  }

  /**
   * Keep applies the edit only to the version it was drafted from. Insert adds the drafted text
   * below the note as it is now, replacing nothing. Each proposal is resolved once.
   */
  async resolve(id: string, action: ProposalAction): Promise<ProposalRecord> {
    const proposal = await this.proposal(id);
    const file = await this.#proposalFile(proposal);
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(file, { realpath: false, retries: 3, stale: 10_000 });
    } catch {
      throw new LibraryError("This suggested edit is being resolved elsewhere. Try again.");
    }
    try {
      const current = await this.proposal(id);
      if (current.state !== "pending")
        throw new LibraryError("This suggested edit was already resolved.");
      let resultNoteId: string | null = null;
      if (action === "keep" || action === "insert") {
        if (!current.noteId) {
          resultNoteId = (await this.create(current.courseId, current.title ?? "", current.text))
            .id;
        } else if (action === "insert") {
          resultNoteId = (await this.append(current.noteId, current.text)).id;
        } else {
          const note = await this.read(current.noteId);
          if (note.revision !== current.baseRevision) throw new ProposalStaleError(STALE);
          const next =
            current.find === null
              ? appended(note.content, current.text)
              : note.content.replace(current.find, () => current.text);
          try {
            resultNoteId = (await this.save(note.id, next, note.revision)).id;
          } catch (error) {
            if (error instanceof NoteConflictError) throw new ProposalStaleError(STALE);
            throw error;
          }
        }
      }
      const resolved: ProposalRecord = {
        ...current,
        state: action === "keep" ? "kept" : action === "insert" ? "inserted" : "discarded",
        resolvedAt: new Date().toISOString(),
        resultNoteId,
      };
      await writeAtomic(file, `${JSON.stringify(resolved, null, 2)}\n`);
      return resolved;
    } finally {
      await release();
    }
  }

  async #read(courseId: string, noteId: string): Promise<CourseNote> {
    const note = await readNoteFile(this.#file(courseId, noteId));
    if (note.revision === MISSING_NOTE) throw new LibraryError("That note no longer exists.");
    return { ...note, id: noteId, courseId, title: noteTitle(note.content) };
  }

  async #courseOf(noteId: string): Promise<string> {
    checkId(noteId);
    for (const course of await this.#library.listCourses()) {
      const note = await readNoteFile(this.#file(course.id, noteId)).catch(() => undefined);
      if (note && note.revision !== MISSING_NOTE) return course.id;
    }
    throw new LibraryError("That note no longer exists.");
  }

  #file(courseId: string, noteId: string): string {
    checkId(noteId);
    return resolve(this.#library.courseDirectory(courseId), "notes", `${noteId}.md`);
  }

  async #proposalFile(proposal: Pick<ProposalRecord, "id" | "courseId">): Promise<string> {
    checkId(proposal.id);
    return resolve(await this.#directory(proposal.courseId, "proposals"), `${proposal.id}.json`);
  }

  async #directory(courseId: string, name: "notes" | "proposals"): Promise<string> {
    const directory = resolve(this.#library.courseDirectory(courseId), name);
    await privateDirectory(directory, "library", LibraryError);
    return directory;
  }
}
