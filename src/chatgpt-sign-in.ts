import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout } from "node:timers/promises";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

/**
 * Sign in with ChatGPT, the way OpenAI asks open-source apps to do it
 * (developers.openai.com/siwc/token-sharing-open-source). The first sign-in registers Folio with
 * the student's ChatGPT account; every later one reuses that registration, so ChatGPT's settings
 * list one Folio however often the student signs out and in. Signing out ends the renewable
 * session at OpenAI and keeps the registration. Pi's own sign-in registers a new client every
 * time and never ends a session, so Folio replaces that one step; Pi still renews the tokens.
 */

export const AGENT_NAME = "Folio";
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = "https://api.openai.com/v1";
/** The client ID that asks OpenAI to register a new client; never one to keep. */
const REGISTER = "dynamic_agent_client";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const CALLBACK_PATH = "/auth/callback";
/** Folio registers on this port, as Pi did; a later sign-in may take another when it's busy. */
const PORT = 1455;
/** Renew this long before the real expiry, as Pi does, so no request starts on a dying token. */
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;
/** A callback error that means ChatGPT no longer accepts the saved client. */
const UNKNOWN_CLIENT = new Set(["invalid_client", "unauthorized_client"]);

export const SIGN_OUT_UNCONFIRMED =
  "Folio signed out, but ChatGPT didn't confirm it. To be sure, remove Folio's access in ChatGPT's settings, under Security and login → Sign in with ChatGPT.";

/** Folio's registration with one ChatGPT account, kept through sign-out in `connection.json`. */
export interface ChatGPTRegistration {
  /** The client ID OpenAI issued when Folio registered, `oaiapp_…`. */
  clientId: string;
  /** The account it belongs to: the verified ID token's subject, and its email for `login_hint`. */
  subject?: string;
  email?: string;
  /** The last sign-in came back without use of the plan, so the next one asks for consent. */
  askConsent?: true;
}

export interface RegistrationStore {
  getDeviceId(): string;
  registration(): Promise<ChatGPTRegistration | undefined>;
  saveRegistration(registration: ChatGPTRegistration | undefined): Promise<void>;
}

/** A sign-in failure whose message is written for the student and safe to show. */
export class SignInError extends Error {}

type Callback = { code: string; clientId?: string } | { error: string; clientId?: string };

interface Discovery {
  jwks_uri: string;
  revocation_endpoint: string;
}

const random = () => randomBytes(32).toString("base64url");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenAI's endpoints for keys and revocation; both must belong to the issuer. */
async function discover(signal?: AbortSignal): Promise<Discovery> {
  const config = await getJson(DISCOVERY_URL, signal);
  const owned = (value: unknown): value is string => {
    try {
      return typeof value === "string" && new URL(value).origin === ISSUER;
    } catch {
      return false;
    }
  };
  if (config.issuer !== ISSUER || !owned(config.jwks_uri) || !owned(config.revocation_endpoint))
    throw new Error("OpenAI's sign-in configuration is not what Folio expects.");
  return { jwks_uri: config.jwks_uri, revocation_endpoint: config.revocation_endpoint };
}

async function getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error(`${url} did not answer with an object.`);
  return body;
}

/** Reads a callback for this attempt; a different `state` is not this attempt's, so it throws. */
function readCallback(url: URL, state: string): Callback {
  if (url.searchParams.get("state") !== state) throw new Error("state");
  const clientId = url.searchParams.get("client_id")?.trim() || undefined;
  const error = url.searchParams.get("error");
  if (error) return { error, clientId };
  const code = url.searchParams.get("code");
  if (!code) throw new Error("code");
  return { code, clientId };
}

/** Listens for the browser's return on the first free port of `ports` (0 picks any). */
async function listen(
  state: string,
  ports: number[],
): Promise<{ server: Server; port: number; result: Promise<Callback> }> {
  let settle!: { resolve: (value: Callback) => void; reject: (error: Error) => void };
  const result = new Promise<Callback>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const server = createServer((request, response) => {
    const page = (status: number, body: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    };
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) return page(404, oauthErrorHtml("Nothing is here."));
    let callback: Callback;
    try {
      callback = readCallback(url, state);
    } catch {
      // Not this attempt's: an old tab or another app's sign-in. Keep waiting for the real one.
      return page(400, oauthErrorHtml("This page belongs to another sign-in. Go back to Folio."));
    }
    page(
      200,
      "code" in callback
        ? oauthSuccessHtml("Folio is connected to ChatGPT. You can close this window.")
        : oauthErrorHtml("ChatGPT didn't connect Folio. Go back to Folio."),
    );
    settle.resolve(callback);
  });
  for (const [index, port] of ports.entries()) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      server.on("error", (error) => settle.reject(error));
      return { server, port: (server.address() as AddressInfo).port, result };
    } catch (error) {
      const busy = isRecord(error) && error.code === "EADDRINUSE";
      if (!busy) throw error;
      if (index === ports.length - 1)
        throw new SignInError(
          `Another sign-in is using port ${port}, perhaps Codex or Pi. Finish or cancel it, then connect again.`,
        );
    }
  }
  throw new Error("No port to listen on.");
}

function stopListening(server: Server): void {
  server.close();
  // A browser keeps spare connections open; one could carry a later attempt's callback here.
  server.closeAllConnections();
}

/** The callback address the student pasted, for when the browser can't reach Folio. */
function pastedCallback(input: string, redirectUri: string, state: string): Callback {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SignInError("Paste the whole address the browser ended on.");
  }
  if (`${url.origin}${url.pathname}` !== redirectUri)
    throw new SignInError(`The address should start with ${redirectUri}.`);
  try {
    return readCallback(url, state);
  } catch {
    throw new SignInError("That address is from another sign-in. Connect again.");
  }
}

async function exchange(body: Record<string, string>, signal: AbortSignal) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal,
  });
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = isRecord(data) && typeof data.error === "string" ? data.error : undefined;
    // The response body can carry details of the request; only the error code leaves here.
    throw Object.assign(new Error(`OpenAI's token endpoint answered ${response.status}.`), {
      code,
    });
  }
  const text = (field: string) => {
    const value = isRecord(data) ? data[field] : undefined;
    if (typeof value !== "string" || !value.trim())
      throw new Error(`OpenAI's token response has no ${field}.`);
    return value;
  };
  const expiresIn = isRecord(data) ? data.expires_in : undefined;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0)
    throw new Error("OpenAI's token response has no expires_in.");
  return {
    access: text("access_token"),
    refresh: text("refresh_token"),
    idToken: text("id_token"),
    scopes: text("scope").trim().split(/\s+/),
    expires: Date.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS,
  };
}

/** Checks the ID token's signature, issuer, audience, expiry and nonce; returns who signed in. */
async function verifyIdentity(
  idToken: string,
  clientId: string,
  nonce: string,
  signal: AbortSignal,
): Promise<{ subject: string; email?: string }> {
  const keys = await getJson((await discover(signal)).jwks_uri, signal);
  if (!Array.isArray(keys.keys)) throw new Error("OpenAI's signing keys are not a key set.");
  const { payload } = await jwtVerify(
    idToken,
    createLocalJWKSet(keys as unknown as JSONWebKeySet),
    {
      issuer: ISSUER,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5,
    },
  );
  if (payload.nonce !== nonce) throw new Error("The ID token's nonce is not this sign-in's.");
  if (typeof payload.sub !== "string" || !payload.sub)
    throw new Error("The ID token has no subject.");
  const email = typeof payload.email === "string" && payload.email ? payload.email : undefined;
  return { subject: payload.sub, ...(email ? { email } : {}) };
}

/**
 * Signs in to ChatGPT in the browser: registers Folio the first time, and reuses the saved
 * registration afterwards. The registration is saved as soon as OpenAI issues it, so a sign-in
 * that fails later still leaves one Folio in ChatGPT's settings, not two.
 */
export async function signInWithChatGPT(
  interaction: ProviderAuthInteraction,
  store: RegistrationStore,
  options: { port?: number } = {},
): Promise<OAuthCredential> {
  const { signal } = interaction;
  signal.throwIfAborted();
  const saved = await store.registration();
  const state = random();
  const nonce = random();
  const verifier = random();
  const port = options.port ?? PORT;
  const callback = await listen(state, saved ? [port, 0] : [port]);
  const redirectUri = `http://127.0.0.1:${callback.port}${CALLBACK_PATH}`;
  const pasting = new AbortController();
  try {
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: saved?.clientId ?? REGISTER,
      ...(saved ? {} : { agent_name_hint: AGENT_NAME }),
      ext_agent_host_id: `urn:uuid:${store.getDeviceId().toLowerCase()}`,
      ...(saved?.email ? { login_hint: saved.email } : {}),
      ...(saved?.askConsent ? { prompt: "consent" } : {}),
      response_type: "code",
      redirect_uri: redirectUri,
      resource: RESOURCE,
      scope: SCOPE,
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    interaction.notify({
      type: "auth_url",
      url: url.toString(),
      instructions: "Finish signing in in your browser.",
    });
    const pasted = interaction
      .prompt({
        type: "manual_code",
        message: "Finish signing in in your browser, or paste the address it ends on here:",
        placeholder: redirectUri,
        signal: AbortSignal.any([pasting.signal, signal]),
      })
      .then((input) => pastedCallback(input, redirectUri, state));
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const answer = await Promise.race([callback.result, pasted, aborted]);
    pasting.abort();
    stopListening(callback.server);

    if ("error" in answer) {
      if (!saved && answer.clientId && answer.clientId !== REGISTER)
        await store.saveRegistration({ clientId: answer.clientId, askConsent: true });
      if (answer.error === "access_denied") {
        if (saved) await store.saveRegistration({ ...saved, askConsent: true });
        throw new SignInError(
          "Folio isn't allowed to use your ChatGPT plan. Connect again when you want to allow it.",
        );
      }
      if (saved && UNKNOWN_CLIENT.has(answer.error)) {
        await store.saveRegistration(undefined);
        throw new SignInError("ChatGPT no longer knows this Folio. Connect again to register it.");
      }
      throw new SignInError("ChatGPT didn't finish connecting Folio. Try again.");
    }

    let clientId: string;
    if (saved) {
      if (answer.clientId && answer.clientId !== saved.clientId)
        throw new SignInError(
          "ChatGPT answered for a different Folio, so nothing changed. Try again.",
        );
      clientId = saved.clientId;
    } else {
      if (!answer.clientId || answer.clientId === REGISTER)
        throw new SignInError("ChatGPT didn't finish registering Folio. Try again.");
      clientId = answer.clientId;
      await store.saveRegistration({ clientId });
    }

    let token: Awaited<ReturnType<typeof exchange>>;
    try {
      token = await exchange(
        {
          grant_type: "authorization_code",
          client_id: clientId,
          code: answer.code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: RESOURCE,
        },
        signal,
      );
    } catch (error) {
      if (saved && isRecord(error) && error.code === "invalid_client") {
        await store.saveRegistration(undefined);
        throw new SignInError("ChatGPT no longer knows this Folio. Connect again to register it.");
      }
      throw error;
    }
    const credential: OAuthCredential = {
      type: "oauth",
      access: token.access,
      refresh: token.refresh,
      expires: token.expires,
      clientId,
      scopes: token.scopes,
    };
    let identity: { subject: string; email?: string };
    try {
      identity = await verifyIdentity(token.idToken, clientId, nonce, signal);
    } catch (error) {
      await endChatGPTSession(credential, signal).catch(() => false);
      throw error;
    }
    if (saved?.subject && identity.subject !== saved.subject) {
      await endChatGPTSession(credential, signal).catch(() => false);
      throw new SignInError(
        saved.email
          ? `This Folio is connected to ${saved.email}. Choose that ChatGPT account to sign in.`
          : "That is a different ChatGPT account from the one this Folio is connected to. Choose that account to sign in.",
      );
    }
    const registration: ChatGPTRegistration = { clientId, ...identity };
    if (!token.scopes.includes(PLAN_SCOPE)) {
      await store.saveRegistration({ ...registration, askConsent: true });
      await endChatGPTSession(credential, signal).catch(() => false);
      throw new SignInError(
        "ChatGPT didn't let Folio use your plan. Connect again and allow Folio to use it.",
      );
    }
    await store.saveRegistration(registration);
    return credential;
  } finally {
    pasting.abort();
    stopListening(callback.server);
  }
}

/**
 * Ends a sign-in's renewable session at OpenAI. The registration lives on, so signing in again
 * reuses it. True when OpenAI confirmed; a network failure or server error is retried twice.
 */
export async function endChatGPTSession(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<boolean> {
  if (typeof credential.clientId !== "string" || !credential.clientId) return false;
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(5_000);
    const limited = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const { revocation_endpoint } = await discover(limited);
      const response = await fetch(revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: credential.refresh,
          token_type_hint: "refresh_token",
          client_id: credential.clientId,
        }),
        signal: limited,
      });
      // OpenAI answers 200 also for a token that was already invalid.
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if (attempt === 2) return false;
    await setTimeout(250 * 3 ** attempt, undefined, { signal });
  }
}
