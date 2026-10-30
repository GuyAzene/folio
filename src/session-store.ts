import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { privateDirectory as sharedPrivateDirectory, writeAtomic } from "./files.ts";
import { validateTranscript } from "./transcript.ts";
import { folioHome } from "./home.ts";
import { connectionOf, type ProviderId } from "./model-refs.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SESSION_RUNTIME = { name: "pi", version: "1.4.0", transcriptVersion: 1 } as const;
const SNAPSHOT_TOKEN = Symbol("Folio session revision");
interface SnapshotToken {
  readonly id: string;
  readonly revision: number;
  readonly hash: string;
}

export type SessionStatus = "idle" | "running" | "interrupted" | "error";
/**
 * The demo tutor reads the synthetic course; a plain chat has no course sources or tools;
 * a course chat reads one course from the student's library (`library` marks those kinds);
 * a library chat (`courseId: null` with `library`) may read any course in the library.
 */
export type SessionScope =
  | { courseId: "demo"; sourceVersion: string }
  | { courseId: null }
  | { courseId: null; library: 1 }
  | { courseId: string; library: 1 };
/** Demo: a synthetic page. Course: the document and page the student is reading. */
export type SessionFocus = { page: number; documentId?: string };
export interface SessionRecord {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  /** Pi's provider: `openai` is the ChatGPT plan, the others a key. Older builds read only `openai`. */
  provider: ProviderId;
  modelId: string;
  runtime: typeof SESSION_RUNTIME;
  scope: SessionScope;
  /** A demo page; always null for a plain chat. */
  focus: SessionFocus | null;
  messages: AgentMessage[];
  status: SessionStatus;
  revision: number;
  activeRun?: { id: string; startedAt: string; pid: number };
  partialAssistant?: AssistantMessage;
}

export type CreateSessionInput = Pick<SessionRecord, "modelId" | "scope" | "focus"> & {
  /** The ChatGPT plan unless given. */
  provider?: ProviderId;
  title?: string;
  messages?: AgentMessage[];
};
export type SessionSummary = Pick<
  SessionRecord,
  | "id"
  | "title"
  | "createdAt"
  | "updatedAt"
  | "provider"
  | "modelId"
  | "status"
  | "revision"
  | "scope"
  | "focus"
> & { messageCount: number };
export type SessionLease = (() => Promise<void>) & { readonly sessionId: string };

export class SessionFormatError extends Error {}
export class SessionConflictError extends Error {}
export class SessionBusyError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function missing(error: unknown): boolean {
  return record(error) && error.code === "ENOENT";
}
function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function checkId(id: string): void {
  if (!UUID.test(id)) throw new SessionFormatError("A session ID must be a UUID.");
}
function validScope(scope: unknown, focus: unknown): boolean {
  if (!record(scope)) return false;
  if (scope.courseId === null)
    return (
      focus === null &&
      (Object.keys(scope).length === 1 || (Object.keys(scope).length === 2 && scope.library === 1))
    );
  if (scope.library === 1)
    return (
      typeof scope.courseId === "string" &&
      UUID.test(scope.courseId) &&
      Object.keys(scope).length === 2 &&
      (focus === null ||
        (record(focus) &&
          Object.keys(focus).length === 2 &&
          typeof focus.documentId === "string" &&
          UUID.test(focus.documentId) &&
          Number.isInteger(focus.page) &&
          Number(focus.page) >= 1))
    );
  return (
    scope.courseId === "demo" &&
    typeof scope.sourceVersion === "string" &&
    !!scope.sourceVersion &&
    record(focus) &&
    Number.isInteger(focus.page) &&
    Number(focus.page) >= 1
  );
}
function scopeKey(scope: SessionScope): string {
  if (scope.courseId === null) return "library" in scope ? "library" : "chat";
  return "library" in scope ? `course:${scope.courseId}` : `demo:${scope.sourceVersion}`;
}
function privateDirectory(path: string): Promise<void> {
  return sharedPrivateDirectory(path, "sessions", SessionFormatError);
}

function validate(value: unknown, expectedId?: string): asserts value is SessionRecord {
  if (
    !record(value) ||
    value.version !== 1 ||
    !record(value.runtime) ||
    value.runtime.name !== SESSION_RUNTIME.name ||
    value.runtime.version !== SESSION_RUNTIME.version ||
    value.runtime.transcriptVersion !== SESSION_RUNTIME.transcriptVersion
  ) {
    throw new SessionFormatError(
      "Unsupported Folio session or Pi transcript version. The existing file was preserved.",
    );
  }
  if (
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    (expectedId !== undefined && value.id !== expectedId) ||
    !validDate(value.createdAt) ||
    !validDate(value.updatedAt) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    !connectionOf(value.provider) ||
    typeof value.modelId !== "string" ||
    !value.modelId ||
    !validScope(value.scope, value.focus) ||
    !Number.isInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !["idle", "running", "interrupted", "error"].includes(String(value.status)) ||
    !Array.isArray(value.messages)
  ) {
    throw new SessionFormatError("Invalid Folio session data. The existing file was preserved.");
  }
  if (
    value.activeRun !== undefined &&
    (!record(value.activeRun) ||
      typeof value.activeRun.id !== "string" ||
      !UUID.test(value.activeRun.id) ||
      !validDate(value.activeRun.startedAt) ||
      !Number.isInteger(value.activeRun.pid) ||
      Number(value.activeRun.pid) < 1)
  ) {
    throw new SessionFormatError("Invalid Folio active-run data. The existing file was preserved.");
  }
  if (value.status === "running" && value.activeRun === undefined)
    throw new SessionFormatError("A running session requires an active run.");
  try {
    validateTranscript(value.messages);
    if (value.partialAssistant !== undefined) {
      if (!record(value.partialAssistant) || value.partialAssistant.role !== "assistant")
        throw new Error("Invalid partial message role.");
      validateTranscript([value.partialAssistant]);
    }
  } catch {
    throw new SessionFormatError("Invalid Folio transcript data. The existing file was preserved.");
  }
}

function jsonCopy(value: unknown): SessionRecord {
  let result: unknown;
  try {
    result = JSON.parse(JSON.stringify(value));
  } catch {
    throw new SessionFormatError("Session data must be serializable JSON.");
  }
  validate(result);
  return result;
}

/** Private snapshots, independent of credentials and of the model's authority. */
export class SessionStore {
  readonly home: string;
  readonly directory: string;
  readonly #leases = new WeakMap<
    SessionLease,
    { id: string; active: boolean; compromised: boolean }
  >();
  readonly #issuedTokens = new WeakSet<SnapshotToken>();

  private constructor(home: string) {
    this.home = home;
    this.directory = resolve(home, "sessions");
  }

  static async open(options: { home?: string } = {}): Promise<SessionStore> {
    const home = resolve(options.home ?? folioHome());
    await privateDirectory(home);
    const store = new SessionStore(home);
    await privateDirectory(store.directory);
    return store;
  }

  #path(id: string): string {
    checkId(id);
    return resolve(this.directory, `${id}.json`);
  }

  #stamp(snapshot: SessionRecord, raw: string): void {
    const token: SnapshotToken = Object.freeze({
      id: snapshot.id,
      revision: snapshot.revision,
      hash: createHash("sha256").update(raw).digest("hex"),
    });
    this.#issuedTokens.add(token);
    // Object spread keeps this optimistic-concurrency token. JSON and public
    // structuredClone snapshots omit it, so runtime metadata never enters disk.
    Object.defineProperty(snapshot, SNAPSHOT_TOKEN, { value: token, enumerable: true });
  }

  async #read(id: string, remember: boolean): Promise<SessionRecord> {
    const file = this.#path(id);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new SessionFormatError(
        "Folio session files must be regular files, never symbolic links.",
      );
    await chmod(file, 0o600);
    let parsed: unknown;
    const raw = await readFile(file, "utf8");
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new SessionFormatError(
          "Unreadable Folio session JSON. The existing file was preserved.",
        );
      throw error;
    }
    validate(parsed, id);
    if (remember) this.#stamp(parsed, raw);
    return parsed;
  }

  async load(id: string): Promise<SessionRecord> {
    return this.#read(id, true);
  }

  async #write(snapshot: SessionRecord, expectedHash?: string): Promise<void> {
    const target = this.#path(snapshot.id);
    const raw = `${JSON.stringify(snapshot, null, 2)}\n`;
    await writeAtomic(target, raw, {
      check: async () => {
        if (
          expectedHash !== undefined &&
          createHash("sha256")
            .update(await readFile(target))
            .digest("hex") !== expectedHash
        )
          throw new SessionConflictError(
            "The session file changed outside Folio. Reload it before saving.",
          );
      },
    });
    this.#stamp(snapshot, raw);
  }

  async #operation<T>(id: string, fn: () => Promise<T>): Promise<T> {
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(`${this.#path(id)}.write`, {
        realpath: false,
        lockfilePath: `${this.#path(id)}.write.lock`,
        stale: 10_000,
        update: 2_000,
        retries: 0,
      });
    } catch (error) {
      if (record(error) && error.code === "ELOCKED")
        throw new SessionBusyError("This session is being saved by another writer.");
      throw error;
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  /** Hold for a complete model/tool run. A crashed process's heartbeat lease becomes stale. */
  async lockSession(id: string): Promise<SessionLease> {
    const state = { id, active: true, compromised: false };
    let unlock: () => Promise<void>;
    try {
      unlock = await lockfile.lock(`${this.#path(id)}.run`, {
        realpath: false,
        lockfilePath: `${this.#path(id)}.run.lock`,
        stale: 10_000,
        update: 2_000,
        retries: 0,
        onCompromised: () => {
          state.compromised = true;
          state.active = false;
        },
      });
    } catch (error) {
      if (record(error) && error.code === "ELOCKED")
        throw new SessionBusyError("This session is already open in another active run.");
      throw error;
    }
    const lease: SessionLease = Object.assign(
      async () => {
        if (!state.active) return;
        state.active = false;
        await unlock();
      },
      { sessionId: id },
    );
    this.#leases.set(lease, state);
    return lease;
  }

  #checkLease(id: string, lease: SessionLease): void {
    const state = this.#leases.get(lease);
    if (!state?.active || state.compromised || state.id !== id)
      throw new SessionBusyError("The session writer lease is no longer valid.");
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const snapshot = jsonCopy({
      version: 1,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      title: input.title ?? "New conversation",
      provider: input.provider ?? "openai",
      modelId: input.modelId,
      runtime: SESSION_RUNTIME,
      scope: input.scope,
      focus: input.focus,
      messages: input.messages ?? [],
      status: "idle",
      revision: 1,
    });
    const lease = await this.lockSession(snapshot.id);
    try {
      return await this.#operation(snapshot.id, async () => {
        try {
          await lstat(this.#path(snapshot.id));
          throw new SessionConflictError("The generated session ID already exists.");
        } catch (error) {
          if (!missing(error)) throw error;
        }
        await this.#write(snapshot);
        return snapshot;
      });
    } finally {
      await lease();
    }
  }

  async save(
    next: SessionRecord,
    expectedRevision: number,
    lease?: SessionLease,
  ): Promise<SessionRecord> {
    const snapshot = jsonCopy(next);
    if (snapshot.revision !== expectedRevision)
      throw new SessionConflictError("The expected revision does not match the supplied session.");
    const seen = (next as SessionRecord & { [SNAPSHOT_TOKEN]?: SnapshotToken })[SNAPSHOT_TOKEN];
    if (
      !seen ||
      !this.#issuedTokens.has(seen) ||
      seen.id !== snapshot.id ||
      seen.revision !== expectedRevision
    )
      throw new SessionConflictError(
        "Load the session in this store before saving its expected revision.",
      );
    const activeLease = lease ?? (await this.lockSession(snapshot.id));
    try {
      this.#checkLease(snapshot.id, activeLease);
      return await this.#operation(snapshot.id, async () => {
        const current = await this.#read(snapshot.id, false);
        if (current.revision !== expectedRevision)
          throw new SessionConflictError("The session changed elsewhere. Reload it before saving.");
        if (
          createHash("sha256")
            .update(await readFile(this.#path(snapshot.id)))
            .digest("hex") !== seen.hash
        )
          throw new SessionConflictError(
            "The session file changed outside Folio. Reload it before saving.",
          );
        if (
          snapshot.createdAt !== current.createdAt ||
          snapshot.provider !== current.provider ||
          snapshot.modelId !== current.modelId ||
          scopeKey(snapshot.scope) !== scopeKey(current.scope)
        )
          throw new SessionConflictError(
            "A saved session's creation time, model and source scope are immutable.",
          );
        const saved = {
          ...snapshot,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        this.#checkLease(snapshot.id, activeLease);
        await this.#write(saved, seen.hash);
        return saved;
      });
    } finally {
      if (lease === undefined) await activeLease();
    }
  }

  async #scan(): Promise<{
    sessions: SessionSummary[];
    unavailable: { id: string; error: string }[];
  }> {
    const sessions: SessionSummary[] = [];
    const unavailable: { id: string; error: string }[] = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) continue;
      const id = name.slice(0, -5);
      try {
        const session = await this.#read(id, false);
        const { title, createdAt, updatedAt, provider, modelId, status, revision, scope, focus } =
          session;
        sessions.push({
          id,
          title,
          createdAt,
          updatedAt,
          provider,
          modelId,
          status,
          revision,
          scope,
          focus,
          messageCount: session.messages.length,
        });
      } catch (error) {
        if (error instanceof SessionFormatError) unavailable.push({ id, error: error.message });
        else throw error;
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    return { sessions, unavailable };
  }

  async list(): Promise<SessionSummary[]> {
    return (await this.#scan()).sessions;
  }
  async listUnavailable(): Promise<{ id: string; error: string }[]> {
    return (await this.#scan()).unavailable;
  }
  async latest(): Promise<SessionRecord | undefined> {
    const latest = (await this.list())[0];
    return latest ? await this.load(latest.id) : undefined;
  }
}

export async function createSessionStore(options: { home?: string } = {}): Promise<SessionStore> {
  return SessionStore.open(options);
}
