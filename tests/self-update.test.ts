import { describe, expect, it } from "vite-plus/test";
import type { UpdateView } from "../src/desktop/api.ts";
import { type Installer, SelfUpdate } from "../src/self-update.ts";

const DOWNLOADS = "https://github.com/GuyAzene/folio/releases/download/";
const RELEASE = { version: "0.3.0", tag: "v0.3.0" };

/** A synthetic installer whose downloads finish, fail or report progress when a test says. */
function installer() {
  const downloads: {
    feed: string;
    version: string;
    progress: (percent: number) => void;
    signal: AbortSignal;
    finish: () => void;
    fail: (error: Error) => void;
  }[] = [];
  let installs = 0;
  const fake: Installer = {
    download(feed, version, progress, signal) {
      return new Promise<void>((finish, fail) => {
        downloads.push({ feed, version, progress, signal, finish, fail });
        signal.addEventListener("abort", () => fail(new Error("Stopped.")));
      });
    },
    install() {
      installs++;
    },
  };
  return { fake, downloads, installs: () => installs };
}

/** A SelfUpdate whose every view change is recorded, as the window would see it. */
function selfUpdate(fake: Installer | null) {
  const seen: (UpdateView | null)[] = [];
  const update: SelfUpdate = new SelfUpdate({
    installer: fake,
    downloads: DOWNLOADS,
    changed: () => seen.push(update.view(RELEASE.version)),
  });
  return { update, seen };
}

const settled = () => new Promise((done) => setTimeout(done, 0));

describe("Folio updating itself", () => {
  it("offers nothing where it can't update itself, and refuses to start", () => {
    const { update } = selfUpdate(null);
    expect(update.available).toBe(false);
    expect(update.view(RELEASE.version)).toBeNull();
    expect(() => update.start(RELEASE)).toThrow("can't update itself");
  });

  it("offers a newer release, and nothing without one", () => {
    const { update } = selfUpdate(installer().fake);
    expect(update.view(RELEASE.version)).toEqual({ step: "available" });
    expect(update.view(null)).toBeNull();
  });

  it("downloads only when asked, from the release's own folder, then restarts into it", async () => {
    const { fake, downloads, installs } = installer();
    const { update, seen } = selfUpdate(fake);
    expect(downloads).toHaveLength(0);
    update.start(RELEASE);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.feed).toBe(`${DOWNLOADS}v0.3.0`);
    expect(downloads[0]!.version).toBe("0.3.0");
    expect(update.view(RELEASE.version)).toEqual({ step: "downloading", percent: 0 });
    // Progress in whole percents, each once, never back.
    for (const percent of [12.4, 12.9, 47, 30, 100, 140]) downloads[0]!.progress(percent);
    expect(() => update.restart(RELEASE.version)).toThrow("isn't downloaded yet");
    downloads[0]!.finish();
    await settled();
    expect(seen).toEqual([
      { step: "downloading", percent: 0 },
      { step: "downloading", percent: 12 },
      { step: "downloading", percent: 47 },
      { step: "downloading", percent: 100 },
      { step: "ready" },
    ]);
    expect(installs()).toBe(0);
    expect(update.ready()).toEqual(RELEASE);
    update.restart(RELEASE.version);
    expect(installs()).toBe(1);
  });

  it("keeps one download however often the student clicks", async () => {
    const { fake, downloads } = installer();
    const { update } = selfUpdate(fake);
    update.start(RELEASE);
    update.start(RELEASE);
    expect(downloads).toHaveLength(1);
    downloads[0]!.finish();
    await settled();
    // Downloaded, a click again downloads nothing more.
    update.start(RELEASE);
    expect(downloads).toHaveLength(1);
    expect(update.view(RELEASE.version)).toEqual({ step: "ready" });
  });

  it("says when a download fails, and starts afresh on Try again", async () => {
    const { fake, downloads } = installer();
    const { update } = selfUpdate(fake);
    update.start(RELEASE);
    downloads[0]!.progress(60);
    downloads[0]!.fail(new Error("The code signature did not match."));
    await settled();
    expect(update.view(RELEASE.version)).toEqual({ step: "failed" });
    expect(update.ready()).toBeNull();
    expect(() => update.restart(RELEASE.version)).toThrow("isn't downloaded yet");
    update.start(RELEASE);
    expect(downloads).toHaveLength(2);
    expect(update.view(RELEASE.version)).toEqual({ step: "downloading", percent: 0 });
  });

  it("stops a download when updates go off, and ignores what it says after", async () => {
    const { fake, downloads } = installer();
    const { update, seen } = selfUpdate(fake);
    update.start(RELEASE);
    update.stop();
    expect(downloads[0]!.signal.aborted).toBe(true);
    expect(update.view(RELEASE.version)).toEqual({ step: "available" });
    const before = seen.length;
    downloads[0]!.progress(80);
    downloads[0]!.finish();
    await settled();
    expect(seen).toHaveLength(before);
    expect(update.view(RELEASE.version)).toEqual({ step: "available" });
  });

  it("keeps a finished download when updates go off, since quitting installs it", async () => {
    const { fake, downloads, installs } = installer();
    const { update } = selfUpdate(fake);
    update.start(RELEASE);
    downloads[0]!.finish();
    await settled();
    update.stop();
    expect(update.view(RELEASE.version)).toEqual({ step: "ready" });
    // The window keeps showing it, though the check that found it is off.
    expect(update.ready()).toEqual(RELEASE);
    update.restart(RELEASE.version);
    expect(installs()).toBe(1);
  });

  it("moves to a newer release, stopping the download of the older one", async () => {
    const { fake, downloads } = installer();
    const { update } = selfUpdate(fake);
    update.start(RELEASE);
    update.start({ version: "0.3.1", tag: "v0.3.1" });
    expect(downloads[0]!.signal.aborted).toBe(true);
    expect(downloads[1]!.feed).toBe(`${DOWNLOADS}v0.3.1`);
    // The older release is offered afresh; the newer is the one downloading.
    expect(update.view(RELEASE.version)).toEqual({ step: "available" });
    expect(update.view("0.3.1")).toEqual({ step: "downloading", percent: 0 });
    downloads[0]!.finish();
    await settled();
    expect(update.view("0.3.1")).toEqual({ step: "downloading", percent: 0 });
    // Restarting needs the release that was downloaded, not the one the window last showed.
    downloads[1]!.finish();
    await settled();
    expect(() => update.restart(RELEASE.version)).toThrow("isn't downloaded yet");
    expect(() => update.restart("0.3.1")).not.toThrow();
  });
});
