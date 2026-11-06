import { createHash } from "node:crypto";
import { BrowserWindow, type Session } from "electron";
import { pixelSize } from "../library/images.ts";
import {
  MAX_TILES,
  TILE_HEIGHT,
  TILE_WIDTH,
  tileCuts,
  tileLines,
  type CapturePayload,
  type NoteInspection,
  type NoteLayout,
  type NoteRenderer,
  type NoteRenderRequest,
  type NoteRendering,
} from "../library/note-render.ts";

export interface NoteCaptureOptions {
  /** The hidden page's address: Folio's own capture.html, or the dev server's. */
  url: string;
  /** The capture's own session, made ready (its protocols and its rules) before first use. */
  session: () => Session;
}

/** How long one picture of a note may take, from opening the page to the last picture. */
const TIME_LIMIT = 30_000;
/** Pictures kept, so the tutor looking at part 2 after part 1 draws nothing again. */
const CACHED = 6;
const QUALITY = 80;
/**
 * A close-up is drawn at twice the size, for formulas and small notation. The whole note is drawn
 * at that size to take it, so a very long note gets less, to keep the drawing's memory bounded.
 */
const closeUpScale = (height: number) => (height <= 12_000 ? 2 : height <= 20_000 ? 1.5 : 1);

/**
 * Draws a note, as Folio shows it, into pictures for the tutor (`view_note`). Each drawing opens
 * a hidden window on capture.html, in its own in-memory session with no bridge to the app, draws
 * the note through Chromium's debugging protocol, takes its pictures, and closes the window. One
 * drawing at a time; a stopped reply or a quit closes the window at once.
 */
export class NoteCapture {
  readonly #options: NoteCaptureOptions;
  readonly #cache = new Map<string, NoteRendering>();
  readonly #open = new Set<BrowserWindow>();
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: NoteCaptureOptions) {
    this.#options = options;
  }

  readonly render: NoteRenderer = (request, signal) => {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          request.content,
          request.view,
          request.closeUp ?? null,
          request.courseId,
          request.courseName,
          request.documents,
        ]),
      )
      .digest("hex");
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return Promise.resolve(cached);
    }
    const drawn = this.#queue.then(() => this.#draw(request, signal));
    this.#queue = drawn.catch(() => undefined);
    return drawn.then((rendering) => {
      this.#cache.set(key, rendering);
      while (this.#cache.size > CACHED) this.#cache.delete(this.#cache.keys().next().value!);
      return rendering;
    });
  };

  /** Closes any window still drawing; later drawings are refused. Called when Folio quits. */
  close(): void {
    this.#closed = true;
    for (const window of this.#open) if (!window.isDestroyed()) window.destroy();
    this.#open.clear();
  }

  async #draw(request: NoteRenderRequest, signal?: AbortSignal): Promise<NoteRendering> {
    if (this.#closed) throw new Error("Folio is closing.");
    signal?.throwIfAborted();
    const window = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      backgroundColor: "#ffffff",
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
      webPreferences: {
        session: this.#options.session(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        // Windows hardly draws a window that is never shown, so a screenshot there can wait for
        // a frame that never comes; drawn offscreen, the page has frames of its own.
        offscreen: process.platform === "win32",
      },
    });
    this.#open.add(window);
    let reason: Error | undefined;
    const stop = (why: Error) => {
      reason ??= why;
      if (!window.isDestroyed()) window.destroy();
    };
    const onAbort = () => stop(new DOMException("The reply was stopped.", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => stop(new Error("Folio couldn't draw the note in time.")),
      TIME_LIMIT,
    );
    // The page never goes anywhere else.
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    try {
      await window.loadURL(this.#options.url);
      const contents = window.webContents;
      const devtools = contents.debugger;
      devtools.attach("1.3");
      const send = (method: string, params?: object) =>
        devtools.sendCommand(method, params) as Promise<Record<string, unknown>>;
      const run = <T>(code: string) => contents.executeJavaScript(code, true) as Promise<T>;
      const metrics = (height: number, scale = 1) =>
        send("Emulation.setDeviceMetricsOverride", {
          width: TILE_WIDTH,
          height: Math.max(1, Math.round(height)),
          deviceScaleFactor: scale,
          mobile: false,
        });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: "light" },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      await metrics(TILE_HEIGHT);
      const payload: CapturePayload = {
        content: request.content,
        view: request.view,
        courseId: request.courseId,
        courseName: request.courseName,
        documents: request.documents,
      };
      let layout = await run<NoteLayout>(`folioCapture.render(${JSON.stringify(payload)})`);
      // The editor draws only what is in view: the view grows to the whole note until it holds.
      const tallest = TILE_HEIGHT * MAX_TILES;
      for (let pass = 0; pass < 6; pass++) {
        await metrics(Math.min(layout.height, tallest));
        const next = await run<NoteLayout>("folioCapture.settle()");
        const settled = Math.abs(next.height - layout.height) < 1;
        layout = next;
        if (settled) break;
      }
      const inspection = await run<NoteInspection>("folioCapture.inspect()");
      const height = Math.min(layout.height, tallest);
      const shot = async (top: number, bottom: number, scale = 1) => {
        signal?.throwIfAborted();
        const result = await send("Page.captureScreenshot", {
          format: "jpeg",
          quality: QUALITY,
          clip: { x: 0, y: top, width: TILE_WIDTH, height: bottom - top, scale: 1 },
          fromSurface: true,
        });
        const jpeg = Buffer.from(String(result.data), "base64");
        // A picture of another width would not be the note as the student sees it.
        if (pixelSize(jpeg)?.width !== TILE_WIDTH * scale)
          throw new Error("Folio drew the note at the wrong size.");
        return new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
      };
      const base = {
        view: request.view,
        width: TILE_WIDTH,
        height: layout.height,
        complete: layout.complete && layout.height <= tallest,
        findings: inspection.findings,
        lines: inspection.lines,
      };
      if (request.closeUp) {
        const { from, to } = request.closeUp;
        const band = await run<{ top: number; bottom: number } | null>(
          `folioCapture.locate(${Number(from)}, ${Number(to)})`,
        );
        if (!band) throw new Error("Those lines aren't drawn in the note.");
        const top = Math.max(0, Math.floor(band.top) - 12);
        const bottom = Math.min(height, Math.ceil(band.bottom) + 12, top + TILE_HEIGHT / 2);
        const scale = closeUpScale(height);
        await metrics(height, scale);
        await run<NoteLayout>("folioCapture.settle()");
        const jpeg = await shot(top, bottom, scale);
        return {
          ...base,
          tiles: [],
          closeUp: { jpeg, lines: tileLines(inspection.blocks, top, bottom, inspection.lines) },
        };
      }
      const tiles = [];
      for (const [index, [top, bottom]] of tileCuts(
        inspection.blocks.map((block) => block.bottom),
        height,
      ).entries())
        tiles.push({
          part: index + 1,
          top,
          height: bottom - top,
          jpeg: await shot(top, bottom),
          lines: tileLines(inspection.blocks, top, bottom, inspection.lines),
          headings: inspection.headings
            .filter((heading) => heading.top >= top && heading.top < bottom)
            .map((heading) => heading.text),
        });
      return { ...base, tiles };
    } catch (error) {
      throw reason ?? error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.#open.delete(window);
      if (!window.isDestroyed()) window.destroy();
    }
  }
}
