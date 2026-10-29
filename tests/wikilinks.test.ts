import { describe, expect, it } from "vite-plus/test";
import { linkAt, linkedMarkdown, wikilinkTarget } from "../app/lib/editor/wikilinks.ts";
import { markdownToHtml } from "../app/lib/markdown.ts";
import { relinkTitle } from "../src/library/notes.ts";

describe("links between notes", () => {
  it("find the link under a position, with or without shown text", () => {
    const line = "See [[Graph search]] and [[topic:alg-bfs|BFS]].";
    expect(linkAt(line, 8)).toEqual({ target: "Graph search" });
    expect(linkAt(line, 30)).toEqual({ target: "topic:alg-bfs" });
    expect(linkAt(line, 2)).toBeNull();
  });

  it("become in-page links in the read view, never inside code", () => {
    const markdown = linkedMarkdown(
      "See [[Graph search]], [[topic:alg-bfs|BFS]] and `[[not a link]]`.\n\n```\n[[code]]\n```",
    );
    expect(markdown).toContain("[Graph search](#wikilink:Graph%20search)");
    expect(markdown).toContain("[BFS](#wikilink:topic%3Aalg-bfs)");
    expect(markdown).toContain("`[[not a link]]`");
    expect(markdown).toContain("[[code]]");
    const html = markdownToHtml(markdown, { note: true });
    expect(html).toContain('href="#wikilink:Graph%20search"');
    expect(wikilinkTarget("#wikilink:topic%3Aalg-bfs")).toBe("topic:alg-bfs");
    expect(wikilinkTarget("https://example.com")).toBeNull();
  });

  it("follow a rename, keeping the text they show", () => {
    expect(relinkTitle("A [[Old]] and [[old|its words]] but not [[Older]].", "Old", "New")).toBe(
      "A [[New]] and [[New|its words]] but not [[Older]].",
    );
  });
});
