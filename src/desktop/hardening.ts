/**
 * What Folio's window may do, decided here without Electron so every rule can be tested. The
 * main process wires these into the session and the window; anything not allowed is refused,
 * and a refusal never depends on what a page claims about itself.
 */

/**
 * A URL's origin as Chromium writes it. Node's URL parser does not know Folio's own schemes are
 * standard, so it calls `folio://app` an opaque "null" origin, which would make every
 * custom-scheme page look the same.
 */
export function originOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "null";
  }
  if (parsed.origin !== "null") return parsed.origin;
  return parsed.host ? `${parsed.protocol}//${parsed.host}` : "null";
}

/** Browser permissions Folio's own page uses: copying a reply or a PDF selection. */
export const PAGE_PERMISSIONS: ReadonlySet<string> = new Set(["clipboard-sanitized-write"]);

/**
 * Whether to grant a browser permission. Only Folio's own page, in the window's main frame, gets
 * any, and only the few it uses. Frames inside the page (the tutor's demos) get none.
 */
export function permissionDecision(request: {
  permission: string;
  isMainFrame: boolean;
  origin: string;
  rendererOrigin: string;
}): boolean {
  return (
    request.isMainFrame &&
    request.origin === request.rendererOrigin &&
    PAGE_PERMISSIONS.has(request.permission)
  );
}

/**
 * Whether a frame inside the window may navigate. The window itself never leaves Folio (see the
 * main frame's own guard); frames inside it may not load anything for now.
 */
export function frameNavigationDecision(navigation: {
  isMainFrame: boolean;
  url: string;
}): boolean {
  return navigation.isMainFrame;
}

/**
 * Whether the window may make a network request. Folio's page needs none: its files come from
 * its own scheme and model traffic runs in the main process. The development server is the one
 * exception, so `vp dev` keeps working.
 */
export function requestDecision(request: { url: string; devOrigin: string | null }): boolean {
  if (!/^(?:https?|wss?):/i.test(request.url)) return true;
  if (!request.devOrigin) return false;
  const origin = originOf(request.url.replace(/^ws/i, "http"));
  return origin === request.devOrigin;
}

/**
 * Whether an IPC call comes from Folio's own page: the window's main frame, at the renderer's
 * origin. A frame inside the page never reaches the app, whatever it loads.
 */
export function trustedSender(sender: {
  fromWindow: boolean;
  isMainFrame: boolean;
  origin: string | undefined;
  rendererOrigin: string;
}): boolean {
  return sender.fromWindow && sender.isMainFrame && sender.origin === sender.rendererOrigin;
}
