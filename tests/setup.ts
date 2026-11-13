import { vi } from "vitest";

// The tests check what Folio writes, not what a disk keeps through a power cut, so they don't
// wait for the disk after each write (flush in src/files.ts). Thousands of flushes took most of
// their time, and on GitHub's Windows runners they ran tests past their limits. A test of the
// flushing itself turns it back on. The switch is an environment variable rather than an import,
// so a test that mocks a module src/files.ts uses still gets its mock.
process.env.FOLIO_FLUSH = "off";

// A wait for something to happen gets longer than Vitest's one second, unless it sets its own:
// the background work a test waits for, such as a queue starting the next job once files are
// written, can take more than a second on a busy machine, and GitHub's runners run several test
// files at once. A wait that is met returns at once. Windows, several times slower at writing
// many files, gets five seconds; elsewhere three, within the ten a test gets.
const timeout = process.platform === "win32" ? 5_000 : 3_000;
const waitFor = vi.waitFor.bind(vi);
vi.waitFor = ((callback, options) =>
  waitFor(
    callback,
    typeof options === "number" ? options : { timeout, ...options },
  )) as typeof vi.waitFor;
