import { createHash } from "node:crypto";
import { buildDocumentInventory } from "./inventory.ts";
import { closeSource, openSource, renderCrop, renderPage } from "./pages.ts";
import type { PreparedSource } from "./pipeline.ts";

/**
 * Opens a verified original for ingestion: its inventory, plus page renders cached for the run
 * (readers, author and reviewers look at the same pages).
 */
export async function prepareSource(data: Uint8Array, sha256: string): Promise<PreparedSource> {
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== sha256)
    throw new Error("This document no longer matches the file that was imported.");
  const doc = await openSource(data);
  const renders = new Map<string, Promise<Uint8Array>>();
  try {
    const inventory = await buildDocumentInventory(doc, sha256);
    return {
      inventory,
      render(page, maxEdge) {
        const key = `${page}:${maxEdge}`;
        let render = renders.get(key);
        if (!render) {
          render = renderPage(doc, page, { maxEdge }).then((image) => image.png);
          renders.set(key, render);
        }
        return render;
      },
      async crop(page, box, maxEdge) {
        return (await renderCrop(doc, page, box, { maxEdge })).png;
      },
      async close() {
        renders.clear();
        await closeSource(doc);
      },
    };
  } catch (error) {
    await closeSource(doc);
    throw error;
  }
}
