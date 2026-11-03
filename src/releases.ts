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

/** What is kept on disk: the student's switch and GitHub's last answer. */
interface Kept {
  version: 1;
  /** Off only when the student turns the check off in Settings. */
  on: boolean;
  /** When GitHub last answered, and the latest release's tag: null when there is none. */
  answer: { checkedAt: number; tag: string | null } | null;
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
  #kept: Kept = { version: 1, on: true, answer: null };
  #writing: Promise<void> = Promise.resolve();
  #failedAt: number | undefined;
  #checking: Promise<void> | undefined;
  /** Stops the request under way, when the student turns the check off. */
  #asking: AbortController | undefined;

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

  /**
   * Reads what was kept once. A missing or unreadable file is the default: on, never asked. The
   * student's switch holds even when the answer beside it does not read; that answer is none, as
   * is one in the shape written before the switch was kept here (a nightly's), so Folio asks again.
   */
  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(this.#file, "utf8"));
      } catch {
        return;
      }
      if (!isRecord(raw) || raw.version !== 1) return;
      const answer = raw.answer;
      const usable =
        isRecord(answer) &&
        Number.isFinite(answer.checkedAt) &&
        (answer.tag === null || isTag(answer.tag));
      this.#kept = {
        version: 1,
        on: raw.on !== false,
        answer: usable
          ? { checkedAt: answer.checkedAt as number, tag: answer.tag as string | null }
          : null,
      };
    })();
    return this.#loaded;
  }

  /**
   * This Folio's version, whether the check is on, and the kept latest release when it is newer
   * and the check is on. Never asks GitHub.
   */
  async view(): Promise<ReleaseView> {
    await this.#load();
    const { on, answer } = this.#kept;
    const tag = on ? answer?.tag : null;
    const latest = tag ? parseVersion(tag) : null;
    const newer = !!latest && !!this.#current && compareVersions(latest, this.#current) > 0;
    return {
      version: this.#version,
      on,
      newer:
        newer && tag
          ? { version: tag.replace(/^v/, ""), url: RELEASE_PAGE + encodeURIComponent(tag) }
          : null,
    };
  }

  /**
   * Turns the check on or off, kept in Folio's home. Off, nothing is asked: a request under way
   * is stopped, and an answer that still arrives is dropped.
   */
  async setOn(on: boolean): Promise<ReleaseView> {
    // Stopped before anything is awaited, so a check that has not reached GitHub never does. A
    // check asked for once it is on again starts afresh, not waiting on the stopped one.
    if (!on) {
      this.#asking?.abort();
      this.#checking = undefined;
    }
    this.#failedAt = undefined;
    await this.#load();
    await this.#keep((kept) => ({ ...kept, on }));
    return this.view();
  }

  /**
   * Asks GitHub when the check is on and the kept answer is a day old, or an hour after a check
   * that failed, then returns the view. It never throws: offline or refused, the kept answer stays.
   */
  async check(): Promise<ReleaseView> {
    if (!this.#checking) {
      const checking = this.#ask().finally(() => {
        if (this.#checking === checking) this.#checking = undefined;
      });
      this.#checking = checking;
    }
    await this.#checking;
    return this.view();
  }

  async #ask(): Promise<void> {
    // Made before anything is awaited, so turning the check off at any point stops this one; a
    // stopped check changes nothing, neither the answer nor when Folio asks next.
    const asking = new AbortController();
    this.#asking = asking;
    const stopped = () => asking.signal.aborted;
    const now = this.#now();
    try {
      await this.#load();
      if (!this.#source || !this.#kept.on || stopped()) return;
      const recent = (time: number | undefined, span: number) =>
        time !== undefined && now >= time && now - time < span;
      if (recent(this.#kept.answer?.checkedAt, CHECK_EVERY_MS) || recent(this.#failedAt, RETRY_MS))
        return;
      const response = await this.#fetch(this.#source, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "Folio",
        },
        signal: AbortSignal.any([asking.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      let tag: string | null = null;
      // A 404 is an answer: no published release yet.
      if (response.status === 404) await response.body?.cancel();
      else if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`GitHub answered ${response.status}.`);
      } else {
        tag = releaseTag(JSON.parse(await capped(response, MAX_BYTES)));
        if (!tag) throw new Error("GitHub's answer names no release.");
      }
      // Stopped by the student while GitHub answered: the answer is dropped, even if the check
      // was turned on again since.
      await this.#keep((kept) =>
        kept.on && !stopped() ? { ...kept, answer: { checkedAt: now, tag } } : kept,
      );
      if (!stopped()) this.#failedAt = undefined;
    } catch {
      // Offline, refused or unreadable: the kept answer stays, and Folio asks again in an hour.
      // Stopped by the student, it is no failure: turned on again, Folio asks at once.
      if (!stopped()) this.#failedAt = now;
    } finally {
      if (this.#asking === asking) this.#asking = undefined;
    }
  }

  /** Writes one change at a time, each to what the last one kept, so a late answer never undoes Off. */
  #keep(change: (kept: Kept) => Kept): Promise<void> {
    const written = this.#writing.then(async () => {
      const kept = change(this.#kept);
      if (kept === this.#kept) return;
      await writeAtomic(this.#file, `${JSON.stringify(kept)}\n`);
      this.#kept = kept;
    });
    this.#writing = written.catch(() => undefined);
    return written;
  }
}
