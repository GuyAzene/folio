import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import {
  createModels,
  type AuthOperationOptions,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type MutableModels,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { folioHome } from "./home.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_WAIT_MS = 30_000;

interface SavedConnection {
  version: 1;
  deviceId: string;
  credential?: OAuthCredential;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCredential(value: unknown): asserts value is OAuthCredential {
  if (
    !isRecord(value) ||
    value.type !== "oauth" ||
    typeof value.access !== "string" ||
    !value.access ||
    typeof value.refresh !== "string" ||
    !value.refresh ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires) ||
    typeof value.clientId !== "string" ||
    !value.clientId ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => typeof scope === "string") ||
    !value.scopes.includes("chatgpt.tokens.use.direct")
  ) {
    throw new Error("Invalid Folio ChatGPT connection; reconnect with the login command.");
  }
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function assertOutsideProject(home: string): void {
  const fromProject = relative(PROJECT_ROOT, home);
  if (fromProject === "" || (!fromProject.startsWith("..") && !isAbsolute(fromProject))) {
    throw new Error("Folio credentials must be stored outside the project directory.");
  }
}

/** Folio's own protected token file. It never reads Pi or Codex account files. */
export class FolioCredentialStore implements CredentialStore {
  readonly home: string;
  readonly #file: string;
  readonly #lock: string;
  #deviceId = "";

  private constructor(home: string) {
    this.home = home;
    this.#file = resolve(home, "connection.json");
    this.#lock = resolve(home, "connection.lock");
  }

  static async create(home: string): Promise<FolioCredentialStore> {
    const absoluteHome = resolve(home);
    assertOutsideProject(absoluteHome);
    await mkdir(absoluteHome, { recursive: true, mode: 0o700 });
    if ((await lstat(absoluteHome)).isSymbolicLink()) {
      throw new Error("Folio's credential directory must not be a symbolic link.");
    }
    assertOutsideProject(await realpath(absoluteHome));
    await chmod(absoluteHome, 0o700);
    const store = new FolioCredentialStore(absoluteHome);
    await store.#locked(async () => {
      let saved = await store.#load();
      if (!saved) {
        saved = { version: 1, deviceId: randomUUID() };
        await store.#save(saved);
      }
      store.#deviceId = saved.deviceId;
    });
    return store;
  }

  /** Stable for this installation, including after local logout and process restart. */
  getDeviceId = (): string => this.#deviceId;

  async #load(): Promise<SavedConnection | undefined> {
    let raw: string;
    try {
      const info = await lstat(this.#file);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Invalid Folio credential file.");
      await chmod(this.#file, 0o600);
      raw = await readFile(this.#file, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let saved: unknown;
    try {
      saved = JSON.parse(raw);
    } catch {
      throw new Error("Invalid Folio connection file; reconnect after repairing or removing it.");
    }
    if (
      !isRecord(saved) ||
      saved.version !== 1 ||
      typeof saved.deviceId !== "string" ||
      !UUID.test(saved.deviceId)
    ) {
      throw new Error("Unsupported or invalid Folio connection format.");
    }
    if (saved.credential !== undefined) validateCredential(saved.credential);
    return saved as unknown as SavedConnection;
  }

  async #save(saved: SavedConnection): Promise<void> {
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(saved, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #locked<T>(operation: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    const started = Date.now();
    let release!: () => Promise<void>;
    while (true) {
      options?.signal?.throwIfAborted();
      try {
        release = await lockfile.lock(this.#file, {
          realpath: false,
          lockfilePath: this.#lock,
          // Heartbeats preserve the lock during refresh; a killed process's lock expires.
          stale: 10_000,
          update: 2_000,
          retries: 0,
        });
        break;
      } catch (error) {
        if (!isRecord(error) || error.code !== "ELOCKED") throw error;
        if (Date.now() - started > LOCK_WAIT_MS)
          throw new Error(
            "Another Folio process is updating the ChatGPT connection. Try again shortly.",
          );
        await setTimeout(30, undefined, { signal: options?.signal });
      }
    }
    try {
      options?.signal?.throwIfAborted();
      return await operation();
    } finally {
      await release();
    }
  }

  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<OAuthCredential | undefined> {
    options?.signal?.throwIfAborted();
    return providerId === "openai" ? (await this.#load())?.credential : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return (await this.read("openai", options)) ? [{ providerId: "openai", type: "oauth" }] : [];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== "openai")
      return Promise.reject(
        new Error("Only Folio's ChatGPT subscription connection is supported."),
      );
    return this.#locked(async () => {
      const saved = await this.#load();
      if (!saved) throw new Error("Folio's installation record disappeared; restart Folio.");
      const next = await fn(saved.credential);
      if (next !== undefined) {
        validateCredential(next);
        // A successful rotating-token refresh must be committed even if cancellation just arrived.
        await this.#save({ ...saved, credential: next });
      }
      return next ?? saved.credential;
    }, options);
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (providerId !== "openai") return;
    await this.#locked(async () => {
      const saved = await this.#load();
      if (saved) await this.#save({ version: 1, deviceId: saved.deviceId });
    }, options);
  }
}

export async function createFolioModels(
  options: { home?: string } = {},
): Promise<{ models: MutableModels; store: FolioCredentialStore }> {
  const store = await FolioCredentialStore.create(options.home ?? folioHome());
  const models = createModels({
    credentials: store,
    // Folio must never fall back to a billable API key from the shell.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const provider = openaiProvider();
  const oauth = provider.auth.oauth!;
  models.setProvider({
    ...provider,
    auth: {
      oauth: {
        ...oauth,
        async login(interaction, loginOptions) {
          try {
            return await oauth.login(interaction, loginOptions);
          } catch {
            // Some upstream error messages include token-endpoint response bodies.
            // Never expose the original error or attach it as a diagnostic cause.
            if (interaction.signal.aborted)
              throw new DOMException("ChatGPT sign-in canceled.", "AbortError");
            throw new Error("ChatGPT sign-in failed. Retry the login command.");
          }
        },
        async refresh(credential, signal) {
          try {
            return await oauth.refresh(credential, signal);
          } catch {
            if (signal.aborted)
              throw new DOMException("ChatGPT connection renewal canceled.", "AbortError");
            throw new Error(
              "ChatGPT connection renewal failed. Run the login command to reconnect.",
            );
          }
        },
      },
    },
  });
  return { models, store };
}

export async function readConnectionStatus(
  store: FolioCredentialStore,
): Promise<{ connected: boolean; expiresAt?: number }> {
  const credential = await store.read("openai");
  return credential?.type === "oauth"
    ? { connected: true, expiresAt: credential.expires }
    : { connected: false };
}
