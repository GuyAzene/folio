import { describe, expect, it } from "vite-plus/test";
import { demoPageTool, readDemoPage } from "../src/demo-source.ts";

describe("synthetic source boundary", () => {
  it("returns the selected page with a stable, usable source anchor", async () => {
    const result = await demoPageTool.execute("read-page-1", { courseId: "demo", page: 1 });

    expect(result.details.anchor).toBe("demo:synthetic-graph-lecture#page=1");
    expect(result.details.text).toContain("A -> B -> C");
    expect(result.content).toEqual([
      {
        type: "text",
        text: `${result.details.anchor}\nDirected graph reachability\n\n${result.details.text}`,
      },
    ]);
    expect(readDemoPage({ courseId: "demo", page: 2 }).text).toContain("Breadth-first search");
  });

  it.each(["other-course", "../demo", "/tmp/another-course", "DEMO", ""])(
    "rejects out-of-scope course %j independently of the model schema",
    (courseId) => {
      expect(() => readDemoPage({ courseId, page: 1 })).toThrow("Source scope denied");
    },
  );

  it.each([0, -1, 3, 1.5, NaN, Infinity, "1", "../page1", null])(
    "rejects invalid page %j without coercion",
    (page) => {
      expect(() => readDemoPage({ courseId: "demo", page })).toThrow("Source scope denied");
    },
  );

  it.each([
    { courseId: "demo", page: 1, path: "/etc/passwd" },
    { courseId: "demo", page: 1, courseRoot: ".." },
    { courseId: "demo", page: 1, write: true },
    { courseId: "demo" },
    null,
    [],
    "demo",
  ])("rejects undeclared fields and malformed requests %j", (request) => {
    expect(() => readDemoPage(request)).toThrow("only courseId and page");
  });

  it("enforces scope when execute is called without Pi's schema validation", async () => {
    await expect(
      demoPageTool.execute("bad-read", { courseId: "demo", page: 1, path: ".." } as never),
    ).rejects.toThrow("only courseId and page");
  });

  it("honors cancellation before exposing source content", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Cancelled by user", "AbortError");
    controller.abort(reason);

    expect(() => readDemoPage({ courseId: "demo", page: 1 }, controller.signal)).toThrow(reason);
    await expect(
      demoPageTool.execute("cancelled-read", { courseId: "demo", page: 1 }, controller.signal),
    ).rejects.toBe(reason);
  });

  it("does not allow consumers to mutate the original source", () => {
    const page = readDemoPage({ courseId: "demo", page: 1 });
    expect(() => Object.assign(page, { text: "replacement" })).toThrow(TypeError);
    expect(readDemoPage({ courseId: "demo", page: 1 }).text).toContain("A -> B -> C");
  });
});
