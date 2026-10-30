import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { folioHome } from "../src/home.ts";
import { stepTimings, timingTable } from "../src/jobs/report.ts";

/**
 * Where each study's time went, from jobs.sqlite in Folio's home (FOLIO_HOME, or ~/.folio).
 * The database is opened read-only: a running Folio is never disturbed.
 *
 *   vp run study:report [--job <id or its start>] [--since <ISO date or time>]
 */
const { values } = parseArgs({
  options: {
    job: { type: "string" },
    since: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log("Usage: vp run study:report [--job <id>] [--since <ISO date or time>]");
  process.exit(0);
}
let since: string | undefined;
if (values.since !== undefined) {
  const time = Date.parse(values.since);
  if (Number.isNaN(time)) {
    console.error(`--since needs an ISO date or time, such as 2026-10-29; got "${values.since}".`);
    process.exit(2);
  }
  since = new Date(time).toISOString();
}

const file = resolve(folioHome(), "jobs.sqlite");
if (!existsSync(file)) {
  console.error(`No study jobs yet: ${file} does not exist.`);
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true });
try {
  console.log(timingTable(stepTimings(db, { job: values.job, since })));
} finally {
  db.close();
}
