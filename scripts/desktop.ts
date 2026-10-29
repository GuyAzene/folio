// Runs the desktop app. Default: Vite dev server with hot reload for the renderer.
// --built: the production renderer from build/renderer (run `vp run desktop:build` first).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const built = process.argv.includes("--built");
const devUrl = "http://127.0.0.1:5173";
const electron = createRequire(import.meta.url)("electron") as string;
const children: ChildProcess[] = [];

function stop(code: number): never {
  // Each child leads its own process group, so tools it started (vp starts vite) stop too.
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

if (!built) {
  // The main process and preload are bundled once per launch; renderer edits hot-reload.
  const pack = spawnSync("vp", ["pack"], { stdio: "inherit" });
  if (pack.status !== 0) process.exit(pack.status ?? 1);
  const vite = spawn("vp", ["dev"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
  children.push(vite);
  vite.on("exit", (code) => stop(code ?? 1));
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(devUrl)).ok) break;
    } catch {
      if (attempt > 150) {
        console.error("The Vite dev server did not start on port 5173.");
        stop(1);
      }
      await sleep(100);
    }
  }
}

const app = spawn(electron, ["dist-desktop/desktop-main.mjs"], {
  stdio: "inherit",
  detached: true,
  env: { ...process.env, ...(built ? {} : { FOLIO_RENDERER_URL: devUrl }) },
});
children.push(app);
app.on("exit", (code) => stop(code ?? 0));
