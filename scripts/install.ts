// Puts the Folio.app that `desktop:package` built into /Applications, in place of the copy there.
// A Folio running from there is asked to quit first, so its chats settle; the new app is copied
// beside the old one and swapped in by renaming, and opens again if Folio was open. An app built
// on this Mac was never downloaded, so it carries no quarantine and opens without Gatekeeper's
// prompt. Folio's data in ~/.folio is not touched.
// FOLIO_INSTALL_DIR installs into another folder instead. A Folio running from there is quit and
// opened again too, with this script's environment, which is how the install checks run it.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BUILT = resolve(ROOT, "release/mac-arm64/Folio.app");
const ID = "io.github.guyazene.folio";
const elsewhere = process.env.FOLIO_INSTALL_DIR;
const target = resolve(elsewhere ?? "/Applications", "Folio.app");
const executable = resolve(target, "Contents/MacOS/Folio");

const run = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Every Folio running now, by the app it runs from (its main process, not its helpers). */
function runningFolios(): { pid: number; app: string }[] {
  return run("ps", ["-axo", "pid=,command="])
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*\/Folio\.app)\/Contents\/MacOS\/Folio(?:\s|$)/.exec(line);
      return match ? [{ pid: Number(match[1]), app: resolve(match[2]!) }] : [];
    });
}

const runningHere = () => runningFolios().filter((folio) => folio.app === target);

const bundleId = (app: string) =>
  run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    resolve(app, "Contents/Info.plist"),
  ]);

/**
 * Asks each Folio running from `target` to quit, as ⌘Q would, and waits for it to be gone. The
 * signal goes to that process alone, so a Folio running from anywhere else is left as it is.
 */
async function quit(): Promise<void> {
  for (const { pid } of runningHere()) process.kill(pid, "SIGTERM");
  for (let waited = 0; runningHere().length; waited += 250) {
    if (waited > 30_000)
      throw new Error("Folio did not quit within 30 seconds. Quit it, then install again.");
    await new Promise((done) => setTimeout(done, 250));
  }
}

if (!existsSync(BUILT)) throw new Error(`Nothing to install: ${BUILT} is missing.`);
if (existsSync(target) && bundleId(target) !== ID)
  throw new Error(`${target} is another app, not Folio. Nothing was changed.`);
// Another copy would hold Folio's single-instance lock: the new app would only bring it forward.
const others = runningFolios().filter((folio) => folio.app !== target);
if (!elsewhere && others.length)
  throw new Error(
    `Folio is running from ${others[0]!.app}. Quit it, then install again; afterwards, open the copy in Applications.`,
  );

const wasOpen = runningHere().length > 0;
if (wasOpen) {
  console.log("Quitting Folio…");
  await quit();
}

// Copied next to the old app, then renamed into place: no moment without a complete Folio.app.
const incoming = resolve(dirname(target), ".Folio.app.incoming");
const outgoing = resolve(dirname(target), ".Folio.app.outgoing");
await rm(incoming, { recursive: true, force: true });
await rm(outgoing, { recursive: true, force: true });
run("ditto", [BUILT, incoming]);
run("codesign", ["--verify", "--deep", "--strict", incoming]);
if (existsSync(target)) await rename(target, outgoing);
try {
  await rename(incoming, target);
} catch (error) {
  if (existsSync(outgoing)) await rename(outgoing, target);
  throw error;
}
await rm(outgoing, { recursive: true, force: true });

const commit = run("git", ["-C", ROOT, "log", "-1", "--format=%h %s"]);
const changed = run("git", ["-C", ROOT, "status", "--porcelain"]).length > 0;
console.log(`\nInstalled ${target}`);
console.log(`  from ${commit}${changed ? ", with uncommitted changes" : ""}`);

if (wasOpen) {
  if (elsewhere) spawn(executable, [], { detached: true, stdio: "ignore" }).unref();
  else execFileSync("open", [target]);
  console.log("  Folio is open again.");
} else if (!elsewhere && run("ps", ["-axo", "command="]).includes("dist-desktop/desktop-main.mjs"))
  // A Folio started from the checkout holds the same lock, so the app would only bring it forward.
  console.log("  A Folio started from the checkout is running; quit it before opening the app.");
