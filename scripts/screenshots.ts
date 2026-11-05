// Pictures of Folio for the README, from the browser preview's synthetic courses: `vp run
// screenshots` serves the interface with `vp dev`, opens it in a hidden Electron window, sets up
// each scene and takes docs/images/<scene>-light.png and <scene>-dark.png at twice their size. A
// picture is replaced only when it looks different, so retaking them changes nothing until the
// interface does. The clip of the tutor answering, docs/images/tutor-light.webp and
// tutor-dark.webp, is recorded in real time and never comes out the same twice, so it is retaken
// only when a picture changed, when it is missing, or when named. The clock is fixed, so relative
// dates and the greeting come out the same on every run. Nothing opens on screen and nothing
// talks to a model. `vp run screenshots board clip` takes only those.
//
// On a pull request that changes the app, CI runs this and commits the pictures that changed:
// CI's pictures are the ones the README keeps. Another Mac draws text a little differently, so
// elsewhere the pictures that changed go to a temporary folder, to look at; `--write` puts them
// in docs/images all the same.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _electron, type Page } from "playwright-core";
import { looksDifferent } from "./picture-difference.ts";

const ROOT = resolve(import.meta.dirname, "..");
const IMAGES = resolve(ROOT, "docs/images");
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
 * The automaton lecture at its slide, with the chat about it beside: a chat opens beside the
 * page it was about from Chats. The question is scrolled to the top of the chat.
 */
async function besideLecture(page: Page): Promise<void> {
  await sidebar(page, "Chats").click();
  await page.getByText("Why the start state is accepting", { exact: true }).click();
  await page.getByRole("button", { name: /^Open beside/ }).click();
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

type Area = { x: number; y: number; width: number; height: number };
/** `fast` encodes quickly, for the clip's frames, which img2webp encodes again. */
type Capture = (area?: Area | null, fast?: boolean) => Promise<Buffer>;

/**
 * A hidden window on the preview, drawn at twice its size; its page is captured, never shown.
 * Nothing comes from the Mac that takes the pictures. The page is drawn at twice its size by
 * Chromium's emulation and captured by Chromium itself, since Playwright's screenshot of an
 * Electron window takes the screen's own scale (once on a Mac without Retina, as GitHub's are).
 * The scrollbars are hidden, since macOS draws them or not by its own setting and whether a
 * mouse is connected.
 */
async function window() {
  const main = resolve(await mkdtemp(resolve(tmpdir(), "folio-screenshots-")), "main.cjs");
  await writeFile(
    main,
    `const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("hide-scrollbars");
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
  /** The page, or an area of it, as a PNG at twice its size; anything else is refused. */
  const capture: Capture = async (area, fast = false) => {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      optimizeForSpeed: fast,
      ...(area && { clip: { ...area, scale: 1 } }),
    });
    const png = Buffer.from(data, "base64");
    const width = png.readUInt32BE(16);
    const expected = Math.round((area?.width ?? SIZE.width) * 2);
    if (width !== expected)
      throw new Error(`A picture came out ${width} pixels wide instead of ${expected}.`);
    return png;
  };
  return { page, capture, close: () => app.close() };
}

/** Opens the preview fresh, in a theme, on Home. */
async function home(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.goto(URL);
  await page.evaluate((theme) => {
    localStorage.clear();
    localStorage.setItem("folio.theme", theme);
    // The preview is a release behind, at 0.2.0; the README's pictures show Folio up to date.
    localStorage.setItem("folio.dismissedRelease", "0.2.0");
  }, theme);
  await page.reload();
  await page.getByPlaceholder("Ask about any of your courses").waitFor();
  // A focused box's caret blinks, so no two pictures of it would be alike.
  await page.addStyleTag({ content: "* { caret-color: transparent !important; }" });
}

/**
 * tutor-<theme>.webp, into `folder`: the automaton slide with a new chat beside it, the question
 * typed and sent, and the answer arriving, as an animated WebP that loops. Frames are taken as
 * fast as they come and each keeps its own duration; img2webp (from libwebp) joins them.
 */
async function clip(
  page: Page,
  capture: Capture,
  theme: "light" | "dark",
  folder: string,
): Promise<void> {
  await home(page, theme);
  await sidebar(page, "Computational Models").click();
  await page.getByText("Lecture 1 Finite automata", { exact: true }).click();
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
    while (recording) frames.push({ png: await capture(area, true), at: Date.now() });
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
  const out = resolve(folder, `tutor-${theme}.webp`);
  execFileSync("img2webp", [...args, "-o", out], { stdio: "ignore" });
  console.log(`${shown(out)} (${frames.length} frames)`);
}

const args = process.argv.slice(2);
const write = process.env.CI === "true" || args.includes("--write");
const only = args.filter((arg) => arg !== "--write");
const names = [...SCENES.map((scene) => scene.name), "clip"];
const unknown = only.filter((name) => !names.includes(name));
if (unknown.length) {
  console.error(`No picture is called ${unknown.join(", ")}. There are ${names.join(", ")}.`);
  process.exit(1);
}
/** Where the pictures that changed go: docs/images on CI or with --write, otherwise a folder. */
const folder = write ? IMAGES : await mkdtemp(resolve(tmpdir(), "folio-readme-pictures-"));
const shown = (path: string) => path.replace(`${ROOT}/`, "");
const taken = await mkdtemp(resolve(tmpdir(), "folio-pictures-"));
const changed: string[] = [];
const stop = await serve();
try {
  const { page, capture, close } = await window();
  try {
    for (const scene of SCENES.filter((scene) => !only.length || only.includes(scene.name)))
      for (const colors of ["light", "dark"] as const) {
        await home(page, colors);
        await scene.show(page);
        await stillness(page);
        const area = scene.main ? await page.locator("main").boundingBox() : null;
        const name = `${scene.name}-${colors}.png`;
        await writeFile(resolve(taken, name), await capture(area));
        const different = await looksDifferent(resolve(IMAGES, name), resolve(taken, name));
        if (different) {
          await copyFile(resolve(taken, name), resolve(folder, name));
          changed.push(name);
        }
        console.log(different ? shown(resolve(folder, name)) : `docs/images/${name} (unchanged)`);
      }
    const clipMissing = ["light", "dark"].some(
      (colors) => !existsSync(resolve(IMAGES, `tutor-${colors}.webp`)),
    );
    if (only.includes("clip") || (!only.length && (changed.length > 0 || clipMissing)))
      for (const colors of ["light", "dark"] as const) await clip(page, capture, colors, folder);
    else if (!only.length) console.log("docs/images/tutor-*.webp (unchanged: no picture changed)");
  } finally {
    await close();
  }
} finally {
  stop();
}
if (!write && (changed.length || only.includes("clip")))
  console.log(
    "\nThese are for looking at. On a pull request, CI commits the pictures that changed; " +
      "--write puts them in docs/images.",
  );
