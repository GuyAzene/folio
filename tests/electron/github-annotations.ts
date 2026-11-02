import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A node:test reporter for GitHub Actions: each failing check becomes an error annotation on the
 * commit, with its file, line and message, which anyone can read without signing in (unlike the
 * job's log). At the end it adds the counts, and which checks failed, to the run's summary page.
 * Used beside the spec reporter, as the CI workflow does.
 */

/** Workflow command data: % and line breaks are escaped. */
const data = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
/** Workflow command properties: also : and , . */
const property = (text: string) => data(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

interface Failure {
  name: string;
  file?: string;
  line?: number;
  details: {
    type?: string;
    error?: { message?: string; stack?: string; cause?: { message?: string; stack?: string } };
  };
}

/** The run's totals: node:test's last summary event, the one without a file. */
interface Summary {
  file?: string;
  duration_ms: number;
  counts: { tests: number; passed: number; failed: number; cancelled: number; skipped: number };
}

/**
 * The line in the check's own file where it failed, read from the error's stack: node:test gives
 * the line the check starts on, which says nothing about which of its assertions failed.
 */
function failedAt(stack: string | undefined, path: string): number | undefined {
  for (const [, url, line] of (stack ?? "").matchAll(/(file:\/\/[^\s)]+):(\d+):\d+/g))
    if (fileURLToPath(url!) === path) return Number(line);
  return undefined;
}

const minutes = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** The summary's section for this run, under a heading for a source build or the packaged app. */
function summarize(summary: Summary, failed: string[]): string {
  const title = process.env.FOLIO_E2E_APP ? "The packaged app" : "Folio in a real window";
  const { passed, failed: failures, cancelled, skipped } = summary.counts;
  const counts = [
    `${passed} passed`,
    failures && `${failures} failed`,
    cancelled && `${cancelled} cancelled`,
    skipped && `${skipped} skipped`,
  ].filter(Boolean);
  const list = failed.map((line) => `- ${line}\n`).join("");
  return `### ${title}: ${counts.join(", ")} (${minutes(summary.duration_ms)})\n\n${list && `${list}\n`}`;
}

export default async function* githubAnnotations(
  source: AsyncIterable<{ type: string; data: Failure | Summary }>,
): AsyncGenerator<string> {
  const failed: string[] = [];
  for await (const event of source) {
    if (event.type === "test:summary") {
      const summary = event.data as Summary;
      const output = process.env.GITHUB_STEP_SUMMARY;
      if (!summary.file && output) appendFileSync(output, summarize(summary, failed));
      continue;
    }
    if (event.type !== "test:fail") continue;
    const { name, file, line, details } = event.data as Failure;
    if (details.type === "suite") continue;
    const error = details.error;
    const message = (error?.cause?.message ?? error?.message ?? "Failed")
      .split("\n")
      .slice(0, 20)
      .join("\n");
    const path = file?.startsWith("file:") ? fileURLToPath(file) : file;
    const at =
      (path ? failedAt(error?.cause?.stack ?? error?.stack, path) : undefined) ?? line ?? 1;
    const shown = path && relative(process.cwd(), path);
    failed.push(shown ? `\`${shown}:${at}\` ${name}` : name);
    const where = shown ? `file=${property(shown)},line=${at},` : "";
    yield `::error ${where}title=${property(name)}::${data(message)}\n`;
  }
}
