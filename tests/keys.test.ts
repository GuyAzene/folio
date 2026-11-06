import { describe, expect, it } from "vitest";
import { keys } from "../app/lib/keys.ts";

describe("shortcut labels", () => {
  it("are left as written on a Mac", () => {
    expect(keys("⌘⇧T", "darwin")).toBe("⌘⇧T");
    expect(keys("⌥-click", "darwin")).toBe("⌥-click");
  });

  it("name the keys elsewhere, modifiers first in the usual order", () => {
    expect(keys("⌘K", "win32")).toBe("Ctrl+K");
    expect(keys("⌘,", "win32")).toBe("Ctrl+,");
    expect(keys("⌘\\", "win32")).toBe("Ctrl+\\");
    expect(keys("⇧⌘←", "win32")).toBe("Ctrl+Shift+←");
    expect(keys("⌘⌥⇧J", "linux")).toBe("Ctrl+Alt+Shift+J");
  });

  it("call Return Enter, and a modified click by its key", () => {
    expect(keys("⌘↵", "win32")).toBe("Ctrl+Enter");
    expect(keys("⌥-click", "win32")).toBe("Alt+click");
    expect(keys("⌘-click", "win32")).toBe("Ctrl+click");
  });

  it("change only the shortcut inside a hint", () => {
    expect(keys("or paste ⌘V", "win32")).toBe("or paste Ctrl+V");
    expect(keys("↵ open", "win32")).toBe("↵ open");
  });
});
