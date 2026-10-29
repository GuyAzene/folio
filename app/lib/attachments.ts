import type { AttachmentInput, AttachmentView } from "../../src/desktop/api.ts";
import type { Added } from "./state.svelte.ts";

export const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;

/** One key per thing, so the same lecture, course or page is not added twice. */
export function attachmentKey(input: AttachmentInput): string {
  switch (input.kind) {
    case "page":
      return `page:${input.documentId}:${input.page}`;
    case "document":
      return `document:${input.documentId}`;
    case "course":
      return `course:${input.courseId}`;
    case "image":
      return `image:${crypto.randomUUID()}`;
  }
}

/** What the + menu picks: a page, lecture or course (images come from files). */
export type Picked = Exclude<AttachmentInput, { kind: "image" }>;

/** A page, lecture or course picked from the + menu. */
export function picked(input: Picked): Added {
  return { key: attachmentKey(input), input, view: { ...input } as AttachmentView };
}

/**
 * An image the student pasted, dropped or chose, with a small preview for the composer and the
 * question. The main process decodes and re-encodes it before anything is saved or sent.
 */
export async function imageAttachment(file: File): Promise<Added> {
  if (!IMAGE_TYPES.test(file.type))
    throw new Error("Folio can read PNG, JPEG, WebP and GIF images.");
  if (file.size > MAX_IMAGE_BYTES)
    throw new Error("That image is too large. Folio takes images up to 20 MB.");
  const [data, thumbnail] = await Promise.all([
    file.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    preview(file),
  ]);
  const input: AttachmentInput = { kind: "image", name: file.name, data };
  return { key: attachmentKey(input), input, view: { kind: "image", name: file.name, thumbnail } };
}

async function preview(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Folio couldn't read that image.");
  });
  const scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.8);
}
