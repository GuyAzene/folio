import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { syncDirectory } from "../src/files.ts";

describe("flushing a folder after a rename", () => {
  it("opens the folder to flush it, except on Windows, which can't", async () => {
    const missing = resolve(tmpdir(), `folio-missing-${randomUUID()}`);
    // On Windows nothing is opened, so not even a missing folder is noticed.
    await expect(syncDirectory(missing, "win32")).resolves.toBeUndefined();
    await expect(syncDirectory(missing, "linux")).rejects.toThrow(/ENOENT/);
    if (process.platform === "win32") return;
    const folder = await mkdtemp(resolve(tmpdir(), "folio-sync-"));
    try {
      await expect(syncDirectory(folder)).resolves.toBeUndefined();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
