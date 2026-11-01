/** A passage quoted into the composer, with where it came from. */
export interface Quote {
  text: string;
  source: string;
}

/** What the student is writing to a chat, kept until it is sent. */
export interface Draft {
  text: string;
  quote: Quote | null;
  /** When it last changed; only the most recent drafts are kept. */
  at: string;
}

export const MAX_DRAFTS = 100;

/** A chat's drafts are its own; a chat not started yet keeps its draft by the pane it is in. */
export function draftKey(chatId: string | null, paneId: string): string {
  return chatId ?? `new:${paneId}`;
}

/** The drafts with one changed. A draft with no text and no quote is gone. */
export function putDraft(
  drafts: Record<string, Draft>,
  key: string,
  patch: Partial<Pick<Draft, "text" | "quote">>,
  now = new Date(),
): Record<string, Draft> {
  const before = drafts[key];
  const next: Draft = {
    text: patch.text ?? before?.text ?? "",
    quote: patch.quote !== undefined ? patch.quote : (before?.quote ?? null),
    at: now.toISOString(),
  };
  const rest = { ...drafts };
  delete rest[key];
  return next.text || next.quote ? keepRecent({ ...rest, [key]: next }) : rest;
}

/** A new chat's draft moves to the chat once Folio has made it, unless the chat has its own. */
export function moveDraft<T>(
  drafts: Record<string, T>,
  from: string,
  to: string,
): Record<string, T> {
  if (!(from in drafts)) return drafts;
  const rest = { ...drafts };
  const moved = rest[from]!;
  delete rest[from];
  return to in rest ? rest : { ...rest, [to]: moved };
}

/** The most recent drafts, at most `max`. */
export function keepRecent(drafts: Record<string, Draft>, max = MAX_DRAFTS): Record<string, Draft> {
  const entries = Object.entries(drafts);
  if (entries.length <= max) return drafts;
  return Object.fromEntries(entries.sort(([, a], [, b]) => b.at.localeCompare(a.at)).slice(0, max));
}

/** Drafts saved on this device, with anything malformed left out. */
export function readDrafts(saved: unknown): Record<string, Draft> {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  const drafts: Record<string, Draft> = {};
  for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
    const draft = value as Partial<Draft> | null;
    const quote = draft?.quote as Partial<Quote> | null | undefined;
    if (
      typeof draft?.text !== "string" ||
      typeof draft.at !== "string" ||
      (quote != null && (typeof quote.text !== "string" || typeof quote.source !== "string"))
    )
      continue;
    const kept = {
      text: draft.text,
      quote: quote ? { text: quote.text!, source: quote.source! } : null,
      at: draft.at,
    };
    if (kept.text || kept.quote) drafts[key] = kept;
  }
  return keepRecent(drafts);
}
