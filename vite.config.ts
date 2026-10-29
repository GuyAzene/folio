import { defineConfig } from "vite-plus";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

const node = { platform: "node", target: "node24", sourcemap: true, dts: false } as const;

/** KaTeX's stylesheet offers woff2, woff and ttf for every font; Chromium only needs woff2. */
const katexWoff2Only = {
  name: "folio:katex-woff2-only",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!/[\\/]katex[\\/]dist[\\/]katex(?:\.min)?\.css$/.test(id)) return null;
    return code.replace(
      /,url\([^)]*\.woff\) format\("woff"\),url\([^)]*\.ttf\) format\("truetype"\)/g,
      "",
    );
  },
};

export default defineConfig({
  // The desktop renderer. Electron loads it from the dev server or from build/renderer.
  plugins: [katexWoff2Only, svelte(), tailwindcss()],
  base: "./",
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "build/renderer", emptyOutDir: true },
  run: {
    tasks: {
      start: { command: "node src/cli.ts", cache: false },
      chat: { command: "node src/cli.ts", cache: false },
      sessions: { command: "node src/cli.ts sessions", cache: false },
      resume: { command: "node src/cli.ts chat", cache: false },
      login: { command: "node src/cli.ts login", cache: false },
      status: { command: "node src/cli.ts status", cache: false },
      models: { command: "node src/cli.ts models", cache: false },
      logout: { command: "node src/cli.ts logout", cache: false },
      demo: { command: "node src/cli.ts demo", cache: false },
      desktop: { command: "node scripts/desktop.ts", cache: false },
      "desktop:build": { command: "vp build && vp pack", cache: false },
      "desktop:start": { command: "node scripts/desktop.ts --built", cache: false },
      typecheck: { command: "vp check --no-fmt --no-lint", cache: false },
      "check:ui": { command: "svelte-check --tsconfig ./tsconfig.app.json", cache: false },
      "format:ui": {
        command: 'prettier --plugin prettier-plugin-svelte --write "app/**/*.svelte"',
        cache: false,
      },
    },
  },
  fmt: {
    ignorePatterns: [".private/**", "docs/**", "README.md", "AGENTS.md", "package-lock.json"],
  },
  lint: {
    // Local working files are not part of the project.
    ignorePatterns: [".private/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  pack: [
    { ...node, entry: ["src/cli.ts"], format: ["esm"], outDir: "dist", clean: true },
    // Electron's main process (ESM) and its sandboxed preload, which must be CommonJS.
    {
      ...node,
      entry: { "desktop-main": "src/desktop/main.ts" },
      format: ["esm"],
      outDir: "dist-desktop",
      clean: false,
      deps: { neverBundle: ["electron"] },
    },
    {
      ...node,
      entry: { preload: "src/desktop/preload.ts" },
      format: ["cjs"],
      outDir: "dist-desktop",
      clean: false,
      deps: { neverBundle: ["electron"] },
    },
  ],
});
