import { Facet } from "@codemirror/state";
import { demoPlaceholders, type DemoRunner } from "../demo-placeholder.ts";

/**
 * What the note editor's widgets need to know about where they are drawn, given by whoever opens
 * the editor: how a ```demo block runs (the app runs it in its sealed frame; a picture of the
 * note shows a placeholder), and which course the note belongs to, for its figures.
 */
export const noteDemos = Facet.define<DemoRunner, DemoRunner>({
  combine: (values) => values.at(-1) ?? demoPlaceholders,
});

export const noteCourse = Facet.define<string | null, string | null>({
  combine: (values) => values.at(-1) ?? null,
});
