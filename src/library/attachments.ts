import type { Grants, SendExtras } from "../conversation.ts";
import type { AttachmentInput } from "../desktop/api.ts";
import { prepareImage, type PreparedImage } from "./images.ts";
import { jpeg, type PageReader } from "./page-reader.ts";
import { LibraryError, type DocumentRecord, type LibraryStore } from "./store.ts";

/** Where a question is asked: a course chat (its course, plus what was added) or a library chat. */
export interface AttachReach {
  /** Null for a library chat, which may read any course. */
  courseId: string | null;
  grants: Grants;
}

export type ResolvedAttachment = NonNullable<SendExtras["attachments"]>[number];

export interface AttachOptions {
  prepare?: (bytes: Uint8Array) => Promise<PreparedImage>;
  /** Whether Folio has studied a course, so the tutor knows how to read one that was added. */
  studied?: (courseId: string) => boolean;
}

/**
 * Checks what the student added to a question against the library and the chat, and turns each
 * item into what is saved and what the tutor is told. Pages must be readable in the chat
 * (courses and lectures added in the same question count); images are decoded and re-encoded.
 * The tutor's note says how to read each item, so the chat's prompt never has to list them.
 */
export function createAttach(
  library: LibraryStore,
  pages: PageReader,
  { prepare = prepareImage, studied = () => false }: AttachOptions = {},
): (reach: AttachReach, inputs: AttachmentInput[]) => Promise<ResolvedAttachment[]> {
  async function documentOf(id: string): Promise<DocumentRecord> {
    return library.document(id).catch(() => {
      throw new LibraryError("That document is no longer in your library.");
    });
  }
  async function courseName(id: string): Promise<string> {
    return (await library.course(id).catch(() => null))?.name ?? "another course";
  }

  return async function attach(reach, inputs) {
    const grants: Grants = {
      courses: [
        ...reach.grants.courses,
        ...inputs.flatMap((input) => (input.kind === "course" ? [input.courseId] : [])),
      ],
      documents: [
        ...reach.grants.documents,
        ...inputs.flatMap((input) => (input.kind === "document" ? [input.documentId] : [])),
      ],
    };
    const readable = (document: DocumentRecord) =>
      reach.courseId === null ||
      document.courseId === reach.courseId ||
      grants.courses.includes(document.courseId) ||
      grants.documents.includes(document.id);

    const resolved: ResolvedAttachment[] = [];
    for (const input of inputs) {
      if (input.kind === "course") {
        if (input.courseId === reach.courseId) continue;
        const course = await library.course(input.courseId).catch(() => {
          throw new LibraryError("That course is no longer in your library.");
        });
        resolved.push({
          attachment: { kind: "course", courseId: course.id },
          note: `the course "${course.name}"${course.code ? ` (${course.code})` : ""}, courseId ${course.id} (${studied(course.id) ? "studied: search_course, read_sections and topic_map take this courseId" : "not studied yet: list_documents lists its documents, read them with read_page"})`,
        });
      } else if (input.kind === "document") {
        const document = await documentOf(input.documentId);
        resolved.push({
          attachment: { kind: "document", documentId: document.id },
          note: `"${document.title}" from "${await courseName(document.courseId)}"${document.pages ? `, ${document.pages} pages` : ""}, documentId ${document.id} (read it with read_page)`,
        });
      } else if (input.kind === "page") {
        const document = await documentOf(input.documentId);
        if (!readable(document)) throw new LibraryError("That page is not part of this chat.");
        if (document.kind !== "pdf" || input.page > (document.pages ?? 0))
          throw new LibraryError("That page is not in this document.");
        resolved.push({
          attachment: { kind: "page", documentId: document.id, page: input.page },
          note: `page ${input.page} of "${document.title}" (${await courseName(document.courseId)}), shown below as an image`,
          image: jpeg(await pages.image(document, input.page)),
        });
      } else {
        const prepared = await prepare(input.data);
        resolved.push({
          attachment: {
            kind: "image",
            name: input.name,
            thumbnail: Buffer.from(prepared.thumbnail).toString("base64"),
          },
          note: `an image of their own${input.name ? ` ("${input.name}")` : ""}, shown below`,
          image: jpeg(prepared.data),
        });
      }
    }
    return resolved;
  };
}
