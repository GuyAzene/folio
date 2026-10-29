/// <reference lib="dom" />
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { SYNTHETIC_LECTURE, syntheticPdf } from "../fixtures/synthetic-pdf.ts";
import { launch, type Running } from "./app.ts";
import { seedHome } from "./seed.ts";

/**
 * Studying on its own, in a real window with no ChatGPT connection: a lecture already in the
 * library and one just added both wait for ChatGPT, and one that stops being a lecture leaves
 * the queue. Run with `vp run test:electron`; nothing here talks to a model.
 */

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

interface Bridge {
  importFiles(courseId: string, paths: string[]): Promise<{ document?: { id: string } }[]>;
  listJobs(): Promise<{ documentIds: string[]; status: string; waitingFor: string | null }[]>;
  updateDocument(id: string, patch: object, revision: number): Promise<unknown>;
  listDocuments(): Promise<{ id: string; revision: number }[]>;
}

void describe("studying on its own", () => {
  void it("queues found and new lectures to wait for ChatGPT, and drops one that stops being a lecture", async () => {
    const seeded = await seedHome("A synthetic reply.", "chat");
    const added = resolve(seeded.home, "Lecture 2.pdf");
    await writeFile(added, syntheticPdf([["Synthetic Lecture 2"], ...SYNTHETIC_LECTURE]));
    const app = await launch(seeded.home, { FOLIO_STUDY_DELAY_MS: "300" });
    running.push(app);
    const { page } = app;
    const jobs = () =>
      page.evaluate(() => (window as unknown as { folio: Bridge }).folio.listJobs());
    const until = async (check: () => Promise<boolean>) => {
      for (let waited = 0; !(await check()); waited += 100) {
        if (waited > 10_000) throw new Error("Timed out.");
        await page.waitForTimeout(100);
      }
    };

    // The lecture already in the library is found and waits for ChatGPT.
    await until(async () => (await jobs()).length === 1);
    assert.deepEqual(
      (await jobs()).map((job) => [job.documentIds, job.status, job.waitingFor]),
      [[[seeded.lectureId], "queued", "connection"]],
    );

    // A lecture added now joins it.
    const imported = await page.evaluate(
      ([courseId, path]) =>
        (window as unknown as { folio: Bridge }).folio.importFiles(courseId!, [path!]),
      [seeded.courseId, added],
    );
    const newId = imported[0]!.document!.id;
    await until(async () => (await jobs()).length === 2);

    // Made an assignment, the first one leaves the queue.
    await page.evaluate(async (id) => {
      const bridge = (window as unknown as { folio: Bridge }).folio;
      const document = (await bridge.listDocuments()).find((item) => item.id === id)!;
      await bridge.updateDocument(id, { role: "assignment" }, document.revision);
    }, seeded.lectureId);
    await until(async () => (await jobs()).length === 1);
    assert.deepEqual(
      (await jobs()).map((job) => job.documentIds),
      [[newId]],
    );
  });
});
