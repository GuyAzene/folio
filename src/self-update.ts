import type { UpdateView } from "./desktop/api.ts";

/**
 * Folio updating itself to a newer release when the student asks. ReleaseCheck finds the release;
 * this downloads it on the student's click and restarts into it on the next. Nothing downloads
 * by itself. Once an update is downloaded, quitting Folio installs it too.
 *
 * The download goes through an Installer: on a Mac, electron-updater and macOS's own updater
 * (`src/desktop/updater.ts`), and in tests a synthetic one. Where Folio can't update itself, as
 * on Windows, from the checkout or from a disk image, there is no Installer, and the sidebar's
 * line links to the release's page instead.
 */

/** Downloads an update and installs it. */
export interface Installer {
  /**
   * Downloads the release whose update files are in the folder `feed`, checks that it is
   * `version`, and resolves once it is ready to install. Reports progress from 0 to 100. Stopped
   * by `signal`, or refused on the way, it rejects.
   */
  download(
    feed: string,
    version: string,
    progress: (percent: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Quits Folio, installs the downloaded update and opens the new Folio. */
  install(): void;
}

type State =
  | { version: string; step: "downloading"; percent: number; stop: AbortController }
  | { version: string; step: "ready" | "failed" };

export class SelfUpdate {
  readonly #installer: Installer | null;
  readonly #downloads: string;
  readonly #changed: () => void;
  #state: State | null = null;

  constructor(options: {
    /** None where Folio can't update itself. */
    installer: Installer | null;
    /** The folder of each release's files, by tag: GitHub's downloads, or a test's. */
    downloads: string;
    /** Called whenever the view changes, as a download moves on. */
    changed: () => void;
  }) {
    this.#installer = options.installer;
    this.#downloads = options.downloads;
    this.#changed = options.changed;
  }

  /** Whether Folio can update itself here. */
  get available(): boolean {
    return this.#installer !== null;
  }

  /** How far Folio is in updating to `version`, the newer release; null when it can't. */
  view(version: string | null): UpdateView | null {
    if (!this.#installer || !version) return null;
    const state = this.#state;
    if (state?.version !== version) return { step: "available" };
    return state.step === "downloading"
      ? { step: "downloading", percent: state.percent }
      : { step: state.step };
  }

  /**
   * Downloads `release`. A download of it that is under way or done is kept; a failed one starts
   * again. A download of another release is stopped first.
   */
  start(release: { version: string; tag: string }): void {
    const installer = this.#installer;
    if (!installer) throw new Error("Folio can't update itself here.");
    const previous = this.#state;
    if (previous?.version === release.version && previous.step !== "failed") return;
    if (previous?.step === "downloading") previous.stop.abort();
    const state: State = {
      version: release.version,
      step: "downloading",
      percent: 0,
      stop: new AbortController(),
    };
    this.#state = state;
    this.#changed();
    const progress = (percent: number) => {
      // Whole percents, so the window hears of each step once.
      const rounded = Math.floor(Math.min(100, Math.max(0, percent)));
      if (this.#state !== state || !(rounded > state.percent)) return;
      state.percent = rounded;
      this.#changed();
    };
    const settle = (step: "ready" | "failed") => {
      if (this.#state !== state) return;
      this.#state = { version: release.version, step };
      this.#changed();
    };
    installer
      .download(
        this.#downloads + encodeURIComponent(release.tag),
        release.version,
        progress,
        state.stop.signal,
      )
      .then(
        () => settle("ready"),
        () => settle("failed"),
      );
  }

  /**
   * Stops a download under way, when the student turns updates off. One already downloaded
   * stays, since macOS installs it when Folio quits.
   */
  stop(): void {
    const state = this.#state;
    if (state?.step !== "downloading") return;
    state.stop.abort();
    this.#state = null;
    this.#changed();
  }

  /** Restarts into `version`, once it is downloaded. */
  restart(version: string): void {
    const state = this.#state;
    if (!this.#installer || state?.version !== version || state.step !== "ready")
      throw new Error("That update isn't downloaded yet.");
    this.#installer.install();
  }
}
