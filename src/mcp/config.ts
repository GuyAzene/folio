import { createHash } from "node:crypto";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { EditableFile } from "../editable-file.ts";

/**
 * The MCP servers the student connected, in `mcp.json` in Folio's home: the common `mcpServers`
 * shape (a block from a server's README, Claude Code or Claude Desktop pastes in as it is), plus a
 * `folio` block per server for what Folio adds: its label, whether it is on, and which tools run
 * without asking. Settings may hold keys and passwords, so the file is the student's alone (0600)
 * and no value of a setting or header ever leaves the main process.
 */

export type ToolRule = "ask" | "allow" | "off";

export interface ServerEntry {
  id: string;
  label: string;
  kind: "local" | "remote";
  /** A local server's program and arguments, shown to the student in full. */
  command?: string;
  args: string[];
  cwd?: string;
  /** Settings passed to a local server: often a key or a password. */
  env: Record<string, string>;
  /** A remote server's address, and headers such as a token. */
  url?: string;
  headers: Record<string, string>;
  enabled: boolean;
  /** "allow": every tool runs without asking. */
  approval: "ask" | "allow";
  tools: Record<string, ToolRule>;
  timeoutSeconds: number;
}

export interface McpState {
  servers: ServerEntry[];
  problems: string[];
}

/** What the window may send to add or change a server. A setting's null removes it; one left out stays. */
export interface ServerInput {
  id: string;
  label?: string;
  command?: string;
  args?: string[];
  cwd?: string | null;
  url?: string;
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const RULES: readonly ToolRule[] = ["ask", "allow", "off"];
const CHANGED = "mcp.json changed outside Folio. Settings now shows it; try again.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === "string");

/** Why a remote address can't be used, or null: https, or plain http to this Mac only. */
export function urlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "its address isn't a URL";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    return null;
  return "its address must start with https://";
}

/** Reads one entry; a string is why it can't be used. */
function readEntry(id: string, raw: unknown): ServerEntry | string {
  if (!ID.test(id)) return "use a name of letters, digits, - and _";
  if (!isRecord(raw)) return 'write an object, such as { "command": "moodle-mcp" }';
  const type = raw.type;
  if (type === "sse")
    return "it uses SSE, which Folio doesn't speak; use the server's Streamable HTTP address";
  const remote =
    type === "http" ||
    type === "streamable-http" ||
    (type === undefined && "url" in raw && !("command" in raw));
  if (type !== undefined && type !== "stdio" && !remote)
    return `Folio doesn't know the type ${JSON.stringify(type)}`;
  const folio = isRecord(raw.folio) ? raw.folio : {};
  const label =
    typeof folio.label === "string" && folio.label.trim()
      ? folio.label.trim().slice(0, 60)
      : id.charAt(0).toUpperCase() + id.slice(1);
  const tools: Record<string, ToolRule> = {};
  if (isRecord(folio.tools))
    for (const [name, rule] of Object.entries(folio.tools))
      if (RULES.includes(rule as ToolRule)) tools[name] = rule as ToolRule;
  const timeout = Number(folio.timeoutSeconds);
  const shared = {
    id,
    label,
    enabled: folio.enabled !== false,
    approval: folio.approval === "allow" ? ("allow" as const) : ("ask" as const),
    tools,
    timeoutSeconds: Number.isFinite(timeout)
      ? Math.min(600, Math.max(5, Math.round(timeout)))
      : 120,
  };
  if (remote) {
    if (typeof raw.url !== "string") return 'write its address as "url"';
    const problem = urlProblem(raw.url);
    if (problem) return problem;
    if (raw.headers !== undefined && !strings(raw.headers)) return "its headers must be text";
    return {
      ...shared,
      kind: "remote",
      url: raw.url,
      headers: { ...(raw.headers as object) },
      args: [],
      env: {},
    };
  }
  if (typeof raw.command !== "string" || !raw.command.trim())
    return 'write the program to run as "command"';
  if (
    raw.args !== undefined &&
    (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === "string"))
  )
    return "write its arguments as a list of text";
  if (raw.env !== undefined && !strings(raw.env)) return "its settings (env) must be text";
  if (raw.cwd !== undefined && typeof raw.cwd !== "string") return "write its folder (cwd) as text";
  return {
    ...shared,
    kind: "local",
    command: raw.command.trim(),
    args: [...((raw.args as string[] | undefined) ?? [])],
    ...(typeof raw.cwd === "string" && raw.cwd ? { cwd: raw.cwd } : {}),
    env: { ...(raw.env as Record<string, string> | undefined) },
    headers: {},
  };
}

/** Reads mcp.json's contents; `raw` is the parsed file, or undefined without one. */
export function readMcp(raw: unknown): McpState {
  if (raw === undefined) return { servers: [], problems: [] };
  if (!isRecord(raw) || (raw.version !== undefined && raw.version !== 1))
    return {
      servers: [],
      problems: ["mcp.json isn't a version 1 JSON object, so no server starts until it's fixed."],
    };
  if (raw.mcpServers === undefined) return { servers: [], problems: [] };
  if (!isRecord(raw.mcpServers))
    return { servers: [], problems: ["mcpServers: write an object of servers by name."] };
  const servers: ServerEntry[] = [];
  const problems: string[] = [];
  for (const [id, entry] of Object.entries(raw.mcpServers)) {
    const read = readEntry(id, entry);
    if (typeof read === "string") problems.push(`${id}: ${read}.`);
    else servers.push(read);
  }
  return { servers, problems };
}

/** What changing a server's program, address or settings would restart: a digest, never shown. */
export function launchKey(entry: ServerEntry): string {
  const { command, args, cwd, env, url, headers, kind } = entry;
  return createHash("sha256")
    .update(JSON.stringify({ kind, command, args, cwd, env, url, headers }))
    .digest("hex");
}

/** The values of a server's settings and headers, to keep out of anything the student or the model sees. */
export function secretsOf(entry: ServerEntry): string[] {
  const values = [...Object.values(entry.env), ...Object.values(entry.headers)];
  return [
    ...new Set(
      values
        .flatMap((value) => [value, value.replace(/^(Bearer|Basic|Token)\s+/i, "")])
        .filter((value) => value.length >= 6),
    ),
  ];
}

/** Replaces every secret in `text` with [hidden]. */
export function redact(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    clean = clean.split(secret).join("[hidden]");
  return clean;
}

/** The servers in a block pasted from a README or another app: `{ mcpServers }`, `{ servers }`, or servers by name. */
export function pastedServers(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That isn't JSON. Paste the block with the server's name and command.");
  }
  if (!isRecord(parsed)) throw new Error("Paste an object with the server's name and command.");
  const servers = isRecord(parsed.mcpServers)
    ? parsed.mcpServers
    : isRecord(parsed.servers)
      ? parsed.servers
      : parsed;
  if ("command" in servers || "url" in servers)
    throw new Error('Add the server\'s name around it, such as { "moodle": { "command": … } }.');
  if (!Object.keys(servers).length) throw new Error("There is no server in that block.");
  return servers;
}

export class McpConfig {
  readonly #file: EditableFile;
  #raw: Record<string, unknown> | null = null;
  #state: McpState = { servers: [], problems: [] };

  private constructor(home: string) {
    this.#file = new EditableFile(resolve(home, "mcp.json"), { changed: CHANGED, mode: 0o600 });
  }

  static async open(home: string): Promise<McpConfig> {
    const config = new McpConfig(home);
    await config.reload();
    // Written by hand or by an older build, it may be readable by others; it holds secrets.
    if (config.#file.text !== null) await chmod(config.path, 0o600).catch(() => undefined);
    return config;
  }

  get path(): string {
    return this.#file.path;
  }
  get servers(): ServerEntry[] {
    return structuredClone(this.#state.servers);
  }
  get problems(): string[] {
    return [...this.#state.problems];
  }
  server(id: string): ServerEntry | undefined {
    return structuredClone(this.#state.servers.find((server) => server.id === id));
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
    this.#raw =
      isRecord(parsed) && (parsed.version === undefined || parsed.version === 1) ? parsed : null;
    this.#state = broken
      ? {
          servers: [],
          problems: ["mcp.json isn't valid JSON, so no server starts until it's fixed."],
        }
      : readMcp(text === null ? undefined : parsed);
  }

  /** Reads the file again; true when what Folio uses changed. */
  async reload(): Promise<boolean> {
    const before = JSON.stringify(this.#state);
    this.#apply(await this.#file.load());
    return JSON.stringify(this.#state) !== before;
  }

  watch(changed: () => void): () => void {
    return this.#file.watch(async () => {
      if (await this.reload()) changed();
    });
  }

  #update(change: (servers: Record<string, unknown>) => void): Promise<void> {
    return this.#file.write(
      (text) => {
        if (text !== null && !this.#raw)
          throw new Error(
            "Folio can't change mcp.json while it isn't a JSON object. Fix or remove it, then try again.",
          );
        const raw = structuredClone(this.#raw ?? {});
        raw.version = 1;
        const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
        change(servers);
        raw.mcpServers = servers;
        return `${JSON.stringify(raw, null, 2)}\n`;
      },
      { stale: () => this.reload(), written: (next) => this.#apply(next) },
    );
  }

  #folio(servers: Record<string, unknown>, id: string, patch: Record<string, unknown>): void {
    const entry = servers[id];
    if (!isRecord(entry)) throw new Error("That server is no longer in mcp.json.");
    entry.folio = { ...(isRecord(entry.folio) ? entry.folio : {}), ...patch };
  }

  /**
   * Adds a server, or changes one (by `previous`, its old name). A new one starts off, so the
   * student sees its full command line before it first runs.
   */
  saveServer(input: ServerInput, previous?: string): Promise<void> {
    return this.#update((servers) => {
      const id = input.id.trim();
      if (!ID.test(id)) throw new Error("Name the server with letters, digits, - and _.");
      const before = previous === undefined ? undefined : servers[previous];
      if (previous !== undefined && !isRecord(before))
        throw new Error("That server is no longer in mcp.json.");
      if (id !== previous && id in servers)
        throw new Error(`There is already a server named ${id}.`);
      const entry: Record<string, unknown> = isRecord(before) ? structuredClone(before) : {};
      const merge = (field: "env" | "headers", values?: Record<string, string | null>) => {
        if (!values) return;
        const current = isRecord(entry[field])
          ? { ...(entry[field] as Record<string, unknown>) }
          : {};
        for (const [name, value] of Object.entries(values))
          if (value === null) delete current[name];
          else if (typeof value === "string" && name.trim()) current[name.trim()] = value;
        if (Object.keys(current).length) entry[field] = current;
        else delete entry[field];
      };
      if (input.url !== undefined) {
        entry.type = "http";
        entry.url = input.url.trim();
        delete entry.command;
        delete entry.args;
        delete entry.env;
        delete entry.cwd;
        merge("headers", input.headers);
      } else {
        delete entry.type;
        delete entry.url;
        delete entry.headers;
        if (input.command !== undefined) entry.command = input.command.trim();
        if (input.args !== undefined)
          entry.args = input.args.filter((arg) => typeof arg === "string");
        if (input.cwd === null) delete entry.cwd;
        else if (typeof input.cwd === "string" && input.cwd.trim()) entry.cwd = input.cwd.trim();
        merge("env", input.env);
      }
      entry.folio = {
        ...(isRecord(entry.folio) ? entry.folio : { enabled: false }),
        ...(input.label?.trim() ? { label: input.label.trim().slice(0, 60) } : {}),
      };
      const read = readEntry(id, entry);
      if (typeof read === "string")
        throw new Error(`${read.charAt(0).toUpperCase()}${read.slice(1)}.`);
      if (previous !== undefined && previous !== id) delete servers[previous];
      servers[id] = entry;
    });
  }

  /** Adds the servers in a pasted block, each off until the student turns it on; returns their names. */
  async addPasted(text: string): Promise<string[]> {
    const pasted = pastedServers(text);
    const added: string[] = [];
    await this.#update((servers) => {
      for (const [id, raw] of Object.entries(pasted)) {
        if (id in servers) throw new Error(`There is already a server named ${id}.`);
        const entry = isRecord(raw) ? structuredClone(raw) : raw;
        if (isRecord(entry))
          entry.folio = { ...(isRecord(entry.folio) ? entry.folio : {}), enabled: false };
        const read = readEntry(id, entry);
        if (typeof read === "string") throw new Error(`${id}: ${read}.`);
        servers[id] = entry;
        added.push(id);
      }
    });
    return added;
  }

  removeServer(id: string): Promise<void> {
    return this.#update((servers) => {
      if (!(id in servers)) throw new Error("That server is no longer in mcp.json.");
      delete servers[id];
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.#update((servers) => this.#folio(servers, id, { enabled }));
  }

  /** "allow" lets every tool of the server run without asking. */
  setApproval(id: string, approval: "ask" | "allow"): Promise<void> {
    return this.#update((servers) => this.#folio(servers, id, { approval }));
  }

  setToolRule(id: string, tool: string, rule: ToolRule): Promise<void> {
    if (!RULES.includes(rule)) return Promise.reject(new Error("Unknown rule."));
    return this.#update((servers) => {
      const entry = servers[id];
      if (!isRecord(entry)) throw new Error("That server is no longer in mcp.json.");
      const folio = isRecord(entry.folio) ? entry.folio : {};
      const tools = isRecord(folio.tools) ? { ...folio.tools } : {};
      if (rule === "ask") delete tools[tool];
      else tools[tool] = rule;
      this.#folio(servers, id, { tools });
    });
  }
}
