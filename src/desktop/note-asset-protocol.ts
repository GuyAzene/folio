import { parseAssetUrl } from "../library/asset-names.ts";
import type { NoteAssets } from "../library/note-assets.ts";
import { originOf } from "./hardening.ts";

/**
 * Answers a `folio-note:` request: one figure of one course's notes, only to Folio's own pages
 * (the window, and the hidden page that draws a note for the tutor). A demo's frame, whose origin
 * is opaque, gets nothing. The address must name exactly one figure: no other path, no query.
 */
export async function noteAssetResponse(
  request: { url: string; initiatorOrigin?: string },
  assets: Pick<NoteAssets, "read">,
  rendererOrigin: string,
): Promise<Response> {
  const refuse = (status: number) => new Response(null, { status });
  const initiator = request.initiatorOrigin;
  if (!initiator || initiator === "null" || originOf(initiator) !== rendererOrigin)
    return refuse(403);
  // Percent-encoding has no place in a figure's address; refuse it rather than decode it.
  if (request.url.includes("%")) return refuse(404);
  const asset = parseAssetUrl(request.url);
  if (!asset) return refuse(404);
  const found = await assets.read(asset.courseId, asset.file).catch(() => null);
  if (!found) return refuse(404);
  return new Response(Buffer.from(found.bytes), {
    headers: {
      "Content-Type": found.type,
      "X-Content-Type-Options": "nosniff",
      // A figure's name is its hash, so the same address always holds the same bytes.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
