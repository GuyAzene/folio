import { createHash } from "node:crypto";

/**
 * The names the tutor sees for a server's tools: `moodle__get_deadlines`. Providers take at most
 * 64 characters of letters, digits, `_` and `-`; Folio's own tools never contain `__`, so a
 * server's tools can't take their names.
 */

const MAX = 64;
const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 6);

/** A server's part of the name: its ID in lowercase letters and digits, up to 16 characters. */
export function serverSlug(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 16) || `s${short(id)}`
  );
}

/**
 * The model's name for each of a server's tools, in order. A name too long, or the same as an
 * earlier one, gets a short hash of the original so it stays the same from one launch to the next.
 */
export function toolNames(
  serverId: string,
  tools: readonly string[],
  taken: ReadonlySet<string> = new Set(),
): string[] {
  const used = new Set(taken);
  const prefix = `${serverSlug(serverId)}__`;
  return tools.map((tool) => {
    let name = `${prefix}${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    if (name.length > MAX || used.has(name) || name !== `${prefix}${tool}`) {
      const suffix = `_${short(`${serverId}/${tool}`)}`;
      name = `${name.slice(0, MAX - suffix.length)}${suffix}`;
    }
    used.add(name);
    return name;
  });
}
