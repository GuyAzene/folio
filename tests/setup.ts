import { vi } from "vitest";

// Windows runs the tests that write many files several times slower than a Mac does, so a wait
// for something to happen gets five seconds there instead of Vitest's one, unless it sets its own.
if (process.platform === "win32") {
  const waitFor = vi.waitFor.bind(vi);
  vi.waitFor = ((callback, options) =>
    waitFor(
      callback,
      typeof options === "number" ? options : { timeout: 5_000, ...options },
    )) as typeof vi.waitFor;
}
