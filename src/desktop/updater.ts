import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app, autoUpdater as squirrel } from "electron";
import type { Installer } from "../self-update.ts";

/**
 * How a packaged Folio on a Mac updates itself: electron-updater downloads the release's zip and
 * checks it against the checksum in the release's latest-mac.yml, and macOS's own updater
 * (Squirrel.Mac, under Electron's autoUpdater) installs it only when it is signed by the same
 * Developer ID as the running Folio. That signature, not the checksum, is what keeps another app
 * out: both files come from the same release.
 *
 * Folio updates itself only from a build made for it: the release and the nightly carry
 * app-update.yml, which `scripts/package.ts` writes for a Developer ID build. It also needs to
 * replace itself where it is, so not from a disk image, nor from a copy macOS runs elsewhere
 * because it was never moved out of Downloads. Elsewhere this gives no Installer, and the window
 * links to the release's page.
 */
/** How long macOS's updater may take to check and unpack a downloaded update. */
const UNPACK_MS = 5 * 60_000;

export async function macInstaller(): Promise<Installer | null> {
  if (process.platform !== "darwin" || !app.isPackaged) return null;
  if (!existsSync(join(process.resourcesPath, "app-update.yml"))) return null;
  // The executable is Folio.app/Contents/MacOS/Folio; the update replaces Folio.app in its folder.
  const bundle = resolve(dirname(app.getPath("exe")), "../..");
  try {
    accessSync(dirname(bundle), constants.W_OK);
  } catch {
    return null;
  }

  const { autoUpdater, CancellationToken } = (await import("electron-updater")).default;
  // Downloads only when asked, the whole zip each time, and only a newer release.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;

  // electron-updater is one updater for the whole app, with one feed, one download and one proxy
  // for macOS's updater. A download starts only once the one before it has settled, as a stopped
  // one does a moment after it is stopped.
  let previous: Promise<unknown> = Promise.resolve();

  const downloadOne: Installer["download"] = async (feed, version, progress, signal) => {
    signal.throwIfAborted();
    autoUpdater.setFeedURL({ provider: "generic", url: feed });
    const found = await autoUpdater.checkForUpdates();
    if (!found?.isUpdateAvailable || found.updateInfo.version !== version)
      throw new Error(`The release's files are not Folio ${version}.`);
    signal.throwIfAborted();
    // macOS's updater says when it has checked and unpacked the update, after electron-updater
    // hands it the zip; listening before the download starts catches either answer.
    let settle: { done: () => void; fail: (error: Error) => void } | undefined;
    const unpacked = new Promise<void>((done, fail) => (settle = { done, fail }));
    // Handled where it is awaited; a refusal while the download itself fails is that failure.
    unpacked.catch(() => undefined);
    const ready = () => settle!.done();
    const refused = (error: Error) => settle!.fail(error);
    squirrel.once("update-downloaded", ready);
    squirrel.once("error", refused);
    const moved = (info: { percent: number }) => progress(info.percent);
    autoUpdater.on("download-progress", moved);
    const token = new CancellationToken();
    const stop = () => {
      token.cancel();
      settle!.fail(new Error("Stopped."));
    };
    signal.addEventListener("abort", stop, { once: true });
    let slow: ReturnType<typeof setTimeout> | undefined;
    try {
      await autoUpdater.downloadUpdate(token);
      progress(100);
      // A Mac takes seconds to check and unpack it; one that never answers fails, so the
      // student can try again rather than wait on "Getting ready" for good.
      slow = setTimeout(() => settle!.fail(new Error("macOS didn't answer.")), UNPACK_MS);
      await unpacked;
    } finally {
      clearTimeout(slow);
      signal.removeEventListener("abort", stop);
      autoUpdater.off("download-progress", moved);
      squirrel.off("update-downloaded", ready);
      squirrel.off("error", refused);
    }
  };

  return {
    download(feed, version, progress, signal) {
      const download = previous
        .catch(() => undefined)
        .then(() => downloadOne(feed, version, progress, signal));
      previous = download;
      return download;
    },
    install() {
      // Closes the window, quits through before-quit (which settles running replies), and macOS
      // opens the new Folio once this one has exited.
      autoUpdater.quitAndInstall();
    },
  };
}
