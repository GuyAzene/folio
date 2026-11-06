/**
 * Shortcuts are written the Mac way, "⌘⇧T" or "⌥-click", and shown the way the student's system
 * names its keys: unchanged on a Mac, "Ctrl+Shift+T" or "Alt+click" elsewhere. Folio's shortcuts
 * already answer to Ctrl wherever they answer to ⌘.
 */

const MODIFIERS: Record<string, string> = { "⌃": "Ctrl", "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift" };
const ORDER = ["Ctrl", "Alt", "Shift"];

export function keys(shortcut: string, platform: string): string {
  if (platform === "darwin") return shortcut;
  return shortcut.replace(/([⌃⌥⇧⌘]+)-?(\S*)/gu, (_match, symbols: string, key: string) => {
    const held = ORDER.filter((name) =>
      Object.entries(MODIFIERS).some(
        ([symbol, named]) => named === name && symbols.includes(symbol),
      ),
    );
    return [...held, key === "↵" ? "Enter" : key].filter(Boolean).join("+");
  });
}
