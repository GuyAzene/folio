import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/geist-mono";
// Hebrew letters: none of the fonts above has them. Each face downloads only the subsets used.
import "@fontsource-variable/noto-sans-hebrew/wght.css";
import "@fontsource-variable/frank-ruhl-libre/wght.css";
import "katex/dist/katex.min.css";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { folio } from "./lib/state.svelte.ts";

async function start(): Promise<void> {
  const api =
    window.folio ??
    (import.meta.env.DEV ? (await import("./lib/preview-api.ts")).previewApi : undefined);
  mount(App, { target: document.getElementById("app")! });
  if (api) await folio.init(api);
}

void start();
