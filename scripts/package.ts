// Builds Folio.app and a .dmg for Apple silicon into release/. The source is built in a folder of
// its own, so a Folio running from this checkout keeps its build/ and dist-desktop/ files. Electron
// is the pinned devDependency's release, from the cache Electron's installer fills, checked
// against Electron's published checksums.
// Signed ad-hoc, to run on this Mac. With CSC_NAME (a Developer ID Application identity in the
// keychain) or CSC_LINK (a .p12 certificate) set, it is signed with that identity instead, and
// notarized when APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER (or APPLE_ID,
// APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID) are set too.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Arch, build, Platform, type Configuration } from "electron-builder";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCES = [
  "app",
  "src",
  "tests/fixtures",
  "index.html",
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

/** The renderer and the main process, built from a copy of the current source. */
async function stage(dir: string): Promise<void> {
  for (const path of SOURCES)
    await cp(resolve(ROOT, path), resolve(dir, path), { recursive: true });
  await symlink(resolve(ROOT, "node_modules"), resolve(dir, "node_modules"), "dir");
  execFileSync("vp", ["build"], { cwd: dir, stdio: "inherit" });
  execFileSync("vp", ["pack"], { cwd: dir, stdio: "inherit" });
}

/** The app icon at every size macOS asks for, drawn from resources/icon.svg. */
async function icon(dir: string): Promise<string> {
  const svg = await readFile(resolve(ROOT, "resources/icon.svg"), "utf8");
  const set = resolve(dir, "icon.iconset");
  await mkdir(set);
  for (const points of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const size = points * scale;
      const sized = svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
      const canvas = createCanvas(size, size);
      canvas.getContext("2d").drawImage(await loadImage(Buffer.from(sized)), 0, 0, size, size);
      const name = `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`;
      await writeFile(resolve(set, name), canvas.toBuffer("image/png"));
    }
  const icns = resolve(dir, "icon.icns");
  execFileSync("iconutil", ["--convert", "icns", "--output", icns, set]);
  return icns;
}

function config(dir: string, icns: string): Configuration {
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
      icon: icns,
      // "-" signs ad-hoc; otherwise electron-builder signs with CSC_NAME or CSC_LINK.
      identity: developerId ? undefined : "-",
      hardenedRuntime: true,
      // Notarization needs a Developer ID; it then reads Apple's credentials from the environment.
      notarize: developerId ? undefined : false,
    },
    dmg: { title: "Folio" },
  };
}

// The build replaces release/, so a Folio opened from there would lose its files while it runs.
if (
  execFileSync("ps", ["-axo", "command="], { encoding: "utf8" }).includes(
    `${resolve(ROOT, "release")}/`,
  )
)
  throw new Error(
    "Folio is running from release/. Quit it before building, since the build replaces that folder.",
  );

const dir = await mkdtemp(resolve(tmpdir(), "folio-package-"));
try {
  await stage(dir);
  const icns = await icon(dir);
  await rm(resolve(ROOT, "release"), { recursive: true, force: true });
  const artifacts = await build({
    projectDir: ROOT,
    targets: Platform.MAC.createTarget("dmg", Arch.arm64),
    config: config(dir, icns),
    publish: "never",
  });
  console.log(`\nBuilt ${resolve(ROOT, "release/mac-arm64/Folio.app")}`);
  for (const artifact of artifacts.filter((path) => path.endsWith(".dmg")))
    console.log(`  and ${artifact}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
