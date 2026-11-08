import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The guide every agent works by: AGENTS.md, which Codex and Cursor read from the root, and the
// skills in .agents/skills, which Claude Code reads through links in .claude/skills.
const SKILLS = ".agents/skills";
const skills = readdirSync(SKILLS).filter((name) => existsSync(join(SKILLS, name, "SKILL.md")));
const guide = readFileSync("AGENTS.md", "utf8");
/** Whether git would leave a path out of a commit; `git check-ignore` exits 1 when it wouldn't. */
const gitIgnored = (path: string) =>
  spawnSync("git", ["check-ignore", "--quiet", "--no-index", path]).status === 0;

describe("the agents' guide", () => {
  it("is what Claude Code loads too, which reads CLAUDE.md and not AGENTS.md", () => {
    const claude = readFileSync("CLAUDE.md", "utf8");
    expect(claude.split("\n")).toContain("@AGENTS.md");
  });

  it("says itself to isolate before the first edit, since a skill's description may not reach an agent", () => {
    expect(guide).toContain("(`isolate`)");
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
      // Git keeps it as a link. Windows reads its target back with backslashes, and a checkout
      // without links writes the target into a small file instead.
      const link = join(".claude/skills", name);
      const target = lstatSync(link).isSymbolicLink()
        ? readlinkSync(link)
        : readFileSync(link, "utf8");
      expect(target.replaceAll("\\", "/"), link).toBe(`../../${SKILLS}/${name}`);
    }
  });

  it("links only to skills that git keeps", () => {
    for (const name of readdirSync(".claude/skills")) {
      expect(existsSync(join(SKILLS, name, "SKILL.md")), name).toBe(true);
      expect(gitIgnored(join(SKILLS, name, "SKILL.md")), name).toBe(false);
    }
  });

  it("names no skill after a command the agents already have, which it would shadow or lose to", () => {
    // Claude Code's /plan, and commands the agents commonly build in.
    const builtIn = [
      "plan",
      "review",
      "init",
      "help",
      "clear",
      "compact",
      "model",
      "status",
      "diff",
    ];
    expect(skills.filter((name) => builtIn.includes(name))).toEqual([]);
  });

  it("names every skill, and keeps the license of one that comes from elsewhere", () => {
    for (const name of skills) expect(guide, name).toContain(`\`${name}\``);
    expect(readFileSync(join(SKILLS, "unslop", "LICENSE"), "utf8")).toContain("MIT License");
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
