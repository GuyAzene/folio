/// <reference lib="dom" />
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { launch, recordExternalLinks, type Running } from "./app.ts";
import { seedHome } from "./seed.ts";

/**
 * Folio's window in Electron: what the page may ask for, load and reach, and that the things it
 * does use (links, copying, PDFs, math through the real sanitizer) still work under those rules.
 * Run with `vp run test:electron`; nothing here talks to a model.
 */

const REPLY = [
  "A formula with a bracket before a comparison, \\(E[X]>0\\), and an arrow, \\(p --> q\\).",
  "",
  "Read more [in the notes](https://example.com/notes).",
].join("\n");

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

async function open(
  options: { open?: "chat" | "lecture"; env?: Record<string, string> } = {},
): Promise<Running> {
  const seeded = await seedHome(REPLY, options.open);
  const app = await launch(seeded.home, options.env);
  running.push(app);
  return app;
}

void describe("Folio's window", () => {
  void it("keeps the sidebar button in one place, open or closed", async () => {
    const { page } = await open();
    const hide = page.getByRole("button", { name: "Hide sidebar" });
    const before = await hide.boundingBox();
    await page.screenshot({
      path: process.env.FOLIO_E2E_SHOTS
        ? `${process.env.FOLIO_E2E_SHOTS}/sidebar-open.png`
        : undefined,
      clip: { x: 0, y: 0, width: 420, height: 60 },
    });
    await hide.click();
    const show = page.getByRole("button", { name: "Show sidebar" });
    await show.waitFor();
    await page.waitForTimeout(400);
    const after = await show.boundingBox();
    await page.screenshot({
      path: process.env.FOLIO_E2E_SHOTS
        ? `${process.env.FOLIO_E2E_SHOTS}/sidebar-closed.png`
        : undefined,
      clip: { x: 0, y: 0, width: 420, height: 60 },
    });
    assert.deepEqual(after, before);
  });

  void it("moves from the tab strip's empty space and the frame, never over its buttons", async () => {
    const { page } = await open();
    // Whether a point moves the window, as Chromium decides: of the elements with an app region
    // that contain the point, the last in document order wins. Clicks there never reach the page,
    // so a click a test sends cannot show it; the regions themselves have to be read.
    const drags = (x: number, y: number) =>
      page.evaluate(
        ([px, py]) => {
          let moves = false;
          for (const element of document.querySelectorAll("*")) {
            const region = getComputedStyle(element).getPropertyValue("-webkit-app-region");
            if (region !== "drag" && region !== "no-drag") continue;
            const box = element.getBoundingClientRect();
            if (px >= box.left && px < box.right && py >= box.top && py < box.bottom)
              moves = region === "drag";
          }
          return moves;
        },
        [x, y],
      );
    const middle = async (name: string) => {
      const box = (await page.getByRole("button", { name }).boundingBox())!;
      return [box.x + box.width / 2, box.y + box.height / 2] as const;
    };
    const { width, height } =
      page.viewportSize() ??
      (await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      })));

    assert.equal(await drags(...(await middle("Hide sidebar"))), false);
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await page.getByRole("button", { name: "Show sidebar" }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await drags(...(await middle("Show sidebar"))), false, "the sidebar button");
    assert.equal(await drags(...(await middle("New tab"))), false, "the new-tab button");
    const tab = (await page.getByRole("tab").first().boundingBox())!;
    assert.equal(await drags(tab.x + tab.width / 2, tab.y + tab.height / 2), false, "a tab");
    const plus = (await page.getByRole("button", { name: "New tab" }).boundingBox())!;
    assert.equal(
      await drags(plus.x + plus.width + 40, plus.y + plus.height / 2),
      true,
      "the tab strip after its tabs",
    );
    assert.equal(await drags(width - 3, height / 2), true, "the frame beside the page");
    assert.equal(await drags(width / 2, height - 3), true, "the frame below the page");
    assert.equal(await drags(width / 2, height / 2), false, "the page itself");
  });

  void it("renders formulas that the sanitizer would otherwise strip", async () => {
    const { page } = await open();
    await page.locator(".prose-folio .math .katex").first().waitFor();
    const formulas = await page
      .locator(".prose-folio .math")
      .evaluateAll((nodes) =>
        nodes.map((node) => [(node as HTMLElement).dataset.tex, !!node.querySelector(".katex")]),
      );
    assert.deepEqual(formulas, [
      ["E[X]>0", true],
      ["p --> q", true],
    ]);
  });

  void it("opens a reply's link in the system browser, never in a window", async () => {
    const { app, page } = await open();
    const opened = await recordExternalLinks(app);
    await page.getByRole("link", { name: "in the notes" }).click();
    await page.waitForTimeout(300);
    assert.deepEqual(await opened(), ["https://example.com/notes"]);
    assert.equal(app.windows().length, 1);
  });

  void it("copies a reply to the clipboard", async () => {
    const { app, page } = await open();
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await page.getByRole("button", { name: "Copy" }).first().click();
    await page.getByRole("button", { name: "Copied" }).first().waitFor();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.match(copied, /E\[X\]>0/);
  });

  void it("shows a lecture's pages", async () => {
    const { page } = await open({ open: "lecture" });
    await page.locator("canvas").first().waitFor();
    await page.getByText("Synthetic Lecture 1").first().waitFor();
  });

  void it("reaches no network, and frames inside it load nothing", async () => {
    const { page } = await open();
    const fetched = await page.evaluate(() =>
      fetch("https://example.com/").then(
        () => "reached",
        () => "refused",
      ),
    );
    assert.equal(fetched, "refused");
    const framed = await page.evaluate(async () => {
      const frame = document.createElement("iframe");
      frame.src = "folio://app/index.html";
      document.body.append(frame);
      await new Promise((done) => setTimeout(done, 800));
      // Blocked outright, the frame holds an error page this page may not read.
      let href: string | undefined;
      try {
        href = frame.contentWindow?.location.href;
      } catch {
        href = "blocked";
      }
      frame.remove();
      return href;
    });
    assert.notEqual(framed, "folio://app/index.html");
  });

  void it("answers Folio's own page, and grants it nothing it does not use", async () => {
    const { page } = await open();
    const booted = await page.evaluate(() =>
      (window as unknown as { folio: { bootstrap(): Promise<unknown> } }).folio
        .bootstrap()
        .then(() => "answered"),
    );
    assert.equal(booted, "answered");
    const states = await page.evaluate(() =>
      Promise.all(
        ["geolocation", "notifications", "camera", "microphone"].map((name) =>
          navigator.permissions.query({ name: name as PermissionName }).then(
            (status) => status.state,
            () => "unsupported",
          ),
        ),
      ),
    );
    for (const state of states) assert.notEqual(state, "granted");
  });

  void it("asks for no permission beyond copying, as the inventory in log mode shows", async () => {
    const { page, logs } = await open({ env: { FOLIO_PERMISSIONS: "log" } });
    await page.locator(".prose-folio .math .katex").first().waitFor();
    await page.getByRole("button", { name: "Copy" }).first().click();
    await page.getByRole("button", { name: "Copied" }).first().waitFor();
    const asked = new Set(
      logs
        .filter((line) => line.startsWith("[permission] "))
        .map((line) => (JSON.parse(line.slice(13)) as { permission: string }).permission),
    );
    console.log(`Permissions asked for: ${[...asked].join(", ") || "none"}`);
    for (const permission of asked)
      assert.ok(
        ["clipboard-sanitized-write"].includes(permission),
        `unexpected permission: ${permission}`,
      );
  });
});
