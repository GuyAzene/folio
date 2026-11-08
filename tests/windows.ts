/**
 * How long a test may wait for background work to finish. GitHub's Windows machines run the
 * tests that write many files ten to twenty times slower than a Mac does (a study job taking 0.3 s
 * here ran past 5 s there), so there the wait is three times as long, still inside the twenty
 * seconds a test gets there. A wait that is met returns at once; only a hang waits it out.
 */
export const forWork = (ms: number) => (process.platform === "win32" ? ms * 3 : ms);
