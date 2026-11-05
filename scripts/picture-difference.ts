// Whether a retaken README picture shows something the kept one doesn't. `vp run screenshots`
// replaces a picture only then; the rule lives here, apart from the script, so it can be tested.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";

/**
 * Chromium draws the same page a few values apart from one version to the next. A retaken
 * picture counts as the same while at most SPECKS of its pixels differ by more than NOISE in a
 * colour channel; a change anyone could see moves far more pixels, far further.
 */
export const NOISE = 8;
export const SPECKS = 50;

/** A picture's pixels, four values (red, green, blue, alpha) each, as a canvas gives them. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Whether `after` looks different from `before`. The pictures are opaque, so alpha is skipped. */
export function differs(before: Pixels, after: Pixels): boolean {
  if (before.width !== after.width || before.height !== after.height) return true;
  let specks = 0;
  for (let index = 0; index < before.data.length; index += 4)
    for (let channel = index; channel < index + 3; channel++)
      if (Math.abs(before.data[channel]! - after.data[channel]!) > NOISE) {
        if (++specks > SPECKS) return true;
        break;
      }
  return false;
}

async function pixels(file: string): Promise<Pixels> {
  const image = await loadImage(await readFile(file));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height);
}

/** Whether the picture just taken looks different from the one kept, or there is none kept. */
export async function looksDifferent(kept: string, taken: string): Promise<boolean> {
  if (!existsSync(kept)) return true;
  const [before, after] = await Promise.all([pixels(kept), pixels(taken)]);
  return differs(before, after);
}
