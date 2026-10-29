/**
 * The models Folio offers, grouped by the subscription that pays for them. A model is listed
 * only after a real request succeeded with that subscription; Pi's catalog lists many more that
 * a subscription may refuse (on 2026-10-27, ChatGPT refused gpt-5.5 as "not supported").
 */
export interface Subscription {
  /** Pi's provider ID. */
  provider: string;
  name: string;
  /** False until Folio can sign in to it. */
  available: boolean;
  models: string[];
}

export const SUBSCRIPTIONS: Subscription[] = [
  {
    provider: "openai",
    name: "ChatGPT",
    available: true,
    // Checked with one request each through a ChatGPT Pro plan on 2026-10-27.
    models: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol"],
  },
  { provider: "anthropic", name: "Claude", available: false, models: [] },
];

export const OFFERED_MODELS: readonly string[] = SUBSCRIPTIONS.flatMap(
  (subscription) => subscription.models,
);
