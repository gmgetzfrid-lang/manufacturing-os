// lib/ai/pricing.ts — pure, isomorphic (no server deps, no fetch).
//
// The in-app price table behind the monthly spend caps. Providers return
// exact token counts on every response; we multiply by these $/million-token
// rates to estimate cost. Estimates only — the provider's own bill is the
// truth — but they're computed from the provider's own token counts, so
// they track real spend closely enough to enforce a "$10/month" cap.
//
// Also home to the personal-key provider allowlist: personal keys are
// limited to Anthropic and OpenAI because their API traffic is contractually
// excluded from model training. Google AI Studio free-tier keys ARE used for
// training — exactly the leak an individual quietly pasting a free key would
// cause — so Gemini keys are org-scope only, where an Admin/DocCtrl signs
// the data-handling agreement for the workspace with eyes open.

import type { AiProviderId } from "./providerCall";

/** Providers a PERSONAL key may use. Enforced server-side at key save,
 *  key test, and ask time (a grandfathered personal Gemini row is skipped). */
export const PERSONAL_ALLOWED_PROVIDERS: readonly AiProviderId[] = ["anthropic", "openai"];

export const PERSONAL_PROVIDER_BLOCK_MESSAGE =
  "Personal keys are limited to Anthropic (Claude) and OpenAI — their API traffic is never used for model training. Google AI Studio free keys can train on your data, so Gemini is only available as an org connection set up by an admin.";

// ── Data-handling agreement ─────────────────────────────────────────────────
// Every NEW key saved requires the saver to accept this agreement; the
// acceptance is recorded in ai_key_agreements (who, which key, which version,
// when, from where). Bump the version when the text materially changes.
export const AGREEMENT_VERSION = "2026-07-v1";
export const AGREEMENT_TEXT =
  "I understand that questions asked through this workspace — including text from " +
  "our internal documents — are sent to the AI provider behind this API key. I " +
  "confirm this key is a PAID API key whose traffic the provider does not use for " +
  "model training. I will never connect a free-tier key (e.g. Google AI Studio " +
  "free keys), because free tiers can train on our proprietary data. Misuse of " +
  "this feature to leak company data is attributable to me via this record.";

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

/** $ per MILLION tokens: [input, output]. Longest-prefix match on the model
 *  id so dated snapshots ("gpt-4o-2024-11-20") price like their family. */
const MODEL_PRICES: Array<[prefix: string, inPerM: number, outPerM: number]> = [
  ["claude-opus", 5, 25],
  ["claude-sonnet", 3, 15],
  ["claude-haiku", 1, 5],
  ["gpt-5", 1.25, 10],
  ["gpt-4o-mini", 0.15, 0.6],
  ["gpt-4o", 2.5, 10],
  ["gemini-2.5-pro", 1.25, 10],
  ["gemini-2.5-flash", 0.3, 2.5],
];

/** Fallback for unknown models — priced like a frontier model so an
 *  unrecognized id can never sneak under the cap. */
const FALLBACK_PRICE: [number, number] = [5, 25];

export function modelPricePerMTok(model: string): [inPerM: number, outPerM: number] {
  const id = model.trim().toLowerCase();
  let best: [number, number] | null = null;
  let bestLen = -1;
  for (const [prefix, inP, outP] of MODEL_PRICES) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = [inP, outP];
      bestLen = prefix.length;
    }
  }
  return best ?? FALLBACK_PRICE;
}

/** Estimated USD cost of one call (or one summed ask) on the given model. */
export function estimateCostUsd(model: string, usage: AiUsage): number {
  const [inPerM, outPerM] = modelPricePerMTok(model);
  const cost =
    (Math.max(0, usage.inputTokens) / 1_000_000) * inPerM +
    (Math.max(0, usage.outputTokens) / 1_000_000) * outPerM;
  // Round to micro-dollars: enough precision to accumulate tiny calls
  // without floating-point lint in the ledger.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export const addUsage = (a: AiUsage, b: AiUsage): AiUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

export const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0 };
