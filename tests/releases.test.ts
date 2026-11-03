import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  CHECK_EVERY_MS,
  compareVersions,
  LATEST_RELEASE,
  parseVersion,
  ReleaseCheck,
  releaseSource,
  RETRY_MS,
} from "../src/releases.ts";

const homes: string[] = [];

async function makeHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "folio-releases-test-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** A synthetic GitHub that answers from `answer`, keeping each request's URL and headers. */
function github(answer: () => Response) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    requests.push({ url: input, init });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

/** GitHub's latest release, in the shape its API sends, with `fields` changed. */
const release = (tag: string, fields: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      tag_name: tag,
      name: `Folio ${tag.slice(1)}`,
      html_url: "https://example.com/elsewhere",
      draft: false,
      prerelease: false,
      published_at: "2026-11-03T07:34:00Z",
      body: "What changed.",
      assets: [{ name: `Folio-${tag.slice(1)}-arm64.dmg` }],
      ...fields,
    }),
    { headers: { "content-type": "application/json" } },
  );

const PAGE = "https://github.com/GuyAzene/folio/releases/tag/v0.2.0";

describe("versions", () => {
  const order = (a: string, b: string) =>
    Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));

  it("are ordered as semantic versioning orders them", () => {
    // Semantic versioning's own example, then numbers that sort wrongly as text.
    const ascending = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.9.0",
      "1.10.0",
      "2.0.0",
      "10.0.0",
      "99999999999999999999.0.0",
    ];
    for (let i = 0; i < ascending.length; i++)
      for (let j = 0; j < ascending.length; j++)
        expect(order(ascending[i]!, ascending[j]!), `${ascending[i]} against ${ascending[j]}`).toBe(
          Math.sign(i - j),
        );
  });

  it("take a leading v and ignore build metadata", () => {
    expect(order("v0.2.0", "0.2.0")).toBe(0);
    expect(order("0.2.0+arm64", "0.2.0")).toBe(0);
    expect(order("0.2.0-beta+1", "0.2.0-beta+2")).toBe(0);
  });

  it("are refused when they are not semantic versions", () => {
    for (const text of [
      "",
      "nightly",
      "latest",
      "1.0",
      "1",
      "01.0.0",
      "1.0.0-",
      "1.0.0-01",
      "vv1.0.0",
      " 1.0.0",
      "1.0.0 ",
    ])
      expect(parseVersion(text), text).toBeNull();
  });
});

describe("a newer release", () => {
  it("is asked for at GitHub's public API, carrying nothing about the student", async () => {
    const home = await makeHome();
    const { fetch, requests } = github(() => release("v0.2.0"));
    const check = new ReleaseCheck({ home, version: "0.1.0", fetch });
    expect(await check.check()).toEqual({
      version: "0.1.0",
      on: true,
      newer: { version: "0.2.0", url: PAGE },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.github.com/repos/GuyAzene/folio/releases/latest");
    expect(requests[0]!.url).toBe(LATEST_RELEASE);
    // No account, no cookie, nothing but what GitHub asks of every client.
    expect(requests[0]!.init?.headers).toEqual({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "Folio",
    });
    expect(requests[0]!.init?.method ?? "GET").toBe("GET");
    expect(requests[0]!.init?.body).toBeUndefined();
  });

  it("is only one that is newer than this Folio", async () => {
    let tag = "v0.1.0";
    const { fetch } = github(() => release(tag));
    for (const [version, latest, newer] of [
      ["0.1.0", "v0.1.0", null],
      ["0.2.0", "v0.1.0", null],
      ["0.1.0", "v0.1.1", "0.1.1"],
      ["0.9.0", "v0.10.0", "0.10.0"],
      ["0.2.0-beta.1", "v0.2.0", "0.2.0"],
      ["not a version", "v9.0.0", null],
    ] as const) {
      tag = latest;
      const check = new ReleaseCheck({ home: await makeHome(), version, fetch });
      expect((await check.check()).newer?.version ?? null, `${version} against ${latest}`).toBe(
        newer,
      );
    }
  });

  it("links to its page on GitHub, never to an address from the answer", async () => {
    const home = await makeHome();
    const check = new ReleaseCheck({
      home,
      version: "0.1.0",
      fetch: github(() => release("v0.2.0+build.7")).fetch,
    });
    expect((await check.check()).newer).toEqual({
      version: "0.2.0+build.7",
      url: "https://github.com/GuyAzene/folio/releases/tag/v0.2.0%2Bbuild.7",
    });
  });

  it("is kept in Folio's home, readable only by the student, and shown after a restart without asking", async () => {
    const home = await makeHome();
    await new ReleaseCheck({
      home,
      version: "0.1.0",
      fetch: github(() => release("v0.2.0")).fetch,
    }).check();
    const file = resolve(home, "release.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      version: 1,
      on: true,
      answer: { tag: "v0.2.0" },
    });

    const offline = github(() => {
      throw new Error("offline");
    });
    const again = new ReleaseCheck({ home, version: "0.1.0", fetch: offline.fetch });
    expect((await again.view()).newer?.version).toBe("0.2.0");
    // Checked a moment ago: nothing is asked for a day.
    expect((await again.check()).newer?.version).toBe("0.2.0");
    expect(offline.requests).toHaveLength(0);
    // Once this Folio is the release, the line goes.
    const updated = new ReleaseCheck({ home, version: "0.2.0", fetch: offline.fetch });
    expect((await updated.view()).newer).toBeNull();
  });

  it("is asked for at most once a day", async () => {
    const home = await makeHome();
    let now = Date.parse("2026-11-03T08:00:00Z");
    let tag = "v0.2.0";
    const { fetch, requests } = github(() => release(tag));
    const check = new ReleaseCheck({ home, version: "0.1.0", fetch, now: () => now });
    await check.check();
    now += CHECK_EVERY_MS - 1;
    await check.check();
    expect(requests).toHaveLength(1);

    now += 1;
    tag = "v0.3.0";
    expect((await check.check()).newer?.version).toBe("0.3.0");
    expect(requests).toHaveLength(2);
    // A clock set back is no reason to stop asking.
    now -= 2 * CHECK_EVERY_MS;
    await check.check();
    expect(requests).toHaveLength(3);
  });

  it("keeps the last answer when GitHub can't be reached or answers badly, tries again in an hour, and never throws", async () => {
    const home = await makeHome();
    let now = Date.parse("2026-11-03T08:00:00Z");
    let answer: () => Response = () => release("v0.2.0");
    const { fetch, requests } = github(() => answer());
    const check = new ReleaseCheck({ home, version: "0.1.0", fetch, now: () => now });
    await check.check();
    const failures: (() => Response)[] = [
      () => {
        throw new Error("offline");
      },
      () => new Response("rate limited", { status: 403 }),
      () => new Response("busy", { status: 500 }),
      () => new Response("{not json"),
      () => new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024) } }),
      () => new Response(`{"tag_name":"v0.3.0","body":"${"x".repeat(2 * 1024 * 1024)}"}`),
      () => new Response("[]"),
      () => release("nightly"),
      () => release("v0.3.0", { draft: true }),
      () => release("v0.3.0", { prerelease: true }),
      () => release("v0.3.0", { tag_name: 3 }),
    ];
    for (const failure of failures) {
      answer = failure;
      now += CHECK_EVERY_MS;
      const asked = requests.length;
      expect((await check.check()).newer?.version).toBe("0.2.0");
      expect(requests).toHaveLength(asked + 1);
      // Within the hour, Folio doesn't ask again.
      now += RETRY_MS - 1;
      await check.check();
      expect(requests).toHaveLength(asked + 1);
      now -= RETRY_MS - 1;
    }
    expect(JSON.parse(await readFile(resolve(home, "release.json"), "utf8")).answer.tag).toBe(
      "v0.2.0",
    );

    answer = () => release("v0.3.0");
    now += RETRY_MS;
    expect((await check.check()).newer?.version).toBe("0.3.0");
  });

  it("is none while the repository has no published release", async () => {
    const home = await makeHome();
    let answer = () => release("v0.2.0");
    const { fetch, requests } = github(() => answer());
    let now = 0;
    const check = new ReleaseCheck({ home, version: "0.1.0", fetch, now: () => now });
    await check.check();
    answer = () => new Response('{"message":"Not Found"}', { status: 404 });
    now += CHECK_EVERY_MS;
    expect((await check.check()).newer).toBeNull();
    // That is an answer: kept, and not asked for again for a day.
    now += RETRY_MS;
    await check.check();
    expect(requests).toHaveLength(2);
    expect(JSON.parse(await readFile(resolve(home, "release.json"), "utf8")).answer.tag).toBeNull();
  });

  it("is asked for once when checked twice at the same time", async () => {
    const home = await makeHome();
    const { fetch, requests } = github(() => release("v0.2.0"));
    const check = new ReleaseCheck({ home, version: "0.1.0", fetch });
    const [one, two] = await Promise.all([check.check(), check.check()]);
    expect(one).toEqual(two);
    expect(requests).toHaveLength(1);
  });

  it("is read back only as Folio wrote it: an edited or broken file is no answer", async () => {
    const now = Date.now();
    for (const contents of [
      "{not json",
      JSON.stringify({ version: 2, on: true, answer: { checkedAt: now, tag: "v0.2.0" } }),
      JSON.stringify({ version: 1, answer: { checkedAt: now, tag: "javascript:alert(1)" } }),
      JSON.stringify({ version: 1, answer: { checkedAt: now, tag: 7 } }),
      JSON.stringify({ version: 1, answer: { checkedAt: "today", tag: "v0.2.0" } }),
      JSON.stringify({ version: 1, answer: "v0.2.0" }),
    ]) {
      const home = await makeHome();
      await writeFile(resolve(home, "release.json"), contents);
      const { fetch, requests } = github(() => release("v0.3.0"));
      const check = new ReleaseCheck({ home, version: "0.1.0", fetch });
      expect((await check.view()).newer, contents).toBeNull();
      // Nothing usable was kept, so Folio asks at once.
      expect((await check.check()).newer?.version).toBe("0.3.0");
      expect(requests).toHaveLength(1);
    }
  });

  it("is never asked for once the student turns the check off, across restarts", async () => {
    const home = await makeHome();
    const { fetch, requests } = github(() => release("v0.2.0"));
    const check = new ReleaseCheck({ home, version: "0.1.0", fetch });
    await check.check();
    expect(requests).toHaveLength(1);
    expect(await check.setOn(false)).toEqual({ version: "0.1.0", on: false, newer: null });
    const file = resolve(home, "release.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1, on: false });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // A day later, and after a restart, nothing is asked and nothing is shown.
    let now = Date.now() + 2 * CHECK_EVERY_MS;
    const later = new ReleaseCheck({ home, version: "0.1.0", fetch, now: () => now });
    expect(await later.view()).toEqual({ version: "0.1.0", on: false, newer: null });
    expect((await later.check()).newer).toBeNull();
    expect(requests).toHaveLength(1);

    // Turned on again, the answer kept from before shows at once, and a day-old one is renewed.
    expect((await later.setOn(true)).newer?.version).toBe("0.2.0");
    await later.check();
    expect(requests).toHaveLength(2);
    now += 1;
    await later.check();
    expect(requests).toHaveLength(2);
  });

  it("stops a check under way when turned off, and drops an answer that still arrives", async () => {
    const home = await makeHome();
    const signals: AbortSignal[] = [];
    let answer: (response: Response) => void = () => undefined;
    // This GitHub answers only when told to, even after the request was stopped.
    const fetch = (async (_input: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise<Response>((done) => (answer = done));
    }) as typeof globalThis.fetch;
    const check = new ReleaseCheck({ home, version: "0.1.0", fetch });
    const checking = check.check();
    while (!signals.length) await new Promise((ready) => setTimeout(ready, 1));
    await check.setOn(false);
    expect(signals[0]!.aborted).toBe(true);
    answer(release("v0.2.0"));
    expect(await checking).toEqual({ version: "0.1.0", on: false, newer: null });
    const kept = JSON.parse(await readFile(resolve(home, "release.json"), "utf8"));
    expect(kept).toEqual({ version: 1, on: false, answer: null });
  });

  it("keeps the student's choice even when the answer beside it doesn't read", async () => {
    const home = await makeHome();
    await writeFile(
      resolve(home, "release.json"),
      JSON.stringify({ version: 1, on: false, answer: { checkedAt: "today", tag: 7 } }),
    );
    const { fetch, requests } = github(() => release("v0.2.0"));
    const check = new ReleaseCheck({ home, version: "0.1.0", fetch });
    expect(await check.check()).toEqual({ version: "0.1.0", on: false, newer: null });
    expect(requests).toHaveLength(0);
  });

  it("is never asked for when off, and only an https address or this Mac may replace GitHub", async () => {
    const home = await makeHome();
    const { fetch, requests } = github(() => release("v0.2.0"));
    const check = new ReleaseCheck({ home, version: "0.1.0", source: null, fetch });
    expect(await check.check()).toEqual({ version: "0.1.0", on: true, newer: null });
    expect(requests).toHaveLength(0);
    expect(releaseSource(undefined)).toBe(LATEST_RELEASE);
    expect(releaseSource("")).toBe(LATEST_RELEASE);
    expect(releaseSource("off")).toBeNull();
    expect(releaseSource("http://releases.example")).toBeNull();
    expect(releaseSource("not a url")).toBeNull();
    expect(releaseSource("http://127.0.0.1:8123/latest")).toBe("http://127.0.0.1:8123/latest");
    expect(releaseSource("https://releases.example/latest")).toBe(
      "https://releases.example/latest",
    );
  });
});
