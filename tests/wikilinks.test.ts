import { describe, expect, it } from "vite-plus/test";
import { linkAt, linkedMarkdown, wikilinkTarget } from "../app/lib/editor/wikilinks.ts";
import { markdownToHtml } from "../app/lib/markdown.ts";
import { citationLabel } from "../src/library/note-meta.ts";
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

describe("page citations after a file is renamed", () => {
  const id = "0b1d5f2e-6a4c-4e8b-9c1d-2f3a4b5c6d7e";
  const title = (documentId: string) => (documentId === id ? "Recitation 1" : null);

  it("read a citation Folio wrote with the file's current name, leaving the note's text", () => {
    expect(citationLabel(`page:${id}#4`, "R01 · p. 4", title)).toBe("Recitation 1 · p. 4");
    const text = `See [[page:${id}#4|R01 · p. 4]].`;
    const label = (target: string, shown: string) => citationLabel(target, shown, title);
    expect(linkedMarkdown(text, label)).toBe(
      `See [Recitation 1 · p. 4](#wikilink:${encodeURIComponent(`page:${id}#4`)}).`,
    );
  });

  it("keep the student's own label, and a citation of a file no longer there", () => {
    expect(citationLabel(`page:${id}#4`, "the BFS diagram", title)).toBeNull();
    expect(citationLabel(`page:${id}#4`, "R01 · p. 5", title)).toBeNull();
    expect(
      citationLabel("page:11111111-2222-4333-8444-555555555555#2", "Lecture 2 · p. 2", title),
    ).toBeNull();
  });
});
