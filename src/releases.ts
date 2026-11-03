import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ReleaseView } from "./desktop/api.ts";
import { writeAtomic } from "./files.ts";
import { capped } from "./live-catalog.ts";
import { urlProblem } from "./mcp/config.ts";

/**
 * Whether a newer Folio is out. Folio is not signed with an Apple Developer ID, so it cannot
 * update itself; instead it asks GitHub for the repository's latest release, at most once a day
 * and only while the student leaves the check on, and the window links to that release's page,
 * which opens in the browser. Nothing is downloaded or installed.
 *
 * The request goes to GitHub's public API with no account and carries nothing about the student:
 * only the name Folio, as GitHub asks every client to send. The answer is kept in
 * `release.json` in Folio's home, so a restart shows it without asking again. GitHub's latest
 * release is never a pre-release, so the nightly is never announced; a nightly carries the
 * version of the release it follows, and hears of the next one.
 */

export const LATEST_RELEASE = "https://api.github.com/repos/GuyAzene/folio/releases/latest";
/** A release's page, by its tag: built here, never taken from GitHub's answer. */
export const RELEASE_PAGE = "https://github.com/GuyAzene/folio/releases/tag/";

/** How old the kept answer may be before GitHub is asked again. */
export const CHECK_EVERY_MS = 24 * 3_600_000;
/** After a check that failed, how long before the next one. */
export const RETRY_MS = 3_600_000;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1024 * 1024;

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/;
const NUMERIC = /^\d+$/;

export interface Version {
  core: [string, string, string];
  pre: string[];
}

/** A semantic version, with or without a leading v; null when it is not one. */
export function parseVersion(text: string): Version | null {
  const match = SEMVER.exec(text.startsWith("v") ? text.slice(1) : text);
  if (!match) return null;
  return { core: [match[1]!, match[2]!, match[3]!], pre: match[4]?.split(".") ?? [] };
}

/** Numbers have no leading zeros, so the longer is larger, however many digits they have. */
function compareNumbers(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Orders two versions as semantic versioning does: by major, minor and patch; a pre-release
 * before its release, its parts compared in turn (numbers by value, before words); build
 * metadata ignored. Negative when `a` is older.
 */
export function compareVersions(a: Version, b: Version): number {
  for (let part = 0; part < 3; part++) {
    const order = compareNumbers(a.core[part]!, b.core[part]!);
    if (order) return order;
  }
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let part = 0; part < Math.min(a.pre.length, b.pre.length); part++) {
    const x = a.pre[part]!;
    const y = b.pre[part]!;
    const xNumber = NUMERIC.test(x);
    const yNumber = NUMERIC.test(y);
    let order: number;
    if (xNumber && yNumber) order = compareNumbers(x, y);
    else if (xNumber !== yNumber) order = xNumber ? -1 : 1;
    else order = x < y ? -1 : x > y ? 1 : 0;
    if (order) return order;
  }
  return a.pre.length - b.pre.length;
}

/** Where releases are asked for: GitHub, another https address (tests), or nowhere ("off"). */
export function releaseSource(value: string | undefined): string | null {
  if (value === undefined || value === "") return LATEST_RELEASE;
  if (value === "off" || urlProblem(value)) return null;
  return value;
}

/** The answer as kept on disk. */
interface Kept {
  version: 1;
  /** When GitHub last answered. */
  checkedAt: number;
  /** The latest release's tag; null when the repository has no release. */
  tag: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A tag that names a version, like v0.2.0. */
const isTag = (tag: unknown): tag is string =>
  typeof tag === "string" && tag.length <= 64 && parseVersion(tag) !== null;

/** The tag of a published release in GitHub's answer, when it names a version. */
function releaseTag(body: unknown): string | null {
  if (!isRecord(body) || body.draft === true || body.prerelease === true) return null;
  return isTag(body.tag_name) ? body.tag_name : null;
}

export class ReleaseCheck {
  readonly #file: string;
  readonly #version: string;
  readonly #current: Version | null;
  readonly #source: string | null;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #loaded: Promise<void> | undefined;
  #kept: Kept | undefined;
  #failedAt: number | undefined;
  #checking: Promise<void> | undefined;

  constructor(options: {
    home: string;
    /** This Folio's version. */
    version: string;
    /** GitHub unless given; null never asks. */
    source?: string | null;
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    this.#file = resolve(options.home, "release.json");
    this.#version = options.version;
    this.#current = parseVersion(options.version);
    this.#source = options.source === undefined ? LATEST_RELEASE : options.source;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  /** Reads the kept answer once; one that is missing or unreadable is none. */
  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      try {
        const raw: unknown = JSON.parse(await readFile(this.#file, "utf8"));
        if (!isRecord(raw) || raw.version !== 1 || (raw.tag !== null && !isTag(raw.tag))) return;
        const checkedAt = Number.isFinite(raw.checkedAt) ? (raw.checkedAt as number) : 0;
        this.#kept = { version: 1, checkedAt, tag: raw.tag };
      } catch {
        // Never checked, or the file was edited into something else: Folio asks again.
      }
    })();
    return this.#loaded;
  }

  /** This Folio's version, and the kept latest release when it is newer. Never asks GitHub. */
  async view(): Promise<ReleaseView> {
    await this.#load();
    const tag = this.#kept?.tag;
    const latest = tag ? parseVersion(tag) : null;
    const newer = !!latest && !!this.#current && compareVersions(latest, this.#current) > 0;
    return {
      version: this.#version,
      newer:
        newer && tag
          ? { version: tag.replace(/^v/, ""), url: RELEASE_PAGE + encodeURIComponent(tag) }
          : null,
    };
  }

  /**
   * Asks GitHub when the kept answer is a day old, an hour after a check that failed, then
   * returns the view. It never throws: offline or refused, the kept answer stays.
   */
  async check(): Promise<ReleaseView> {
    this.#checking ??= this.#ask().finally(() => {
      this.#checking = undefined;
    });
    await this.#checking;
    return this.view();
  }

  async #ask(): Promise<void> {
    await this.#load();
    if (!this.#source) return;
    const now = this.#now();
    const recent = (time: number | undefined, span: number) =>
      time !== undefined && now >= time && now - time < span;
    if (recent(this.#kept?.checkedAt, CHECK_EVERY_MS) || recent(this.#failedAt, RETRY_MS)) return;
    try {
      const response = await this.#fetch(this.#source, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "Folio",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // No published release yet.
      if (response.status === 404) {
        await response.body?.cancel();
        await this.#keep({ version: 1, checkedAt: now, tag: null });
        return;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`GitHub answered ${response.status}.`);
      }
      const tag = releaseTag(JSON.parse(await capped(response, MAX_BYTES)));
      if (!tag) throw new Error("GitHub's answer names no release.");
      await this.#keep({ version: 1, checkedAt: now, tag });
      this.#failedAt = undefined;
    } catch {
      // Offline, refused or unreadable: the kept answer stays, and Folio asks again in an hour.
      this.#failedAt = now;
    }
  }

  async #keep(kept: Kept): Promise<void> {
    await writeAtomic(this.#file, `${JSON.stringify(kept)}\n`);
    this.#kept = kept;
  }
}
