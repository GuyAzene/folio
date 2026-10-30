import { relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A node:test reporter for GitHub Actions: each failing check becomes an error annotation on the
 * commit, with its file, line and message, which anyone can read without signing in (unlike the
 * job's log). Used beside the spec reporter, as the CI workflow does.
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
  details: { type?: string; error?: { message?: string; cause?: { message?: string } } };
}

export default async function* githubAnnotations(
  source: AsyncIterable<{ type: string; data: Failure }>,
): AsyncGenerator<string> {
  for await (const event of source) {
    if (event.type !== "test:fail" || event.data.details.type === "suite") continue;
    const { name, file, line, details } = event.data;
    const error = details.error;
    const message = (error?.cause?.message ?? error?.message ?? "Failed")
      .split("\n")
      .slice(0, 20)
      .join("\n");
    const path = file?.startsWith("file:") ? fileURLToPath(file) : file;
    const where = path ? `file=${property(relative(process.cwd(), path))},line=${line ?? 1},` : "";
    yield `::error ${where}title=${property(name)}::${data(message)}\n`;
  }
}
