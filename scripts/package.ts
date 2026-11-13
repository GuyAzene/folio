// Builds Folio into release/: on a Mac, Folio.app and a .dmg for Apple silicon; on Windows,
// release/win-unpacked/Folio.exe and an installer for x64. The source is built in a folder of its
// own, so a Folio running from this checkout keeps its build/ and dist-desktop/ files. Electron is
// the pinned devDependency's release, from the cache Electron's installer fills, checked against
// Electron's published checksums.
// On a Mac it is signed ad-hoc, to run on this Mac. With CSC_NAME (a Developer ID Application
// identity in the keychain) or CSC_LINK (a .p12 certificate, opened with CSC_KEY_PASSWORD) set, it
// is signed with that identity instead, the disk image too. With an App Store Connect API key as
// well (APPLE_API_KEY, the path of its .p8 file, with APPLE_API_KEY_ID and APPLE_API_ISSUER; or
// APPLE_KEYCHAIN_PROFILE, the name `xcrun notarytool store-credentials` kept it under), Apple
// notarizes the app and the disk image, each gets its ticket stapled, and the build checks both
// as Gatekeeper will on another Mac. FOLIO_NOTARIZE=1, which the release and the nightly set,
// refuses to build without all of that. A Developer ID build can also update itself: beside the
// disk image come a zip of the app and latest-mac.yml, which a release publishes for Folio to
// download. On Windows it is not signed unless CSC_LINK names a
// code-signing certificate, so Windows warns before the first run.
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Arch, build, Platform, type Configuration } from "electron-builder";
import { parse } from "yaml";
import { importedPackages, notices, withDependencies } from "./notices.ts";
import { signing, unsetEmpty } from "./signing.ts";

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
const ENTITLEMENTS = resolve(ROOT, "resources/developer-id.entitlements.plist");
// Throws before anything is built when FOLIO_NOTARIZE=1 lacks a secret: the build would
// otherwise come out ad-hoc, which other Macs refuse, and be published.
unsetEmpty(process.env);
const { developerId, notaryAuth } = signing(process.env, process.platform);
const notarize = notaryAuth !== undefined;
const windows = process.platform === "win32";
// Only a Developer ID build updates itself: macOS installs an update signed by the same identity
// as the running app, and an ad-hoc signature changes with every build.
const updates = developerId && !windows;
// FOLIO_DISTRIBUTE=1 builds the app handed to other people: the inspector flags are off, so
// nothing can drive it from outside. The real-window checks need them, so they test the default.
const distribute = process.env.FOLIO_DISTRIBUTE === "1";

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
    // A build that updates itself carries app-update.yml, and latest-mac.yml comes beside its zip.
    // Folio points the updater at the release it found (src/desktop/updater.ts), so this address
    // is only the default the file records.
    publish: updates
      ? { provider: "generic", url: "https://github.com/GuyAzene/folio/releases/latest/download" }
      : null,
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
      // Cookies are encrypted with a key in the keychain, which macOS gives only to an app signed
      // as the one that made it. An ad-hoc signature changes with every build, and macOS would
      // ask the student's permission after each one, so only a Developer ID build encrypts.
      enableCookieEncryption: developerId,
    },
    mac: {
      // The disk image; build() below adds the zip for a build that updates itself.
      target: [{ target: "dmg", arch: ["arm64"] }],
      category: "public.app-category.education",
      icon,
      // "-" signs ad-hoc; otherwise electron-builder signs with CSC_NAME or CSC_LINK.
      identity: developerId ? undefined : "-",
      hardenedRuntime: true,
      // A Developer ID build loads only libraries signed by its own team, which electron-builder
      // signs every one in the app with. An ad-hoc signature has no team, so there
      // electron-builder's default entitlements turn that check off.
      entitlements: developerId ? ENTITLEMENTS : undefined,
      entitlementsInherit: developerId ? ENTITLEMENTS : undefined,
      // electron-builder notarizes the app and staples its ticket; the disk image is done after.
      notarize,
    },
    // No blockmap: stapling changes the disk image after electron-builder made it, so one would
    // describe a different file. Nothing reads it, and updates on a Mac come from a zip.
    dmg: { title: "Folio", sign: developerId, writeUpdateInfo: false },
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

/** Apple's notary tool, signed in with the App Store Connect API key, whatever it answers. */
function notaryTool(args: string[]) {
  return spawnSync("xcrun", ["notarytool", ...args, ...notaryAuth!], { encoding: "utf8" });
}

/**
 * Apple's notary service checks the signed disk image, which holds the app it has already
 * notarized, and its ticket is stapled to the image, so a Mac that opens it offline finds it.
 * Apple usually answers within minutes; after 15 the build fails saying so, inside CI's limit.
 */
function notarizeDiskImage(dmg: string): void {
  console.log(`\nNotarizing ${dmg}`);
  const submitted = notaryTool([
    "submit",
    dmg,
    "--wait",
    "--timeout",
    "15m",
    "--output-format",
    "json",
  ]);
  let answer: { id?: string; status?: string } = {};
  try {
    answer = JSON.parse(submitted.stdout) as typeof answer;
  } catch {
    // Not JSON: the tool failed before Apple answered, and says why on stderr.
  }
  if (submitted.status !== 0 || answer.status !== "Accepted") {
    const log = answer.id ? notaryTool(["log", answer.id]).stdout : "";
    throw new Error(
      `Apple did not notarize the disk image (${answer.status ?? "no answer"}).\n` +
        `${submitted.stdout}${submitted.stderr}${log}`,
    );
  }
  execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
}

/**
 * Checks the ticket stapled to `path` against Apple's copy, which the stapler downloads. A download
 * that fails now and then (the stapler says "Error 68") is tried three times, ten seconds apart.
 */
async function validateTicket(path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync("xcrun", ["stapler", "validate", path], { encoding: "utf8" });
    if (result.status === 0) return;
    if (attempt === 3)
      throw new Error(
        `Apple's ticket on ${path} did not validate:\n${result.stdout}${result.stderr}`,
      );
    console.log(`The stapler could not validate ${path}; trying again in 10 seconds.`);
    await sleep(10_000);
  }
}

/**
 * What another Mac checks before it opens a download, checked here first: the app sealed with a
 * Developer ID, a secure timestamp and the hardened runtime, the disk image signed too, and, once
 * notarized, both carrying Apple's ticket and accepted by Gatekeeper.
 */
async function checkSignatures(app: string, dmg: string): Promise<void> {
  execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
  execFileSync("codesign", ["--verify", "--strict", dmg]);
  const signed = (path: string) =>
    spawnSync("codesign", ["--display", "--verbose=2", path], { encoding: "utf8" }).stderr;
  const expected = [
    [app, /^Authority=Developer ID Application: /m, "a Developer ID"],
    [app, /^Timestamp=/m, "a secure timestamp"],
    [app, /flags=0x\w*\(runtime\)/, "the hardened runtime"],
    [dmg, /^Authority=Developer ID Application: /m, "a Developer ID"],
  ] as const;
  for (const [path, pattern, what] of expected)
    if (!pattern.test(signed(path))) throw new Error(`${path} is not signed with ${what}.`);
  if (!notarize) return;
  for (const path of [app, dmg]) await validateTicket(path);
  // spctl can only judge where Gatekeeper is on; the ticket and signature checks above still hold.
  if (
    !spawnSync("spctl", ["--status"], { encoding: "utf8" }).stdout.includes("assessments enabled")
  ) {
    console.log("Gatekeeper is off on this Mac, so it did not assess the app.");
    return;
  }
  const assessments = [
    [app, ["--type", "execute"]],
    [dmg, ["--type", "open", "--context", "context:primary-signature"]],
  ] as const;
  for (const [path, type] of assessments) {
    const verdict = spawnSync("spctl", ["--assess", ...type, "--verbose=2", path], {
      encoding: "utf8",
    });
    if (verdict.status !== 0 || !verdict.stderr.includes("source=Notarized Developer ID"))
      throw new Error(`Gatekeeper refuses ${path}:\n${verdict.stderr}`);
  }
  console.log("Gatekeeper accepts the app and the disk image as notarized.");
}

/**
 * The update a release publishes, checked as Folio will on another Mac: latest-mac.yml names the
 * zip with this version and the zip's checksum, and the app in the zip is sealed with the Developer
 * ID, which macOS's updater requires to match the running Folio's, and once notarized carries
 * Apple's ticket.
 */
async function checkUpdateFiles(zip: string): Promise<void> {
  const { version } = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  const info = parse(await readFile(resolve(ROOT, "release/latest-mac.yml"), "utf8")) as {
    version?: string;
    files?: { url?: string; sha512?: string }[];
  };
  const sha512 = createHash("sha512")
    .update(await readFile(zip))
    .digest("base64");
  const [file, ...others] = info.files ?? [];
  if (info.version !== version || others.length || file?.url !== basename(zip))
    throw new Error(`release/latest-mac.yml does not name ${basename(zip)} as Folio ${version}.`);
  if (file.sha512 !== sha512) throw new Error(`release/latest-mac.yml has another checksum.`);
  const dir = await mkdtemp(resolve(tmpdir(), "folio-update-check-"));
  try {
    execFileSync("ditto", ["-x", "-k", zip, dir]);
    const app = resolve(dir, "Folio.app");
    execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
    const signed = spawnSync("codesign", ["--display", "--verbose=2", app], { encoding: "utf8" });
    if (!/^Authority=Developer ID Application: /m.test(signed.stderr))
      throw new Error(`The app in ${zip} is not signed with a Developer ID.`);
    if (notarize) await validateTicket(app);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(`The update in ${basename(zip)} matches latest-mac.yml and is signed.`);
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
      : Platform.MAC.createTarget(updates ? ["dmg", "zip"] : "dmg", Arch.arm64),
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
  if (developerId && !windows) {
    const dmg = artifacts.find((path) => path.endsWith(".dmg"));
    if (!dmg) throw new Error("electron-builder made no disk image.");
    if (notarize) notarizeDiskImage(dmg);
    await checkSignatures(app, dmg);
    const zip = artifacts.find((path) => path.endsWith(".zip"));
    if (!zip) throw new Error("electron-builder made no zip for updates.");
    await checkUpdateFiles(zip);
  }
  console.log(`\nBuilt ${windows ? resolve(app, "Folio.exe") : app}`);
  for (const artifact of artifacts.filter((path) => /\.(dmg|exe|zip)$/.test(path)))
    console.log(`  and ${artifact}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
