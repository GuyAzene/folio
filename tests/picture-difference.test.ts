import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  differs,
  looksDifferent,
  NOISE,
  type Pixels,
  SPECKS,
} from "../scripts/picture-difference.ts";

/** A synthetic picture of one grey, opaque. */
function picture(width = 40, height = 30, grey = 120): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set([grey, grey, grey, 255], index);
  return { width, height, data };
}

/** The same picture with `count` pixels moved by `by` in one channel. */
function speckled(base: Pixels, count: number, by = NOISE + 1, channel = 0): Pixels {
  const data = base.data.slice();
  for (let pixel = 0; pixel < count; pixel++) data[pixel * 4 + channel]! += by;
  return { ...base, data };
}

describe("whether a retaken README picture looks different", () => {
  it("keeps a picture drawn the same, or a few values apart anywhere", () => {
    const kept = picture();
    expect(differs(kept, picture())).toBe(false);
    expect(differs(kept, picture(40, 30, 120 + NOISE))).toBe(false);
    expect(differs(kept, picture(40, 30, 120 - NOISE))).toBe(false);
  });

  it("allows a few specks, and no more", () => {
    const kept = picture();
    expect(differs(kept, speckled(kept, SPECKS))).toBe(false);
    expect(differs(kept, speckled(kept, SPECKS + 1))).toBe(true);
    // A pixel counts once, however many of its channels moved.
    const twice = speckled(speckled(kept, SPECKS, NOISE + 1, 0), SPECKS, NOISE + 1, 2);
    expect(differs(kept, twice)).toBe(false);
    // Alpha is not a colour: the pictures are opaque.
    expect(differs(kept, speckled(kept, SPECKS * 10, -100, 3))).toBe(false);
  });

  it("replaces a picture of another size", () => {
    expect(differs(picture(40, 30), picture(80, 60))).toBe(true);
    expect(differs(picture(40, 30), picture(40, 31))).toBe(true);
  });
});

describe("comparing picture files", () => {
  let folder = "";
  afterEach(async () => {
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  async function png(name: string, draw: (context: CanvasRenderingContext2D) => void) {
    const canvas = createCanvas(64, 48);
    const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    context.fillStyle = "#f4f4f2";
    context.fillRect(0, 0, 64, 48);
    draw(context);
    const path = resolve(folder, name);
    await writeFile(path, canvas.toBuffer("image/png"));
    return path;
  }

  it("takes a picture with none kept, and tells the same from a change", async () => {
    folder = await mkdtemp(resolve(tmpdir(), "folio-picture-difference-"));
    const plain = await png("plain.png", () => {});
    const again = await png("again.png", () => {});
    const boxed = await png("boxed.png", (context) => {
      context.fillStyle = "#1f2328";
      context.fillRect(10, 10, 20, 12);
    });
    expect(await looksDifferent(resolve(folder, "missing.png"), plain)).toBe(true);
    expect(await looksDifferent(plain, again)).toBe(false);
    expect(await looksDifferent(plain, boxed)).toBe(true);
  });
});
