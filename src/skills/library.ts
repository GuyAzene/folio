import { lstat, mkdir, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { privateDirectory, writeAtomic } from "../files.ts";
import {
  MAX_SKILL_BYTES,
  nameProblem,
  parseSkill,
  skillDigest,
  skillText,
  type SkillMeta,
} from "./skill-file.ts";

/**
 * The student's routines: Agent Skills folders, from Folio's own folder and from folders the
 * student adds, whose routines start off. Folio never looks in other apps' skill folders. It reads
 * a skill's instructions and its text files; it never runs anything in it.
 */

export type SkillSource = "folio" | "folder";

/** Which skills are on, keyed by folder (with ~ for the home folder), and folders added. */
export interface SkillSwitches {
  on: string[];
  off: string[];
  folders: string[];
}

export const NO_SWITCHES: SkillSwitches = { on: [], off: [], folders: [] };

export interface Skill extends SkillMeta {
  /** The folder as found, with ~ for the home folder: the skill's key in config.json. */
  key: string;
  source: SkillSource;
  /** Where it came from, for Settings: "Folio", or the added folder. */
  from: string;
  on: boolean;
  /** Set when an earlier skill that is on has the same name, so this one isn't used. */
  hiddenBy?: string;
  digest: string;
}

export interface SkippedSkill {
  key: string;
  from: string;
  reason: string;
}

export interface SkillFile {
  path: string;
  kind: "text" | "script" | "other";
}

export class SkillError extends Error {}

const MAX_BODY = 40_000;
const MAX_FILE = 128 * 1024;
const MAX_LISTED = 100;
const MAX_CATALOG = 8_000;
const SCRIPT = new Set([
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".rb",
  ".pl",
  ".ps1",
  ".bat",
  ".exe",
]);
const TEXT = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".tsv",
  ".tex",
  ".bib",
  ".html",
  ".xml",
  ".svg",
  "",
]);

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const exists = (path: string) =>
  stat(path).then(
    (found) => found,
    () => null,
  );

interface Found {
  skill: Skill;
  dir: string;
  mtime: number;
  size: number;
}

export class SkillLibrary {
  readonly #folio: string;
  readonly #user: string;
  readonly #switches: () => SkillSwitches;
  /** Parsed SKILL.md files by path, kept while the file is unchanged. */
  readonly #cache = new Map<
    string,
    { mtime: number; size: number; parsed: ReturnType<typeof parseSkill>; digest: string }
  >();

  /**
   * `home` is Folio's home (its own skills live in `skills/` there); `user` is the home folder an
   * added folder's ~ stands for, the student's own outside tests.
   */
  constructor(options: { home: string; user: string; switches: () => SkillSwitches }) {
    this.#folio = resolve(options.home, "skills");
    this.#user = options.user;
    this.#switches = options.switches;
  }

  /** Folio's own skills folder, which Settings opens. */
  get folder(): string {
    return this.#folio;
  }

  /** A path with ~ for the home folder and forward slashes after it, as config.json keeps it. */
  key(path: string): string {
    const part = relative(this.#user, path);
    return part && !part.startsWith("..") && !isAbsolute(part)
      ? `~/${part.split(sep).join("/")}`
      : path;
  }

  /** A key back to a path. */
  path(key: string): string {
    return key === "~" || key.startsWith("~/") ? resolve(this.#user, key.slice(2)) : key;
  }

  #roots(): { dir: string; source: SkillSource; from: string }[] {
    return [
      { dir: this.#folio, source: "folio", from: "Folio" },
      ...this.#switches().folders.map((key) => ({
        dir: this.path(key),
        source: "folder" as const,
        from: key,
      })),
    ];
  }

  /** Every skill found, in order, and the ones Folio couldn't read. */
  async scan(): Promise<{ skills: Skill[]; skipped: SkippedSkill[] }> {
    const switches = this.#switches();
    const found: Found[] = [];
    const skipped: SkippedSkill[] = [];
    const seen = new Set<string>();
    for (const root of this.#roots()) {
      const folders = (await exists(resolve(root.dir, "SKILL.md")))
        ? [root.dir]
        : await readdir(root.dir, { withFileTypes: true }).then(
            (entries) =>
              entries
                .filter(
                  (entry) =>
                    (entry.isDirectory() || entry.isSymbolicLink()) &&
                    !entry.name.startsWith(".") &&
                    entry.name !== "node_modules",
                )
                .map((entry) => resolve(root.dir, entry.name))
                .sort(),
            () => [] as string[],
          );
      for (const dir of folders) {
        const key = this.key(dir);
        if (seen.has(key)) continue;
        const file = resolve(dir, "SKILL.md");
        const info = await exists(file);
        if (!info?.isFile()) continue;
        seen.add(key);
        if (info.size > MAX_SKILL_BYTES) {
          skipped.push({ key, from: root.from, reason: "its SKILL.md is larger than 256 KB" });
          continue;
        }
        let cached = this.#cache.get(file);
        if (!cached || cached.mtime !== info.mtimeMs || cached.size !== info.size) {
          const text = await readFile(file, "utf8");
          cached = {
            mtime: info.mtimeMs,
            size: info.size,
            parsed: parseSkill(text, basename(dir)),
            digest: skillDigest(text),
          };
          this.#cache.set(file, cached);
        }
        const { parsed } = cached;
        if ("problem" in parsed) {
          skipped.push({ key, from: root.from, reason: parsed.problem });
          continue;
        }
        const on =
          root.source === "folio" ? !switches.off.includes(key) : switches.on.includes(key);
        found.push({
          skill: {
            ...parsed.meta,
            key,
            source: root.source,
            from: root.from,
            on,
            digest: cached.digest,
          },
          dir,
          mtime: info.mtimeMs,
          size: info.size,
        });
      }
    }
    // Among skills that are on, the first of a name is used; later ones say which hides them.
    const used = new Map<string, Skill>();
    for (const { skill } of found) {
      if (!skill.on) continue;
      const first = used.get(skill.name);
      if (first) skill.hiddenBy = `${first.from}'s ${first.name}`;
      else used.set(skill.name, skill);
    }
    return { skills: found.map((item) => item.skill), skipped };
  }

  /** The skills the tutor and the student can use now: on, and not hidden by another. */
  async active(): Promise<Skill[]> {
    return (await this.scan()).skills.filter((skill) => skill.on && !skill.hiddenBy);
  }

  /** The `<available_skills>` list for skills the tutor may pick itself, within its budget. */
  static catalog(skills: readonly Skill[]): string {
    const lines = ["<available_skills>"];
    let size = lines[0]!.length;
    let left = 0;
    for (const skill of skills.filter((candidate) => candidate.model)) {
      const line = `<skill><name>${skill.name}</name><description>${escape(skill.description)}</description></skill>`;
      if (size + line.length > MAX_CATALOG) left++;
      else {
        lines.push(line);
        size += line.length + 1;
      }
    }
    lines.push("</available_skills>");
    if (left) lines.push(`(${left} more routines didn't fit in this list.)`);
    return lines.join("\n");
  }

  async #find(name: string): Promise<{ skill: Skill; dir: string }> {
    const skill = (await this.active()).find((candidate) => candidate.name === name);
    if (!skill) throw new SkillError(`The student has no routine "${name}" turned on.`);
    const dir = await realpath(this.path(skill.key)).catch(() => {
      throw new SkillError(`The routine "${name}" is no longer where Folio found it.`);
    });
    return { skill, dir };
  }

  /** A skill's instructions, as they are now, and the files that come with it. */
  async instructions(
    name: string,
  ): Promise<{ skill: Skill; body: string; files: SkillFile[]; truncated: boolean }> {
    const { skill, dir } = await this.#find(name);
    const parsed = parseSkill(await readFile(resolve(dir, "SKILL.md"), "utf8"), basename(dir));
    if ("problem" in parsed)
      throw new SkillError(`The routine "${name}" can't be read: ${parsed.problem}.`);
    const truncated = parsed.body.length > MAX_BODY;
    return {
      skill,
      body: truncated ? parsed.body.slice(0, MAX_BODY) : parsed.body,
      files: await listFiles(dir),
      truncated,
    };
  }

  /** One text file in a skill's folder. */
  async file(name: string, path: string): Promise<{ skill: Skill; path: string; text: string }> {
    const { skill, dir } = await this.#find(name);
    const target = await realpath(resolve(dir, path)).catch(() => {
      throw new SkillError(`The routine "${name}" has no file ${path}.`);
    });
    if (!target.startsWith(`${dir}${sep}`))
      throw new SkillError(`${path} isn't inside the routine "${name}".`);
    const info = await stat(target);
    if (!info.isFile()) throw new SkillError(`${path} isn't a file.`);
    if (info.size > MAX_FILE) throw new SkillError(`${path} is larger than 128 KB.`);
    const bytes = await readFile(target);
    if (bytes.includes(0)) throw new SkillError(`${path} isn't a text file.`);
    const shown = relative(dir, target).split(sep).join("/");
    return { skill, path: shown, text: new TextDecoder().decode(bytes) };
  }

  /** The SKILL.md of one of Folio's own routines, to edit, with its revision. */
  async read(name: string): Promise<{ text: string; revision: string }> {
    const file = await this.#own(name);
    const text = await readFile(file, "utf8");
    return { text, revision: skillDigest(text) };
  }

  /** Makes a new routine in Folio's own folder. */
  async create(name: string, description: string, body: string): Promise<void> {
    const problem = nameProblem(name);
    if (problem) throw new SkillError(`That name can't be used: ${problem}.`);
    const text = skillText(name, description, body);
    if ("problem" in parseSkill(text, name)) throw new SkillError("Write a description.");
    await privateDirectory(this.#folio, "skills", SkillError);
    const dir = resolve(this.#folio, name);
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch {
      throw new SkillError(`There is already a routine named ${name}.`);
    }
    const handle = await open(resolve(dir, "SKILL.md"), "wx", 0o600);
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  }

  /** Saves an edited SKILL.md; refused when it changed since `revision` or no longer reads. */
  async save(name: string, text: string, revision: string): Promise<void> {
    const file = await this.#own(name);
    const parsed = parseSkill(text, name);
    if ("problem" in parsed) throw new SkillError(`This can't be saved: ${parsed.problem}.`);
    if (parsed.meta.name !== name)
      throw new SkillError(`Keep the name ${name}; a routine's name is its folder's.`);
    const changed = new SkillError("This routine changed since you opened it. Open it again.");
    if (skillDigest(await readFile(file, "utf8")) !== revision) throw changed;
    await writeAtomic(file, text, {
      check: async () => {
        if (skillDigest(await readFile(file, "utf8")) !== revision) throw changed;
      },
    });
  }

  async #own(name: string): Promise<string> {
    if (nameProblem(name)) throw new SkillError("No such routine.");
    const file = resolve(this.#folio, name, "SKILL.md");
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) throw new SkillError(`Folio has no routine of its own named ${name}.`);
    return file;
  }
}

/** The files that come with a skill, a few levels deep, without reading them. */
async function listFiles(dir: string): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  async function walk(folder: string, depth: number): Promise<void> {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_LISTED) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) await walk(path, depth + 1);
      } else if (entry.isFile()) {
        // With forward slashes on Windows too, as a routine names its files.
        const rel = relative(dir, path).split(sep).join("/");
        if (rel === "SKILL.md") continue;
        const ext = extname(entry.name).toLowerCase();
        const executable = ((await stat(path).catch(() => null))?.mode ?? 0) & 0o111;
        files.push({
          path: rel,
          kind: SCRIPT.has(ext) || executable ? "script" : TEXT.has(ext) ? "text" : "other",
        });
      }
    }
  }
  await walk(dir, 1);
  return files;
}
