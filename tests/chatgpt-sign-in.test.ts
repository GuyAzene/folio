import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createFolioModels, readConnectionStatus, signOutOfChatGPT } from "../src/auth.ts";

/**
 * A synthetic OpenAI sign-in, for tests: it registers clients, issues codes and signed ID tokens,
 * and records revocations. The browser is simulated by following each authorization URL to
 * Folio's callback. Nothing here reaches the network.
 */

const ISSUER = "https://auth.openai.com";
const PLAN = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const realFetch = globalThis.fetch;
const homes: string[] = [];

interface Visit {
  /** Overrides for the callback's query; undefined values are left out. */
  callback?: Record<string, string | undefined>;
}

class FakeOpenAI {
  readonly authorizations: URL[] = [];
  readonly registered: string[] = [];
  readonly revoked: Record<string, string>[] = [];
  readonly tokenRequests: Record<string, string>[] = [];
  /** Clients ChatGPT no longer knows. */
  readonly forgotten = new Set<string>();
  subject = "synthetic-subject";
  email = "student@example.test";
  scope = PLAN;
  revokeStatus = 200;
  nonce: string | undefined;
  signer: CryptoKey | undefined;
  #key!: { privateKey: CryptoKey; jwk: Record<string, unknown> };
  readonly #codes = new Map<
    string,
    { clientId: string; nonce: string; redirectUri: string; challenge: string }
  >();

  static async start(): Promise<FakeOpenAI> {
    const fake = new FakeOpenAI();
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    fake.#key = { privateKey, jwk: { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" } };
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      fake.#fetch(input, init),
    );
    return fake;
  }

  async #fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.href === `${ISSUER}/.well-known/openid-configuration`)
      return json({
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
      });
    if (url.href === `${ISSUER}/.well-known/jwks.json`) return json({ keys: [this.#key.jwk] });
    const form = Object.fromEntries(init?.body instanceof URLSearchParams ? init.body : []);
    if (url.href === `${ISSUER}/api/accounts/oauth/revoke`) {
      this.revoked.push(form);
      return new Response(null, { status: this.revokeStatus });
    }
    if (url.href === `${ISSUER}/api/accounts/oauth/token`) {
      this.tokenRequests.push(form);
      if (this.forgotten.has(form.client_id!)) return json({ error: "invalid_client" }, 401);
      const code = this.#codes.get(form.code!);
      this.#codes.delete(form.code!);
      const challenge = createHash("sha256")
        .update(form.code_verifier ?? "")
        .digest("base64url");
      if (
        !code ||
        code.clientId !== form.client_id ||
        code.redirectUri !== form.redirect_uri ||
        code.challenge !== challenge ||
        form.grant_type !== "authorization_code" ||
        form.resource !== "https://api.openai.com/v1"
      )
        return json({ error: "invalid_grant" }, 400);
      const idToken = await new SignJWT({ nonce: this.nonce ?? code.nonce, email: this.email })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience(code.clientId)
        .setSubject(this.subject)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(this.signer ?? this.#key.privateKey);
      return json({
        access_token: `access-${randomUUID()}`,
        refresh_token: `refresh-${randomUUID()}`,
        id_token: idToken,
        scope: this.scope,
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    throw new Error(`The fake OpenAI has nothing at ${url.href}`);
  }

  /** Signs in at an authorization URL and returns the address the browser goes back to. */
  approve(authorize: URL, visit: Visit = {}): URL {
    this.authorizations.push(authorize);
    const asked = authorize.searchParams.get("client_id")!;
    const registering = asked === "dynamic_agent_client";
    const clientId = registering ? `oaiapp_${this.registered.length + 1}` : asked;
    if (registering) this.registered.push(clientId);
    const code = `code-${randomUUID()}`;
    const redirectUri = authorize.searchParams.get("redirect_uri")!;
    this.#codes.set(code, {
      clientId,
      nonce: authorize.searchParams.get("nonce")!,
      redirectUri,
      challenge: authorize.searchParams.get("code_challenge")!,
    });
    const query: Record<string, string | undefined> = {
      code,
      state: authorize.searchParams.get("state")!,
      // A new registration returns its client ID; a returning sign-in may leave it out.
      client_id: registering ? clientId : undefined,
      ...visit.callback,
    };
    const callback = new URL(redirectUri);
    for (const [name, value] of Object.entries(query))
      if (value !== undefined) callback.searchParams.set(name, value);
    return callback;
  }

  /** What the browser does: sign in, then return to Folio. */
  visit(authorize: URL, visit?: Visit): Promise<Response> {
    return realFetch(this.approve(authorize, visit));
  }
}

/**
 * A student at the browser. By default each authorization URL is visited as `visit` says;
 * "wait" leaves it to the test, and "paste" pastes the address instead of returning to Folio.
 */
function student(
  fake: FakeOpenAI,
  visit?: Visit,
  mode: "visit" | "wait" | "paste" = "visit",
): ProviderAuthInteraction & { controller: AbortController; opened: Promise<URL> } {
  const controller = new AbortController();
  let opened!: (url: URL) => void;
  const openedPromise = new Promise<URL>((resolve) => {
    opened = resolve;
  });
  let paste: ((value: string) => void) | undefined;
  return {
    controller,
    opened: openedPromise,
    signal: controller.signal,
    prompt: (prompt) =>
      new Promise<string>((resolve, reject) => {
        paste = resolve;
        prompt.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Prompt closed.", "AbortError")),
          { once: true },
        );
      }),
    notify(event) {
      if (event.type !== "auth_url") return;
      const url = new URL(event.url);
      opened(url);
      if (mode === "visit") void fake.visit(url, visit);
      else if (mode === "paste") {
        const callback = fake.approve(url, visit);
        setTimeout(() => paste?.(callback.href), 0);
      }
    },
  };
}

async function setup() {
  const home = await mkdtemp(resolve(tmpdir(), "folio-sign-in-test-"));
  homes.push(home);
  const fake = await FakeOpenAI.start();
  const { models, store } = await createFolioModels({ home, callbackPort: 0 });
  const saved = async () => JSON.parse(await readFile(resolve(home, "connection.json"), "utf8"));
  const signIn = (visit?: Visit) =>
    models.login("openai", "oauth", student(fake, visit)) as Promise<OAuthCredential>;
  return { home, fake, models, store, saved, signIn };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("Signing in with ChatGPT", () => {
  it("registers Folio once, and signing out and in again reuses that registration", async () => {
    const { fake, store, saved, signIn } = await setup();
    const first = await signIn();
    const register = fake.authorizations[0]!.searchParams;
    expect(register.get("client_id")).toBe("dynamic_agent_client");
    expect(register.get("agent_name_hint")).toBe("Folio");
    expect(register.get("ext_agent_host_id")).toBe(`urn:uuid:${store.getDeviceId()}`);
    expect(register.get("scope")).toBe(PLAN);
    expect(register.get("code_challenge_method")).toBe("S256");
    expect(new URL(register.get("redirect_uri")!).hostname).toBe("127.0.0.1");
    expect(register.has("prompt")).toBe(false);
    expect(first.clientId).toBe("oaiapp_1");
    expect((await saved()).registration).toEqual({
      clientId: "oaiapp_1",
      subject: "synthetic-subject",
      email: "student@example.test",
    });

    expect(await signOutOfChatGPT(store)).toBe(true);
    expect(fake.revoked).toEqual([
      { token: first.refresh, token_type_hint: "refresh_token", client_id: "oaiapp_1" },
    ]);
    expect(await readConnectionStatus(store)).toEqual({ connected: false });
    const afterSignOut = await saved();
    expect(afterSignOut.credential).toBeUndefined();
    expect(afterSignOut.registration.clientId).toBe("oaiapp_1");
    expect(JSON.stringify(afterSignOut)).not.toContain(first.refresh);

    const second = await signIn();
    const returning = fake.authorizations[1]!.searchParams;
    expect(returning.get("client_id")).toBe("oaiapp_1");
    expect(returning.has("agent_name_hint")).toBe(false);
    expect(returning.get("ext_agent_host_id")).toBe(register.get("ext_agent_host_id"));
    expect(returning.get("login_hint")).toBe("student@example.test");
    expect(returning.has("prompt")).toBe(false);
    expect(second.clientId).toBe("oaiapp_1");
    expect(fake.registered).toEqual(["oaiapp_1"]);
    expect(await readConnectionStatus(store)).toMatchObject({ connected: true });
  });

  it("reuses the client of a sign-in saved before Folio kept registrations", async () => {
    const { fake, store, saved, signIn } = await setup();
    await store.modify("openai", async () => ({
      type: "oauth",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() + 3_600_000,
      clientId: "oaiapp_earlier",
      scopes: PLAN.split(" "),
    }));
    expect((await saved()).registration).toBeUndefined();
    expect(await signOutOfChatGPT(store)).toBe(true);
    expect(fake.revoked[0]).toMatchObject({ client_id: "oaiapp_earlier" });
    expect((await saved()).registration).toEqual({ clientId: "oaiapp_earlier" });
    expect((await signIn()).clientId).toBe("oaiapp_earlier");
    expect(fake.registered).toEqual([]);
  });

  it("forgets the tokens even when ChatGPT doesn't confirm the sign-out, and says so", async () => {
    const { fake, store, saved, signIn } = await setup();
    await signIn();
    fake.revokeStatus = 503;
    expect(await signOutOfChatGPT(store)).toBe(false);
    expect(fake.revoked).toHaveLength(3);
    expect((await saved()).credential).toBeUndefined();
    expect((await saved()).registration.clientId).toBe("oaiapp_1");

    await signIn();
    fake.revokeStatus = 400;
    expect(await signOutOfChatGPT(store)).toBe(false);
    expect(fake.revoked).toHaveLength(4);
    expect((await saved()).credential).toBeUndefined();
  });

  it("refuses a returning sign-in that comes back for another registration", async () => {
    const { fake, saved, signIn } = await setup();
    await signIn();
    const before = await saved();
    await expect(signIn({ callback: { client_id: "oaiapp_other" } })).rejects.toThrow(
      "ChatGPT answered for a different Folio",
    );
    expect(fake.tokenRequests).toHaveLength(1);
    expect(await saved()).toEqual(before);
  });

  it("refuses another ChatGPT account and keeps the one Folio is connected to", async () => {
    const { fake, store, saved, signIn } = await setup();
    await signIn();
    await signOutOfChatGPT(store);
    fake.subject = "someone-else";
    await expect(signIn()).rejects.toThrow(
      "This Folio is connected to student@example.test. Choose that ChatGPT account to sign in.",
    );
    expect(await readConnectionStatus(store)).toEqual({ connected: false });
    expect((await saved()).registration.subject).toBe("synthetic-subject");
    // The other account's session is ended rather than left behind.
    expect(fake.revoked).toHaveLength(2);
  });

  it("asks for consent next time when ChatGPT didn't give Folio use of the plan", async () => {
    const { fake, store, saved, signIn } = await setup();
    fake.scope = "openid profile email offline_access";
    await expect(signIn()).rejects.toThrow("ChatGPT didn't let Folio use your plan");
    expect(await readConnectionStatus(store)).toEqual({ connected: false });
    expect((await saved()).registration).toMatchObject({ clientId: "oaiapp_1", askConsent: true });
    expect(fake.revoked).toHaveLength(1);

    fake.scope = PLAN;
    await signIn();
    expect(fake.authorizations[1]!.searchParams.get("prompt")).toBe("consent");
    expect(fake.authorizations[1]!.searchParams.get("client_id")).toBe("oaiapp_1");
    expect((await saved()).registration.askConsent).toBeUndefined();
    await signOutOfChatGPT(store);
    await signIn();
    expect(fake.authorizations[2]!.searchParams.has("prompt")).toBe(false);
  });

  it("stops at a declined returning sign-in without asking for tokens", async () => {
    const { fake, store, saved, signIn } = await setup();
    await signIn();
    await signOutOfChatGPT(store);
    await expect(signIn({ callback: { code: undefined, error: "access_denied" } })).rejects.toThrow(
      "Folio isn't allowed to use your ChatGPT plan",
    );
    expect(fake.tokenRequests).toHaveLength(1);
    expect((await saved()).registration).toMatchObject({ clientId: "oaiapp_1", askConsent: true });
  });

  it("registers anew when ChatGPT no longer knows Folio's client", async () => {
    const { fake, saved, signIn } = await setup();
    await signIn();
    fake.forgotten.add("oaiapp_1");
    await expect(signIn()).rejects.toThrow("ChatGPT no longer knows this Folio");
    expect((await saved()).registration).toBeUndefined();
    expect((await signIn()).clientId).toBe("oaiapp_2");
  });

  it("rejects an ID token that isn't this sign-in's, or isn't OpenAI's", async () => {
    const { fake, store, saved, signIn } = await setup();
    fake.nonce = "another-attempt";
    await expect(signIn()).rejects.toThrow("ChatGPT sign-in failed.");
    expect(await readConnectionStatus(store)).toEqual({ connected: false });
    // The client was issued, so it is kept for the next attempt rather than registered again.
    expect((await saved()).registration).toEqual({ clientId: "oaiapp_1" });

    fake.nonce = undefined;
    fake.signer = (await generateKeyPair("RS256")).privateKey;
    await expect(signIn()).rejects.toThrow("ChatGPT sign-in failed.");
    expect(await readConnectionStatus(store)).toEqual({ connected: false });
    expect(fake.registered).toEqual(["oaiapp_1"]);
  });

  it("waits past a callback from another sign-in, and takes a pasted address", async () => {
    const { fake, models, store } = await setup();
    const interaction = student(fake, undefined, "wait");
    const signingIn = models.login("openai", "oauth", interaction);
    const authorize = await interaction.opened;
    const stranger = new URL(authorize.searchParams.get("redirect_uri")!);
    stranger.searchParams.set("state", "someone-elses");
    stranger.searchParams.set("code", "stray");
    expect((await realFetch(stranger)).status).toBe(400);
    expect((await fake.visit(authorize)).status).toBe(200);
    await signingIn;
    expect(await readConnectionStatus(store)).toMatchObject({ connected: true });

    await signOutOfChatGPT(store);
    const pasting = student(fake, undefined, "paste");
    await expect(models.login("openai", "oauth", pasting)).resolves.toMatchObject({
      clientId: "oaiapp_1",
    });
  });

  it("stops listening when the sign-in is cancelled", async () => {
    const { fake, models } = await setup();
    const interaction = student(fake, undefined, "wait");
    const signingIn = models.login("openai", "oauth", interaction);
    const callback = new URL((await interaction.opened).searchParams.get("redirect_uri")!);
    interaction.controller.abort();
    await expect(signingIn).rejects.toThrow();
    await expect(realFetch(callback)).rejects.toThrow();
    expect(fake.registered).toEqual([]);
  });
});
