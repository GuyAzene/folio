/// <reference lib="dom" />
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { launch, type Running } from "./app.ts";
import { seedHome } from "./seed.ts";

/**
 * Diagrams in Folio's window: drawn in replies and notes, copied as their source, readable in
 * Hebrew, themed without redrawing, and smooth in a long note. Synthetic diagrams only.
 */

const HEBREW_LABEL = "התחלה: גרף G וקודקוד s";
const REPLY = [
  "The search, step by step:",
  "",
  "```mermaid",
  "flowchart TD",
  `  A[${HEBREW_LABEL}] --> B{Is the queue empty?}`,
  "  B -->|yes| C[Done]",
  "  B -->|no| A",
  "```",
  "",
  "Each vertex enters the queue once.",
].join("\n");

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

async function open(open: "chat" | "note" = "chat", noteText?: string): Promise<Running> {
  const seeded = await seedHome(REPLY, open, noteText);
  const app = await launch(seeded.home);
  running.push(app);
  return app;
}

void describe("Diagrams in Folio's window", () => {
  void it("draws a reply's diagram, with each label in its own direction", async () => {
    const { page } = await open();
    await page.locator(".prose-folio .diagram svg").waitFor();
    // Word order, left to right on screen, against Chromium's own right-to-left layout.
    const order = await page.evaluate((label) => {
      const words = label.split(" ");
      const visual = (root: Node) => {
        const found: { word: string; left: number }[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.includes(words[0]!)) continue;
          let at = 0;
          for (const word of words) {
            at = node.textContent.indexOf(word, at);
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + word.length);
            found.push({ word, left: range.getBoundingClientRect().left });
            at += word.length;
          }
        }
        return found.sort((a, b) => a.left - b.left).map((item) => item.word);
      };
      const reference = document.createElement("div");
      reference.dir = "rtl";
      reference.textContent = label;
      document.body.append(reference);
      const expected = visual(reference);
      reference.remove();
      return { expected, drawn: visual(document.querySelector(".prose-folio .diagram svg")!) };
    }, HEBREW_LABEL);
    assert.deepEqual(order.drawn, order.expected);
  });

  void it("copies a diagram as the Markdown it was written in", async () => {
    const { app, page } = await open();
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    const diagram = page.locator(".prose-folio .diagram").first();
    await diagram.hover();
    await diagram.getByRole("button", { name: "Copy" }).click();
    await diagram.getByRole("button", { name: "Copied" }).waitFor();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(copied, REPLY.slice(REPLY.indexOf("```mermaid"), REPLY.lastIndexOf("```") + 3));
  });

  void it("follows the theme without drawing again", async () => {
    const { page } = await open();
    await page.locator(".prose-folio .diagram svg").waitFor();
    const colors = await page.evaluate(async () => {
      const svg = document.querySelector(".prose-folio .diagram svg")!;
      const text = svg.querySelector("text")!;
      const before = getComputedStyle(text).fill;
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
      await new Promise((done) => requestAnimationFrame(() => done(null)));
      return {
        before,
        after: getComputedStyle(text).fill,
        same: document.querySelector(".prose-folio .diagram svg") === svg,
      };
    });
    assert.notEqual(colors.after, colors.before);
    assert.equal(colors.same, true);
  });

  void it("draws a note's diagrams in place, and a note of 300 stays smooth to scroll", async () => {
    const block = (n: number) =>
      `## Step ${n}\n\n\`\`\`mermaid\nflowchart LR\n  A${n}[Step ${n}] --> B${n}{Check ${n}}\n  B${n} -->|again| A${n}\n\`\`\`\n`;
    const { page } = await open("note", Array.from({ length: 300 }, (_, n) => block(n)).join("\n"));
    const opened = Date.now();
    await page.locator(".cm-diagram .diagram svg").first().waitFor();
    const firstDrawn = Date.now() - opened;
    await page.waitForTimeout(500);
    const timing = await page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      const frames: number[] = [];
      let last = performance.now();
      let running = true;
      const tick = (now: number) => {
        frames.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      for (let step = 0; step < 40; step++) {
        scroller.scrollTop += scroller.clientHeight;
        await new Promise((done) => setTimeout(done, 30));
      }
      running = false;
      return {
        reachedEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2000,
        drawn: document.querySelectorAll(".cm-diagram .diagram svg").length,
        longest: Math.max(...frames.slice(1)),
      };
    });
    console.log(
      `300-diagram note: first drawing after ${firstDrawn} ms, ${timing.drawn} on screen, longest frame while scrolling ${timing.longest.toFixed(0)} ms`,
    );
    assert.ok(timing.drawn > 0);
    assert.ok(timing.longest < 250, `a frame took ${timing.longest} ms`);
  });

  void it("refuses to save anything but a diagram", async () => {
    const { page } = await open();
    const outcome = await page.evaluate(() =>
      (
        window as unknown as {
          folio: { saveFile(file: unknown): Promise<boolean> };
        }
      ).folio
        .saveFile({ name: "x.sh", type: "sh", data: "#!/bin/sh" })
        .then(
          () => "saved",
          (error: Error) => error.message,
        ),
    );
    assert.match(outcome, /Only diagrams/);
  });
});
