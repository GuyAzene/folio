/// <reference lib="dom" />
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { launch, recordExternalLinks, type Running } from "./app.ts";
import { seedHome } from "./seed.ts";

/**
 * A newer release, in a real window: Folio asks a synthetic GitHub on this Mac (never the real
 * one), the sidebar says the release is out and opens its page in the system browser, the line
 * can be closed until the next release, and Settings turns the check off. Run with
 * `vp run test:electron`.
 */

const running: Running[] = [];
const servers: { close: () => Promise<void> }[] = [];
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
  await Promise.allSettled(servers.map((server) => server.close()));
});

/** Folio's own version and the next minor release after it. */
async function versions(): Promise<{ current: string; next: string }> {
  const { version } = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../../package.json"), "utf8"),
  ) as { version: string };
  const [major, minor] = version.split(".").map(Number);
  return { current: version, next: `${major}.${minor! + 1}.0` };
}

/** A synthetic GitHub on this Mac, answering with one release, keeping each request's headers. */
async function startGitHub(tag: string): Promise<{
  url: string;
  requests: IncomingHttpHeaders[];
  close: () => Promise<void>;
}> {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        tag_name: tag,
        html_url: "https://example.com/elsewhere",
        draft: false,
        prerelease: false,
      }),
    );
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>((done) => server.close(() => done()));
  return { url: `http://127.0.0.1:${port}/repos/GuyAzene/folio/releases/latest`, requests, close };
}

void describe("a newer Folio", () => {
  void it("is announced in the sidebar and Settings, links to its page, and can be closed or turned off", async () => {
    const { current, next } = await versions();
    const github = await startGitHub(`v${next}`);
    servers.push(github);
    const seeded = await seedHome("A synthetic reply.");
    const releasePage = `https://github.com/GuyAzene/folio/releases/tag/v${next}`;
    const open = async () => {
      const app = await launch(seeded.home, { FOLIO_RELEASES: github.url });
      running.push(app);
      await app.page.waitForFunction(() => "folio" in window);
      return app;
    };

    const first = await open();
    const opened = await recordExternalLinks(first.app);
    const line = first.page.getByRole("link", { name: `Folio ${next} is out` });
    await line.waitFor({ timeout: 15_000 });
    // Asked once, as an anonymous client: no account, no cookie.
    assert.equal(github.requests.length, 1);
    assert.equal(github.requests[0]!["user-agent"], "Folio");
    assert.equal(github.requests[0]!.authorization, undefined);
    assert.equal(github.requests[0]!.cookie, undefined);
    // The page opens in the system browser, at GitHub, whatever address the answer gave.
    await line.click();
    await first.page.waitForTimeout(300);
    assert.deepEqual(await opened(), [releasePage]);
    assert.equal(first.app.windows().length, 1);
    await first.close();

    // Reopened the same day, the release is shown from what was kept, without asking again.
    const second = await open();
    const { page } = second;
    const kept = page.getByRole("link", { name: `Folio ${next} is out` });
    await kept.waitFor();
    await page.waitForTimeout(3_000);
    assert.equal(github.requests.length, 1);

    // Closed, the line is gone; Settings still has this Folio's version and the release.
    await kept.hover();
    await page.getByRole("button", { name: "Hide until the next release" }).click();
    await kept.waitFor({ state: "detached" });
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.getByText(`Folio ${current}. Checks GitHub once a day`).waitFor();
    const settingsLink = page.getByRole("link", { name: `Folio ${next} is out. See what's new` });
    assert.equal(await settingsLink.getAttribute("href"), releasePage);

    // Turned off, Folio no longer mentions it, and after a restart asks nothing.
    await page.getByRole("group", { name: "Check for updates" }).getByText("Off").click();
    await settingsLink.waitFor({ state: "detached" });
    await second.close();
    const third = await open();
    await third.page.waitForTimeout(3_000);
    assert.equal(github.requests.length, 1);
    assert.equal(await third.page.getByText(`Folio ${next} is out`).count(), 0);
    const file = JSON.parse(await readFile(resolve(seeded.home, "release.json"), "utf8"));
    // The choice is kept by the main process, beside what was found.
    assert.equal(file.on, false);
    assert.equal(file.answer.tag, `v${next}`);
  });
});
