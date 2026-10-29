/**
 * A request that lost its connection to the model on the way, as the provider's client and
 * Node report it: worth trying again, unlike a refusal, a usage limit or a bad answer.
 */
export const DROPPED =
  /connection error|connection (?:was )?(?:reset|closed|lost)|timed out|\bterminated\b|fetch failed|socket hang up|other side closed|premature close|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EAI_AGAIN/i;
