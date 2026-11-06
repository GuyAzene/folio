import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readableText, styleColors } from "../app/lib/readable-text.ts";
import { noteAssetResponse } from "../src/desktop/note-asset-protocol.ts";
import { chatView } from "../src/desktop/view.ts";
import { assetUrl, imageSize, parseAssetUrl } from "../src/library/asset-names.ts";
import { closeSource, openSource, textColumn } from "../src/ingest/pages.ts";
import { createRuntimes, figureWidth } from "../src/library/course-tools.ts";
import { PageReader } from "../src/library/page-reader.ts";
import { pixelSize } from "../src/library/images.ts";
import { MAX_ASSET_BYTES, NoteAssets } from "../src/library/note-assets.ts";
import {
  findingsText,
  MAX_TILES,
  tileCuts,
  tileLines,
  type NoteRenderRequest,
  type NoteRendering,
} from "../src/library/note-render.ts";
import { CourseNotes, noteTitle } from "../src/library/notes.ts";
import { noteHeadings } from "../src/library/note-meta.ts";
import { LibraryStore } from "../src/library/store.ts";
import type { SessionRecord } from "../src/session-store.ts";
import { withoutMarkup } from "../src/text.ts";
import { MAX_IMAGES, modelContextMessages, stubOf } from "../src/transcript.ts";
import { SYNTHETIC_LECTURE, syntheticPdf } from "./fixtures/synthetic-pdf.ts";
import { expectMode } from "./fixtures/modes.ts";

// Synthetic notes, pictures and pages only.

const COURSE = "0b7f4c56-3c8f-4a62-9a3b-2f5c9b1d4e01";
const RENDERER = "folio://app";
const HASH = "a".repeat(64);

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function picture(
  width = 40,
  height = 30,
  format: "png" | "jpeg" = "png",
): Promise<Uint8Array> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffb9bb";
  context.fillRect(0, 0, width, height);
  const bytes = format === "png" ? await canvas.encode("png") : await canvas.encode("jpeg", 80);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe("titles and headings written with markup", () => {
  it("read as their words, keeping signs that aren't tags", () => {
    expect(withoutMarkup('<span style="display:block"><u>Exercise 3</u></span>')).toBe(
      "Exercise 3",
    );
    expect(withoutMarkup("a < b and x<y, <3")).toBe("a < b and x<y, <3");
    expect(withoutMarkup("unclosed <span title")).toBe("unclosed <span title");
    expect(
      noteTitle('# <span style="display:block;text-align:center"><u>Exercise 3</u></span>\n\nText'),
    ).toBe("Exercise 3");
    expect(noteTitle("# Plain title")).toBe("Plain title");
    expect(
      noteHeadings("# Title\n\n## <u>Problem 1</u>\n\n## <br>").map((heading) => heading.text),
    ).toEqual(["Problem 1"]);
  });

  it("keep a markup title whole when the note is created, cutting only a long plain one", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "folio-pictures-test-"));
    homes.push(home);
    const library = await LibraryStore.open({ home });
    const course = await library.createCourse({ name: "Synthetic" });
    const notes = new CourseNotes(library);
    const title = `<span style="display:block;text-align:center"><u>${"Long words ".repeat(9).trim()}</u></span>`;
    const made = await notes.create(course.id, title, "");
    expect(made.content.split("\n")[0]).toBe(`# ${title}`);
    expect(made.title).toBe("Long words ".repeat(9).trim());
    const long = await notes.create(course.id, `<u>${"x".repeat(200)}</u>`, "");
    expect(long.title).toBe("x".repeat(120));
  });
});

describe("figure names", () => {
  it("load a note's own figures by their hash, and nothing else", () => {
    expect(assetUrl(COURSE, `assets/${HASH}.png`)).toBe(`folio-note://${COURSE}/${HASH}.png`);
    expect(assetUrl(COURSE, `./assets/${HASH}.jpg`)).toBe(`folio-note://${COURSE}/${HASH}.jpg`);
    for (const src of [
      `assets/${HASH}.gif`,
      `assets/../${HASH}.png`,
      `assets/sub/${HASH}.png`,
      "assets/figure.png",
      `/assets/${HASH}.png`,
      `assets/${HASH}.png?x=1`,
      `https://example.com/${HASH}.png`,
    ])
      expect(assetUrl(COURSE, src), src).toBeNull();
    expect(assetUrl("not-a-course", `assets/${HASH}.png`)).toBeNull();
  });

  it("read back only an address that names exactly one figure", () => {
    expect(parseAssetUrl(`folio-note://${COURSE}/${HASH}.png`)).toEqual({
      courseId: COURSE,
      file: `${HASH}.png`,
    });
    for (const url of [
      `folio-note://${COURSE}/${HASH}.png?x`,
      `folio-note://${COURSE}/${HASH}.png#x`,
      `folio-note://${COURSE}/a/${HASH}.png`,
      `folio-note://${COURSE}:8080/${HASH}.png`,
      `folio-note://user@${COURSE}/${HASH}.png`,
      `folio-note://lib/${HASH}.png`,
      `folio://${COURSE}/${HASH}.png`,
      "not a url",
    ])
      expect(parseAssetUrl(url), url).toBeNull();
  });

  it("take a width after a bar, as Obsidian does", () => {
    expect(imageSize("A gadget|360")).toEqual({ alt: "A gadget", width: 360 });
    expect(imageSize("A gadget | 120 ")).toEqual({ alt: "A gadget", width: 120 });
    expect(imageSize("x|y")).toEqual({ alt: "x|y" });
    expect(imageSize("tiny|5")).toEqual({ alt: "tiny|5" });
    expect(imageSize("Plain")).toEqual({ alt: "Plain" });
  });
});

describe("colored blocks in dark mode", () => {
  it("get dark text on a light color and light text on a dark one", () => {
    expect(readableText("#ffb9bb")).toBe("#18181b");
    expect(readableText("#fffd66")).toBe("#18181b");
    expect(readableText("#99ccff")).toBe("#18181b");
    expect(readableText("#1f2328")).toBe("#f4f4f5");
    expect(readableText("rgb(20, 30, 40)")).toBe("#f4f4f5");
    expect(readableText("lightblue")).toBe("#18181b");
    expect(readableText("#abc")).toBe("#18181b");
    expect(readableText("url(paper.png)")).toBeNull();
  });

  it("know whether a style already sets the text's color", () => {
    expect(styleColors("background-color:#ffb9bb;padding:4px")).toEqual({
      background: "#ffb9bb",
      color: false,
    });
    expect(styleColors("background: #fff; color: #111")).toEqual({
      background: "#fff",
      color: true,
    });
    expect(styleColors("text-align:center")).toEqual({ background: null, color: false });
  });
});

describe("cutting a drawn note into pictures", () => {
  it("cuts between blocks, never inside one that fits", () => {
    const bottoms = [100, 400, 900, 1300, 1700, 2100];
    const tiles = tileCuts(bottoms, 2100, 1000);
    expect(tiles).toEqual([
      [0, 900],
      [900, 1700],
      [1700, 2100],
    ]);
    for (const [top, bottom] of tiles) expect(bottom - top).toBeLessThanOrEqual(1000);
  });

  it("cuts a block taller than a picture where it must, and stops at the most it draws", () => {
    expect(tileCuts([3000], 3000, 1000)).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 3000],
    ]);
    expect(tileCuts([], 500, 1000)).toEqual([[0, 500]]);
    expect(tileCuts([], 1000 * 100, 1000)).toHaveLength(MAX_TILES);
  });

  it("says which of the note's lines each picture shows", () => {
    const blocks = [
      { top: 0, bottom: 100, line: 1 },
      { top: 100, bottom: 500, line: 3 },
      { top: 500, bottom: 900, line: 9 },
    ];
    expect(tileLines(blocks, 0, 500, 12)).toEqual([1, 8]);
    expect(tileLines(blocks, 500, 900, 12)).toEqual([9, 12]);
  });

  it("tells the tutor what looked broken, or that nothing did", () => {
    expect(findingsText([])).toMatch(/^Nothing looked broken/);
    expect(
      findingsText([
        { kind: "math-error", line: 4, text: "\\frac{a" },
        { kind: "too-wide", line: 0, text: "the page scrolls sideways" },
      ]),
    ).toBe(
      "What looked wrong in how it was drawn (2):\n- line 4, a formula that can't be drawn: \\frac{a\n- wider than the note's column: the page scrolls sideways",
    );
  });

  it("reads a PNG's or a JPEG's size from its header", async () => {
    expect(pixelSize(await picture(40, 30))).toEqual({ kind: "png", width: 40, height: 30 });
    expect(pixelSize(await picture(64, 20, "jpeg"))).toEqual({
      kind: "jpg",
      width: 64,
      height: 20,
    });
    expect(pixelSize(new TextEncoder().encode("not an image"))).toBeNull();
  });
});

async function setup() {
  const home = await mkdtemp(resolve(tmpdir(), "folio-pictures-test-"));
  homes.push(home);
  const pdf = resolve(home, "handout.pdf");
  await writeFile(pdf, syntheticPdf(SYNTHETIC_LECTURE));
  const markdown = resolve(home, "readme.md");
  await writeFile(markdown, "# Read me\n\nPlain text.");
  const library = await LibraryStore.open({ home: resolve(home, "data") });
  const course = await library.createCourse({ name: "Synthetic Theory" });
  const other = await library.createCourse({ name: "Private course" });
  const handout = (await library.importFile(course.id, pdf)).document;
  const text = (await library.importFile(course.id, markdown)).document;
  const elsewhere = (await library.importFile(other.id, pdf)).document;
  const notes = new CourseNotes(library);
  const note = await notes.create(course.id, "Exercise 9", "Line two\n\n## Problem 1\n\nLet $x$.");
  const hidden = await notes.create(other.id, "Private", "Not yours.");
  const assets = new NoteAssets(library);
  const drawn: NoteRenderRequest[] = [];
  const tile = await picture(784, 200, "jpeg");
  const renderNote = async (request: NoteRenderRequest): Promise<NoteRendering> => {
    drawn.push(request);
    return {
      view: request.view,
      width: 784,
      height: 400,
      complete: true,
      findings: [{ kind: "math-error", line: 7, text: "\\frac{a" }],
      lines: 7,
      tiles: request.closeUp
        ? []
        : [
            { part: 1, top: 0, height: 200, jpeg: tile, lines: [1, 4], headings: ["Exercise 9"] },
            { part: 2, top: 200, height: 200, jpeg: tile, lines: [5, 7], headings: ["Problem 1"] },
          ],
      ...(request.closeUp
        ? { closeUp: { jpeg: tile, lines: [request.closeUp.from, request.closeUp.to] } }
        : {}),
    };
  };
  const runtimes = createRuntimes(library, { notes, renderNote, assets });
  const chat = await runtimes.course(course.id, "00000000-0000-4000-8000-0000000000d1");
  const tool = (name: string) => {
    const found = chat.tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`No ${name}`);
    return found;
  };
  return {
    home,
    library,
    course,
    other,
    handout,
    text,
    elsewhere,
    notes,
    note,
    hidden,
    assets,
    drawn,
    chat,
    tool,
    runtimes,
  };
}

describe("figures beside notes", () => {
  it("are saved once by their hash, privately, and read back only as they were", async () => {
    const { library, course, assets } = await setup();
    const png = await picture(40, 30);
    const saved = await assets.save(course.id, png);
    expect(saved).toMatchObject({ path: `assets/${saved.file}`, width: 40, height: 30 });
    expect(saved.file).toMatch(/^[0-9a-f]{64}\.png$/);
    const file = resolve(library.courseDirectory(course.id), "notes", "assets", saved.file);
    await expectMode(file, 0o600);
    await expectMode(resolve(file, ".."), 0o700);
    expect(await assets.save(course.id, png)).toEqual(saved);
    const read = await assets.read(course.id, saved.file);
    expect(read.type).toBe("image/png");
    expect(Buffer.from(read.bytes).equals(Buffer.from(png))).toBe(true);
    // A note list never mistakes the figures' folder for a note.
    expect((await new CourseNotes(library).list(course.id)).map((note) => note.title)).toEqual([
      "Exercise 9",
    ]);
  });

  it("refuse what isn't a small PNG or JPEG, and anything changed or linked on disk", async () => {
    const { library, course, assets } = await setup();
    await expect(assets.save(course.id, new TextEncoder().encode("<svg/>"))).rejects.toThrow(
      "PNG or JPEG",
    );
    const big = new Uint8Array(MAX_ASSET_BYTES + 1);
    big.set(await picture());
    await expect(assets.save(course.id, big)).rejects.toThrow("too large");
    await expect(assets.read(course.id, "figure.png")).rejects.toThrow("Unknown figure");
    await expect(assets.read("not-a-course", `${HASH}.png`)).rejects.toThrow();
    const saved = await assets.save(course.id, await picture(10, 10));
    const folder = resolve(library.courseDirectory(course.id), "notes", "assets");
    await writeFile(resolve(folder, saved.file), await picture(11, 11));
    await expect(assets.read(course.id, saved.file)).rejects.toThrow("changed on disk");
    const outside = resolve(folder, "..", "..", "outside.png");
    await writeFile(outside, await picture(12, 12));
    await symlink(outside, resolve(folder, `${HASH}.png`));
    expect((await lstat(resolve(folder, `${HASH}.png`))).isSymbolicLink()).toBe(true);
    await expect(assets.read(course.id, `${HASH}.png`)).rejects.toThrow("Unknown figure");
  });

  it("write a damaged figure again rather than keep it", async () => {
    const { library, course, assets } = await setup();
    const png = await picture(20, 20);
    const saved = await assets.save(course.id, png);
    const file = resolve(library.courseDirectory(course.id), "notes", "assets", saved.file);
    await writeFile(file, png.slice(0, 20));
    await expect(assets.read(course.id, saved.file)).rejects.toThrow("changed on disk");
    expect(await assets.save(course.id, png)).toEqual(saved);
    expect(
      Buffer.from((await assets.read(course.id, saved.file)).bytes).equals(Buffer.from(png)),
    ).toBe(true);
  });

  it("are served only to Folio's own pages, at exactly their address", async () => {
    const { course, assets } = await setup();
    const saved = await assets.save(course.id, await picture());
    const url = `folio-note://${course.id}/${saved.file}`;
    const answer = (request: { url: string; initiatorOrigin?: string }) =>
      noteAssetResponse(request, assets, RENDERER);
    const ok = await answer({ url, initiatorOrigin: RENDERER });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("image/png");
    expect(ok.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = Buffer.from(await ok.arrayBuffer());
    expect(body.equals(Buffer.from((await assets.read(course.id, saved.file)).bytes))).toBe(true);
    for (const initiatorOrigin of [
      undefined,
      "null",
      "https://example.com",
      "folio-artifact://abc",
    ])
      expect((await answer({ url, initiatorOrigin })).status, String(initiatorOrigin)).toBe(403);
    for (const bad of [
      `${url}?x=1`,
      `folio-note://${course.id}/%2e%2e/${saved.file}`,
      `folio-note://${course.id}/assets/${saved.file}`,
      `folio-note://lib/${saved.file}`,
      `folio-note://${course.id}/${HASH}.png`,
    ])
      expect((await answer({ url: bad, initiatorOrigin: RENDERER })).status, bad).toBe(404);
  });
});

describe("the tutor's view_note", () => {
  it("is offered with notes and a way to draw them, after the note tools", async () => {
    const { chat, library, notes } = await setup();
    expect(chat.tools.map((tool) => tool.name).slice(-2)).toEqual(["view_note", "add_note_figure"]);
    const plain = await createRuntimes(library, { notes }).course(
      (await library.listCourses())[0]!.id,
      "00000000-0000-4000-8000-0000000000d2",
    );
    expect(plain.tools.map((tool) => tool.name)).not.toContain("view_note");
    expect(plain.tools.map((tool) => tool.name)).not.toContain("add_note_figure");
    expect(await chat.prompt()).toContain(
      "look at it with view_note in the edit view and the read view",
    );
    expect(await plain.prompt()).not.toContain("view_note");
  });

  it("shows a part of the note with every part listed and what looked broken", async () => {
    const { tool, note, drawn, course } = await setup();
    const result = await tool("view_note").execute("v1", { noteId: note.id, view: "edit" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`The note "Exercise 9" in the edit view (revision ${note.revision}).`);
    expect(text).toContain("Part 1 of 2, lines 1–4: Exercise 9.");
    expect(text).toContain("All parts: 1, lines 1–4: Exercise 9; 2, lines 5–7: Problem 1.");
    expect(text).toContain("line 7, a formula that can't be drawn: \\frac{a");
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(result.details).toMatchObject({
      noteId: note.id,
      view: "edit",
      part: 1,
      parts: 2,
      closeUp: false,
    });
    expect(drawn[0]).toMatchObject({ content: note.content, courseId: course.id, view: "edit" });
    const second = await tool("view_note").execute("v2", {
      noteId: note.id,
      view: "read",
      part: 2,
    });
    expect((second.content[0] as { text: string }).text).toContain(
      "Part 2 of 2, lines 5–7: Problem 1.",
    );
    await expect(
      tool("view_note").execute("v3", { noteId: note.id, view: "read", part: 3 }),
    ).rejects.toThrow("The note has 2 parts in the read view.");
  });

  it("gives a close-up of a passage that appears once", async () => {
    const { tool, note, drawn } = await setup();
    const result = await tool("view_note").execute("v1", {
      noteId: note.id,
      view: "read",
      find: "## Problem 1\n\nLet $x$.",
    });
    // The note's title is its first line, so the passage is on lines 5 to 7.
    expect(drawn.at(-1)!.closeUp).toEqual({ from: 5, to: 7 });
    expect((result.content[0] as { text: string }).text).toContain(
      "A close-up of lines 5–7, at twice the size.",
    );
    expect(result.details).toMatchObject({ closeUp: true, part: 0 });
    // Line endings and trailing spaces don't make the passage different.
    await tool("view_note").execute("v1b", {
      noteId: note.id,
      view: "read",
      find: "## Problem 1\r\n\r\nLet $x$.  \n",
    });
    expect(drawn.at(-1)!.closeUp).toEqual({ from: 5, to: 7 });
    await expect(
      tool("view_note").execute("v2", { noteId: note.id, view: "read", find: "Not in it" }),
    ).rejects.toThrow("not in the note");
    await expect(
      tool("view_note").execute("v3", { noteId: note.id, view: "read", find: "e" }),
    ).rejects.toThrow("appears");
  });

  it("stays in the chat's course, takes only its own keys, and stops after enough looks", async () => {
    const { tool, note, hidden, chat } = await setup();
    await expect(
      tool("view_note").execute("v1", { noteId: hidden.id, view: "edit" }),
    ).rejects.toThrow("not part of this chat");
    await expect(
      tool("view_note").execute("v2", { noteId: note.id, view: "edit", width: 2000 }),
    ).rejects.toThrow("accepts only");
    await expect(
      tool("view_note").execute("v3", { noteId: note.id, view: "print" }),
    ).rejects.toThrow("edit or read");
    chat.beforeSend!({ webSearch: false });
    for (let look = 0; look < 48; look++)
      await tool("view_note").execute(`l${look}`, { noteId: note.id, view: "edit" });
    await expect(
      tool("view_note").execute("l48", { noteId: note.id, view: "edit" }),
    ).rejects.toThrow("48 times");
    chat.beforeSend!({ webSearch: false });
    await tool("view_note").execute("next", { noteId: note.id, view: "edit" });
  });
});

describe("a closer look at a page, and figures from it", () => {
  it("reads part of a page as a sharp picture, checking the region", async () => {
    const { tool, handout, elsewhere } = await setup();
    const result = await tool("read_page").execute("p1", {
      documentId: handout.id,
      page: 1,
      region: [0, 0, 0.5, 0.25],
    });
    expect((result.content[0] as { text: string }).text).toContain(
      "A close-up of part of the page",
    );
    const image = result.content[1] as { type: string; data: string };
    expect(image.type).toBe("image");
    const size = pixelSize(Buffer.from(image.data, "base64"));
    expect(size?.kind).toBe("jpg");
    expect(size!.width).toBeGreaterThan(size!.height);
    expect(result.details).toMatchObject({ documentId: handout.id, page: 1, region: true });
    for (const region of [[0, 0, 0.5], [0.5, 0, 0.4, 1], [0, 0, 1.2, 1], [0, 0, 0.01, 1], "all"])
      await expect(
        tool("read_page").execute("p2", { documentId: handout.id, page: 1, region }),
      ).rejects.toThrow("region");
    await expect(
      tool("read_page").execute("p3", { documentId: elsewhere.id, page: 1, region: [0, 0, 1, 1] }),
    ).rejects.toThrow("not part of this chat");
  });

  it("crops a figure into the course's figures and gives the Markdown to place it", async () => {
    const { tool, note, handout, notes, library, course, text, hidden } = await setup();
    const result = await tool("add_note_figure").execute("f1", {
      noteId: note.id,
      documentId: handout.id,
      page: 1,
      region: [0.1, 0.1, 0.6, 0.4],
      alt: "A [gadget] | two nodes",
    });
    const said = (result.content[0] as { text: string }).text;
    // Half the page's width, against the typical column of a page with too little text to measure.
    const markdown = /!\[A gadget two nodes\|480\]\(assets\/([0-9a-f]{64})\.png\)/.exec(said);
    expect(markdown, said).not.toBeNull();
    const file = resolve(
      library.courseDirectory(course.id),
      "notes",
      "assets",
      `${markdown![1]}.png`,
    );
    expect(pixelSize(await readFile(file))?.kind).toBe("png");
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(result.details).toMatchObject({ noteId: note.id, documentId: handout.id, page: 1 });
    // The note itself is not changed: placing the figure is an edit the student can undo.
    expect((await notes.read(note.id)).revision).toBe(note.revision);
    await expect(
      tool("add_note_figure").execute("f2", {
        noteId: note.id,
        documentId: text.id,
        page: 1,
        region: [0, 0, 1, 1],
        alt: "x",
      }),
    ).rejects.toThrow("isn't a PDF");
    await expect(
      tool("add_note_figure").execute("f3", {
        noteId: hidden.id,
        documentId: handout.id,
        page: 1,
        region: [0, 0, 1, 1],
        alt: "x",
      }),
    ).rejects.toThrow("not part of this chat");
  });
});

describe("a figure's printed size", () => {
  it("falls back to the usual size when the page's text layer can't be read", async () => {
    const { library, notes, assets, course, handout, note } = await setup();
    class Unmeasurable extends PageReader {
      override async column(): Promise<[number, number] | null> {
        throw new Error("A text layer that can't be read");
      }
    }
    const pages = new Unmeasurable(library);
    try {
      const chat = await createRuntimes(library, { notes, assets, pages }).course(
        course.id,
        "00000000-0000-4000-8000-0000000000d2",
      );
      const figure = chat.tools.find((tool) => tool.name === "add_note_figure")!;
      const result = await figure.execute("f1", {
        noteId: note.id,
        documentId: handout.id,
        page: 1,
        region: [0.1, 0.1, 0.6, 0.4],
        alt: "A gadget",
      });
      expect((result.content[0] as { text: string }).text).toContain("![A gadget|480](assets/");
    } finally {
      await pages.close();
    }
  });

  it("is as wide against the note's column as it was against the page's text column", () => {
    expect(figureWidth([0.288, 0.1, 0.67, 0.2], [0.15, 0.85])).toBe(393);
    // Wider than the text, as a figure in the margins can be: no wider than the note's column.
    expect(figureWidth([0.1, 0.5, 0.94, 0.9], [0.15, 0.85])).toBe(720);
    expect(figureWidth([0.5, 0.5, 0.52, 0.6], null)).toBe(120);
    expect(figureWidth([0.25, 0, 0.625, 1], null)).toBe(360);
  });

  it("measures the text column from the page's text layer, when it has enough text", async () => {
    const lines = Array.from({ length: 12 }, (_, line) =>
      line % 3 ? "Every line of this synthetic page starts at the same margin." : "Short line.",
    );
    const doc = await openSource(syntheticPdf([lines, ["Too little text."]]));
    try {
      const column = await textColumn(doc, 1);
      // The lines start 72 points into a 612-point page.
      expect(column![0]).toBeCloseTo(72 / 612, 2);
      expect(column![1]).toBeGreaterThan(column![0] + 0.2);
      expect(column![1]).toBeLessThanOrEqual(1);
      expect(await textColumn(doc, 2)).toBeNull();
    } finally {
      await closeSource(doc);
    }
  });
});

describe("pictures in a long chat", () => {
  const result = (toolName: string, details: object) =>
    ({
      role: "toolResult",
      toolCallId: `call_${Math.random()}`,
      toolName,
      content: [
        { type: "text", text: "Seen." },
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      ],
      details,
      isError: false,
      timestamp: 0,
    }) as unknown as AgentMessage;

  /** A question, then each result after the call that asked for it, all in one reply. */
  const oneReply = (results: AgentMessage[]): AgentMessage[] => [
    { role: "user", content: "Make the workbook.", timestamp: 0 } as AgentMessage,
    ...results.flatMap((each) => {
      const { toolCallId: id, toolName: name } = each as { toolCallId: string; toolName: string };
      return [
        {
          role: "assistant",
          content: [{ type: "toolCall", id, name, arguments: {} }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-6.1-sol",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 0,
        } as unknown as AgentMessage,
        each,
      ];
    }),
  ];

  it("send only the latest few, even after every look and figure one reply may take", () => {
    // 48 looks at the note and 12 figures: the most one reply may take.
    const results = [
      ...Array.from({ length: 48 }, () => result("view_note", { title: "Exercise 9" })),
      ...Array.from({ length: 12 }, () => result("add_note_figure", { source: "Handout" })),
    ];
    const images = modelContextMessages(oneReply(results))
      .filter((message) => message.role === "toolResult")
      .map((message) => (message as { content: { type: string }[] }).content[1]!.type);
    const kept = images.filter((type) => type === "image").length;
    expect(kept).toBeGreaterThanOrEqual(2);
    expect(kept).toBeLessThanOrEqual(MAX_IMAGES);
    expect(images.at(-1)).toBe("image");
  });

  it("say what an earlier picture of a note or figure was, and leave page wording as it was", () => {
    expect(stubOf({ toolName: "view_note", details: { title: "Exercise 9", view: "edit" } })).toBe(
      '[An earlier view_note result (the note "Exercise 9", edit view) is not sent again; call the tool again if you need its text.]',
    );
    expect(
      stubOf({ toolName: "add_note_figure", details: { source: "Handout", page: 2 } }),
    ).toContain('(a figure from "Handout", page 2)');
    expect(stubOf({ toolName: "read_note", details: { title: "Exercise 9" } })).toBe(
      '[An earlier read_note result (the note "Exercise 9") is not sent again; call the tool again if you need its text.]',
    );
    const results = [
      ...Array.from({ length: 4 }, () => result("view_note", { title: "Exercise 9" })),
      result("add_note_figure", { source: "Handout", page: 1 }),
      ...Array.from({ length: 2 }, () => result("read_page", { title: "Handout", page: 1 })),
    ];
    const sent = modelContextMessages(oneReply(results))
      .filter((message) => message.role === "toolResult")
      .map((message) => (message as { content: { type: string; text?: string }[] }).content[1]);
    expect(sent[0]).toEqual({
      type: "text",
      text: "[A picture of the note from earlier is not sent again; call view_note again to look at it.]",
    });
    expect(sent[4]).toEqual({
      type: "text",
      text: "[A figure's preview from earlier is not sent again.]",
    });
    expect(sent[6]).toMatchObject({ type: "image" });
  });

  it("show as steps that say what the tutor looked at", () => {
    const call = (id: string, name: string, args: object) => ({
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-6.1-sol",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 0,
    });
    const done = (id: string, name: string, details: object) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: "Done." }],
      details,
      isError: false,
      timestamp: 0,
    });
    const record = {
      id: "00000000-0000-4000-8000-0000000000e1",
      scope: { courseId: COURSE, library: 1 },
      title: "Synthetic",
      status: "idle",
      modelId: "gpt-6.1-sol",
      focus: null,
      updatedAt: new Date().toISOString(),
      messages: [
        { role: "user", content: "Make the workbook.", timestamp: 0 },
        call("a", "view_note", { noteId: "n", view: "edit" }),
        done("a", "view_note", {
          title: "Exercise 9",
          view: "edit",
          part: 2,
          parts: 3,
          closeUp: false,
        }),
        call("b", "view_note", { noteId: "n", view: "read", find: "x" }),
        done("b", "view_note", {
          title: "Exercise 9",
          view: "read",
          part: 0,
          parts: 0,
          closeUp: true,
        }),
        call("c", "add_note_figure", { page: 4 }),
        done("c", "add_note_figure", { source: "Handout", page: 4 }),
        call("d", "read_page", { documentId: "d", page: 4, region: [0, 0, 1, 1] }),
        done("d", "read_page", {
          documentId: "d",
          title: "Handout",
          page: 4,
          pages: 9,
          region: true,
        }),
      ],
    } as unknown as SessionRecord;
    const reply = chatView(record).messages.find((message) => message.role === "assistant")!;
    expect(reply.steps?.map((step) => step.label)).toEqual([
      "Looked at your note Exercise 9 (edit view, part 2 of 3)",
      "Looked at your note Exercise 9 (read view, close-up)",
      "Saved a figure from Handout, page 4",
      "Looked closer at Handout, page 4",
    ]);
  });
});
