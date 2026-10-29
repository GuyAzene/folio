/**
 * The page's side of a demo's sealed frame: what a demo may say through its port, and how many
 * demos run at once. A demo's code can send anything, so every message is checked here and
 * anything unexpected is dropped.
 */

export type FrameMessage =
  | { type: "resize"; height: number }
  | { type: "error"; message: string }
  | { type: "pong" }
  | { type: "ask"; text: string };

/** A demo's frame is never shorter or taller than this, whatever it asks for. */
export const FRAME_MIN = 80;
export const FRAME_MAX = 1600;
/** A demo that has not answered for this long has stopped responding. */
export const FRAME_SILENCE = 4000;
/** At most this many demos run at once; one that scrolled away gives its place to one in view. */
export const LIVE_FRAMES = 4;

export function frameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case "resize":
      return typeof message.height === "number" && Number.isFinite(message.height)
        ? {
            type: "resize",
            height: Math.min(FRAME_MAX, Math.max(FRAME_MIN, Math.round(message.height))),
          }
        : null;
    case "error":
      return typeof message.message === "string"
        ? { type: "error", message: message.message.slice(0, 300) }
        : null;
    case "pong":
      return { type: "pong" };
    case "ask":
      return typeof message.text === "string" && message.text.trim()
        ? { type: "ask", text: message.text.trim().slice(0, 1000) }
        : null;
    default:
      return null;
  }
}

/** Lets through at most `limit` calls in any second; the rest are dropped. */
export function rateLimit(limit: number, now: () => number = Date.now): () => boolean {
  const times: number[] = [];
  return () => {
    const at = now();
    while (times.length && at - times[0]! >= 1000) times.shift();
    if (times.length >= limit) return false;
    times.push(at);
    return true;
  };
}

const live: { id: symbol; stop: () => void }[] = [];

/**
 * A demo about to run takes one of the live places; past the limit, the demo that started
 * longest ago stops. Returns the release to call when this demo stops.
 */
export function claimLiveFrame(stop: () => void): () => void {
  const id = Symbol("demo");
  live.push({ id, stop });
  while (live.length > LIVE_FRAMES) live.shift()!.stop();
  return () => {
    const index = live.findIndex((entry) => entry.id === id);
    if (index !== -1) live.splice(index, 1);
  };
}
