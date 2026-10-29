import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vite-plus/test";
import { prepareImage } from "../src/library/images.ts";

/** A synthetic drawing, encoded as the student's screenshot or photo would be. */
function drawing(width: number, height: number, format: "png" | "jpeg" | "webp"): Uint8Array {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#2b59c3";
  context.fillRect(width / 4, height / 4, width / 2, height / 2);
  const bytes = format === "png" ? canvas.encodeSync("png") : canvas.encodeSync(format, 90);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe("images the student adds", () => {
  it.each(["png", "jpeg", "webp"] as const)(
    "re-encodes a %s as a JPEG and a thumbnail",
    async (format) => {
      const prepared = await prepareImage(drawing(3200, 1600, format));
      expect([...prepared.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      const full = await loadImage(prepared.data);
      expect([full.width, full.height]).toEqual([1600, 800]);
      const thumbnail = await loadImage(prepared.thumbnail);
      expect(Math.max(thumbnail.width, thumbnail.height)).toBe(240);
    },
  );

  it("keeps a small image at its size, and puts transparency on white", async () => {
    const prepared = await prepareImage(drawing(320, 200, "png"));
    const image = await loadImage(prepared.data);
    expect([image.width, image.height]).toEqual([320, 200]);
    const canvas = createCanvas(image.width, image.height);
    canvas.getContext("2d").drawImage(image, 0, 0);
    const corner = canvas.getContext("2d").getImageData(0, 0, 1, 1).data;
    expect(corner[0]).toBeGreaterThan(240);
  });

  it("refuses anything that is not a PNG, JPEG, WebP or GIF image", async () => {
    await expect(prepareImage(new TextEncoder().encode("%PDF-1.7 not an image"))).rejects.toThrow(
      "PNG, JPEG, WebP and GIF",
    );
    await expect(
      prepareImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).rejects.toThrow("PNG, JPEG, WebP and GIF");
    const broken = drawing(64, 64, "png").slice(0, 40);
    await expect(prepareImage(broken)).rejects.toThrow("couldn't read");
    await expect(prepareImage(new Uint8Array(21 * 1024 * 1024))).rejects.toThrow("too large");
  });
});
