// The third-party notices that ship inside Folio.app: the name, version, license and license text
// of every package whose code is in the app. That is each production dependency, which ships as
// it is, and each package the interface or the main process imports, whose code its bundle
// carries, together with the packages they depend on. Electron's and Chromium's licenses ship on
// their own, beside the notices.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

interface Locked {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface Manifest {
  name: string;
  version: string;
  license?: string | { type?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** The package a bare import names: `@scope/name/sub` is `@scope/name`, `name/sub` is `name`. */
export function packageName(specifier: string): string | undefined {
  if (/^(\.|\/|[a-z]+:)/.test(specifier)) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The packages a source file imports: `from "x"`, `import "x"`, `import("x")`, `@import "x"`. */
export function imported(source: string): Set<string> {
  const names = new Set<string>();
  for (const [, specifier] of source.matchAll(
    /(?:\bfrom|\bimport\s*\(?|@import)\s*["']([^"']+)["']/g,
  )) {
    const name = packageName(specifier!);
    if (name) names.add(name);
  }
  return names;
}

const SOURCE = new Set([".ts", ".js", ".mjs", ".svelte", ".css", ".html"]);

/** Every package the files under these folders import, among the project's own dependencies. */
export function importedPackages(root: string, folders: string[]): Set<string> {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as Manifest;
  const known = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.has(extname(entry.name)))
        for (const name of imported(readFileSync(path, "utf8")))
          if (known.has(name)) names.add(name);
    }
  };
  for (const folder of folders) walk(resolve(root, folder));
  return names;
}

/** Where npm installed `name` for the package at `from` ("" for the project), by the lockfile. */
function installed(
  packages: Record<string, Locked>,
  from: string,
  name: string,
): string | undefined {
  for (let base = from; ;) {
    const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return undefined;
    const parent = base.lastIndexOf("/node_modules/");
    base = parent === -1 ? "" : base.slice(0, parent);
  }
}

/**
 * The installed folders of these packages and everything they depend on, as the lockfile places
 * them. Optional packages for other systems are in the lockfile but not on disk, and are skipped.
 */
export function withDependencies(root: string, names: Iterable<string>): string[] {
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as {
    packages: Record<string, Locked>;
  };
  const found = new Set<string>();
  const visit = (from: string, name: string) => {
    const path = installed(lock.packages, from, name);
    if (!path || found.has(path) || !existsSync(resolve(root, path, "package.json"))) return;
    found.add(path);
    const entry = lock.packages[path]!;
    const next = {
      ...entry.peerDependencies,
      ...entry.optionalDependencies,
      ...entry.dependencies,
    };
    for (const dependency of Object.keys(next)) visit(path, dependency);
  };
  for (const name of names) visit("", name);
  return [...found];
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(?:[.-].*)?$/i;

/** The notices file for the packages installed in these folders, one section each, by name. */
export function notices(root: string, folders: string[]): string {
  const sections = new Map<string, string>();
  for (const folder of folders) {
    const dir = resolve(root, folder);
    const manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as Manifest;
    const id = `${manifest.name} ${manifest.version}`;
    if (sections.has(id)) continue;
    const license =
      (typeof manifest.license === "string" ? manifest.license : manifest.license?.type) ??
      "not stated";
    const texts = readdirSync(dir)
      .filter((file) => LICENSE_FILE.test(file))
      .sort()
      .map((file) => readFileSync(resolve(dir, file), "utf8").trim());
    const text = texts.length ? texts.join("\n\n") : "The package has no license file.";
    sections.set(id, `${id}\nLicense: ${license}\n\n${text}`);
  }
  const sorted = [...sections.keys()].sort().map((id) => sections.get(id)!);
  const rule = `\n\n${"-".repeat(78)}\n\n`;
  return (
    "Folio includes the open source software below, with the license each is distributed under.\n" +
    "Electron's license is in LICENSE.electron.txt beside this file, and Chromium's in\n" +
    "LICENSES.chromium.html." +
    rule +
    sorted.join(rule) +
    "\n"
  );
}
