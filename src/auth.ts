import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import {
  createModels,
  type ApiKeyCredential,
  type AuthOperationOptions,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type MutableModels,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  endChatGPTSession,
  signInWithChatGPT,
  SignInError,
  type ChatGPTRegistration,
} from "./chatgpt-sign-in.ts";
import { keyProviders } from "./connections.ts";
import { folioHome } from "./home.ts";
import { CONNECTIONS, connectionOf, type ConnectionId } from "./model-refs.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_WAIT_MS = 30_000;

/**
 * `registration` was added within version 1: an older Folio reads past it, and its sign-out
 * drops it, which costs only a second registration on the next sign-in.
 */
interface SavedConnection {
  version: 1;
  deviceId: string;
  credential?: OAuthCredential;
  registration?: ChatGPTRegistration;
}

interface SavedKey {
  type: "api_key";
  key: string;
  addedAt: string;
}

/** API keys by Pi provider ID. Entries for providers this build doesn't know are kept as they are. */
interface SavedKeys {
  version: 1;
  keys: Record<string, SavedKey>;
}

const KEY_PROVIDERS: readonly string[] = CONNECTIONS.filter(
  (connection) => connection.kind === "key",
).map((connection) => connection.provider);
const KEY = /^[\x21-\x7e]{8,512}$/;

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

function validateRegistration(value: unknown): asserts value is ChatGPTRegistration {
  const optional = (field: unknown) =>
    field === undefined || (typeof field === "string" && field.length > 0);
  if (
    !isRecord(value) ||
    typeof value.clientId !== "string" ||
    !value.clientId ||
    value.clientId === "dynamic_agent_client" ||
    !optional(value.subject) ||
    !optional(value.email) ||
    (value.askConsent !== undefined && value.askConsent !== true)
  )
    throw new Error("Unsupported or invalid Folio connection format.");
}

/**
 * The registration a sign-in reuses. A connection saved before Folio kept registrations has
 * one in its credential.
 */
function registrationOf(saved: SavedConnection): ChatGPTRegistration | undefined {
  if (saved.registration) return saved.registration;
  const clientId = saved.credential?.clientId;
  return typeof clientId === "string" && clientId ? { clientId } : undefined;
}

function validateKey(value: unknown): asserts value is ApiKeyCredential & { key: string } {
  if (
    !isRecord(value) ||
    value.type !== "api_key" ||
    typeof value.key !== "string" ||
    !KEY.test(value.key)
  )
    throw new Error("Invalid API key.");
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

/**
 * Folio's own protected credential files: the ChatGPT sign-in in `connection.json` and API keys
 * in `keys.json`, behind one lock. It never reads Pi or Codex account files.
 */
export class FolioCredentialStore implements CredentialStore {
  readonly home: string;
  readonly #file: string;
  readonly #keysFile: string;
  readonly #lock: string;
  #deviceId = "";

  private constructor(home: string) {
    this.home = home;
    this.#file = resolve(home, "connection.json");
    this.#keysFile = resolve(home, "keys.json");
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
    if (saved.registration !== undefined) validateRegistration(saved.registration);
    return saved as unknown as SavedConnection;
  }

  async #loadKeys(): Promise<SavedKeys> {
    let raw: string;
    try {
      const info = await lstat(this.#keysFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid Folio key file.");
      await chmod(this.#keysFile, 0o600);
      raw = await readFile(this.#keysFile, "utf8");
    } catch (error) {
      if (isMissing(error)) return { version: 1, keys: {} };
      throw error;
    }
    let saved: unknown;
    try {
      saved = JSON.parse(raw);
    } catch {
      throw new Error("Folio's key file is not valid JSON; repair or remove keys.json.");
    }
    if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.keys))
      throw new Error("Unsupported or invalid Folio key file.");
    for (const provider of KEY_PROVIDERS)
      if (saved.keys[provider] !== undefined) validateKey(saved.keys[provider]);
    return saved as unknown as SavedKeys;
  }

  async #save(saved: SavedConnection | SavedKeys, file = this.#file): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(saved, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
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

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    if (providerId === "openai") return (await this.#load())?.credential;
    if (!KEY_PROVIDERS.includes(providerId)) return undefined;
    const saved = (await this.#loadKeys()).keys[providerId];
    return saved && { type: "api_key", key: saved.key };
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const keys = (await this.#loadKeys()).keys;
    return [
      ...((await this.#load())?.credential
        ? [{ providerId: "openai", type: "oauth" } as const]
        : []),
      ...KEY_PROVIDERS.filter((provider) => keys[provider]).map(
        (providerId) => ({ providerId, type: "api_key" }) as const,
      ),
    ];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (KEY_PROVIDERS.includes(providerId)) return this.#modifyKey(providerId, fn, options);
    if (providerId !== "openai")
      return Promise.reject(new Error(`Folio does not connect to ${providerId}.`));
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

  #modifyKey(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#locked(async () => {
      const saved = await this.#loadKeys();
      const current = saved.keys[providerId];
      const next = await fn(current && { type: "api_key", key: current.key });
      if (next === undefined) return current && { type: "api_key", key: current.key };
      validateKey(next);
      await this.#save(
        {
          ...saved,
          keys: {
            ...saved.keys,
            [providerId]: { type: "api_key", key: next.key, addedAt: new Date().toISOString() },
          },
        },
        this.#keysFile,
      );
      return { type: "api_key", key: next.key };
    }, options);
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (KEY_PROVIDERS.includes(providerId)) {
      await this.#locked(async () => {
        const saved = await this.#loadKeys();
        if (!saved.keys[providerId]) return;
        const { [providerId]: _removed, ...keys } = saved.keys;
        await this.#save({ ...saved, keys }, this.#keysFile);
      }, options);
      return;
    }
    if (providerId !== "openai") return;
    await this.signOut(async () => false, options);
  }

  /** Folio's ChatGPT registration, which outlives sign-out so a later sign-in reuses it. */
  async registration(): Promise<ChatGPTRegistration | undefined> {
    const saved = await this.#load();
    return saved && registrationOf(saved);
  }

  /** Saves the registration; undefined forgets it, and the sign-in made through it. */
  async saveRegistration(
    registration: ChatGPTRegistration | undefined,
    options?: AuthOperationOptions,
  ): Promise<void> {
    if (registration) validateRegistration(registration);
    await this.#locked(async () => {
      const saved = await this.#load();
      if (!saved) throw new Error("Folio's installation record disappeared; restart Folio.");
      // Forgetting a registration ChatGPT no longer knows drops its sign-in with it.
      await this.#save(
        registration ? { ...saved, registration } : { version: 1, deviceId: saved.deviceId },
      );
    }, options);
  }

  /**
   * Signs out of ChatGPT: `end` ends the session at OpenAI, under the lock so no refresh rotates
   * the token meanwhile, then the tokens go and the registration stays. True when `end` confirmed
   * it, or when there was no sign-in to end.
   */
  async signOut(
    end: (credential: OAuthCredential) => Promise<boolean>,
    options?: AuthOperationOptions,
  ): Promise<boolean> {
    return this.#locked(async () => {
      const saved = await this.#load();
      if (!saved) return true;
      const ended = saved.credential ? await end(saved.credential) : true;
      const registration = registrationOf(saved);
      await this.#save({
        version: 1,
        deviceId: saved.deviceId,
        ...(registration ? { registration } : {}),
      });
      return ended;
    }, options);
  }
}

/** Signs out of ChatGPT, ending the session at OpenAI; false when OpenAI didn't confirm it. */
export function signOutOfChatGPT(store: FolioCredentialStore): Promise<boolean> {
  return store.signOut((credential) => endChatGPTSession(credential));
}

/** `callbackPort` is for tests: the port the browser returns to after signing in. */
export async function createFolioModels(
  options: { home?: string; callbackPort?: number } = {},
): Promise<{ models: MutableModels; store: FolioCredentialStore }> {
  const store = await FolioCredentialStore.create(options.home ?? folioHome());
  const models = createModels({
    credentials: store,
    // Keys come only from Folio's own key file, never from the shell or another app.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  for (const provider of keyProviders()) models.setProvider(provider);
  const provider = openaiProvider();
  const oauth = provider.auth.oauth!;
  models.setProvider({
    ...provider,
    auth: {
      oauth: {
        ...oauth,
        // Folio's own sign-in, which reuses its registration (`chatgpt-sign-in.ts`).
        async login(interaction) {
          try {
            return await signInWithChatGPT(interaction, store, { port: options.callbackPort });
          } catch (error) {
            // Only messages written for the student leave; others may carry endpoint details.
            if (interaction.signal.aborted)
              throw new DOMException("ChatGPT sign-in canceled.", "AbortError");
            if (error instanceof SignInError) throw new SignInError(error.message);
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

/** The connections that have a saved sign-in or key; nothing is checked over the network. */
export async function readConnections(store: FolioCredentialStore): Promise<Set<ConnectionId>> {
  const saved = await store.list();
  return new Set(
    saved.flatMap((info) => {
      const connection = connectionOf(info.providerId);
      return connection ? [connection.id] : [];
    }),
  );
}

export async function readConnectionStatus(
  store: FolioCredentialStore,
): Promise<{ connected: boolean; expiresAt?: number }> {
  const credential = await store.read("openai");
  return credential?.type === "oauth"
    ? { connected: true, expiresAt: credential.expires }
    : { connected: false };
}
