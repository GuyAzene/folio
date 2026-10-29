import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { claimLiveFrame, frameMessage, LIVE_FRAMES, rateLimit } from "../app/lib/frames.ts";
import { fillDiagrams, fillMath, markdownToHtml } from "../app/lib/markdown.ts";
import { chatView } from "../src/desktop/view.ts";
import { visualTool } from "../src/library/visual-tool.ts";
import type { SessionRecord } from "../src/session-store.ts";
import { staticSvg, svgImage, visualKind, visualProblem, visualTitle } from "../src/visual.ts";

// Synthetic visuals only.
const DRAWING =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><title>Two states</title><style>circle{fill:var(--folio-surface)}</style><circle cx="20" cy="20" r="12"/><circle cx="80" cy="20" r="12"/></svg>';
const DEMO = `<title>Step through the queue</title><button id="next">Next</button><output id="out">0</output><script>let n = 0; document.getElementById("next").onclick = () => { document.getElementById("out").textContent = ++n; };</script>`;

describe("what a visual may be", () => {
  it("tells a still drawing from one that runs", () => {
    expect(visualKind(DRAWING)).toBe("svg");
    expect(visualKind(DEMO)).toBe("html");
    expect(staticSvg(DRAWING)).toBe(true);
    expect(staticSvg(DRAWING.replace("</svg>", "<script>1</script></svg>"))).toBe(false);
    expect(staticSvg(DRAWING.replace("<circle", '<circle onclick="x()"'))).toBe(false);
    expect(staticSvg(DRAWING.replace("</svg>", '<animate attributeName="r"/></svg>'))).toBe(false);
    expect(staticSvg(DEMO)).toBe(false);
    expect(visualTitle(DRAWING)).toBe("Two states");
    expect(visualTitle("<svg></svg>")).toBeNull();
  });

  it("accepts a whole visual, and says how to fix one it refuses", () => {
    expect(visualProblem(DRAWING)).toBeNull();
    expect(visualProblem(DEMO)).toBeNull();
    expect(
      visualProblem(
        `${DEMO}<link rel="stylesheet" href="folio-artifact://lib/katex/katex.min.css">`,
      ),
    ).toBeNull();
    const refusals: [string, RegExp][] = [
      ["", /empty/],
      ["<svg><circle r='1'/></svg>", /<title>/],
      ["<svg><title>Cut</title><circle r='1'/>", /must end with <\/svg>/],
      [`${DEMO}<script src="https://cdn.example.com/lib.js"></script>`, /no network/],
      [`${DEMO}<img src="//example.com/x.png">`, /no network/],
      [`${DEMO}<style>@import url("https://example.com/x.css");</style>`, /no network/],
      [`${DEMO}<script src="folio-artifact://lib/other.js"></script>`, /no network/],
      [`${DEMO}<script>fetch("/data.json")</script>`, /no network/],
      [`${DEMO}<script>new WebSocket("ws://x")</script>`, /no network/],
      [`${DEMO}<script>localStorage.x = 1</script>`, /cannot store/],
      [`${DEMO}<script>alert("hi")</script>`, /cannot open windows/],
      [`<title>Big</title>${"x".repeat(200_001)}`, /keep it under/],
    ];
    for (const [source, reason] of refusals)
      expect(visualProblem(source), source.slice(0, 60)).toMatch(reason);
  });

  it("checks the visual in the tool, which records what the window needs to show it again", async () => {
    const tool = visualTool();
    const shown = await tool.execute("call_1", { source: DEMO });
    expect(shown.details).toMatchObject({
      v: 1,
      kind: "html",
      title: "Step through the queue",
      libs: [],
      runtime: "folio-visual-1",
      bytes: DEMO.length,
    });
    expect(JSON.stringify(shown.content)).not.toContain("<button");
    await expect(tool.execute("call_2", { source: "<svg></svg>" })).rejects.toThrow("<title>");
    await expect(tool.execute("call_3", {})).rejects.toThrow("source");
  });

  it("themes a still drawing inside the image, for either theme", () => {
    const light = decodeURIComponent(svgImage(DRAWING, "light").split(",")[1]!);
    const dark = decodeURIComponent(svgImage(DRAWING, "dark").split(",")[1]!);
    expect(light).toContain("--folio-surface:#f7f7f8");
    expect(dark).toContain("--folio-surface:#1e1e21");
    expect(light.indexOf("<style>:root{")).toBeGreaterThan(light.indexOf("<svg"));
  });
});

describe("what a demo may say to Folio", () => {
  it("accepts only known messages, within bounds", () => {
    expect(frameMessage({ type: "resize", height: 300.4 })).toEqual({
      type: "resize",
      height: 300,
    });
    expect(frameMessage({ type: "resize", height: 1e9 })).toEqual({ type: "resize", height: 1600 });
    expect(frameMessage({ type: "resize", height: -5 })).toEqual({ type: "resize", height: 80 });
    expect(frameMessage({ type: "ask", text: `  ${"q".repeat(5000)}` })).toMatchObject({
      type: "ask",
      text: "q".repeat(1000),
    });
    for (const forged of [
      null,
      "resize",
      [],
      { type: "resize", height: Number.NaN },
      { type: "resize", height: "300" },
      { type: "ask", text: "   " },
      { type: "ask", text: 5 },
      { type: "navigate", url: "https://example.com" },
      { type: "invoke", method: "trashCourse" },
    ])
      expect(frameMessage(forged), JSON.stringify(forged)).toBeNull();
    fc.assert(
      fc.property(fc.anything(), (anything) => {
        const message = frameMessage(anything);
        if (message?.type === "resize") {
          expect(message.height).toBeGreaterThanOrEqual(80);
          expect(message.height).toBeLessThanOrEqual(1600);
        }
      }),
    );
  });

  it("holds a resizing loop to ten a second", () => {
    let now = 0;
    const allow = rateLimit(10, () => now);
    const passed = Array.from({ length: 50 }, () => allow()).filter(Boolean).length;
    expect(passed).toBe(10);
    now = 1000;
    expect(allow()).toBe(true);
  });

  it("runs at most a few demos at once, stopping the one that started first", () => {
    const stopped: number[] = [];
    const releases = Array.from({ length: LIVE_FRAMES + 2 }, (_, n) =>
      claimLiveFrame(() => stopped.push(n)),
    );
    expect(stopped).toEqual([0, 1]);
    for (const release of releases) release();
  });
});

describe("visuals in a chat", () => {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (content: unknown[], stopReason = "toolUse") =>
    ({
      role: "assistant",
      content,
      stopReason,
      api: "openai-responses",
      provider: "openai",
      model: "synthetic-model",
      timestamp: 0,
      usage,
    }) as unknown as AgentMessage;
  const record = (messages: AgentMessage[], status: SessionRecord["status"] = "idle") =>
    ({
      id: "00000000-0000-4000-8000-000000000001",
      title: "Synthetic",
      status,
      modelId: "synthetic-model",
      updatedAt: "2026-10-29T00:00:00.000Z",
      scope: { courseId: "00000000-0000-4000-8000-000000000002", library: 1 },
      focus: null,
      messages,
    }) as unknown as SessionRecord;

  it("places each visual between the messages around it, settled by its result", () => {
    const messages = [
      { role: "user", content: "Show me", timestamp: 0 },
      assistant([
        { type: "text", text: "Here it is:" },
        { type: "toolCall", id: "call_1", name: "show_visual", arguments: { source: DEMO } },
      ]),
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "show_visual",
        content: [{ type: "text", text: "Shown" }],
        isError: false,
        timestamp: 0,
      },
      assistant([
        { type: "text", text: "And a wrong one:" },
        { type: "toolCall", id: "call_2", name: "show_visual", arguments: { source: "<svg/>" } },
      ]),
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "show_visual",
        content: [{ type: "text", text: "Give the visual a short <title>." }],
        isError: true,
        timestamp: 0,
      },
      assistant([{ type: "text", text: "Done." }], "stop"),
    ] as AgentMessage[];
    const reply = chatView(record(messages)).messages[1]!;
    expect(reply.text).toBe("Here it is:\n\nAnd a wrong one:\n\nDone.");
    expect(reply.steps).toEqual([]);
    expect(reply.visuals).toEqual([
      {
        id: "call_1",
        kind: "html",
        title: "Step through the queue",
        source: DEMO,
        state: "ready",
        at: "Here it is:".length,
      },
      {
        id: "call_2",
        kind: "svg",
        title: "",
        source: "<svg/>",
        state: "invalid",
        error: "Give the visual a short <title>.",
        at: "Here it is:\n\nAnd a wrong one:".length,
      },
    ]);
  });

  it("shows a visual the reply never finished as stopped, and one still being checked as drawing", () => {
    const messages = [
      { role: "user", content: "Show me", timestamp: 0 },
      assistant(
        [{ type: "toolCall", id: "call_1", name: "show_visual", arguments: { source: DEMO } }],
        "aborted",
      ),
    ] as AgentMessage[];
    expect(chatView(record(messages, "interrupted")).messages[1]!.visuals![0]!.state).toBe(
      "stopped",
    );
    expect(chatView(record(messages, "running")).messages[1]!.visuals![0]!.state).toBe("streaming");
  });
});

describe("demos in notes", () => {
  const rendered = (text: string, note: boolean) =>
    fillDiagrams(fillMath(markdownToHtml(text, { note })));

  it("give a note's closed ```demo block a slot to run in, and leave a reply's as code", () => {
    const block = "```demo\n<button>Go</button>\n```";
    const inNote = rendered(block, true);
    expect(inNote).toContain('<div class="demo-slot" dir="ltr" data-source="');
    expect(decodeURIComponent(inNote.match(/data-source="([^"]*)"/)![1]!)).toBe(
      "<button>Go</button>",
    );
    expect(rendered(block, false)).not.toContain("demo-slot");
    expect(rendered("```demo\n<button>Go</button>", true)).not.toContain("demo-slot");
  });
});

describe("one way to make a frame", () => {
  async function files(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(ts|svelte|html)$/.test(entry.name))
      .map((entry) => resolve(entry.parentPath, entry.name));
  }

  it("never grants a frame Folio's origin, and creates frames in one component only", async () => {
    const root = resolve(import.meta.dirname, "..");
    const sources = [
      ...(await files(resolve(root, "app"))),
      ...(await files(resolve(root, "src"))),
      resolve(root, "index.html"),
    ];
    const framers: string[] = [];
    for (const file of sources) {
      const text = await readFile(file, "utf8");
      expect(text.includes("allow-same-origin"), file).toBe(false);
      if (/<iframe\b|createElement\(\s*["']iframe/.test(text)) framers.push(file);
    }
    expect(framers.map((file) => file.slice(root.length + 1))).toEqual([
      "app/components/ArtifactFrame.svelte",
    ]);
  });
});
