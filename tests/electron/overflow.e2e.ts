/// <reference lib="dom" />
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { launch, type Running } from "./app.ts";
import { seedLongNames, type SeededLong } from "./seed.ts";

/**
 * Every place in Folio with long names in English and Hebrew, at a narrow, a middle and a wide
 * window: nothing spills out of its box, and no word is broken in the middle to fit one.
 * Run with `vp run test:electron`; nothing here talks to a model.
 */

const WIDTHS = [640, 1024, 1360];

type Ids = Omit<SeededLong, "home">;
const PLACES: [string, (ids: Ids) => unknown][] = [
  ["home", () => ({ view: "home" })],
  ["library", () => ({ view: "library" })],
  ["assignments", () => ({ view: "assignments" })],
  ["chats", () => ({ view: "chats" })],
  ["course overview", (ids) => ({ view: "course", courseId: ids.courseId, tab: "overview" })],
  ["course materials", (ids) => ({ view: "course", courseId: ids.courseId, tab: "materials" })],
  ["course study notes", (ids) => ({ view: "course", courseId: ids.courseId, tab: "study" })],
  ["course notes", (ids) => ({ view: "course", courseId: ids.courseId, tab: "notes" })],
  ["course chats", (ids) => ({ view: "course", courseId: ids.courseId, tab: "chats" })],
  ["topic", (ids) => ({ view: "study", courseId: ids.courseId, item: "topic:alg-bfs" })],
  ["session", (ids) => ({ view: "study", courseId: ids.courseId, item: "session:alg-R02" })],
  ["chat", (ids) => ({ view: "chat", chatId: ids.chatId, courseId: ids.courseId })],
  [
    "document",
    (ids) => ({
      view: "document",
      documentId: ids.recitationId,
      page: 1,
      panel: "full",
      chatId: ids.chatId,
    }),
  ],
  ["notes", (ids) => ({ view: "notes", noteId: ids.noteId, courseId: null })],
  [
    "note beside a document",
    (ids) => ({
      view: "document",
      documentId: ids.recitationId,
      page: 1,
      panel: "docked",
      chatId: null,
      side: "note",
      noteId: ids.noteId,
    }),
  ],
];

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

/**
 * Text that spills out of its box, and words that wrap in the middle, on the page as shown. A
 * box that scrolls or clips its text on purpose (truncation) counts as holding it; a row whose
 * hover background reaches into the gutter is fine as long as its text stays inside.
 */
function audit(): string[] {
  const name = (element: Element) =>
    `<${element.tagName.toLowerCase()}${typeof element.className === "string" && element.className ? ` class="${element.className.slice(0, 60)}"` : ""}> "${(element.textContent ?? "").trim().slice(0, 50)}"`;
  const skipped = "svg, .katex, .cm-editor, script, style, title, [aria-hidden=true]";
  const found: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = node.textContent ?? "";
    if (!parent || !text.trim() || parent.closest(skipped)) continue;
    const whole = document.createRange();
    whole.selectNodeContents(node);
    const rects = [...whole.getClientRects()].filter((rect) => rect.width && rect.height);
    if (!rects.length) continue;
    // Each box up to the first one that clips or scrolls must hold the text.
    for (
      let box: HTMLElement | null = parent;
      box && box !== document.body;
      box = box.parentElement
    ) {
      const style = getComputedStyle(box);
      if (style.display === "inline" || style.display === "contents") continue;
      // A box that truncates or scrolls holds its text by design.
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) break;
      const edge = box.getBoundingClientRect();
      const out = rects.some(
        (rect) =>
          rect.left < edge.left - 1 ||
          rect.right > edge.right + 1 ||
          (style.height !== "auto" &&
            style.overflowY === "visible" &&
            rect.bottom > edge.bottom + 1),
      );
      if (out) {
        found.push(`spills from ${name(box)}`);
        break;
      }
    }
    for (const run of text.matchAll(/\S+/gu)) {
      // A URL-length run has to break somewhere; ordinary words never should.
      if (run[0].length > 30) continue;
      for (const word of run[0].matchAll(/[\p{L}\p{N}]{2,}/gu)) {
        const range = document.createRange();
        const at = run.index + word.index;
        range.setStart(node, at);
        range.setEnd(node, at + word[0].length);
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        if (lines.size > 1) found.push(`breaks "${word[0]}" inside ${name(parent)}`);
      }
    }
  }
  return found;
}

void describe("long names", () => {
  void it("are caught when a chip is squeezed, so a clean audit means something", async () => {
    const seeded = await seedLongNames(() => ({ view: "home" }));
    const app = await launch(seeded.home);
    running.push(app);
    await app.page.waitForTimeout(800);
    // The chip as it was before the fix: in a row with text beside it, free to shrink.
    await app.page.evaluate(() => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:flex-start;gap:12px;width:260px";
      row.innerHTML =
        '<button style="display:inline-flex;height:24px;align-items:center;font-size:12px">Complexity Theory Recitation 2 · Page 1</button><span>Parts of these pages were described elsewhere in the notes.</span>';
      document.querySelector("main")?.prepend(row);
    });
    const problems = await app.page.evaluate(audit);
    await app.close();
    assert.ok(
      problems.some((line) => line.includes("Complexity")),
      `The audit missed the squeezed chip: ${problems.join("; ")}`,
    );
  });

  for (const [label, place] of PLACES)
    void it(`fit in ${label} at every width`, async () => {
      const seeded = await seedLongNames(place);
      const app = await launch(seeded.home);
      running.push(app);
      await app.page.waitForSelector("main, [data-folio-ready], body");
      await app.page.waitForTimeout(800);
      const problems: string[] = [];
      for (const width of WIDTHS) {
        await app.app.evaluate(({ BrowserWindow }, width) => {
          BrowserWindow.getAllWindows()[0]!.setSize(width, 820);
        }, width);
        await app.page.waitForTimeout(400);
        problems.push(...(await app.page.evaluate(audit)).map((line) => `${width}px ${line}`));
      }
      await app.close();
      assert.deepEqual([...new Set(problems)], []);
    });
});
