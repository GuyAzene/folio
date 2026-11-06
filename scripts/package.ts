// Builds Folio into release/: on a Mac, Folio.app and a .dmg for Apple silicon; on Windows,
// release/win-unpacked/Folio.exe and an installer for x64. The source is built in a folder of its
// own, so a Folio running from this checkout keeps its build/ and dist-desktop/ files. Electron is
// the pinned devDependency's release, from the cache Electron's installer fills, checked against
// Electron's published checksums.
// On a Mac it is signed ad-hoc, to run on this Mac. With CSC_NAME (a Developer ID Application
// identity in the keychain) or CSC_LINK (a .p12 certificate) set, it is signed with that identity
// instead, and notarized when APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER (or APPLE_ID,
// APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID) are set too. On Windows it is not signed unless
// CSC_LINK names a code-signing certificate, so Windows warns before the first run.
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Arch, build, Platform, type Configuration } from "electron-builder";
import { importedPackages, notices, withDependencies } from "./notices.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCES = [
  "app",
  "src",
  "tests/fixtures",
  "index.html",
  "capture.html",
  "vite.config.ts",
  "svelte.config.js",
  "tsconfig.json",
  "tsconfig.app.json",
  "package.json",
];
const developerId = !!(process.env.CSC_NAME || process.env.CSC_LINK);
// FOLIO_DISTRIBUTE=1 builds the app handed to other people: the inspector flags are off, so
// nothing can drive it from outside. The real-window checks need them, so they test the default.
const distribute = process.env.FOLIO_DISTRIBUTE === "1";
const windows = process.platform === "win32";

/** The renderer and the main process, built from a copy of the current source. */
async function stage(dir: string): Promise<void> {
  for (const path of SOURCES)
    await cp(resolve(ROOT, path), resolve(dir, path), { recursive: true });
  // A junction on Windows, which needs no administrator, as a folder link would.
  await symlink(
    resolve(ROOT, "node_modules"),
    resolve(dir, "node_modules"),
    windows ? "junction" : "dir",
  );
  // Through a shell, which also starts vp where it is a .cmd shim.
  execSync("vp build", { cwd: dir, stdio: "inherit" });
  execSync("vp pack", { cwd: dir, stdio: "inherit" });
}

/**
 * THIRD_PARTY_NOTICES.txt: the licenses of the production dependencies and of what the interface
 * and the main process import, with what those depend on. Electron's ship on their own.
 */
async function thirdPartyNotices(dir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const packages = new Set([
    ...Object.keys(manifest.dependencies),
    ...importedPackages(ROOT, ["app", "src"]),
  ]);
  packages.delete("electron");
  const path = resolve(dir, "THIRD_PARTY_NOTICES.txt");
  await writeFile(path, notices(ROOT, withDependencies(ROOT, packages)));
  return path;
}

/** The icon drawn from resources/icon.svg at one size, as a PNG. */
async function drawIcon(svg: string, size: number): Promise<Buffer> {
  const sized = svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
  const canvas = createCanvas(size, size);
  canvas.getContext("2d").drawImage(await loadImage(Buffer.from(sized)), 0, 0, size, size);
  return canvas.toBuffer("image/png");
}

/**
 * The app icon: on a Mac at every size macOS asks for; on Windows one 256-pixel PNG, which
 * electron-builder turns into the .ico Windows asks for.
 */
async function icon(dir: string): Promise<string> {
  const svg = await readFile(resolve(ROOT, "resources/icon.svg"), "utf8");
  if (windows) {
    const png = resolve(dir, "icon.png");
    await writeFile(png, await drawIcon(svg, 256));
    return png;
  }
  const set = resolve(dir, "icon.iconset");
  await mkdir(set);
  for (const points of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const name = `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`;
      await writeFile(resolve(set, name), await drawIcon(svg, points * scale));
    }
  const icns = resolve(dir, "icon.icns");
  execFileSync("iconutil", ["--convert", "icns", "--output", icns, set]);
  return icns;
}

function config(dir: string, icon: string, licenses: string): Configuration {
  return {
    appId: "io.github.guyazene.folio",
    productName: "Folio",
    copyright: "Copyright © 2026 Guy Azene",
    directories: { output: resolve(ROOT, "release"), buildResources: resolve(ROOT, "resources") },
    // The canvas module ships prebuilt for Electron's Node; nothing is compiled.
    npmRebuild: false,
    extraMetadata: { main: "dist-desktop/desktop-main.mjs", author: "Guy Azene" },
    // No update channel yet, so the app carries no update feed.
    publish: null,
    // The main process, its preload and the renderer; production dependencies are added on their
    // own, and the renderer's libraries are already in its bundle.
    files: [
      "package.json",
      { from: resolve(dir, "dist-desktop"), to: "dist-desktop", filter: ["*.mjs", "*.cjs"] },
      { from: resolve(dir, "build/renderer"), to: "build/renderer", filter: ["**/*", "!**/*.map"] },
      "!**/node_modules/**/*.{map,md,d.ts,d.mts,d.cts}",
      // The main process reads PDFs with pdf.js's legacy build and its fonts, CMaps and decoders.
      "!**/node_modules/pdfjs-dist/{build,web,image_decoders,types}/**",
      "!**/node_modules/pdfjs-dist/legacy/{web,image_decoders}/**",
    ],
    asar: true,
    // Beside Electron's LICENSE.electron.txt and Chromium's LICENSES.chromium.html.
    extraResources: [{ from: licenses, to: "THIRD_PARTY_NOTICES.txt" }],
    // Folio's interface is English; Hebrew keeps Chromium's own strings for a Hebrew system.
    electronLanguages: ["en", "he"],
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      // The real-window tests drive the packaged app through the inspector; a build for others
      // turns it off.
      enableNodeCliInspectArguments: !distribute,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    },
    mac: {
      target: [{ target: "dmg", arch: ["arm64"] }],
      category: "public.app-category.education",
      icon,
      // "-" signs ad-hoc; otherwise electron-builder signs with CSC_NAME or CSC_LINK.
      identity: developerId ? undefined : "-",
      hardenedRuntime: true,
      // Notarization needs a Developer ID; it then reads Apple's credentials from the environment.
      notarize: developerId ? undefined : false,
    },
    dmg: { title: "Folio" },
    // An installer for the student alone: no administrator, into their own programs folder, with
    // a Start menu entry. Unsigned unless CSC_LINK names a certificate.
    win: { target: [{ target: "nsis", arch: ["x64"] }], icon },
    nsis: {
      oneClick: true,
      perMachine: false,
      artifactName: "Folio-${version}-x64-setup.${ext}",
    },
  };
}

// The build replaces release/, so a Folio opened from there would lose its files while it runs.
// Windows refuses to delete a running program's files, so there the build stops on its own.
if (
  !windows &&
  execFileSync("ps", ["-axo", "command="], { encoding: "utf8" }).includes(
    `${resolve(ROOT, "release")}/`,
  )
)
  throw new Error(
    "Folio is running from release/. Quit it before building, since the build replaces that folder.",
  );

// The temporary folder's real path: Windows may give it a short name, as RUNNER~1, which Vite
// resolves to the long one, and then refuses the pages as outside the build.
const dir = await mkdtemp(resolve(await realpath(tmpdir()), "folio-package-"));
try {
  await stage(dir);
  const licenses = await thirdPartyNotices(dir);
  const configuration = config(dir, await icon(dir), licenses);
  await rm(resolve(ROOT, "release"), { recursive: true, force: true });
  const artifacts = await build({
    projectDir: ROOT,
    targets: windows
      ? Platform.WINDOWS.createTarget("nsis", Arch.x64)
      : Platform.MAC.createTarget("dmg", Arch.arm64),
    config: configuration,
    publish: "never",
  });
  // Electron's and Chromium's licenses sit beside Folio.exe on Windows, and with Folio's own
  // notices in Folio.app's resources on a Mac.
  const app = resolve(ROOT, windows ? "release/win-unpacked" : "release/mac-arm64/Folio.app");
  const resources = windows ? resolve(app, "resources") : resolve(app, "Contents/Resources");
  const beside = windows ? app : resources;
  for (const file of [
    resolve(resources, "THIRD_PARTY_NOTICES.txt"),
    resolve(beside, "LICENSE.electron.txt"),
    resolve(beside, "LICENSES.chromium.html"),
  ])
    if (!existsSync(file)) throw new Error(`The packaged Folio has no ${file}.`);
  console.log(`\nBuilt ${windows ? resolve(app, "Folio.exe") : app}`);
  for (const artifact of artifacts.filter((path) => /\.(dmg|exe)$/.test(path)))
    console.log(`  and ${artifact}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
