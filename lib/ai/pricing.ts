// lib/ai/pricing.ts — pure, isomorphic (no server deps, no fetch).
//
// The in-app price table behind the monthly spend caps. Providers return
// exact token counts on every response; we multiply by these $/million-token
// rates to estimate cost. Estimates only — the provider's own bill is the
// truth — but they're computed from the provider's own token counts, so
// they track real spend closely enough to enforce a "$10/month" cap.
//
// Also home to the provider allowlist and the acceptable-use agreement:
//   - ONLY Anthropic and OpenAI are allowed, for ANY scope. Their API
//     traffic is contractually excluded from model training. Providers that
//     can train on submitted data (Google AI Studio free tier is the
//     canonical example) are banned outright — there is no admin override,
//     because one quietly-pasted free key would leak document excerpts.
//   - Every user signs ONE general agreement before their first question:
//     plain rules about what never goes into a prompt, plus a paragraph
//     about what the workspace's provider does and doesn't protect.

import type { AiProviderId } from "./providerCall";

/** The ONLY providers any connection (org or personal) may use. */
export const ALLOWED_PROVIDERS: readonly AiProviderId[] = ["anthropic", "openai"];

export const PROVIDER_BLOCK_MESSAGE =
  "Only Anthropic (Claude) and OpenAI keys are allowed — their API traffic is never used for " +
  "model training. Providers that can train on what you send (like Google AI Studio keys) are " +
  "blocked entirely, for every scope. No exceptions.";

// ── Acceptable-use agreement ────────────────────────────────────────────────
// One general agreement, signed once per user per workspace (re-signed when
// the version bumps). Recorded server-side with name, date, and IP; the ask
// route refuses to answer for anyone who hasn't signed.
export const AGREEMENT_VERSION = "2026-07-v2";

const AGREEMENT_CORE =
  "Before you use the AI assistant, understand what it does: everything you type — and " +
  "excerpts from the indexed documents used to answer you — is sent to the workspace's AI " +
  "provider.\n\n" +
  "NEVER enter any of the following, in any form:\n" +
  "• passwords, login credentials, API keys, or access codes\n" +
  "• bank accounts, credit card numbers, or any financial account details\n" +
  "• social security numbers or personal identity information\n" +
  "• anything you wouldn't put in a company document\n\n" +
  "This is a work tool for questions about work documents. Use it for that.";

const PROVIDER_AGREEMENT_NOTES: Partial<Record<AiProviderId, string>> = {
  anthropic:
    "This workspace runs on Claude (Anthropic). Anthropic does not train models on API " +
    "traffic, so your questions and document excerpts stay out of their training data. That " +
    "protects the company — it is not a reason to get careless. The rules above still apply " +
    "to every prompt.",
  openai:
    "This workspace runs on OpenAI. OpenAI does not train models on API traffic, so your " +
    "questions and document excerpts stay out of their training data. That protects the " +
    "company — it is not a reason to get careless. The rules above still apply to every prompt.",
};

/** The full agreement text a user signs, flavored for the provider that
 *  will actually receive their prompts. */
export function buildAgreementText(provider?: string): string {
  const note = PROVIDER_AGREEMENT_NOTES[provider as AiProviderId];
  return note ? `${AGREEMENT_CORE}\n\n${note}` : AGREEMENT_CORE;
}

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
  // Embeddings. Priced explicitly because the frontier-model fallback would
  // charge 250× the real rate and eat a user's monthly cap for a job that
  // actually costs cents. Output tokens don't exist for this model.
  ["text-embedding-3-small", 0.02, 0],
  ["text-embedding-3-large", 0.13, 0],
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
