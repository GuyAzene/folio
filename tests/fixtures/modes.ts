import { stat } from "node:fs/promises";
import { expect } from "vitest";

/**
 * Checks a file's or folder's permissions. Windows keeps only whether a file may be written,
 * which is all chmod sets there; its user profile, not the file, keeps other people out. So on
 * Windows only that is checked.
 */
export async function expectMode(path: string, mode: number): Promise<void> {
  const actual = (await stat(path)).mode & 0o777;
  if (process.platform === "win32") expect(actual & 0o200).toBe(mode & 0o200);
  else expect(actual).toBe(mode);
}
