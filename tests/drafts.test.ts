import { describe, expect, it } from "vite-plus/test";
import {
  draftKey,
  keepRecent,
  MAX_DRAFTS,
  moveDraft,
  putDraft,
  readDrafts,
  type Draft,
} from "../app/lib/drafts.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 9, minute));
const quote = { text: "A synthetic passage.", source: "Lecture 1, page 2" };

describe("drafts", () => {
  it("keeps a chat's draft by chat, and a new chat's by the pane it is in", () => {
    expect(draftKey("chat-1", "pane-1")).toBe("chat-1");
    expect(draftKey(null, "pane-1")).toBe("new:pane-1");
  });

  it("changes text and quote apart, and drops a draft once both are empty", () => {
    let drafts = putDraft({}, "chat-1", { text: "Why is" }, at(1));
    drafts = putDraft(drafts, "chat-1", { quote }, at(2));
    expect(drafts["chat-1"]).toEqual({ text: "Why is", quote, at: at(2).toISOString() });
    drafts = putDraft(drafts, "chat-1", { text: "" }, at(3));
    expect(drafts["chat-1"]?.quote).toEqual(quote);
    // Sending clears both, and the draft is gone.
    expect(putDraft(drafts, "chat-1", { text: "", quote: null }, at(4))).toEqual({});
  });

  it("keeps the text exactly as typed, spaces included", () => {
    expect(putDraft({}, "chat-1", { text: " " })["chat-1"]?.text).toBe(" ");
  });

  it("moves a new chat's draft to the chat once it exists, unless the chat has one", () => {
    const drafts = putDraft({}, "new:pane-1", { text: "And the next step?" }, at(1));
    expect(moveDraft(drafts, "new:pane-1", "chat-1")).toEqual({ "chat-1": drafts["new:pane-1"] });
    const both = putDraft(drafts, "chat-1", { text: "Kept" }, at(2));
    expect(moveDraft(both, "new:pane-1", "chat-1")).toEqual({ "chat-1": both["chat-1"] });
    expect(moveDraft(drafts, "new:pane-2", "chat-1")).toBe(drafts);
  });

  it("keeps only the most recent drafts", () => {
    const many: Record<string, Draft> = {};
    for (let index = 0; index < MAX_DRAFTS + 5; index++)
      many[`chat-${index}`] = { text: "x", quote: null, at: at(index).toISOString() };
    const kept = keepRecent(many);
    expect(Object.keys(kept)).toHaveLength(MAX_DRAFTS);
    expect(kept["chat-0"]).toBeUndefined();
    expect(kept[`chat-${MAX_DRAFTS + 4}`]).toBeDefined();
  });

  it("reads saved drafts and leaves out anything malformed", () => {
    const saved = {
      good: { text: "Hello", quote: null, at: at(1).toISOString() },
      quoted: { text: "", quote, at: at(2).toISOString() },
      empty: { text: "", quote: null, at: at(3).toISOString() },
      noTime: { text: "Hello", quote: null },
      badQuote: { text: "Hello", quote: { text: 3 }, at: at(4).toISOString() },
      notADraft: "Hello",
    };
    expect(Object.keys(readDrafts(saved)).sort()).toEqual(["good", "quoted"]);
    for (const value of [null, "drafts", [], 3]) expect(readDrafts(value)).toEqual({});
  });
});
