import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFile, syncDirectory, writeAtomic } from "../src/files.ts";

const refused = () =>
  Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

/** A rename refused `times` times, then done; and the checks and waits around it. */
function refusing(times: number) {
  const seen = { moves: 0, checks: 0, pauses: [] as number[] };
  return {
    seen,
    options: {
      check: async () => void seen.checks++,
      move: async () => {
        if (seen.moves++ < times) throw refused();
      },
      pause: async (ms: number) => void seen.pauses.push(ms),
    },
  };
}

describe("a rename Windows refuses", () => {
  it("is tried again on Windows, checking the file again before each try", async () => {
    const { seen, options } = refusing(2);
    await replaceFile("from", "to", { ...options, platform: "win32" });
    expect(seen).toEqual({ moves: 3, checks: 3, pauses: [10, 20] });
  });

  it("fails at once elsewhere, where a refusal isn't a moment's", async () => {
    const { seen, options } = refusing(1);
    await expect(replaceFile("from", "to", { ...options, platform: "darwin" })).rejects.toThrow(
      /EPERM/,
    );
    expect(seen.moves).toBe(1);
  });

  it("stops when the file changed while it waited, and leaves it as it is", async () => {
    const { seen, options } = refusing(5);
    const check = async () => {
      if (++seen.checks === 2) throw new Error("mcp.json changed outside Folio.");
    };
    await expect(
      replaceFile("from", "to", { ...options, check, platform: "win32" }),
    ).rejects.toThrow("mcp.json changed outside Folio.");
    expect(seen.moves).toBe(1);
  });

  it("gives up after about three seconds, and on anything but a refusal", async () => {
    const { seen, options } = refusing(Infinity);
    await expect(replaceFile("from", "to", { ...options, platform: "win32" })).rejects.toThrow(
      /EPERM/,
    );
    expect(seen.pauses.reduce((sum, ms) => sum + ms, 0)).toBe(3270);
    const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const once = { tries: 0 };
    await expect(
      replaceFile("from", "to", {
        platform: "win32",
        move: async () => {
          once.tries++;
          throw missing;
        },
      }),
    ).rejects.toBe(missing);
    expect(once.tries).toBe(1);
  });
});

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
