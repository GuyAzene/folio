// Pictures of Folio for the README, from the browser preview's synthetic courses: `vp run
// screenshots` serves the interface with `vp dev`, opens it in a hidden Electron window, sets up
// each scene, and writes docs/images/<scene>-light.png and <scene>-dark.png at twice their size,
// then the clip of the tutor answering, docs/images/tutor-light.webp and tutor-dark.webp.
// The clock is fixed, so relative dates and the greeting come out the same on every run. Nothing
// opens on screen and nothing talks to a model. `vp run screenshots board clip` takes only
// those.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _electron, type Page } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 5199;
const URL = `http://127.0.0.1:${PORT}/`;
const SIZE = { width: 1280, height: 800 };
const NOW = new Date("2026-11-03T10:30:00");

interface Scene {
  name: string;
  /** Brings the preview from Home to the scene. */
  show(page: Page): Promise<void>;
  /** Only the main view, without the sidebar, for the README's smaller pictures. */
  main?: true;
}

const sidebar = (page: Page, name: string) =>
  page.locator("aside").getByText(name, { exact: true }).first();

/**
 * The automaton lecture at its slide, with the chat about it beside: a chat reopens beside the
 * page it was about. The question is scrolled to the top of the chat.
 */
async function besideLecture(page: Page): Promise<void> {
  await sidebar(page, "Computational Models").click();
  await page.getByText("Why the start state is accepting", { exact: true }).click();
  await page.locator(".prose-folio svg").first().waitFor();
  const slide = page.locator('[data-page="3"]');
  await slide.locator("canvas").waitFor();
  await slide.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.getByText("Why is the start state also accepting here?").evaluate((element) => {
    let chat = element.parentElement;
    while (chat && !/auto|scroll/.test(getComputedStyle(chat).overflowY)) chat = chat.parentElement;
    chat?.scrollTo({ top: 0 });
  });
}

const SCENES: Scene[] = [
  {
    name: "study-notes",
    async show(page) {
      await sidebar(page, "Algorithms").click();
      await page.getByRole("tab", { name: "Study notes" }).click();
      await page.getByText("Breadth-first search", { exact: true }).first().click();
    },
    main: true,
  },
  {
    name: "notebook",
    async show(page) {
      await sidebar(page, "Notes").click();
      await page.getByText("Regular languages", { exact: true }).first().click();
      await page.locator(".cm-editor").getByText("Closure").waitFor();
    },
    main: true,
  },
  {
    name: "board",
    async show(page) {
      await sidebar(page, "Assignments").click();
    },
    main: true,
  },
  {
    // The + in the chat beside a lecture: the page on screen, an image, another lecture or course.
    name: "add-context",
    async show(page) {
      await besideLecture(page);
      await page.getByRole("button", { name: "Add to your question" }).last().click();
    },
    main: true,
  },
];

/** Waits for the page to stop moving: fonts loaded and no running transitions. */
async function stillness(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((frame) => requestAnimationFrame(() => frame(null))));
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getTiming().iterations !== Infinity,
        ),
    undefined,
    { timeout: 10_000 },
  );
}

/** The preview on its own port, stopped with everything it started. */
async function serve(): Promise<() => void> {
  const server = spawn("vp", ["dev", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
  });
  const stop = () => process.kill(-server.pid!, "SIGTERM");
  for (let waited = 0; ; waited += 250) {
    const up = await fetch(URL).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return stop;
    if (waited > 30_000) {
      stop();
      throw new Error(`The preview did not start on ${URL}.`);
    }
    await new Promise((done) => setTimeout(done, 250));
  }
}

/** A hidden window on the preview, at twice its size; its page is captured, never shown. */
async function window() {
  const main = resolve(await mkdtemp(resolve(tmpdir(), "folio-screenshots-")), "main.cjs");
  await writeFile(
    main,
    `const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, ...${JSON.stringify(SIZE)},
    webPreferences: { backgroundThrottling: false } });
  void window.loadURL("about:blank");
});`,
  );
  const electron = createRequire(import.meta.url)("electron") as string;
  const app = await _electron.launch({ executablePath: electron, args: [main] });
  const page = await app.firstWindow();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    ...SIZE,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.clock.setFixedTime(NOW);
  return { page, close: () => app.close() };
}

/** Opens the preview fresh, in a theme, on Home. */
async function home(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.goto(URL);
  await page.evaluate((theme) => {
    localStorage.clear();
    localStorage.setItem("folio.theme", theme);
  }, theme);
  await page.reload();
  await page.getByPlaceholder("Ask about any of your courses").waitFor();
}

/**
 * docs/images/tutor-<theme>.webp: the automaton slide with a new chat beside it, the question
 * typed and sent, and the answer arriving, as an animated WebP that loops. Frames are taken as
 * fast as they come and each keeps its own duration; img2webp (from libwebp) joins them.
 */
async function clip(page: Page, theme: "light" | "dark"): Promise<void> {
  await home(page, theme);
  await sidebar(page, "Computational Models").click();
  await page.getByRole("button", { name: /^(Open|Resume)/ }).click();
  const slide = page.locator('[data-page="3"]');
  await slide.locator("canvas").waitFor();
  await slide.evaluate((element) => element.scrollIntoView({ block: "start" }));
  // A lecture opens with a new chat beside it.
  const box = page.getByRole("textbox", { name: "Message Folio" });
  await box.waitFor();
  await stillness(page);
  const area = (await page.locator("main").boundingBox())!;

  const frames: { png: Buffer; at: number }[] = [];
  let recording = true;
  const record = (async () => {
    while (recording) frames.push({ png: await page.screenshot({ clip: area }), at: Date.now() });
  })();
  await page.waitForTimeout(600);
  await box.click();
  await page.keyboard.type("Why is the start state also accepting here?", { delay: 45 });
  await page.keyboard.press("Enter");
  // Out of the chat, so the diagram doesn't show the toolbar it has under the pointer.
  await page.mouse.move(area.x + 120, area.y + 420);
  await page.getByText("Lecture 1 Finite automata", { exact: false }).last().waitFor();
  await page.locator(".prose-folio svg").first().waitFor({ timeout: 20_000 });
  await stillness(page);
  await page.waitForTimeout(400);
  recording = false;
  await record;

  const dir = await mkdtemp(resolve(tmpdir(), "folio-clip-"));
  // Lossless: lossy frames, stored as changes, leave traces of what a frame replaced.
  const args = ["-loop", "0", "-lossless", "-m", "4"];
  for (const [index, frame] of frames.entries()) {
    const path = resolve(dir, `${String(index).padStart(4, "0")}.png`);
    await writeFile(path, frame.png);
    // The last frame stays a while before the loop starts over.
    const duration = index + 1 < frames.length ? frames[index + 1]!.at - frame.at : 3000;
    args.push("-d", String(Math.max(20, duration)), path);
  }
  const out = resolve(ROOT, `docs/images/tutor-${theme}.webp`);
  execFileSync("img2webp", [...args, "-o", out], { stdio: "ignore" });
  console.log(`docs/images/tutor-${theme}.webp (${frames.length} frames)`);
}

const only = process.argv.slice(2);
const stop = await serve();
try {
  const { page, close } = await window();
  try {
    for (const scene of SCENES.filter((scene) => !only.length || only.includes(scene.name)))
      for (const colors of ["light", "dark"] as const) {
        await home(page, colors);
        await scene.show(page);
        await stillness(page);
        const area = scene.main ? await page.locator("main").boundingBox() : null;
        await page.screenshot({
          path: resolve(ROOT, `docs/images/${scene.name}-${colors}.png`),
          ...(area && { clip: area }),
        });
        console.log(`docs/images/${scene.name}-${colors}.png`);
      }
    if (!only.length || only.includes("clip"))
      for (const colors of ["light", "dark"] as const) await clip(page, colors);
  } finally {
    await close();
  }
} finally {
  stop();
}
