import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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
 * same build. FOLIO_E2E_APP names a build to use instead.
 */
export function buildApp(): Promise<string> {
  built ??= (async () => {
    if (process.env.FOLIO_E2E_APP) return process.env.FOLIO_E2E_APP;
    const dir = resolve(tmpdir(), `folio-e2e-app-${await fingerprint()}`);
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
      await symlink(resolve(ROOT, "node_modules"), resolve(dir, "node_modules"), "dir");
      execFileSync("vp", ["build"], { cwd: dir, stdio: "ignore" });
      execFileSync("vp", ["pack"], { cwd: dir, stdio: "ignore" });
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

export async function launch(home: string, env: Record<string, string> = {}): Promise<Running> {
  const dir = await buildApp();
  const connection = await mkdtemp(resolve(tmpdir(), "folio-e2e-connection-"));
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [resolve(dir, "dist-desktop/desktop-main.mjs")],
    cwd: dir,
    env: {
      ...(process.env as Record<string, string>),
      FOLIO_HOME: home,
      FOLIO_CONNECTION_HOME: connection,
      ...env,
    },
  });
  const logs: string[] = [];
  app
    .process()
    .stderr?.on("data", (chunk: Buffer) => logs.push(...String(chunk).split("\n").filter(Boolean)));
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, logs, close: () => app.close() };
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
