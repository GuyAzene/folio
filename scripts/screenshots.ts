// Pictures of Folio for the README, from the browser preview's synthetic courses: `vp run
// screenshots` serves the interface with `vp dev`, opens it in a hidden Electron window, sets up
// each scene, and writes docs/images/<scene>-light.png and <scene>-dark.png at twice their size.
// The clock is fixed, so relative dates and the greeting come out the same on every run. Nothing
// opens on screen and nothing talks to a model. `vp run screenshots reader board` takes only
// those scenes.
import { spawn } from "node:child_process";
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
}

const sidebar = (page: Page, name: string) =>
  page.locator("aside").getByText(name, { exact: true }).first();

const SCENES: Scene[] = [
  {
    // A lecture with the tutor beside it: a chat reopens beside the page it was about.
    name: "reader",
    async show(page) {
      await sidebar(page, "Computational Models").click();
      await page.getByText("Why the start state is accepting", { exact: true }).click();
      await page.locator(".prose-folio svg").first().waitFor();
      // The slide the answer is about, and the question at the top of the chat.
      const slide = page.locator('[data-page="3"]');
      await slide.locator("canvas").waitFor();
      await slide.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await page.getByText("Why is the start state also accepting here?").evaluate((element) => {
        let chat = element.parentElement;
        while (chat && !/auto|scroll/.test(getComputedStyle(chat).overflowY))
          chat = chat.parentElement;
        chat?.scrollTo({ top: 0 });
      });
    },
  },
  {
    name: "study-notes",
    async show(page) {
      await sidebar(page, "Algorithms").click();
      await page.getByRole("tab", { name: "Study notes" }).click();
      await page.getByText("Breadth-first search", { exact: true }).first().click();
    },
  },
  {
    name: "notebook",
    async show(page) {
      await sidebar(page, "Notes").click();
      await page.getByText("Regular languages", { exact: true }).first().click();
      await page.locator(".cm-editor").getByText("Closure").waitFor();
    },
  },
  {
    name: "board",
    async show(page) {
      await sidebar(page, "Assignments").click();
    },
  },
  {
    // The + in the composer, finding lectures across courses.
    name: "add-context",
    async show(page) {
      await page.getByRole("button", { name: "Add to your question" }).click();
      await page.keyboard.type("lecture");
    },
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

const only = process.argv.slice(2);
const stop = await serve();
try {
  const { page, close } = await window();
  try {
    for (const scene of SCENES.filter((scene) => !only.length || only.includes(scene.name)))
      for (const colors of ["light", "dark"] as const) {
        await page.goto(URL);
        await page.evaluate((theme) => {
          localStorage.clear();
          localStorage.setItem("folio.theme", theme);
        }, colors);
        await page.reload();
        await page.getByPlaceholder("Ask about any of your courses").waitFor();
        await scene.show(page);
        await stillness(page);
        await page.screenshot({ path: resolve(ROOT, `docs/images/${scene.name}-${colors}.png`) });
        console.log(`docs/images/${scene.name}-${colors}.png`);
      }
  } finally {
    await close();
  }
} finally {
  stop();
}
