import { createHash } from "node:crypto";
import { parse } from "yaml";

/**
 * One `SKILL.md` in the open Agent Skills format: YAML frontmatter (a name and a description,
 * with a few optional fields), then the instructions. Folio reads skills written for other
 * agents too, so it is lenient where that costs nothing and strict where a name must work as a
 * `/` command.
 */

export const MAX_SKILL_BYTES = 256 * 1024;
const MAX_FRONTMATTER = 16 * 1024;
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface SkillMeta {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** Tools the skill asks for in other agents; shown, never granted. */
  allowedTools?: string;
  /** False when the skill says only the student may start it (`disable-model-invocation`). */
  model: boolean;
  /** False when the skill says it isn't for the student to call (`user-invocable: false`). */
  user: boolean;
  /** Something worth saying about a skill that still loads, such as a name unlike its folder. */
  note?: string;
}

export type ParsedSkill = { meta: SkillMeta; body: string } | { problem: string };

export const skillDigest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Why a skill name can't be used, or null. */
export function nameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !name) return "it has no name";
  if (name.length > 64) return "its name is longer than 64 characters";
  if (!NAME.test(name)) return "its name isn't lowercase letters, digits and single hyphens";
  return null;
}

/** Reads a SKILL.md found in the folder `folder` (its last path part). */
export function parseSkill(text: string, folder: string): ParsedSkill {
  const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!source.startsWith("---\n")) return { problem: "SKILL.md doesn't start with frontmatter" };
  const end = source.indexOf("\n---", 3);
  if (end === -1 || end > MAX_FRONTMATTER)
    return { problem: "SKILL.md's frontmatter doesn't end with ---" };
  let raw: unknown;
  try {
    raw = parse(source.slice(4, end + 1), { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    return { problem: "its frontmatter isn't valid YAML" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { problem: "its frontmatter isn't a list of fields" };
  const fields = raw as Record<string, unknown>;
  const description =
    typeof fields.description === "string" ? fields.description.replace(/\s+/g, " ").trim() : "";
  if (!description) return { problem: "it has no description" };
  if (description.length > 1024)
    return { problem: "its description is longer than 1024 characters" };
  const name = fields.name === undefined ? folder : fields.name;
  const problem = nameProblem(name);
  if (problem) return { problem };
  const field = (value: unknown, limit: number) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
  const meta: SkillMeta = {
    name: name as string,
    description,
    model: fields["disable-model-invocation"] !== true,
    user: fields["user-invocable"] !== false,
  };
  const license = field(fields.license, 200);
  const compatibility = field(fields.compatibility, 500);
  const allowedTools = field(fields["allowed-tools"], 500);
  if (license) meta.license = license;
  if (compatibility) meta.compatibility = compatibility;
  if (allowedTools) meta.allowedTools = allowedTools;
  if (name !== folder)
    meta.note = `Its name, ${name as string}, differs from its folder, ${folder}.`;
  // The body starts after the closing line of dashes.
  const after = source.indexOf("\n", end + 1);
  return { meta, body: after === -1 ? "" : source.slice(after + 1).trim() };
}

const quoted = (value: string) => JSON.stringify(value);

/** A new SKILL.md for one of Folio's own routines. */
export function skillText(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${quoted(description.replace(/\s+/g, " ").trim())}\n---\n\n${body.trim()}\n`;
}
