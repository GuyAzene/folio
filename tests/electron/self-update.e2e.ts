/// <reference lib="dom" />
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { _electron, type ElectronApplication } from "playwright-core";
import { parse } from "yaml";

/**
 * A packaged Folio updating itself, end to end: it finds a newer release on a synthetic GitHub on
 * this Mac, downloads nothing until the student clicks, downloads the release's zip on the click,
 * and on Restart quits, lets macOS install the update in place and opens the new Folio.
 *
 * macOS installs an update only when it is signed by the same Developer ID as the running app, so
 * this needs two builds signed that way, which CI's pull-request builds are not:
 * FOLIO_E2E_APP names the older Folio.app, built without FOLIO_DISTRIBUTE so these checks can
 * drive it, and FOLIO_E2E_UPDATE the release/ folder of a newer build, with its zip and
 * latest-mac.yml. Without them the check is skipped.
 *
 * macOS opens the updated Folio itself, without this test's environment, so for that moment the
 * Folio variables are set in launchd's user session (`launchctl setenv`), and taken back after:
 * the reopened Folio runs on a temporary home, never on ~/.folio.
 *
 * electron-updater keeps a downloaded update in ~/Library/Caches/folio-updater, whatever the home,
 * and skips a download it already has. The check empties that folder before and after, so it sees
 * the download; a Folio of the student's own then downloads its next update afresh.
 */

const APP = process.env.FOLIO_E2E_APP ?? "";
const UPDATE = process.env.FOLIO_E2E_UPDATE ?? "";
const skip =
  process.platform === "darwin" &&
  APP.endsWith(".app") &&
  existsSync(resolve(UPDATE, "latest-mac.yml"))
    ? false
    : "needs FOLIO_E2E_APP, a Developer ID Folio.app, and FOLIO_E2E_UPDATE, a newer build's release folder";

const CACHE = resolve(homedir(), "Library/Caches/folio-updater");
const servers: Server[] = [];
const started: ElectronApplication[] = [];
const sessionVariables = new Set<string>();
const folders: string[] = [];
let installed = "";
after(async () => {
  await Promise.allSettled(started.map((app) => app.close()));
  for (const pid of running(installed)) process.kill(pid, "SIGKILL");
  for (const name of sessionVariables) execFileSync("launchctl", ["unsetenv", name]);
  for (const server of servers) server.close();
  await Promise.all(folders.map((path) => rm(path, { recursive: true, force: true })));
  if (!skip) await rm(CACHE, { recursive: true, force: true });
});

const folder = async (name: string) => {
  const path = await mkdtemp(resolve(tmpdir(), `folio-self-update-${name}-`));
  folders.push(path);
  return path;
};

/** The version in a Folio.app's Info.plist. */
const versionOf = (app: string) =>
  execFileSync(
    "plutil",
    [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      resolve(app, "Contents/Info.plist"),
    ],
    { encoding: "utf8" },
  ).trim();

/** Process IDs of Folio running from `app`. */
function running(app: string): number[] {
  if (!app) return [];
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match && match[2]!.startsWith(`${app}/Contents/MacOS/Folio`) ? [Number(match[1])] : [];
    });
}

async function until(what: string, test: () => Promise<boolean> | boolean, ms: number) {
  for (let waited = 0; !(await test()); waited += 500) {
    if (waited > ms) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((ready) => setTimeout(ready, 500));
  }
}

/**
 * A synthetic GitHub on this Mac: its API names `tag` as the latest release, and its downloads
 * serve the files in `folder` under that tag. Every request's path is kept.
 */
async function startGitHub(tag: string, folder: string) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    requests.push(path);
    if (path === "/repos/GuyAzene/folio/releases/latest") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tag_name: tag, draft: false, prerelease: false }));
      return;
    }
    const prefix = `/download/${tag}/`;
    const name = path.startsWith(prefix) ? path.slice(prefix.length) : "";
    const file = resolve(folder, name);
    if (!name || name.includes("/") || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    void stat(file).then(({ size }) => {
      response.writeHead(200, { "content-length": size });
      createReadStream(file).pipe(response);
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, requests };
}

void describe("a packaged Folio updating itself", { skip }, () => {
  void it("downloads a newer release on the student's click and restarts into it", async () => {
    const info = parse(await readFile(resolve(UPDATE, "latest-mac.yml"), "utf8")) as {
      version: string;
      files: { url: string }[];
    };
    const newer = info.version;
    const zip = info.files[0]!.url;
    const current = versionOf(APP);
    assert.notEqual(current, newer, "FOLIO_E2E_UPDATE must be a newer build than FOLIO_E2E_APP.");

    // The older Folio, copied with its signature to a folder Folio may replace itself in. Its real
    // path, as macOS reopens it there: the temporary folder is behind the /var link.
    installed = resolve(await realpath(await folder("applications")), "Folio.app");
    execFileSync("ditto", [APP, installed]);
    await rm(CACHE, { recursive: true, force: true });
    const github = await startGitHub(`v${newer}`, UPDATE);
    const environment = {
      FOLIO_HOME: await folder("home"),
      FOLIO_CONNECTION_HOME: await folder("connection"),
      FOLIO_SKILL_HOME: await folder("skills"),
      FOLIO_MODEL_CATALOG: "off",
      FOLIO_RELEASES: `${github.base}/repos/GuyAzene/folio/releases/latest`,
      FOLIO_RELEASE_DOWNLOADS: `${github.base}/download/`,
    };
    const app = await _electron.launch({
      executablePath: resolve(installed, "Contents/MacOS/Folio"),
      env: { ...(process.env as Record<string, string>), ...environment },
    });
    started.push(app);
    const page = await app.firstWindow();

    // Found, and offered; nothing is downloaded before the click.
    const offer = page.getByRole("button", { name: `Folio ${newer} is out` });
    await offer.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1_000);
    assert.deepEqual(
      github.requests.filter((path) => path.startsWith("/download/")),
      [],
    );
    await offer.click();
    const restart = page.getByRole("button", { name: `Restart to update to ${newer}` });
    await restart.waitFor({ timeout: 180_000 });
    // The release's own files, by its tag, the zip once.
    assert.deepEqual(
      github.requests.filter((path) => path.startsWith("/download/")),
      [`/download/v${newer}/latest-mac.yml`, `/download/v${newer}/${zip}`],
    );

    // macOS reopens the new Folio without this test's environment: for that moment its Folio
    // variables live in the session, so it opens on a home of its own.
    const reopenedHome = await folder("reopened-home");
    const session = { ...environment, FOLIO_HOME: reopenedHome, FOLIO_RELEASES: "off" };
    for (const [name, value] of Object.entries(session)) {
      execFileSync("launchctl", ["setenv", name, value]);
      sessionVariables.add(name);
    }
    const before = running(installed);
    await restart.click();
    await until(
      "the older Folio to quit",
      () => before.every((pid) => !running(installed).includes(pid)),
      60_000,
    );
    await until("macOS to install the update", () => versionOf(installed) === newer, 120_000);
    await until("the new Folio to open", () => running(installed).length > 0, 60_000);
    await until(
      "the new Folio to open on its own home",
      async () => (await readdir(reopenedHome)).length > 0,
      30_000,
    );
    // The session's variables go as soon as the new Folio has them.
    for (const name of sessionVariables) execFileSync("launchctl", ["unsetenv", name]);
    sessionVariables.clear();
    execFileSync("codesign", ["--verify", "--deep", "--strict", installed]);
    assert.equal(basename(installed), "Folio.app");
  });
});
