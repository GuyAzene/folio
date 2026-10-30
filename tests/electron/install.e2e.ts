import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";

/**
 * `vp run desktop:install` on the app `desktop:package` built, into temporary folders: it
 * installs and replaces Folio.app without leaving anything behind, refuses to replace another
 * app, and quits and reopens only the Folio running from the folder it replaces. Each Folio here
 * runs on a temporary home with no ChatGPT connection. Run with `vp run test:electron` after
 * `vp run desktop:package`; without a packaged app these checks are skipped.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const BUILT = resolve(ROOT, "release/mac-arm64/Folio.app");
const skip = existsSync(BUILT) ? false : "no packaged app; run `vp run desktop:package` first";

const started: number[] = [];
after(async () => {
  for (const pid of started) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

/** A home and connection folder of its own, so no Folio here touches ~/.folio. */
async function environment(): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    FOLIO_HOME: await mkdtemp(resolve(tmpdir(), "folio-install-home-")),
    FOLIO_CONNECTION_HOME: await mkdtemp(resolve(tmpdir(), "folio-install-connection-")),
    FOLIO_STUDY_DELAY_MS: "600000",
  };
}

function install(into: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [resolve(ROOT, "scripts/install.ts")], {
    cwd: ROOT,
    env: { ...env, FOLIO_INSTALL_DIR: into },
    encoding: "utf8",
  });
}

/** Process IDs of Folio running from `app`. */
function running(app: string): number[] {
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match &&
        match[2]!.startsWith(`${app}/Contents/MacOS/Folio`) &&
        !match[2]!.includes("Helper")
        ? [Number(match[1])]
        : [];
    });
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !check(); waited += 200) {
    if (waited > 20_000) throw new Error(`Waited too long for ${what}.`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

function open(app: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(resolve(app, "Contents/MacOS/Folio"), [], {
    env,
    detached: true,
    stdio: "ignore",
  });
  started.push(child.pid!);
  child.unref();
}

void describe("installing the packaged app", { skip }, () => {
  void it("installs, replaces the copy there, and leaves nothing behind", async () => {
    const into = await mkdtemp(resolve(tmpdir(), "folio-install-"));
    const first = install(into);
    assert.equal(first.status, 0, first.stderr);
    const app = resolve(into, "Folio.app");
    const before = (await stat(app)).ino;
    const again = install(into);
    assert.equal(again.status, 0, again.stderr);
    assert.notEqual((await stat(app)).ino, before, "the second install put a new copy in place");
    assert.deepEqual(await readdir(into), ["Folio.app"]);
    execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
    // Built here, never downloaded: nothing marks it for Gatekeeper.
    assert.ok(!execFileSync("xattr", [app], { encoding: "utf8" }).includes("quarantine"));
    await rm(into, { recursive: true, force: true });
  });

  void it("refuses to replace another app called Folio.app", async () => {
    const into = await mkdtemp(resolve(tmpdir(), "folio-install-"));
    const other = resolve(into, "Folio.app/Contents");
    await mkdir(other, { recursive: true });
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      "Add :CFBundleIdentifier string com.example.other",
      resolve(other, "Info.plist"),
    ]);
    const result = install(into);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another app, not Folio/);
    assert.deepEqual(await readdir(other), ["Info.plist"]);
    await rm(into, { recursive: true, force: true });
  });

  void it("quits the Folio it replaces and opens it again, leaving any other Folio alone", async () => {
    const into = await mkdtemp(resolve(tmpdir(), "folio-install-"));
    assert.equal(install(into).status, 0);
    const app = resolve(into, "Folio.app");
    // One Folio from the folder being replaced, and one from the build, each on its own home.
    const env = await environment();
    open(app, env);
    open(BUILT, await environment());
    await until(() => running(app).length === 1 && running(BUILT).length === 1, "both to start");
    const [before] = running(app);
    const [bystander] = running(BUILT);
    await new Promise((done) => setTimeout(done, 3000));

    const result = install(into, env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Quitting Folio/);
    assert.match(result.stdout, /Folio is open again/);
    await until(() => running(app).length === 1, "Folio to open again");
    const [reopened] = running(app);
    started.push(reopened!);
    assert.notEqual(reopened, before, "the old Folio quit and a new one opened");
    assert.deepEqual(running(BUILT), [bystander], "the other Folio kept running");

    // Quitting by signal finishes like ⌘Q: the process leaves.
    process.kill(reopened!, "SIGTERM");
    await until(() => running(app).length === 0, "the reopened Folio to quit");
    await rm(into, { recursive: true, force: true });
  });
});
