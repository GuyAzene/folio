/// <reference lib="dom" />
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Frame } from "playwright-core";
import { launch, type Running } from "./app.ts";
import { seedHome, visualTurns } from "./seed.ts";

/**
 * The tutor's demos in Folio's window: a demo runs, sealed, in a process of its own; whatever it
 * tries, it reaches nothing (a local sink records any request, and canaries sit in Folio's page);
 * a demo that loops forever freezes only itself; its questions only fill the message box; and a
 * long chat runs a few demos at a time. Synthetic demos only; nothing here talks to a model.
 */

const COUNTER = `<title>Counter</title><button id="next">Next</button> <output id="out">0</output>
<script>let n = 0; document.getElementById("next").onclick = () => { document.getElementById("out").textContent = String(++n); };</script>`;

const running: Running[] = [];
const hits: string[] = [];
let sink: Server;
let sinkUrl = "";

before(async () => {
  sink = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.end("ok");
  });
  sink.on("upgrade", (request, socket) => {
    hits.push(`UPGRADE ${request.url}`);
    socket.destroy();
  });
  await new Promise<void>((done) => sink.listen(0, "127.0.0.1", done));
  sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
});
after(async () => {
  await Promise.allSettled(running.map((app) => app.close()));
  sink.close();
});

async function open(sources: string[]): Promise<Running> {
  const seeded = await seedHome("", "chat", undefined, visualTurns(sources));
  const app = await launch(seeded.home);
  running.push(app);
  return app;
}

async function demoFrame(running: Running): Promise<Frame> {
  await running.page.locator(".visual iframe").first().waitFor();
  for (let tries = 0; tries < 50; tries++) {
    const frame = running.page
      .frames()
      .find((candidate) => candidate.url().startsWith("folio-artifact://"));
    if (frame) {
      await frame.waitForLoadState("load");
      return frame;
    }
    await running.page.waitForTimeout(100);
  }
  throw new Error("No demo frame appeared.");
}

void describe("Demos in Folio's window", () => {
  void it("runs a demo, sized to its content, in a process of its own", async () => {
    const app = await open([COUNTER]);
    const frame = await demoFrame(app);
    await frame.locator("#next").click();
    await frame.locator("#next").click();
    assert.equal(await frame.locator("#out").textContent(), "2");
    const height = await app.page.locator(".visual iframe").evaluate((node) => node.clientHeight);
    assert.ok(height >= 80 && height < 400, `height ${height}`);
    const processes = await app.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0]!.webContents.mainFrame;
      return main.framesInSubtree.map((frame) => ({ url: frame.url, pid: frame.osProcessId }));
    });
    const page = processes.find((entry) => entry.url.startsWith("folio://"))!;
    const demo = processes.find((entry) => entry.url.startsWith("folio-artifact://"))!;
    console.log(`Folio's page in process ${page.pid}, the demo in ${demo.pid}`);
    assert.notEqual(demo.pid, page.pid, "the demo must not share Folio's process");
  });

  void it("reaches nothing: no network, no Folio, no storage, no windows, no navigation", async () => {
    const probe = `<title>Probe</title><p id="done">running</p><script>
      const sink = ${JSON.stringify(sinkUrl)};
      const tries = [];
      const pending = [];
      const attempt = (name, run) => {
        try {
          const result = run();
          if (result && result.then)
            pending.push(result.then(() => tries.push(name + ": reached"), (error) => tries.push(name + ": " + error.name)));
          else tries.push(name + ": started");
        } catch (error) { tries.push(name + ": " + error.name); }
      };
      attempt("fetch", () => fetch(sink + "/fetch"));
      attempt("xhr", () => { const x = new XMLHttpRequest(); x.open("GET", sink + "/xhr"); x.send(); });
      attempt("image", () => { new Image().src = sink + "/image"; });
      attempt("css", () => { const s = document.createElement("style"); s.textContent = "body{background:url(" + sink + "/css)}"; document.head.append(s); });
      attempt("import css", () => { const s = document.createElement("style"); s.textContent = "@import url(" + sink + "/import);"; document.head.append(s); });
      attempt("prefetch", () => { const l = document.createElement("link"); l.rel = "prefetch"; l.href = sink + "/prefetch"; document.head.append(l); });
      attempt("beacon", () => navigator.sendBeacon(sink + "/beacon", "x"));
      attempt("socket", () => new WebSocket(sink.replace("http", "ws") + "/socket"));
      attempt("events", () => new EventSource(sink + "/events"));
      attempt("script", () => { const s = document.createElement("script"); s.src = sink + "/script.js"; document.head.append(s); });
      attempt("frame", () => { const f = document.createElement("iframe"); f.src = sink + "/frame"; document.body.append(f); });
      attempt("form", () => { const f = document.createElement("form"); f.action = sink + "/form"; f.method = "post"; document.body.append(f); f.submit(); });
      attempt("open", () => window.open(sink + "/open"));
      attempt("top", () => { top.location.href = sink + "/top"; });
      attempt("parent", () => parent.document.title);
      attempt("parent canary", () => parent.canary);
      attempt("storage", () => localStorage.getItem("canary"));
      attempt("cookie", () => document.cookie);
      attempt("folio page", () => fetch("folio://app/index.html"));
      attempt("folio api", () => parent.folio.bootstrap());
      attempt("rtc", () => new RTCPeerConnection());
      Promise.allSettled(pending).then(() => {
        document.getElementById("done").textContent = tries.join("\\n");
      });
    </script>`;
    const app = await open([probe]);
    await app.page.evaluate(() => {
      (window as unknown as { canary: string }).canary = "C4N4RY";
      localStorage.setItem("canary", "C4N4RY");
    });
    const frame = await demoFrame(app);
    // Read in the same step: the probe tries to navigate itself away right after.
    const tries = (await (
      await frame.waitForFunction(() => {
        const text = document.getElementById("done")?.textContent;
        return text !== "running" && text;
      })
    ).jsonValue()) as string;
    // Last, the demo tries to send itself to the sink.
    await frame
      .evaluate((target) => {
        location.href = `${target}/self`;
      }, sinkUrl)
      .catch(() => undefined);
    await app.page.waitForTimeout(2000);
    console.log(`What the probe saw:\n${tries}`);
    assert.deepEqual(hits, [], `the sink was reached: ${hits.join(", ")}`);
    assert.equal(app.app.windows().length, 1, "no window opened");
    assert.match(app.page.url(), /^folio:\/\/app\//, "Folio's page did not move");
    for (const line of ["parent", "parent canary", "storage", "cookie", "folio api"])
      assert.match(tries, new RegExp(`^${line}: (SecurityError|TypeError)`, "m"), line);
    // Requests that return a promise must fail, not merely go unrecorded.
    for (const line of ["fetch", "beacon", "folio page"])
      assert.doesNotMatch(tries, new RegExp(`^${line}: reached`, "m"), line);
    assert.doesNotMatch(tries, /: reached$/m);
    assert.equal(
      await app.page.evaluate(() => (window as unknown as { canary: string }).canary),
      "C4N4RY",
    );
  });

  void it("loads the libraries Folio bundles, fonts included, and nothing else", async () => {
    const math = `<title>Math</title><link rel="stylesheet" href="folio-artifact://lib/katex/katex.min.css"><script src="folio-artifact://lib/katex/katex.min.js"></script><p id="f"></p><script>katex.render("\\\\frac{a}{b} + \\\\sqrt{x}", document.getElementById("f"));</script>`;
    const app = await open([math]);
    const frame = await demoFrame(app);
    await frame.locator("#f .katex").waitFor();
    const fonts = await frame.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map((face) => face.family);
    });
    assert.ok(
      fonts.some((family) => family.includes("KaTeX")),
      `fonts: ${fonts.join(", ")}`,
    );
  });

  void it("lets a demo that loops forever freeze only itself, then says it stopped", async () => {
    const loop = `<title>Spin</title><p>spinning</p><script>setTimeout(() => { for (;;) {} }, 200);</script>`;
    const app = await open([loop]);
    await demoFrame(app);
    await app.page.waitForTimeout(600);
    const answers: number[] = [];
    for (let index = 0; index < 10; index++) {
      const started = Date.now();
      await app.page.evaluate(() => document.title);
      answers.push(Date.now() - started);
      await app.page.waitForTimeout(200);
    }
    console.log(`Folio answered in ${Math.max(...answers)} ms at worst while the demo looped`);
    assert.ok(Math.max(...answers) < 500, `Folio took ${Math.max(...answers)} ms to answer`);
    await app.page.getByText("This demo stopped responding.").waitFor({ timeout: 10_000 });
    assert.equal(await app.page.locator(".visual iframe").count(), 0);
  });

  void it("turns a demo's question into a draft in the message box, never a sent message", async () => {
    const asking = `<title>Ask</title><button id="ask">Why?</button><script>document.getElementById("ask").onclick = () => folio.ask("Why does the counter start at zero?");</script>`;
    const app = await open([asking]);
    const frame = await demoFrame(app);
    const before = await app.page.locator(".prose-folio").count();
    await frame.locator("#ask").click();
    const box = app.page.getByRole("textbox").last();
    await app.page.waitForFunction(() =>
      [...document.querySelectorAll("textarea")].some((field) => field.value.includes("counter")),
    );
    assert.match(await box.inputValue(), /Why does the counter start at zero\?/);
    assert.equal(await app.page.locator(".prose-folio").count(), before);
  });

  void it("shows a still drawing as an image, and runs at most four demos at once", async () => {
    const drawing = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 20"><title>Dot</title><circle cx="10" cy="10" r="6"/></svg>`;
    const app = await open([drawing, ...Array.from({ length: 12 }, () => COUNTER)]);
    await app.page.locator(".visual img.visual-drawing").waitFor();
    let most = 0;
    const scroller = app.page.locator(".prose-folio").first();
    for (let step = 0; step < 30; step++) {
      await scroller.evaluate((node) =>
        node.closest(".overflow-y-auto, .scroll-quiet")?.scrollBy(0, 400),
      );
      await app.page.waitForTimeout(120);
      most = Math.max(most, await app.page.locator(".visual iframe").count());
    }
    console.log(`Most demos running at once: ${most}`);
    assert.ok(most >= 1 && most <= 4, `${most} demos ran at once`);
  });
});
