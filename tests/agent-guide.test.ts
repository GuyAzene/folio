import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The guide every agent works by: AGENTS.md, which Codex and Cursor read from the root, and the
// skills in .agents/skills, which Claude Code reads through links in .claude/skills.
const SKILLS = ".agents/skills";
const skills = readdirSync(SKILLS).filter((name) => existsSync(join(SKILLS, name, "SKILL.md")));
const guide = readFileSync("AGENTS.md", "utf8");

describe("the agents' guide", () => {
  it("is what Claude Code loads too, which reads CLAUDE.md and not AGENTS.md", () => {
    const claude = readFileSync("CLAUDE.md", "utf8");
    expect(claude.split("\n")).toContain("@AGENTS.md");
  });

  it("says itself to isolate before the first edit, since a skill's description may not reach an agent", () => {
    expect(guide).toContain("folio-isolate");
    expect(guide).toContain("before the first edit");
    expect(guide).toMatch(/git worktree add \.\.\/folio-<task> -b <agent>\/<task> origin\/main/);
    expect(guide).toContain("git branch --show-current");
  });

  it("gives every skill a name, a description, and a link Claude Code reads it through", () => {
    expect(skills.length).toBeGreaterThan(0);
    for (const name of skills) {
      const text = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
      const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
      expect(front?.[1], name).toBe(name);
      expect(front?.[2]?.length, name).toBeGreaterThan(40);
      const link = join(".claude/skills", name);
      expect(lstatSync(link).isSymbolicLink(), link).toBe(true);
      expect(readlinkSync(link)).toBe(`../../${SKILLS}/${name}`);
    }
  });

  it("only links to files that exist", () => {
    const files = ["AGENTS.md", ...skills.map((name) => join(SKILLS, name, "SKILL.md"))];
    for (const file of files) {
      for (const [, target] of readFileSync(file, "utf8").matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(target!)) continue;
        expect(existsSync(resolve(dirname(file), target!)), `${file} → ${target}`).toBe(true);
      }
    }
  });
});
