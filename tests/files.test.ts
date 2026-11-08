import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { syncDirectory, writeAtomic } from "../src/files.ts";

describe("replacing a file", () => {
  it("replaces one that something else is reading for a moment", async () => {
    const folder = await mkdtemp(resolve(tmpdir(), "folio-replace-"));
    const target = resolve(folder, "mcp.json");
    await writeFile(target, "before");
    // A reader holding the file, as an editor, an antivirus scan or a test's polling does.
    const reader = await open(target, "r");
    let closed = false;
    const close = () => {
      if (closed) return Promise.resolve();
      closed = true;
      return reader.close();
    };
    const later = setTimeout(() => void close(), 300);
    try {
      await writeAtomic(target, "after");
      expect(await readFile(target, "utf8")).toBe("after");
    } finally {
      clearTimeout(later);
      await close();
      await rm(folder, { recursive: true, force: true });
    }
  });
});

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
