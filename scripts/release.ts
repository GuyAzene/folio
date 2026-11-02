// Starts a release: `vp run release 0.2.0` sets the version in package.json and the lockfile,
// commits it on main as "Release 0.2.0" and tags that commit v0.2.0, signed like any commit, all
// locally. Pushing main and the tag then runs the release workflow, which checks the commit,
// builds Folio for others and drafts the release on GitHub.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const stop = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const parts = (version: string) => version.split(".").map(Number);
const newer = (next: string, current: string) => {
  const [a, b] = [parts(next), parts(current)];
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
};

const next = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+$/.test(next)) stop("Usage: vp run release <version>, such as 0.2.0.");

const packagePath = resolve(ROOT, "package.json");
const lockPath = resolve(ROOT, "package-lock.json");
const manifest = await readFile(packagePath, "utf8");
const current = (JSON.parse(manifest) as { version: string }).version;
if (!newer(next, current)) stop(`${next} is not newer than the current version, ${current}.`);

if (git("branch", "--show-current") !== "main") stop("A release is made from main.");
if (git("status", "--porcelain")) stop("Commit or put aside the changes in this checkout first.");
git("fetch", "--quiet", "origin", "main");
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main"))
  stop("This main is not the same as GitHub's: pull or push first.");
if (git("tag", "--list", `v${next}`)) stop(`The tag v${next} already exists.`);

// Only the project's own version changes: the top of package.json, and the lockfile's top and
// root package.
const field = `"version": "${current}"`;
const version = `"version": "${next}"`;
const lock = (await readFile(lockPath, "utf8")).replace(field, version).replace(field, version);
const parsed = JSON.parse(lock) as {
  version: string;
  packages: Record<string, { version?: string }>;
};
if (parsed.version !== next || parsed.packages[""]?.version !== next)
  stop("The lockfile's version is not where expected; nothing was changed.");
await writeFile(packagePath, manifest.replace(field, version));
await writeFile(lockPath, lock);

git("commit", "--quiet", "-m", `Release ${next}`, "--", "package.json", "package-lock.json");
git("tag", "--sign", "-m", `Folio ${next}`, `v${next}`);
console.log(`Committed "Release ${next}" and tagged it v${next}.`);
console.log(`Push both to start the release: git push origin main v${next}`);
