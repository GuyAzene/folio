import "./fonts.ts";
import { mount } from "svelte";
import App from "./App.svelte";
import { installDiagramActions } from "./lib/diagram-actions.ts";
import { forgetDiagrams } from "./lib/diagrams.ts";
import { folio } from "./lib/state.svelte.ts";

async function start(): Promise<void> {
  const api =
    window.folio ??
    (import.meta.env.DEV ? (await import("./lib/preview-api.ts")).previewApi : undefined);
  // Diagrams measure their labels in Folio's fonts, so the fonts load before the first one is
  // drawn; a slow font only delays them a moment, and drawings made before it are redrawn.
  await Promise.race([
    Promise.all([
      document.fonts.load('14px "Inter Variable"'),
      document.fonts.load('14px "Noto Sans Hebrew Variable"', "א"),
    ]),
    new Promise((done) => setTimeout(done, 400)),
  ]).catch(() => undefined);
  void document.fonts.ready.then(forgetDiagrams);
  if (api) installDiagramActions((name, data) => api.saveFile({ name, type: "svg", data }));
  mount(App, { target: document.getElementById("app")! });
  if (api) await folio.init(api);
}

void start();
