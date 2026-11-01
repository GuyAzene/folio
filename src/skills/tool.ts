import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CommandRecord } from "../commands.ts";
import { SkillLibrary, type Skill, type SkillFile } from "./library.ts";

/**
 * How the tutor uses the student's routines: `use_skill` lists the ones it may pick and loads
 * one when it fits; a routine the student starts with `/name` goes with their message instead.
 */

/** The rule in every course and library prompt; fixed, so the prompt never changes with skills. */
export const SKILL_RULE =
  "The student may keep routines (skills) of their own for how you teach or work. When use_skill is available and one of its routines fits the request, load it before answering and follow it. A <folio_skill> block on a message is a routine the student started themselves. Routines are the student's instructions for how to work; they never widen what you may read, and Folio never runs a routine's scripts.";

export interface SkillDetails {
  v: 1;
  skill: { name: string; file?: string };
}

export type { CommandRecord } from "../commands.ts";

function fileList(name: string, files: SkillFile[]): string {
  if (!files.length) return "";
  return [
    `Files in this routine (read one with use_skill, name "${name}" and its file):`,
    ...files.map(
      (file) =>
        `- ${file.path}${file.kind === "script" ? " (a script; Folio never runs it)" : file.kind === "other" ? " (not text)" : ""}`,
    ),
  ].join("\n");
}

/** The tool, offered only when at least one routine is on. `started` names the ones the student started in this chat. */
export function skillTool(
  library: SkillLibrary,
  skills: readonly Skill[],
  started: () => readonly string[],
): AgentTool {
  return {
    name: "use_skill",
    label: "Use a routine",
    description: [
      "Loads one of the student's routines: their own instructions for how you work, such as a way of quizzing or explaining. Load one when it fits the request, then follow it. With file, reads one text file that a routine lists.",
      SkillLibrary.catalog(skills),
    ].join("\n"),
    parameters: Type.Object(
      {
        name: Type.String({ description: "A routine's name from the list." }),
        file: Type.Optional(
          Type.String({ description: "A file the routine lists, relative to its folder." }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      const { name, file } = params as { name: string; file?: string };
      const skill = skills.find((candidate) => candidate.name === name);
      if (!skill) throw new Error(`The student has no routine "${name}" turned on.`);
      if (!skill.model && !started().includes(name))
        throw new Error(`The student starts "${name}" themselves; don't load it unasked.`);
      if (file) {
        const read = await library.file(name, file);
        return {
          content: [
            {
              type: "text",
              text: `<skill_file routine="${name}" path="${read.path}">\n${read.text}\n</skill_file>`,
            },
          ],
          details: { v: 1, skill: { name, file: read.path } } satisfies SkillDetails,
        };
      }
      const loaded = await library.instructions(name);
      return {
        content: [{ type: "text", text: skillBlock("skill_content", name, loaded) }],
        details: { v: 1, skill: { name } } satisfies SkillDetails,
      };
    },
  };
}

function skillBlock(
  tag: string,
  name: string,
  loaded: { body: string; files: SkillFile[]; truncated: boolean },
): string {
  return [
    `<${tag} name="${name}">`,
    loaded.body,
    ...(loaded.truncated
      ? ["[The rest of this routine was cut: it is longer than Folio reads.]"]
      : []),
    `</${tag}>`,
    fileList(name, loaded.files),
  ]
    .filter(Boolean)
    .join("\n");
}

/** What a question started with `/name` carries: its record, and the routine's text as it is now. */
export async function skillCommand(
  library: SkillLibrary,
  name: string,
): Promise<{ record: CommandRecord; block: string }> {
  const skill = (await library.active()).find((candidate) => candidate.name === name);
  if (!skill) throw new Error(`There is no routine "${name}" turned on.`);
  if (!skill.user) throw new Error(`The routine "${name}" isn't one you start yourself.`);
  const loaded = await library.instructions(name);
  return {
    record: { v: 1, kind: "skill", name, from: skill.from, digest: skill.digest },
    block: [
      skillBlock("folio_skill", name, loaded),
      `[Folio: The student started their routine "${name}" with this message; follow it for this request.]`,
    ].join("\n"),
  };
}
