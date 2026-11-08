import { vi } from "vitest";

// A wait for something to happen gets longer than Vitest's one second, unless it sets its own:
// the background work a test waits for, such as a queue starting the next job once files are
// written, can take more than a second on a busy machine, and GitHub's runners run several test
// files at once. A wait that is met returns at once. Windows, several times slower at writing
// many files, gets five seconds; elsewhere three, within the five a test gets.
const timeout = process.platform === "win32" ? 5_000 : 3_000;
const waitFor = vi.waitFor.bind(vi);
vi.waitFor = ((callback, options) =>
  waitFor(
    callback,
    typeof options === "number" ? options : { timeout, ...options },
  )) as typeof vi.waitFor;
