import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  imported,
  importedPackages,
  notices,
  packageName,
  withDependencies,
} from "../scripts/notices.ts";

/** A synthetic project: its manifest, its lockfile, and the packages installed on disk. */
async function project(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "folio-notices-"));
  const write = async (path: string, text: string) => {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), text);
  };
  const pkg = (name: string, version: string, license?: string) =>
    JSON.stringify({ name, version, ...(license ? { license } : {}) });
  await write(
    "package.json",
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { runtime: "1.0.0" },
      devDependencies: { "@ui/kit": "2.0.0", tool: "3.0.0" },
    }),
  );
  await write(
    "package-lock.json",
    JSON.stringify({
      packages: {
        "": {},
        "node_modules/runtime": {
          dependencies: { shared: "^1.0.0" },
          optionalDependencies: { "runtime-linux": "1.0.0", "runtime-darwin": "1.0.0" },
        },
        "node_modules/runtime-linux": { optional: true },
        "node_modules/runtime-darwin": { optional: true },
        "node_modules/shared": {},
        "node_modules/@ui/kit": { dev: true, dependencies: { shared: "^2.0.0" } },
        "node_modules/@ui/kit/node_modules/shared": { dev: true },
        "node_modules/tool": { dev: true },
      },
    }),
  );
  await write("node_modules/runtime/package.json", pkg("runtime", "1.0.0", "MIT"));
  await write("node_modules/runtime/LICENSE", "MIT License\n\nCopyright (c) Runtime");
  await write("node_modules/runtime-darwin/package.json", pkg("runtime-darwin", "1.0.0", "MIT"));
  await write("node_modules/runtime-darwin/LICENSE.md", "Darwin build license");
  await write("node_modules/shared/package.json", pkg("shared", "1.0.0", "ISC"));
  await write("node_modules/shared/license", "ISC License, shared 1");
  await write("node_modules/@ui/kit/package.json", pkg("@ui/kit", "2.0.0", "Apache-2.0"));
  await write("node_modules/@ui/kit/LICENSE-APACHE", "Apache License 2.0");
  await write("node_modules/@ui/kit/NOTICE", "Kit notice");
  await write(
    "node_modules/@ui/kit/node_modules/shared/package.json",
    pkg("shared", "2.0.0", "ISC"),
  );
  await write("node_modules/tool/package.json", pkg("tool", "3.0.0"));
  await write(
    "app/main.ts",
    'import { Button } from "@ui/kit/button";\nimport "./local.ts";\nimport type { X } from "node:fs";\n',
  );
  await write("app/style.css", '@import "@ui/kit/theme.css";\n');
  await write(
    "src/main.ts",
    'const later = await import("runtime");\nconst text = "from \\"nowhere\\"";\n',
  );
  return root;
}

describe("third-party notices", () => {
  it("reads the package a bare import names, and nothing from relative or built-in ones", () => {
    expect(packageName("@scope/name/sub/path.js")).toBe("@scope/name");
    expect(packageName("name/sub")).toBe("name");
    expect(packageName("./local.ts")).toBeUndefined();
    expect(packageName("node:fs")).toBeUndefined();
    expect(packageName("virtual:module")).toBeUndefined();
    expect([
      ...imported(
        'import a from "a";\nexport * from "b/c";\nimport "d";\nawait import("@e/f");\n@import "g";',
      ),
    ]).toEqual(["a", "b", "d", "@e/f", "g"]);
  });

  it("finds the project's packages its sources import, in scripts, styles and dynamic imports", async () => {
    const root = await project();
    expect([...importedPackages(root, ["app", "src"])].sort()).toEqual(["@ui/kit", "runtime"]);
  });

  it("follows each package's dependencies where npm installed them, skipping other systems' builds", async () => {
    const root = await project();
    expect(withDependencies(root, ["runtime", "@ui/kit"]).sort()).toEqual([
      "node_modules/@ui/kit",
      "node_modules/@ui/kit/node_modules/shared",
      "node_modules/runtime",
      "node_modules/runtime-darwin",
      "node_modules/shared",
    ]);
  });

  it("lists each package once, by name, with its license and every license file it has", async () => {
    const root = await project();
    const text = notices(root, [
      "node_modules/runtime",
      "node_modules/shared",
      "node_modules/@ui/kit",
      "node_modules/@ui/kit/node_modules/shared",
      "node_modules/tool",
      "node_modules/shared",
    ]);
    const headings = [...text.matchAll(/^(\S+ \d+\.\d+\.\d+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      "@ui/kit 2.0.0",
      "runtime 1.0.0",
      "shared 1.0.0",
      "shared 2.0.0",
      "tool 3.0.0",
    ]);
    expect(text).toContain(
      "@ui/kit 2.0.0\nLicense: Apache-2.0\n\nApache License 2.0\n\nKit notice",
    );
    expect(text).toContain("shared 1.0.0\nLicense: ISC\n\nISC License, shared 1");
    expect(text).toContain("tool 3.0.0\nLicense: not stated\n\nThe package has no license file.");
  });
});
