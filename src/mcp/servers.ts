import { mkdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  McpAuthRequiredError,
  McpHttpError,
  type CallToolResult,
  type McpFetch,
  type McpTransport,
  type Tool,
} from "@earendil-works/pi-mcp";
import { privateDirectory, writeAtomic } from "../files.ts";
import { launchKey, redact, secretsOf, type McpConfig, type ServerEntry } from "./config.ts";
import { which } from "./shell-path.ts";

/**
 * The student's MCP servers while Folio runs: each one that is on is started in the background,
 * kept running, restarted after a crash (three times in ten minutes at most), and closed with
 * Folio. Each local server gets a clean environment (never Folio's own) and its own folder in
 * `~/.folio/mcp/<name>/`, where its last list of tools is also kept, so a server that is still
 * starting offers the same tools as before and the tutor's requests keep their cached start.
 */

export type ServerStatus = "off" | "starting" | "ready" | "stopped" | "failed";

/** A prompt a server offers: text the student can start a question with, as `/server:name`. */
export interface PromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** What a server's prompt gives: messages, each with one piece of content. */
export interface PromptResult {
  description?: string;
  messages: { role: string; content: unknown }[];
}

export interface ServerState {
  entry: ServerEntry;
  status: ServerStatus;
  /** Its tools, as it last listed them. */
  tools: Tool[];
  /** Its prompts, while it runs. */
  prompts: PromptInfo[];
  /** What went wrong, in plain words. */
  error?: string;
  /** The end of what it printed to its error output, with its secrets hidden. */
  log: string;
  /** What the server says about itself when it connects; shown in Settings only. */
  instructions?: string;
}

interface Live extends ServerState {
  key: string;
  client?: McpClient;
  /** Set while Folio closes it on purpose, so the close isn't taken for a crash. */
  closing?: boolean;
  failures: number[];
  retry?: NodeJS.Timeout;
  steady?: NodeJS.Timeout;
  /** Resolves when it is ready or gives up starting. */
  waiters: (() => void)[];
  generation: number;
}

const BACKOFF = [2_000, 10_000, 60_000];
const FAILURE_WINDOW = 10 * 60_000;
const MAX_LOG = 4_096;
const CONNECT_TIMEOUT = 30_000;

/**
 * What programs on Windows expect to find, which a server started without Folio's own environment
 * would lack: without SystemRoot, for one, Python can't open a network connection.
 */
const WINDOWS_ENV = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERNAME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "TEMP",
  "TMP",
];
function windowsEnv(): Record<string, string> {
  return Object.fromEntries(
    WINDOWS_ENV.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
  );
}

export interface McpServersOptions {
  config: McpConfig;
  /** Folio's home: servers' folders are in `mcp/` there. */
  home: string;
  /** The PATH local servers get, with the student's own commands on it. */
  path: () => Promise<string>;
  /** Called when a server's state or tools change. */
  changed: () => void;
  /** Requests to remote servers: Node's fetch unless given. */
  fetch?: McpFetch;
  /** How long to wait between restarts; shorter in tests. */
  backoff?: readonly number[];
}

export class McpServers {
  readonly #options: McpServersOptions;
  readonly #live = new Map<string, Live>();
  /** Lists of tools being saved: closing waits for them, so none is written after it. */
  readonly #saving = new Set<Promise<void>>();
  #closed = false;

  constructor(options: McpServersOptions) {
    this.#options = options;
  }

  #folder(id: string): string {
    return resolve(this.#options.home, "mcp", id);
  }

  /** Every server in mcp.json, as it is now. */
  list(): ServerState[] {
    return this.#options.config.servers.map((entry) => {
      const live = this.#live.get(entry.id);
      return {
        entry,
        status: live?.status ?? "off",
        tools: structuredClone(live?.tools ?? []),
        prompts: live?.status === "ready" ? structuredClone(live.prompts) : [],
        log: live?.log ?? "",
        ...(live?.error ? { error: live.error } : {}),
        ...(live?.instructions ? { instructions: live.instructions } : {}),
      };
    });
  }

  /** Starts what is on, stops what is off or gone, and restarts what changed. */
  async reconcile(): Promise<void> {
    if (this.#closed) return;
    const entries = this.#options.config.servers;
    for (const [id, live] of this.#live)
      if (!entries.some((entry) => entry.id === id && entry.enabled)) {
        await this.#stop(live);
        this.#live.delete(id);
      }
    for (const entry of entries) {
      if (!entry.enabled) continue;
      const live = this.#live.get(entry.id);
      const key = launchKey(entry);
      if (live && live.key === key) {
        live.entry = entry;
        continue;
      }
      if (live) await this.#stop(live);
      const fresh: Live = {
        entry,
        key,
        status: "starting",
        tools: live?.tools ?? (await this.#savedTools(entry.id)),
        prompts: [],
        log: "",
        failures: [],
        waiters: [],
        generation: (live?.generation ?? 0) + 1,
      };
      this.#live.set(entry.id, fresh);
      void this.#start(fresh);
    }
    this.#options.changed();
  }

  /** Starts a server again after it failed, or restarts a running one. */
  async restart(id: string): Promise<void> {
    const live = this.#live.get(id);
    if (!live) return this.reconcile();
    await this.#stop(live);
    live.failures = [];
    live.error = undefined;
    live.generation++;
    live.status = "starting";
    this.#options.changed();
    void this.#start(live);
  }

  async #savedTools(id: string): Promise<Tool[]> {
    try {
      const saved = JSON.parse(await readFile(resolve(this.#folder(id), "tools.json"), "utf8"));
      return Array.isArray(saved) ? (saved as Tool[]) : [];
    } catch {
      return [];
    }
  }

  async #start(live: Live): Promise<void> {
    const generation = live.generation;
    const { entry } = live;
    const secrets = secretsOf(entry);
    let transport: McpTransport;
    try {
      if (entry.kind === "remote") {
        transport = new StreamableHttpTransport({
          url: entry.url!,
          headers: entry.headers,
          ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
        });
      } else {
        const path = await this.#options.path();
        const command = await which(entry.command!, path);
        if (!command)
          throw new NotFound(
            `Folio can't find the program "${entry.command}". Write its full path, or install it first (for a uv tool: uv tool install).`,
          );
        const folder = this.#folder(entry.id);
        await privateDirectory(folder, "server", Error);
        const cwd = entry.cwd ? resolve(entry.cwd.replace(/^~(?=\/|$)/, homedir())) : folder;
        transport = new StdioTransport({
          command,
          args: entry.args,
          cwd,
          inheritEnv: false,
          env: {
            PATH: path,
            HOME: homedir(),
            ...(process.platform === "win32"
              ? windowsEnv()
              : {
                  USER: process.env.USER ?? "",
                  LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
                  SHELL: process.env.SHELL ?? "/bin/zsh",
                  TMPDIR: process.env.TMPDIR ?? tmpdir(),
                }),
            LANG: process.env.LANG ?? "en_US.UTF-8",
            PYTHONIOENCODING: "utf-8",
            ...entry.env,
          },
          stderr: "pipe",
          onStderr: (chunk) => {
            live.log = redact(`${live.log}${chunk}`, secrets).slice(-MAX_LOG);
          },
          closeTimeoutMs: 2_000,
        });
      }
      const client = new McpClient({ name: "Folio", version: "0.0.1", requestTimeoutMs: 60_000 });
      live.client = client;
      const connected = await Promise.race([
        client.connect(transport).then(() => true),
        new Promise<false>((done) => setTimeout(() => done(false), CONNECT_TIMEOUT)),
      ]);
      if (!connected) throw new Error("It didn't answer within 30 seconds of starting.");
      const tools = await client.listTools({ timeoutMs: CONNECT_TIMEOUT });
      if (live.generation !== generation || this.#closed) return await client.close();
      live.tools = tools;
      live.prompts = await this.#prompts(client);
      live.instructions = client.instructions
        ? redact(client.instructions, secrets).slice(0, 2_000)
        : undefined;
      live.status = "ready";
      live.error = undefined;
      void this.#saveTools(entry.id, tools);
      let timer: NodeJS.Timeout | undefined;
      client.onNotification("notifications/tools/list_changed", () => {
        clearTimeout(timer);
        timer = setTimeout(() => void this.#refreshTools(live, generation), 500);
      });
      client.onNotification("notifications/prompts/list_changed", () => {
        void this.#prompts(client).then((prompts) => {
          if (live.generation !== generation) return;
          live.prompts = prompts;
          this.#options.changed();
        });
      });
      client.onClose(() => {
        clearTimeout(timer);
        if (live.closing || live.generation !== generation || this.#closed) return;
        this.#failed(live, generation, "It stopped.");
      });
      // Up for a minute, it starts over with no failures counted.
      live.steady = setTimeout(() => (live.failures = []), 60_000);
      for (const waiter of live.waiters.splice(0)) waiter();
      this.#options.changed();
    } catch (error) {
      if (live.generation !== generation || this.#closed) return;
      await live.client?.close().catch(() => undefined);
      // A program that isn't there, or a token that is refused, won't change by trying again.
      const final =
        error instanceof NotFound ||
        error instanceof McpAuthRequiredError ||
        (error instanceof McpHttpError && (error.status === 401 || error.status === 403));
      this.#failed(live, generation, redact(plain(error, entry), secrets), final);
    }
  }

  #failed(live: Live, generation: number, error: string, final = false): void {
    clearTimeout(live.steady);
    const now = Date.now();
    live.failures = [...live.failures.filter((at) => now - at < FAILURE_WINDOW), now];
    live.client = undefined;
    live.error = error;
    const backoff = this.#options.backoff ?? BACKOFF;
    if (final || live.failures.length > backoff.length) {
      live.status = "failed";
      for (const waiter of live.waiters.splice(0)) waiter();
    } else {
      live.status = "stopped";
      live.retry = setTimeout(
        () => {
          if (live.generation !== generation || this.#closed) return;
          live.generation++;
          live.status = "starting";
          this.#options.changed();
          void this.#start(live);
        },
        backoff[live.failures.length - 1],
      );
    }
    this.#options.changed();
  }

  async #refreshTools(live: Live, generation: number): Promise<void> {
    try {
      const tools = await live.client!.listTools({ timeoutMs: CONNECT_TIMEOUT });
      if (live.generation !== generation) return;
      live.tools = tools;
      void this.#saveTools(live.entry.id, tools);
      this.#options.changed();
    } catch {
      // The next question keeps the tools it knew; a dead server is noticed when it closes.
    }
  }

  /** A server's prompts, every page of them; none when it offers none or can't list them. */
  async #prompts(client: McpClient): Promise<PromptInfo[]> {
    if (!client.serverCapabilities?.prompts) return [];
    const prompts: PromptInfo[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 5; page++) {
        const result = await client.request<{ prompts?: PromptInfo[]; nextCursor?: string }>(
          "prompts/list",
          cursor ? { cursor } : {},
          { timeoutMs: CONNECT_TIMEOUT },
        );
        prompts.push(
          ...(result.prompts ?? []).filter((prompt) => typeof prompt?.name === "string"),
        );
        cursor = result.nextCursor;
        if (!cursor) break;
      }
    } catch {
      return [];
    }
    return prompts.slice(0, 50);
  }

  /** One of a running server's prompts, with the student's arguments. */
  async getPrompt(
    id: string,
    name: string,
    args: Record<string, string>,
    timeoutMs = 20_000,
  ): Promise<PromptResult> {
    const live = this.#live.get(id);
    if (!live || live.status !== "ready" || !live.client)
      throw new Error(
        `${live?.entry.label ?? "That service"} isn't running. Start it in Settings.`,
      );
    try {
      return await live.client.request<PromptResult>(
        "prompts/get",
        { name, arguments: args },
        { timeoutMs },
      );
    } catch (error) {
      throw new Error(redact(plain(error, live.entry), secretsOf(live.entry)));
    }
  }

  #saveTools(id: string, tools: Tool[]): Promise<void> {
    const saving = (async () => {
      try {
        const folder = this.#folder(id);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeAtomic(resolve(folder, "tools.json"), JSON.stringify(tools));
      } catch (error) {
        console.error(`Folio could not keep ${id}'s list of tools:`, error);
      }
    })().finally(() => this.#saving.delete(saving));
    this.#saving.add(saving);
    return saving;
  }

  async #stop(live: Live): Promise<void> {
    clearTimeout(live.retry);
    clearTimeout(live.steady);
    live.generation++;
    live.closing = true;
    const client = live.client;
    live.client = undefined;
    live.status = "off";
    for (const waiter of live.waiters.splice(0)) waiter();
    await client?.close().catch(() => undefined);
    live.closing = false;
  }

  /**
   * Calls one of a server's tools. A server still starting, or restarting after a crash, is waited
   * for up to `waitMs`; one that is off or failed is refused in plain words.
   */
  async call(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs: number; waitMs?: number },
  ): Promise<CallToolResult> {
    const live = this.#live.get(id);
    if (!live) throw new Error("The student turned this service off.");
    if (live.status === "starting" || live.status === "stopped")
      await new Promise<void>((done) => {
        const timer = setTimeout(done, options.waitMs ?? 20_000);
        live.waiters.push(() => {
          clearTimeout(timer);
          done();
        });
      });
    if (live.status !== "ready" || !live.client)
      throw new Error(
        `${live.entry.label} isn't running${live.error ? `: ${live.error}` : ""}. Tell the student; they can restart it in Settings.`,
      );
    try {
      return await live.client.callTool(tool, args, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      throw new Error(redact(plain(error, live.entry), secretsOf(live.entry)));
    }
  }

  /** Closes every server, waiting at most `deadlineMs` for them to exit. */
  async close(deadlineMs = 3_000): Promise<void> {
    this.#closed = true;
    await Promise.race([
      Promise.all([...this.#live.values()].map((live) => this.#stop(live))).then(() =>
        Promise.allSettled(this.#saving),
      ),
      new Promise((done) => setTimeout(done, deadlineMs)),
    ]);
  }
}

class NotFound extends Error {}

function plain(error: unknown, entry: ServerEntry): string {
  const token = Object.keys(entry.headers).some((name) => name.toLowerCase() === "authorization");
  if (
    error instanceof McpAuthRequiredError ||
    (error instanceof McpHttpError && (error.status === 401 || error.status === 403))
  )
    return token
      ? "It refused the token in its headers."
      : "It asks for a sign-in Folio can't do yet. Add a token to its headers if it offers one.";
  if (error instanceof McpHttpError) return `It answered with an error (${error.status}).`;
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}
