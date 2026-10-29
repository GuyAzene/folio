import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Folio keeps everything it owns in one self-contained folder, ~/.folio: the ChatGPT sign-in,
 * courses with their original files and knowledge, background jobs, chats and notes.
 * FOLIO_HOME selects another folder, for tests and trial runs.
 */
export function folioHome(): string {
  return resolve(process.env.FOLIO_HOME ?? resolve(homedir(), ".folio"));
}

/** Where builds before 2026-10-28 kept the same data. */
export const LEGACY_HOME = resolve(homedir(), ".local", "share", "folio");

/**
 * Moves an earlier build's folder to the new home, once: only when the new home does not
 * exist yet. A single rename keeps every file and permission as it was.
 */
export function moveLegacyHome(from: string, to: string): "moved" | "kept" {
  if (existsSync(to) || !existsSync(from)) return "kept";
  try {
    renameSync(from, to);
    return "moved";
  } catch {
    // Another volume, or another Folio already moved it: leave both folders as they are.
    return "kept";
  }
}

/** The home for this process, after moving earlier data into it when it is the default. */
export function prepareHome(): string {
  const home = folioHome();
  if (!process.env.FOLIO_HOME) moveLegacyHome(LEGACY_HOME, home);
  return home;
}
