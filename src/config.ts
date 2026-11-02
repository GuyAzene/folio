import { resolve } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { IMAGE_ROLES, MODEL_ROLES, type ModelRole } from "./desktop/api.ts";
import { EditableFile } from "./editable-file.ts";
import { DEFAULT_OPENROUTER, modelFor, modelName, offered } from "./model-choices.ts";
import { formatRef, parseRef, studyModel } from "./model-refs.ts";
import { NO_SWITCHES, type SkillSwitches } from "./skills/library.ts";
import { DEFAULT_MODEL } from "./agents.ts";
import { DEFAULT_ROLES as STUDY_DEFAULTS, type RoleModels } from "./ingest/pipeline.ts";
import {
  categoriesProblem,
  namingProblem,
  readCategories,
  readNaming,
  writeCategories,
  type Category,
} from "./library/categories.ts";

/**
 * Which model does what, from `config.json` in Folio's home: the student's file, edited in
 * Settings or by hand. Keys never go in it, so it can be copied or shared. Folio checks every
 * entry in code; one it can't use is reported and its default applies, and the file is never
 * rewritten behind the student's back.
 */

const chatgpt = (id: string) => formatRef("chatgpt", id);

/**
 * Today's assignments, all on the ChatGPT plan: what config.json leaves out keeps these. Studying
 * keeps the models its own defaults name.
 */
export const DEFAULT_ROLES: Record<ModelRole, string> = {
  teaching: chatgpt(DEFAULT_MODEL),
  research: chatgpt("gpt-6.1-terra"),
  planner: chatgpt(STUDY_DEFAULTS.brief),
  reader: chatgpt(STUDY_DEFAULTS.reader),
  closeup: chatgpt(STUDY_DEFAULTS.escalation),
  writer: chatgpt(STUDY_DEFAULTS.author),
  checker: chatgpt(STUDY_DEFAULTS.reviewer),
  rechecker: chatgpt(STUDY_DEFAULTS.recheck ?? STUDY_DEFAULTS.reviewer),
  topics: chatgpt("gpt-6.1-terra"),
  syllabus: chatgpt(DEFAULT_MODEL),
};

/** Studying's roles as the pipeline names them, from the config's; each step keeps its effort. */
export function studyRoles(roles: Record<ModelRole, string>): RoleModels {
  return {
    ...STUDY_DEFAULTS,
    brief: studyModel(roles.planner),
    reader: studyModel(roles.reader),
    escalation: studyModel(roles.closeup),
    author: studyModel(roles.writer),
    reviewer: studyModel(roles.checker),
    recheck: studyModel(roles.rechecker),
  };
}

/** Where each role sits in config.json, grouped by routine. */
const PATHS: Record<ModelRole, readonly [string, string]> = {
  teaching: ["teaching", "model"],
  research: ["research", "model"],
  planner: ["studying", "planner"],
  reader: ["studying", "reader"],
  closeup: ["studying", "closeup"],
  writer: ["studying", "writer"],
  checker: ["studying", "checker"],
  rechecker: ["studying", "rechecker"],
  topics: ["studying", "topics"],
  syllabus: ["library", "syllabus"],
};

/** What a role's model does, for saying why a model can't do it. */
const WORK: Record<ModelRole, string> = {
  teaching: "tutoring",
  research: "searching the web",
  planner: "outlining a lecture",
  reader: "reading slides",
  closeup: "re-reading hard parts of a slide",
  writer: "writing study notes",
  checker: "checking notes against the slides",
  rechecker: "checking corrected notes against the slides",
  topics: "comparing topics",
  syllabus: "reading a syllabus",
};

export interface ConfigState {
  roles: Record<ModelRole, string>;
  openrouter: string[];
  /** The student's kinds of course file. */
  categories: Category[];
  /** How files are named when their category has no pattern of its own; null keeps their names. */
  naming: string | null;
  /** Which of the student's routines are on, and folders of routines they added. */
  skills: SkillSwitches;
  /** Entries Folio could not use, each with where it is and why. */
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why a role can't use this model, or null when it can. */
export function roleProblem(
  catalog: Models,
  role: ModelRole,
  ref: unknown,
  openrouter: readonly string[],
): string | null {
  const parsed = parseRef(ref);
  if (!parsed) return "write a model as connection/model, such as chatgpt/gpt-6.1-sol";
  const model = modelFor(catalog, ref as string);
  if (!model)
    return parsed.connection.id === "chatgpt"
      ? `${parsed.id} isn't one of the ChatGPT plan's models in Folio`
      : `${parsed.connection.name} has no model ${parsed.id} that Folio knows`;
  const name = modelName(model);
  if (IMAGE_ROLES.includes(role) && !model.input.includes("image"))
    return `${name} reads text only, and ${WORK[role]} needs page images`;
  if (role === "teaching" && !offered(ref as string, openrouter))
    return parsed.connection.id === "openrouter"
      ? `add ${name} to the composer's OpenRouter models first`
      : `${name} isn't one of the composer's models`;
  return null;
}

/** Applies config.json to the defaults; `raw` is the parsed file, or undefined without one. */
export function readConfig(catalog: Models, raw: unknown): ConfigState {
  const roles = { ...DEFAULT_ROLES };
  const problems: string[] = [];
  const defaults = readCategories(undefined).categories;
  if (raw === undefined)
    return {
      roles,
      openrouter: [...DEFAULT_OPENROUTER],
      categories: defaults,
      naming: null,
      skills: structuredClone(NO_SWITCHES),
      problems,
    };
  if (!isRecord(raw))
    return {
      roles,
      openrouter: [...DEFAULT_OPENROUTER],
      categories: defaults,
      naming: null,
      skills: structuredClone(NO_SWITCHES),
      problems: ["config.json isn't a JSON object, so Folio uses its defaults until it's fixed."],
    };
  if (raw.version !== 1)
    return {
      roles,
      openrouter: [...DEFAULT_OPENROUTER],
      categories: defaults,
      naming: null,
      skills: structuredClone(NO_SWITCHES),
      problems: [
        `config.json is version ${JSON.stringify(raw.version)}, which this Folio can't read; it uses its defaults.`,
      ],
    };
  let openrouter = [...DEFAULT_OPENROUTER];
  const listed = isRecord(raw.openrouter) ? raw.openrouter.models : undefined;
  if (listed !== undefined) {
    if (!Array.isArray(listed))
      problems.push("openrouter.models: write a list of OpenRouter model IDs.");
    else {
      openrouter = [];
      for (const id of listed) {
        if (typeof id === "string" && modelFor(catalog, formatRef("openrouter", id))) {
          if (!openrouter.includes(id)) openrouter.push(id);
        } else
          problems.push(
            `openrouter.models: OpenRouter has no model ${String(id)} that Folio knows.`,
          );
      }
    }
  }
  for (const role of MODEL_ROLES) {
    const [group, key] = PATHS[role];
    const section = raw[group];
    if (section === undefined) continue;
    if (!isRecord(section)) {
      problems.push(`${group}: write an object, such as { "${key}": "${DEFAULT_ROLES[role]}" }.`);
      continue;
    }
    const value = section[key];
    if (value === undefined) continue;
    const problem = roleProblem(catalog, role, value, openrouter);
    if (problem) problems.push(`${group}.${key}: ${problem}.`);
    else roles[role] = value as string;
  }
  const library = readCategories(raw.library);
  const naming = readNaming(raw.library);
  const skills = readSkills(raw.skills);
  problems.push(...library.problems, ...naming.problems, ...skills.problems);
  return {
    roles,
    openrouter,
    categories: library.categories,
    naming: naming.naming,
    skills: skills.switches,
    problems: [...new Set(problems)],
  };
}

/** The `skills` section: lists of skill folders turned on and off, and folders added. */
export function readSkills(raw: unknown): { switches: SkillSwitches; problems: string[] } {
  const switches = structuredClone(NO_SWITCHES);
  if (raw === undefined) return { switches, problems: [] };
  if (!isRecord(raw))
    return { switches, problems: ['skills: write an object, such as { "on": [], "off": [] }.'] };
  const problems: string[] = [];
  for (const key of ["on", "off", "folders"] as const) {
    const list = raw[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && item)) {
      problems.push(`skills.${key}: write a list of folders.`);
      continue;
    }
    switches[key] = [...new Set(list as string[])];
  }
  return { switches, problems };
}

const CHANGED = "config.json changed outside Folio. Settings now shows it; try again.";

export class FolioConfig {
  readonly #file: EditableFile;
  readonly #catalog: Models;
  /** Its parsed contents, when it is a JSON object Folio can write back. */
  #raw: Record<string, unknown> | null = null;
  #state: ConfigState;

  private constructor(home: string, catalog: Models) {
    this.#file = new EditableFile(resolve(home, "config.json"), { changed: CHANGED });
    this.#catalog = catalog;
    this.#state = readConfig(catalog, undefined);
  }

  get path(): string {
    return this.#file.path;
  }

  static async open(home: string, catalog: Models): Promise<FolioConfig> {
    const config = new FolioConfig(home, catalog);
    await config.reload();
    return config;
  }

  get roles(): Record<ModelRole, string> {
    return { ...this.#state.roles };
  }
  get openrouter(): string[] {
    return [...this.#state.openrouter];
  }
  get problems(): string[] {
    return [...this.#state.problems];
  }
  get categories(): Category[] {
    return structuredClone(this.#state.categories);
  }
  get naming(): string | null {
    return this.#state.naming;
  }
  get skills(): SkillSwitches {
    return structuredClone(this.#state.skills);
  }

  #apply(text: string | null): void {
    let parsed: unknown;
    let broken = false;
    if (text !== null)
      try {
        parsed = JSON.parse(text);
      } catch {
        broken = true;
      }
    this.#raw = isRecord(parsed) && parsed.version === 1 ? parsed : null;
    this.#state = broken
      ? {
          ...readConfig(this.#catalog, undefined),
          problems: ["config.json isn't valid JSON, so Folio uses its defaults until it's fixed."],
        }
      : readConfig(this.#catalog, text === null ? undefined : parsed);
  }

  /** Reads the file again; true when what Folio uses or reports changed. */
  async reload(): Promise<boolean> {
    const before = JSON.stringify(this.#state);
    this.#apply(await this.#file.load());
    return JSON.stringify(this.#state) !== before;
  }

  /** Sets one role's model; refused when the model can't do it or the file changed elsewhere. */
  setRole(role: ModelRole, ref: string): Promise<void> {
    if (!MODEL_ROLES.includes(role)) return Promise.reject(new Error("Unknown role."));
    const problem = roleProblem(this.#catalog, role, ref, this.#state.openrouter);
    if (problem)
      return Promise.reject(new Error(`${problem.charAt(0).toUpperCase()}${problem.slice(1)}.`));
    const [group, key] = PATHS[role];
    return this.#update((raw) => {
      raw[group] = { ...(isRecord(raw[group]) ? raw[group] : {}), [key]: ref };
    });
  }

  /** Sets which OpenRouter models the composer offers. */
  setOpenRouter(ids: unknown): Promise<void> {
    if (
      !Array.isArray(ids) ||
      !ids.every(
        (id) => typeof id === "string" && modelFor(this.#catalog, formatRef("openrouter", id)),
      )
    )
      return Promise.reject(new Error("Pick models from OpenRouter's list."));
    return this.#update((raw) => {
      raw.openrouter = {
        ...(isRecord(raw.openrouter) ? raw.openrouter : {}),
        models: [...new Set(ids as string[])],
      };
    });
  }

  /** Saves the student's categories, in their order. */
  setCategories(categories: unknown): Promise<void> {
    const problem = categoriesProblem(categories);
    if (problem) return Promise.reject(new Error(problem));
    const list = readCategories({ categories }).categories;
    return this.#update((raw) => {
      raw.library = {
        ...(isRecord(raw.library) ? raw.library : {}),
        categories: writeCategories(list),
      };
    });
  }

  /** Sets how files are named when their category has no pattern; null keeps their names. */
  setNaming(pattern: unknown): Promise<void> {
    const clean = typeof pattern === "string" ? pattern.trim() || null : pattern;
    const problem = namingProblem(clean);
    if (problem)
      return Promise.reject(new Error(`${problem.charAt(0).toUpperCase()}${problem.slice(1)}.`));
    return this.#update((raw) => {
      raw.library = { ...(isRecord(raw.library) ? raw.library : {}), naming: clean };
    });
  }

  /**
   * Turns one routine on or off, by its folder's key. `usual` is whether it is on with no entry:
   * Folio's own routines are, those in folders the student added are not.
   */
  setSkill(key: string, on: boolean, usual: boolean): Promise<void> {
    if (typeof key !== "string" || !key) return Promise.reject(new Error("Unknown routine."));
    return this.#update((raw) => {
      const current = readSkills(raw.skills).switches;
      const turnedOn = current.on.filter((item) => item !== key);
      const off = current.off.filter((item) => item !== key);
      if (on !== usual) (on ? turnedOn : off).push(key);
      raw.skills = { ...(isRecord(raw.skills) ? raw.skills : {}), on: turnedOn, off };
    });
  }

  /** Adds or removes a folder of routines, by its key. */
  setSkillFolder(key: string, added: boolean): Promise<void> {
    if (typeof key !== "string" || !key) return Promise.reject(new Error("Pick a folder."));
    return this.#update((raw) => {
      const current = readSkills(raw.skills).switches;
      const folders = current.folders.filter((item) => item !== key);
      if (added) folders.push(key);
      raw.skills = { ...(isRecord(raw.skills) ? raw.skills : {}), folders };
    });
  }

  /** Writes today's choices when there is no file yet, so there is one to open and edit. */
  async ensure(): Promise<void> {
    if ((await this.#file.read()) !== null) return;
    const state = this.#state;
    await this.#update((raw) => {
      for (const role of MODEL_ROLES) {
        const [group, key] = PATHS[role];
        raw[group] = { ...(isRecord(raw[group]) ? raw[group] : {}), [key]: state.roles[role] };
      }
      raw.openrouter = { models: state.openrouter };
      raw.library = { categories: writeCategories(state.categories) };
    });
  }

  #update(change: (raw: Record<string, unknown>) => void): Promise<void> {
    return this.#file.write(
      (text) => {
        if (text !== null && !this.#raw)
          throw new Error(
            "Folio can't change config.json while it isn't a version 1 JSON object. Fix or remove it, then try again.",
          );
        const raw = structuredClone(this.#raw ?? { version: 1 });
        change(raw);
        return `${JSON.stringify(raw, null, 2)}\n`;
      },
      { stale: () => this.reload(), written: (next) => this.#apply(next) },
    );
  }

  /** Calls `changed` after the file is edited outside Folio and what it says changed. */
  watch(changed: () => void): () => void {
    return this.#file.watch(async () => {
      if (await this.reload()) changed();
    });
  }
}
