import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, resolve } from "node:path";

/**
 * Where the student's commands are. An app opened from the Dock gets the system's short PATH, not
 * the one their shell sets up, so `moodle-mcp` (installed by uv in ~/.local/bin) or a Homebrew
 * tool wouldn't be found. Folio asks the login shell once, with a time limit, and adds the usual
 * install folders. A Windows app already gets the PATH the student set, so there it asks nothing.
 */

const MARK = "__FOLIO_PATH__";
const USUAL = [".local/bin", ".cargo/bin"].map((part) => resolve(homedir(), part));
const SYSTEM =
  process.platform === "win32"
    ? []
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** The PATH printed by the student's login shell, or null when it can't be read in time. */
export function shellPath(
  shell = process.env.SHELL || "/bin/zsh",
  timeoutMs = 5_000,
): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      shell,
      ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`],
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        env: {
          HOME: homedir(),
          USER: process.env.USER ?? "",
          LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
          SHELL: shell,
          TERM: "dumb",
          // Keeps oh-my-zsh from updating itself or starting tmux on the way.
          DISABLE_AUTO_UPDATE: "true",
          ZSH_TMUX_AUTOSTARTED: "true",
          ZSH_TMUX_AUTOSTART: "false",
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        const found = new RegExp(`${MARK}(.*?)${MARK}`, "s").exec(String(stdout))?.[1];
        done(found && !error ? found : found || null);
      },
    );
  });
}

/** One PATH from the shell's, Folio's own, and the usual install folders, without repeats. */
export function mergePath(...paths: (string | null | undefined)[]): string {
  const parts = [...paths.flatMap((path) => path?.split(delimiter) ?? []), ...USUAL, ...SYSTEM];
  return [...new Set(parts.filter((part) => part && isAbsolute(part)))].join(delimiter);
}

/**
 * The files a command may name. On Windows a program is found by the extensions PATHEXT lists, so
 * `npx` is `npx.cmd` and `uvx` is `uvx.exe`; a command that names its extension is taken as it is.
 */
function programFiles(file: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [file];
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const named = extname(file).toLowerCase();
  return extensions.some((extension) => extension.toLowerCase() === named)
    ? [file]
    : extensions.map((extension) => `${file}${extension.toLowerCase()}`);
}

/** The command's full path: as given when it has a slash, else the first match on PATH. */
export async function which(
  command: string,
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const executable = async (file: string) => {
    try {
      if (!(await stat(file)).isFile()) return false;
      await access(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const found = async (file: string) => {
    for (const candidate of programFiles(file, platform))
      if (await executable(candidate)) return candidate;
    return null;
  };
  const windows = platform === "win32";
  if (windows ? /[\\/]/.test(command) : command.includes("/")) {
    const home = windows ? /^~[\\/]/.test(command) : command.startsWith("~/");
    const file = home ? resolve(homedir(), command.slice(2)) : command;
    return isAbsolute(file) ? await found(file) : null;
  }
  for (const folder of path.split(delimiter)) {
    const file = await found(resolve(folder, command));
    if (file) return file;
  }
  return null;
}
