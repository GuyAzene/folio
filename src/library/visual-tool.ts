import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  staticSvg,
  VISUAL_LIBRARIES,
  visualKind,
  visualLibraries,
  visualProblem,
  visualTitle,
} from "../visual.ts";
import { LibraryError } from "./store.ts";

/** Saved with each visual, so a chat reopened later shows it the way it first ran. */
export const VISUAL_RUNTIME = "folio-visual-1";

export interface VisualDetails {
  v: 1;
  kind: "svg" | "html";
  title: string;
  /** The first 16 hex digits of the source's SHA-256. */
  hash: string;
  libs: string[];
  runtime: string;
  bytes: number;
}

const DESCRIPTION = [
  "Show the student a drawing or an interactive demo, inside the reply where you call it. Use it when seeing or playing with something teaches more than words: a geometric construction, a plot of a function, an algorithm stepping through its states, a simulation with sliders or buttons. For flowcharts, automata, sequences and other diagrams, write a ```mermaid block in your reply instead. Do not use it for decoration, and explain in your reply text; the visual does not replace the explanation.",
  "`source` is the visual itself: either an SVG (starting with <svg>) for a still drawing, or an HTML fragment with inline <style> and <script> for something interactive. Always include a <title> naming it, in the student's language.",
  "It runs in a sealed frame about 680 pixels wide that grows to its content's height. There is no network, no storage, no pop-ups or dialogs, and no access to Folio: put all data in the code. Libraries, only these, loaded with exactly these tags: " +
    Object.entries(VISUAL_LIBRARIES)
      .map(([name, tags]) => `${name}: ${tags.join(" ")}`)
      .join("; ") +
    ".",
  'Use Folio\'s colors so it fits light and dark themes: var(--folio-bg), var(--folio-surface), var(--folio-text), var(--folio-text-2), var(--folio-muted), var(--folio-line), var(--folio-accent), var(--folio-highlight), var(--folio-danger), var(--folio-success), and the font var(--folio-font). In an SVG, set colors with these variables in a <style> element. Hebrew text needs dir="rtl" on its element.',
  "To offer a follow-up question from a button, call folio.ask('…'): it fills in the student's message box, and they choose whether to send it.",
].join("\n");

/** `show_visual`: checks the visual and records it; the window shows it, sealed. */
export function visualTool(): AgentTool {
  return {
    name: "show_visual",
    label: "Show a visual",
    description: DESCRIPTION,
    parameters: Type.Object(
      {
        source: Type.String({
          description: "The SVG or HTML of the visual, with a <title>.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params) => {
      const source = (params as { source?: unknown }).source;
      if (typeof source !== "string")
        throw new LibraryError("show_visual needs the SVG or HTML of the visual in `source`.");
      const problem = visualProblem(source);
      if (problem) throw new LibraryError(problem);
      const details: VisualDetails = {
        v: 1,
        kind: visualKind(source),
        title: visualTitle(source)!,
        hash: createHash("sha256").update(source).digest("hex").slice(0, 16),
        libs: visualLibraries(source),
        runtime: VISUAL_RUNTIME,
        bytes: source.length,
      };
      return {
        content: [
          {
            type: "text",
            text: `Shown to the student${staticSvg(source) ? " as a drawing" : ""}. Do not repeat its markup in your reply.`,
          },
        ],
        details,
      };
    },
  };
}
