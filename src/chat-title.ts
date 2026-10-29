/**
 * A chat's title from its first message. A passage quoted from the reader ("> text" lines,
 * then "> (source)") names the chat better than the instruction that follows it.
 */
export function chatTitle(text: string): string {
  const quoted = text
    .split("\n")
    .filter((line) => line.startsWith(">"))
    .map((line) => line.replace(/^>\s?/, ""))
    .filter((line) => !/^\(.*\)$/.test(line.trim()));
  const title = (quoted.length ? quoted.join(" ") : text).replace(/\s+/g, " ").trim();
  return (title || text.replace(/\s+/g, " ").trim()).slice(0, 80);
}
