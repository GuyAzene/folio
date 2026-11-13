import { describe, expect, it } from "vite-plus/test";
import { updateFilesProblem } from "../scripts/update-files.ts";

const build = { version: "0.3.0", zip: "Folio-0.3.0-arm64-mac.zip", sha512: "c2hhNTEy" };

/** latest-mac.yml as electron-builder writes it, with `files` and `version` changed. */
const latestMac = (version = "0.3.0", files = [{ url: build.zip, sha512: build.sha512 }]) =>
  [
    `version: ${version}`,
    "files:",
    ...files.flatMap((file) => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      "    size: 140436396",
    ]),
    `path: ${build.zip}`,
    `sha512: ${build.sha512}`,
    "releaseDate: '2026-11-13T08:51:10.742Z'",
  ].join("\n");

describe("the update files a build publishes", () => {
  it("pass when latest-mac.yml names this zip, as this version, with its checksum", () => {
    expect(updateFilesProblem(latestMac(), build)).toBeNull();
  });

  it("fail on another version, another file, a second file or another checksum", () => {
    expect(updateFilesProblem(latestMac("0.2.9"), build)).toContain("says 0.2.9");
    expect(
      updateFilesProblem(
        latestMac("0.3.0", [{ url: "Folio-0.3.0-arm64.dmg", sha512: build.sha512 }]),
        build,
      ),
    ).toContain("other files");
    expect(
      updateFilesProblem(
        latestMac("0.3.0", [
          { url: build.zip, sha512: build.sha512 },
          { url: "Folio-0.3.0-x64-mac.zip", sha512: "b3RoZXI=" },
        ]),
        build,
      ),
    ).toContain("other files");
    expect(
      updateFilesProblem(latestMac("0.3.0", [{ url: build.zip, sha512: "b3RoZXI=" }]), build),
    ).toContain("another checksum");
  });

  it("fail when the file is missing or isn't YAML", () => {
    expect(updateFilesProblem("", build)).toContain("says undefined");
    expect(updateFilesProblem("version: [", build)).toContain("doesn't read as YAML");
  });
});
