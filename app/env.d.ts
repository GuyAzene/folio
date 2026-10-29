/// <reference types="svelte" />
/// <reference types="vite/client" />
import type { FolioApi } from "../src/desktop/api.ts";

declare global {
  interface Window {
    /** Exposed by the Electron preload; absent in a plain browser. */
    folio?: FolioApi;
  }
}
