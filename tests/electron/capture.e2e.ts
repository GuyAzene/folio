/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { NoteAssets } from "../../src/library/note-assets.ts";
import type { NoteRenderRequest } from "../../src/library/note-render.ts";
import { CourseNotes } from "../../src/library/notes.ts";
import { LibraryStore } from "../../src/library/store.ts";
import { launch, type Running } from "./app.ts";

/**
 * The tutor looking at a note (`view_note`): Folio draws a note in a hidden page, in the edit
 * view and the read view, cuts it into pictures and says what looked broken, then closes the
 * page and leaves the window as it was. Run with `vp run test:electron`; nothing here talks to
 * a model. FOLIO_CAPTURE_SHOTS=<folder> saves the pictures to look at.
 */

const PINK = [255, 185, 187] as const;

/** A synthetic figure: two labelled circles joined by a line. */
async function figure(): Promise<Uint8Array> {
  const canvas = createCanvas(360, 160);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 360, 160);
  context.strokeStyle = "#1f4e9a";
  context.lineWidth = 4;
  for (const x of [80, 280]) {
    context.beginPath();
    context.arc(x, 80, 40, 0, Math.PI * 2);
    context.stroke();
  }
  context.beginPath();
  context.moveTo(120, 80);
  context.lineTo(240, 80);
  context.stroke();
  context.fillStyle = "#1f4e9a";
  context.font = "28px serif";
  context.fillText("u", 72, 90);
  context.fillText("v", 272, 90);
  const png = await canvas.encode("png");
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
}

/** A synthetic homework workbook, with each thing Folio draws differently, and two mistakes. */
function workbook(asset: string): string {
  return [
    '# <span style="display:block;text-align:center"><u>Synthetic Theory – Exercise 9</u></span>',
    "",
    "Due Friday, January 9, 2026",
    "",
    '<div style="background-color:#ffb9bb;padding:4px 8px">',
    "",
    "**Work on your own.** You may ask a classmate for a hint about $x \\in \\{0,1\\}^*$.",
    "",
    "</div>",
    "",
    '<div style="background-color:#99ccff;color:#111;padding:4px 6px;margin:0">Submit a <strong>single PDF</strong>.</div>',
    '<div style="background-color:#d1e8ff;color:#111;padding:4px 6px;margin:0">At most <strong>10 MB</strong>.</div>',
    "",
    "## [1 pt] Problem 1",
    "",
    "[19 pts] 1\\. Let $PAIR=\\left\\{\\langle\\varphi\\rangle\\;\\middle|\\;\\begin{array}{c}\\varphi\\textit{ is a formula with at least two}\\\\\\textit{satisfying assignments}\\end{array}\\right\\}$.",
    "",
    "Show $A \\le_P PAIR$.",
    "",
    `![A gadget with two nodes|360](${asset})`,
    "",
    "שאלה בעברית עם נוסחה $a+b$ בתוכה.",
    "",
    "| $n$ | $f(n)$ |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "A broken one: $\\frac{a$ here.",
    "",
    "An over-wide one: $\\left\\{ w \\mid w\\textit{ is a very long word that keeps going and going far past the edge of the column so that it cannot fit}\\right\\}$.",
    "",
  ].join("\n");
}

let app: Running;
let home: string;
let request: Omit<NoteRenderRequest, "view">;

interface Drawn {
  width: number;
  tiles: { part: number; height: number; jpeg: string; lines: [number, number] }[];
  closeUp?: { jpeg: string };
  findings: { kind: string; line: number; text: string }[];
}

/** Draws the note in the app, as view_note does. */
function draw(view: "edit" | "read", closeUp?: { from: number; to: number }): Promise<Drawn> {
  return app.app.evaluate(
    async (_electron, { request, view, closeUp }) => {
      const hooks = (
        globalThis as unknown as {
          folioE2E: {
            renderNote: (request: unknown) => Promise<{
              width: number;
              tiles: { part: number; height: number; jpeg: Uint8Array; lines: [number, number] }[];
              closeUp?: { jpeg: Uint8Array };
              findings: { kind: string; line: number; text: string }[];
            }>;
          };
        }
      ).folioE2E;
      const drawn = await hooks.renderNote({ ...request, view, ...(closeUp ? { closeUp } : {}) });
      const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
      return {
        width: drawn.width,
        tiles: drawn.tiles.map((tile) => ({ ...tile, jpeg: base64(tile.jpeg) })),
        ...(drawn.closeUp ? { closeUp: { jpeg: base64(drawn.closeUp.jpeg) } } : {}),
        findings: drawn.findings,
      };
    },
    { request, view, closeUp },
  );
}

async function pixels(jpeg: string) {
  const image = await loadImage(Buffer.from(jpeg, "base64"));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return { width: image.width, data: context.getImageData(0, 0, image.width, image.height).data };
}

/** How many pixels are close to a color. */
async function near(jpeg: string, [r, g, b]: readonly number[]): Promise<number> {
  const { data } = await pixels(jpeg);
  let count = 0;
  for (let index = 0; index < data.length; index += 4)
    if (
      Math.abs(data[index]! - r!) < 12 &&
      Math.abs(data[index + 1]! - g!) < 12 &&
      Math.abs(data[index + 2]! - b!) < 12
    )
      count++;
  return count;
}

async function save(name: string, jpeg: string): Promise<void> {
  const folder = process.env.FOLIO_CAPTURE_SHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, name), Buffer.from(jpeg, "base64"));
}

const windows = () => app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const storage = () =>
  app.page.evaluate(() =>
    JSON.stringify(Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b))),
  );

before(async () => {
  home = await mkdtemp(resolve(tmpdir(), "folio-e2e-home-"));
  const library = await LibraryStore.open({ home });
  const course = await library.createCourse({ name: "Synthetic Theory" });
  const asset = await new NoteAssets(library).save(course.id, await figure());
  const note = await new CourseNotes(library).create(course.id, "Draft", "");
  const content = workbook(asset.path);
  const notes = new CourseNotes(library);
  const saved = await notes.save(note.id, content, note.revision);
  await writeFile(
    resolve(home, "workspace.json"),
    JSON.stringify({
      version: 1,
      tabs: [{ id: "tab-1", location: { view: "note", noteId: saved.id } }],
      active: "tab-1",
    }),
  );
  request = {
    content,
    courseId: course.id,
    courseName: course.name,
    documents: [],
  };
  app = await launch(home, { FOLIO_E2E_HOOKS: "1" });
  await app.page.locator(".cm-editor").waitFor();
});

after(async () => {
  await app?.close();
});

void describe("the tutor looking at a note", () => {
  void it("draws the edit view and the read view as Folio shows them, and says what is broken", async () => {
    const before = {
      storage: await storage(),
      workspace: await readFile(resolve(home, "workspace.json"), "utf8"),
    };
    for (const view of ["edit", "read"] as const) {
      const drawn = await draw(view);
      assert.ok(drawn.tiles.length >= 1, `${view}: no pictures`);
      for (const tile of drawn.tiles) {
        assert.equal((await pixels(tile.jpeg)).width, 784, `${view}: a picture's width`);
        assert.ok(tile.height <= 1456, `${view}: a picture's height`);
        await save(`${view}-${tile.part}.jpg`, tile.jpeg);
      }
      let pink = 0;
      for (const tile of drawn.tiles) pink += await near(tile.jpeg, PINK);
      assert.ok(pink > 2000, `${view}: the pink block shows (${pink} pixels)`);
      const kinds = drawn.findings.map((finding) => finding.kind);
      assert.ok(
        drawn.findings.some(
          (finding) => finding.kind === "math-error" && /frac/.test(finding.text),
        ),
        `${view}: the broken formula is found (${JSON.stringify(drawn.findings)})`,
      );
      assert.ok(
        drawn.findings.some(
          (finding) =>
            (finding.kind === "scrolls" || finding.kind === "too-wide") &&
            /long word/.test(finding.text),
        ),
        `${view}: the over-wide formula is found (${JSON.stringify(drawn.findings)})`,
      );
      assert.ok(!kinds.includes("html-as-text"), `${view}: ${JSON.stringify(drawn.findings)}`);
      assert.ok(!kinds.includes("image-missing"), `${view}: ${JSON.stringify(drawn.findings)}`);
      assert.equal(await windows(), 1, `${view}: the hidden page closed`);
    }
    const closeUp = await draw("read", { from: 16, to: 16 });
    assert.ok(closeUp.closeUp, "a close-up");
    assert.equal((await pixels(closeUp.closeUp.jpeg)).width, 784 * 2);
    await save("close-up.jpg", closeUp.closeUp.jpeg);
    assert.equal(await windows(), 1);
    assert.equal(await storage(), before.storage, "the window's storage is untouched");
    assert.equal(
      await readFile(resolve(home, "workspace.json"), "utf8"),
      before.workspace,
      "the workspace is untouched",
    );
  });

  void it("closes the hidden page at once when the reply stops", async () => {
    const outcome = await app.app.evaluate(async (_electron, request) => {
      const hooks = (
        globalThis as unknown as {
          folioE2E: { renderNote: (request: unknown, signal: AbortSignal) => Promise<unknown> };
        }
      ).folioE2E;
      const stop = new AbortController();
      // Text it hasn't drawn before, so it isn't answered from what was kept.
      const drawing = hooks
        .renderNote(
          { ...request, view: "edit", content: `${request.content}\n\nOnce more.` },
          stop.signal,
        )
        .then(
          () => "drawn",
          (error: Error) => error.name,
        );
      setTimeout(() => stop.abort(), 50);
      return drawing;
    }, request);
    assert.equal(outcome, "AbortError");
    assert.equal(await windows(), 1);
  });

  void it("shows the note's figure in the window", async () => {
    const image = app.page.locator(".cm-editor img.cm-image");
    await image.waitFor();
    await app.page.waitForFunction(
      () =>
        ((document.querySelector(".cm-editor img.cm-image") as HTMLImageElement | null)
          ?.naturalWidth ?? 0) > 0,
    );
    assert.equal(await image.getAttribute("width"), "360");
  });
});
