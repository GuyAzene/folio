// The update a Developer ID build publishes beside its disk image: the zip of the app and
// latest-mac.yml, which names it. scripts/package.ts checks the pair with this, in a module of its
// own so the rule can be tested without building anything.
import { parse } from "yaml";

/**
 * What is wrong with `latestMac`, the text of latest-mac.yml, for the zip named `zip` with the
 * SHA-512 `sha512` (base64), built as Folio `version`; null when it names that zip, and only it,
 * with that version and checksum, as Folio checks it before downloading.
 */
export function updateFilesProblem(
  latestMac: string,
  build: { version: string; zip: string; sha512: string },
): string | null {
  let info: unknown;
  try {
    info = parse(latestMac);
  } catch {
    return "latest-mac.yml doesn't read as YAML.";
  }
  const { version, files } = (info ?? {}) as {
    version?: unknown;
    files?: { url?: unknown; sha512?: unknown }[];
  };
  if (version !== build.version)
    return `latest-mac.yml says ${String(version)}, but this is Folio ${build.version}.`;
  if (!Array.isArray(files) || files.length !== 1 || files[0]?.url !== build.zip)
    return `latest-mac.yml names other files than ${build.zip}.`;
  if (files[0].sha512 !== build.sha512)
    return `latest-mac.yml has another checksum for ${build.zip}.`;
  return null;
}
