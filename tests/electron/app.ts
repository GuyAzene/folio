import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

/**
 * Folio in a real window, for checks the browser preview cannot make: the Electron bridge, the
 * main process's rules and Chromium's own sanitizing and layout. The app is built from the
 * current source into a folder of its own, so a Folio the owner has open keeps its files, and
 * each run has its own home and no ChatGPT connection, so no model request can happen.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCES = [
  "app",
  "src",
  "tests/fixtures",
  "index.html",
  "capture.html",
  "vite.config.ts",
  "svelte.config.js",
  "tsconfig.json",
  "tsconfig.app.json",
  "package.json",
];
const electronPath = createRequire(import.meta.url)("electron") as string;

let built: Promise<string> | undefined;

/** A fingerprint of the source the app is built from, so an unchanged app is built once. */
async function fingerprint(): Promise<string> {
  const hash = createHash("sha256");
  for (const path of SOURCES) {
    const entries = (await stat(resolve(ROOT, path))).isDirectory()
      ? (await readdir(resolve(ROOT, path), { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => resolve(entry.parentPath, entry.name))
          .sort()
      : [resolve(ROOT, path)];
    for (const file of entries) hash.update(file).update(await readFile(file));
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Builds Folio from the current source once; test files running at the same time wait for the
 * same build. FOLIO_E2E_APP names a build to use instead: a built folder, or a packaged Folio.app
 * or Folio.exe.
 */
export function buildApp(): Promise<string> {
  built ??= (async () => {
    if (process.env.FOLIO_E2E_APP) return process.env.FOLIO_E2E_APP;
    // The temporary folder's real path: Windows may give it a short name, as RUNNER~1, which
    // Vite resolves to the long one, and then refuses the pages as outside the build.
    const dir = resolve(await realpath(tmpdir()), `folio-e2e-app-${await fingerprint()}`);
    const done = resolve(dir, ".built");
    const exists = (path: string) =>
      stat(path).then(
        () => true,
        () => false,
      );
    if (await exists(done)) return dir;
    // The first test file to get here builds; the others wait for it.
    const building = await mkdir(`${dir}.lock`).then(
      () => true,
      () => false,
    );
    if (!building) {
      for (let waited = 0; !(await exists(done)); waited += 500) {
        if (waited > 300_000) throw new Error("Building Folio for these checks took too long.");
        await new Promise((ready) => setTimeout(ready, 500));
      }
      return dir;
    }
    try {
      await rm(dir, { recursive: true, force: true });
      for (const path of SOURCES)
        await cp(resolve(ROOT, path), resolve(dir, path), { recursive: true });
      // A junction on Windows, which needs no administrator, as a folder link would.
      const link = process.platform === "win32" ? "junction" : "dir";
      await symlink(resolve(ROOT, "node_modules"), resolve(dir, "node_modules"), link);
      // Through a shell, which also starts vp where it is a .cmd shim. A failed build says why.
      execSync("vp build", { cwd: dir, stdio: "pipe" });
      execSync("vp pack", { cwd: dir, stdio: "pipe" });
      await writeFile(done, "");
      console.log(`Built Folio for these checks in ${dir}.`);
      return dir;
    } finally {
      await rm(`${dir}.lock`, { recursive: true, force: true });
    }
  })();
  return built;
}

export interface Running {
  app: ElectronApplication;
  page: Page;
  /** The main process's stderr, line by line. */
  logs: string[];
  close(): Promise<void>;
}

/** How to start the app under test on `home`, with no ChatGPT connection unless `env` names one. */
async function command(home: string, env: Record<string, string>) {
  const dir = await buildApp();
  // A packaged app runs its own executable and the code in its archive.
  const packaged = dir.endsWith(".app") || dir.endsWith(".exe");
  const connection = await mkdtemp(resolve(tmpdir(), "folio-e2e-connection-"));
  // An added routine folder's ~ is this folder, never the developer's own home.
  const skills = await mkdtemp(resolve(tmpdir(), "folio-e2e-skills-"));
  return {
    executablePath: dir.endsWith(".app")
      ? resolve(dir, "Contents/MacOS/Folio")
      : packaged
        ? dir
        : electronPath,
    args: packaged ? [] : [resolve(dir, "dist-desktop/desktop-main.mjs")],
    cwd: packaged ? undefined : dir,
    env: {
      ...(process.env as Record<string, string>),
      FOLIO_HOME: home,
      FOLIO_CONNECTION_HOME: connection,
      FOLIO_SKILL_HOME: skills,
      // Pi's live model list and GitHub's latest release are never fetched; a test that wants
      // one serves its own.
      FOLIO_MODEL_CATALOG: "off",
      FOLIO_RELEASES: "off",
      ...env,
    },
  };
}

export async function launch(home: string, env: Record<string, string> = {}): Promise<Running> {
  const app = await _electron.launch(await command(home, env));
  const logs: string[] = [];
  app
    .process()
    .stderr?.on("data", (chunk: Buffer) => logs.push(...String(chunk).split("\n").filter(Boolean)));
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, logs, close: () => app.close() };
}

/**
 * Opens Folio once more on `home`, as opening the app a second time would, and resolves with its
 * exit code. There is no window to wait for: a second Folio on a home that is open should leave.
 */
export async function launchAgain(
  home: string,
  env: Record<string, string> = {},
): Promise<number | null> {
  const { executablePath, args, cwd, env: environment } = await command(home, env);
  const child = spawn(executablePath, args, { cwd, env: environment, stdio: "ignore" });
  return new Promise((done, fail) => {
    const stuck = setTimeout(() => {
      child.kill();
      fail(new Error("Folio, opened a second time on the same home, did not leave."));
    }, 20_000);
    child.once("error", fail);
    child.once("exit", (code) => {
      clearTimeout(stuck);
      done(code);
    });
  });
}

/** Replaces opening a link in the system browser with a list, so a test sees what would open. */
export async function recordExternalLinks(
  app: ElectronApplication,
): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  return () => app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []);
}

/**
 * Waits for the page to stop moving: hiding the sidebar slides the tab strip with a transition,
 * and measured halfway its buttons are not where they will be. A fixed pause was not always
 * enough on GitHub's virtual Macs. Looping animations, like a spinner, do not count.
 */
export async function stillness(page: Page): Promise<void> {
  // A change made this frame starts its transition at the next one.
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
