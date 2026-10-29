import { describe, expect, it } from "vite-plus/test";
import { drawDiagram } from "../app/lib/diagrams.ts";
import { DIAGRAMS } from "./fixtures/diagrams.ts";

describe("drawing diagrams", () => {
  it("draws each kind of diagram a tutor writes, and explains one with a mistake", () => {
    for (const fixture of DIAGRAMS) {
      const drawn = drawDiagram(fixture.source);
      if (fixture.invalid || /escapes its rule/.test(fixture.name)) {
        expect(drawn.ok, fixture.name).toBe(false);
        if (!drawn.ok) expect(drawn.message, fixture.name).toMatch(/shown as text/);
      } else if (!fixture.unsafe) {
        expect(drawn.ok, fixture.name).toBe(true);
        if (drawn.ok) expect(drawn.svg, fixture.name).toMatch(/^<svg/);
      }
    }
  });

  it("never lets markup that could run or load come out of a diagram", () => {
    for (const fixture of DIAGRAMS.filter((candidate) => candidate.unsafe)) {
      const drawn = drawDiagram(fixture.source);
      if (!drawn.ok) continue;
      expect(drawn.svg, fixture.name).not.toMatch(
        /<script|<img|<iframe|<foreignObject|\son[a-z]+\s*=|javascript:|url\(\s*['"]?(?!#)/i,
      );
    }
  });

  it("draws the same source once, from its cache", () => {
    const source = "flowchart LR\n  A --> B";
    expect(drawDiagram(source)).toBe(drawDiagram(source));
  });
});
