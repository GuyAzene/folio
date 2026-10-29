/**
 * Ingestion contracts. Code decides what exists on a page (the inventory) and computes
 * coverage; models only read and write about named regions.
 */

/** A rectangle in page points with a top-left origin: [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];

export type RegionKind = "text" | "image" | "drawing";

export interface Region {
  /** "p<page>.r<n>", numbered in reading order. Stable for one source hash and inventory version. */
  id: string;
  page: number;
  kind: RegionKind;
  box: Box;
  /** Text-layer text in reading order; for drawings, the labels inside them. Empty for images. */
  text: string;
  /** From pdf.js: "rtl" for Hebrew runs, "mixed" when both directions occur. */
  direction: "ltr" | "rtl" | "mixed" | null;
  /** Numbers and math-like tokens that must reach the wiki unchanged. */
  numbers: string[];
}

export type TextLayerHealth = "ok" | "empty" | "suspect";

export interface PageInventory {
  page: number;
  /** Page size in points. */
  width: number;
  height: number;
  regions: Region[];
  /**
   * "empty": nothing to anchor to (a scan or a slide exported as a picture).
   * "suspect": replacement or private-use characters, or text that does not survive extraction.
   */
  textLayer: TextLayerHealth;
  characters: number;
}

export interface SourceInventory {
  /** The inventory algorithm's version; region IDs change when it does. */
  version: 1;
  sha256: string;
  pages: PageInventory[];
}
