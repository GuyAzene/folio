import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { moveLegacyHome } from "../src/home.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function legacy() {
  const root = await mkdtemp(resolve(tmpdir(), "folio-home-test-"));
  roots.push(root);
  const from = resolve(root, "old", "folio");
  await mkdir(resolve(from, "sessions"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(from, "sessions", "chat.json"), "{}", { mode: 0o600 });
  return { root, from, to: resolve(root, ".folio") };
}

describe("Folio's home folder", () => {
  it("moves an earlier build's folder into ~/.folio once, keeping files and permissions", async () => {
    const { from, to } = await legacy();
    expect(moveLegacyHome(from, to)).toBe("moved");
    expect(await readFile(resolve(to, "sessions", "chat.json"), "utf8")).toBe("{}");
    expect((await stat(to)).mode & 0o777).toBe(0o700);
    await expect(stat(from)).rejects.toThrow();
    expect(moveLegacyHome(from, to)).toBe("kept");
  });

  it("never touches either folder when ~/.folio already exists", async () => {
    const { from, to } = await legacy();
    await mkdir(to);
    await writeFile(resolve(to, "marker"), "new");
    expect(moveLegacyHome(from, to)).toBe("kept");
    expect(await readFile(resolve(to, "marker"), "utf8")).toBe("new");
    expect(await readFile(resolve(from, "sessions", "chat.json"), "utf8")).toBe("{}");
  });
});
