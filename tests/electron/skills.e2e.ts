/// <reference lib="dom" />
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_MODEL } from "../../src/agents.ts";
import type { FolioApi } from "../../src/desktop/api.ts";
import { createSessionStore } from "../../src/session-store.ts";
import { launch, type Running } from "./app.ts";
import { reply, seedHome } from "./seed.ts";

/**
 * The student's routines in a real window: Settings lists Folio's own and another agent's (off
 * until turned on), a switch writes config.json, and a chat started with /quiz-me shows it.
 * Synthetic skills only; nothing here talks to a model.
 */

const running: Running[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
});

declare global {
  interface Window {
    folio: FolioApi;
  }
}

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nAsk one question at a time.\n`;

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  await mkdir(resolve(root, name), { recursive: true });
  await writeFile(resolve(root, name, "SKILL.md"), skill(name, description));
}

void describe("routines", () => {
  void it("lists routines, turns another agent's on, and shows a started one in its chat", async () => {
    const seeded = await seedHome("A synthetic reply.", "lecture");
    await writeSkill(resolve(seeded.home, "skills"), "quiz-me", "Quiz me one question at a time.");
    const user = await mkdtemp(resolve(tmpdir(), "folio-e2e-user-"));
    await writeSkill(resolve(user, ".claude/skills"), "feynman", "Teach it back in plain words.");
    const sessions = await createSessionStore({ home: seeded.home });
    await sessions.create({
      modelId: DEFAULT_MODEL,
      scope: { courseId: seeded.courseId, library: 1 },
      focus: null,
      title: "lecture 1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "/quiz-me lecture 1" },
            { type: "text", text: '<folio_skill name="quiz-me">\nAsk.\n</folio_skill>' },
          ],
          timestamp: Date.now(),
          folioCommand: { v: 1, kind: "skill", name: "quiz-me", from: "Folio", digest: "x" },
        } as AgentMessage,
        reply("First question: what is a regular language?"),
      ],
    });

    const app = await launch(seeded.home, { FOLIO_SKILL_HOME: user });
    running.push(app);
    const { page } = app;
    await page.waitForFunction(() => !!window.folio);
    const listed = await page.evaluate(() => window.folio.listSkills());
    assert.deepEqual(
      listed.skills.map((each) => [each.name, each.from, each.on]),
      [
        ["quiz-me", "Folio", true],
        ["feynman", "Claude Code", false],
      ],
    );

    await page.keyboard.press("Meta+,");
    await page.getByRole("button", { name: "Skills" }).click();
    await page.getByText("/quiz-me").waitFor();
    await page.getByRole("switch", { name: "Use feynman" }).click();
    for (let waited = 0; waited < 5_000; waited += 100) {
      const config = JSON.parse(
        await readFile(resolve(seeded.home, "config.json"), "utf8").catch(() => "{}"),
      );
      if (config.skills?.on?.includes("~/.claude/skills/feynman")) break;
      await new Promise((ready) => setTimeout(ready, 100));
    }
    const config = JSON.parse(await readFile(resolve(seeded.home, "config.json"), "utf8"));
    assert.deepEqual(config.skills.on, ["~/.claude/skills/feynman"]);
    await page.keyboard.press("Escape");

    await page.keyboard.press("Meta+k");
    await page.keyboard.type("lecture 1");
    await page.getByRole("option", { name: "lecture 1", exact: true }).click();
    await page.getByText("First question: what is a regular language?").waitFor();
    await page.getByTitle("You started your routine quiz-me").waitFor();
  });
});
