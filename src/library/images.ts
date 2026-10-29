import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";

/** An image the student added to a question, ready to send to the tutor and to show in the chat. */
export interface PreparedImage {
  /** JPEG for the tutor, at most 1600 pixels on its longer side. */
  data: Uint8Array;
  /** A small JPEG for the question in the chat. */
  thumbnail: Uint8Array;
}

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const LONG_EDGE = 1600;
const THUMBNAIL_EDGE = 240;

/**
 * Decodes a PNG, JPEG, WebP or GIF the student added and re-encodes it as JPEG. Anything else
 * is refused before it is decoded. Re-encoding also drops metadata, such as where a photo was
 * taken, before the image is saved in the chat or sent.
 */
export async function prepareImage(bytes: Uint8Array): Promise<PreparedImage> {
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    throw new Error("That image is too large. Folio takes images up to 20 MB.");
  if (!knownFormat(bytes)) throw new Error("Folio can read PNG, JPEG, WebP and GIF images.");
  const image = await loadImage(bytes).catch(() => {
    throw new Error("Folio couldn't read that image.");
  });
  if (!image.width || !image.height) throw new Error("Folio couldn't read that image.");
  return { data: jpegOf(image, LONG_EDGE, 85), thumbnail: jpegOf(image, THUMBNAIL_EDGE, 80) };
}

function jpegOf(image: Image, edge: number, quality: number): Uint8Array {
  const scale = Math.min(1, edge / Math.max(image.width, image.height));
  const canvas = createCanvas(
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  );
  // JPEG has no transparency: a screenshot with a transparent background goes on white.
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const jpeg = canvas.encodeSync("jpeg", quality);
  return new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
}

function knownFormat(bytes: Uint8Array): boolean {
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  return (
    starts(0x89, 0x50, 0x4e, 0x47) || // PNG
    starts(0xff, 0xd8, 0xff) || // JPEG
    starts(0x47, 0x49, 0x46, 0x38) || // GIF
    (starts(0x52, 0x49, 0x46, 0x46) && // WebP: RIFF....WEBP
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50)
  );
}
