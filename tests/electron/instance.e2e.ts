import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readdir, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { after, describe, it } from "node:test";
import type { ElectronApplication } from "playwright-core";
import { JobStore } from "../../src/jobs/store.ts";
import { launch, launchAgain, type Running } from "./app.ts";
import { seedHome } from "./seed.ts";

/**
 * One Folio per home: opening Folio while it already runs on that home, as opening Folio.app
 * beside a build from the checkout does, leaves before it touches anything there, and the Folio
 * already open comes forward. Run with `vp run test:electron`; nothing here talks to a model.
 */

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

// No study is queued on its own while a check runs, so only a second Folio could change the home.
const QUIET = { FOLIO_STUDY_DELAY_MS: "600000" };

/**
 * Everything in a home but the open Folio's own browser storage: each entry's mode, and each
 * file's size, time and contents. Folder times are left out, since a chat's run lease touches
 * its lock folder every two seconds.
 */
async function snapshot(home: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const paths = (await readdir(home, { recursive: true, withFileTypes: true })).map((entry) =>
    resolve(entry.parentPath, entry.name),
  );
  for (const path of [home, ...paths]) {
    const name = relative(home, path);
    if (name === "electron" || name.startsWith("electron/")) continue;
    const info = await lstat(path);
    const mode = (info.mode & 0o777).toString(8);
    entries.set(
      name,
      info.isSymbolicLink()
        ? `link ${await readlink(path)}`
        : info.isFile()
          ? `${mode} ${info.size} ${info.mtimeMs} ${createHash("sha256")
              .update(await readFile(path))
              .digest("hex")}`
          : mode,
    );
  }
  return entries;
}

/** Whether the open Folio's only window is minimized. */
const minimized = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized());

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let waited = 0; !(await check()); waited += 100) {
    if (waited > 10_000) throw new Error(`Waited too long for ${what}.`);
    await new Promise((ready) => setTimeout(ready, 100));
  }
}

void describe("A second Folio on the same home", () => {
  void it("leaves the home as it found it, and brings the open Folio forward", async () => {
    const seeded = await seedHome("A synthetic reply.");
    const first = await launch(seeded.home, QUIET);
    running.push(first);
    await first.page.getByText("Synthetic chat").first().waitFor();

    // A lecture the open Folio is studying: a second Folio's recovery would queue it again.
    const jobs = await JobStore.open(seeded.home);
    const job = jobs.createJob({
      courseId: seeded.courseId,
      documentIds: [seeded.lectureId],
      title: "Synthetic Lecture 1",
    });
    jobs.updateJob(job.id, { status: "running" });
    const node = jobs.addNode(job.id, {
      role: "run",
      title: "Study",
      task: "Read",
      parentId: null,
      status: "running",
    });
    // Opening any store tightens the home back to 0700, and a connection makes its folder.
    await chmod(seeded.home, 0o755);
    const connection = resolve(tmpdir(), `folio-e2e-unused-${randomUUID()}`);
    await first.app.evaluate(
      ({ BrowserWindow }) =>
        new Promise<void>((done) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.once("minimize", () => done());
          window.minimize();
        }),
    );
    const before = await snapshot(seeded.home);

    const code = await launchAgain(seeded.home, { ...QUIET, FOLIO_CONNECTION_HOME: connection });
    assert.equal(code, 0);
    await until(async () => !(await minimized(first.app)), "the open Folio to come forward");

    assert.deepEqual(await snapshot(seeded.home), before);
    await assert.rejects(lstat(connection), { code: "ENOENT" });
    assert.equal(jobs.job(job.id).status, "running");
    assert.equal(jobs.node(node.id).status, "running");
    jobs.close();
  });

  void it("opens the window again when the open Folio had closed it", async () => {
    const seeded = await seedHome("A synthetic reply.");
    const first = await launch(seeded.home, QUIET);
    running.push(first);
    await first.page.getByText("Synthetic chat").first().waitFor();
    // On a Mac, Folio keeps running with its window closed.
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const windows = () =>
      first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await until(async () => (await windows()) === 0, "the window to close");

    const reopened = first.app.waitForEvent("window");
    assert.equal(await launchAgain(seeded.home, QUIET), 0);
    await (await reopened).getByText("Synthetic chat").first().waitFor();
    assert.equal(await windows(), 1);
  });
});
