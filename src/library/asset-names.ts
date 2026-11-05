/**
 * Figures in notes: image files kept beside a course's notes, named by their SHA-256, written in a
 * note as `![A figure|360](assets/<file>)` and loaded by the app as `folio-note://<course>/<file>`.
 * Shared by the main process, which stores and serves them, and the window, which shows them.
 */

export const ASSET_SCHEME = "folio-note";

/** A figure's file name: its SHA-256 and its kind. */
export const ASSET_FILE = /^[0-9a-f]{64}\.(?:png|jpg)$/;

const COURSE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where a note's figure loads from, for `assets/<file>` (or `./assets/<file>`); null otherwise. */
export function assetUrl(courseId: string, src: string): string | null {
  const file = /^(?:\.\/)?assets\/([^/?#\\]+)$/.exec(src.trim())?.[1];
  if (!file || !ASSET_FILE.test(file) || !COURSE.test(courseId)) return null;
  return `${ASSET_SCHEME}://${courseId}/${file}`;
}

/** The course and file a `folio-note://` address names, if it names exactly one figure. */
export function parseAssetUrl(url: string): { courseId: string; file: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.search || parsed.hash) return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  const file = /^\/([^/]+)$/.exec(parsed.pathname)?.[1];
  if (!file || !ASSET_FILE.test(file) || !COURSE.test(parsed.hostname)) return null;
  return { courseId: parsed.hostname, file };
}

/**
 * An image's description and width, written as Obsidian does: `![A figure|360](…)` is 360 pixels
 * wide. Anything after the last `|` that isn't a width stays part of the description.
 */
export function imageSize(alt: string): { alt: string; width?: number } {
  const match = /^(.*?)\s*\|\s*(\d{2,4})\s*$/.exec(alt);
  if (!match) return { alt };
  const width = Number(match[2]);
  return width >= 16 && width <= 2000 ? { alt: match[1]!, width } : { alt };
}
