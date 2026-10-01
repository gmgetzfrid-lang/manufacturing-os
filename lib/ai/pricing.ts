// lib/ai/pricing.ts — pure, isomorphic (no server deps, no fetch).
//
// The in-app price table behind the monthly spend caps. Providers return
// exact token counts on every response; we multiply by these $/million-token
// rates to estimate cost. Estimates only — the provider's own bill is the
// truth — but they're computed from the provider's own token counts, so
// they track real spend closely enough to enforce a "$10/month" cap.
//
// Also home to the provider allowlists and the acceptable-use agreement:
//   - TWO lists, one per kind of key (GOV-6). A CHAT key may only be
//     Anthropic or OpenAI (ALLOWED_PROVIDERS); an EMBEDDINGS key may only be
//     Voyage AI or OpenAI (ALLOWED_EMBEDDING_PROVIDERS). Every listed
//     provider's API traffic is excluded from model training. Providers that
//     can train on submitted data (Google AI Studio free tier is the
//     canonical example) are banned outright, for every scope — there is no
//     admin override, because one quietly-pasted free key would leak
//     document excerpts.
//   - Every user signs ONE general agreement before their first AI call: plain
//     rules about what never goes into a prompt, every vendor that can
//     receive document text (both lists), and a paragraph about what the
//     member's own providers do and don't protect.

import type { AiProviderId } from "./providerCall";
import type { EmbeddingProviderId } from "./embeddings";

/** The ONLY providers a CHAT key (org or personal) may use. */
export const ALLOWED_PROVIDERS: readonly AiProviderId[] = ["anthropic", "openai"];

/** GOV-6: the ONLY providers an EMBEDDINGS key may use — the second of the
 *  two lists. Embeddings are a separate service (Anthropic makes no
 *  embeddings model): Voyage AI is the provider Anthropic recommends beside a
 *  Claude key, and like OpenAI it does not train on API traffic. Voyage
 *  receives the text of every page it embeds, so the signed agreement names
 *  it (buildAgreementText). Nothing outside this list is accepted for the
 *  embeddings key, at save, at test, or at spend (lib/ai/aiGates). */
export const ALLOWED_EMBEDDING_PROVIDERS: readonly EmbeddingProviderId[] = ["voyage", "openai"];

export const PROVIDER_BLOCK_MESSAGE =
  "Only Anthropic (Claude) and OpenAI keys are allowed — their API traffic is never used for " +
  "model training. Providers that can train on what you send (like Google AI Studio keys) are " +
  "blocked entirely, for every scope. No exceptions.";

// ── Acceptable-use agreement ────────────────────────────────────────────────
// One general agreement, signed once per user per workspace (re-signed when
// the version bumps). Recorded server-side with name, date, and IP; every
// route that calls a provider on a member's key refuses (428) until it is
// signed (lib/ai/aiGates). 2026-10-v3 (GOV-6): the text names Voyage AI —
// the embeddings vendor that receives the text of every indexed page —
// beside Anthropic and OpenAI, so every earlier acceptance is re-signed.
export const AGREEMENT_VERSION = "2026-10-v3";

const AGREEMENT_CORE =
  "Before you use the AI assistant, understand what it does: everything you type — and " +
  "excerpts from the indexed documents used to answer you — is sent to your AI provider " +
  "(Anthropic or OpenAI: whichever key you saved). If you add an embeddings key, the text of " +
  "every page in the libraries you index is also sent to your embeddings provider (Voyage AI " +
  "or OpenAI) to build the meaning index.\n\n" +
  "NEVER enter any of the following, in any form:\n" +
  "• passwords, login credentials, API keys, or access codes\n" +
  "• bank accounts, credit card numbers, or any financial account details\n" +
  "• social security numbers or personal identity information\n" +
  "• anything you wouldn't put in a company document\n\n" +
  "This is a work tool for questions about work documents. Use it for that.";

const PROVIDER_AGREEMENT_NOTES: Partial<Record<AiProviderId | EmbeddingProviderId, string>> = {
  anthropic:
    "This workspace runs on Claude (Anthropic). Anthropic does not train models on API " +
    "traffic, so your questions and document excerpts stay out of their training data. That " +
    "protects the company — it is not a reason to get careless. The rules above still apply " +
    "to every prompt.",
  openai:
    "This workspace runs on OpenAI. OpenAI does not train models on API traffic, so your " +
    "questions and document excerpts stay out of their training data. That protects the " +
    "company — it is not a reason to get careless. The rules above still apply to every prompt.",
  voyage:
    "Your meaning index is built by Voyage AI: the text of every page you index is sent to " +
    "Voyage to be turned into search vectors. Voyage does not train models on API traffic, so " +
    "that text stays out of their training data. The rules above still apply to everything you " +
    "index.",
};

/** The full agreement text a user signs: the core (which names every vendor
 *  either allowlist admits), flavored for the providers that will actually
 *  receive this member's text — the chat key's, and the embeddings key's
 *  when it is a different company. */
export function buildAgreementText(provider?: string, embeddingProvider?: string): string {
  const notes: string[] = [];
  for (const p of [provider, embeddingProvider]) {
    const note = PROVIDER_AGREEMENT_NOTES[p as AiProviderId | EmbeddingProviderId];
    if (note && !notes.includes(note)) notes.push(note);
  }
  return [AGREEMENT_CORE, ...notes].join("\n\n");
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
  // actually costs cents. Output tokens don't exist for these models.
  ["text-embedding-3-small", 0.02, 0],
  ["text-embedding-3-large", 0.13, 0],
  // Voyage AI — the three models the embeddings picker offers, at Voyage's
  // published list price per million tokens (docs.voyageai.com/docs/pricing,
  // read 2026-10-01; GOV-6). Voyage's free allowance is ignored on purpose:
  // the cap never assumes a call was free. Any other Voyage model falls to
  // the conservative family row (above every published text-model rate).
  ["voyage-3.5-lite", 0.02, 0],
  ["voyage-3.5", 0.06, 0],
  ["voyage-3-large", 0.18, 0],
  ["voyage-", 0.20, 0],
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

// ── Worst case of a pending call (GOV-13) ──────────────────────────────────
// The cap reserves what a call COULD cost before it is made. Input is
// estimated high on purpose — text at 3 characters a token (providers
// average about 4), every attached page image at 1,600 tokens (the most a
// provider charges for one image at the sizes this app sends) — and output
// at the call's full maxTokens. The reservation is replaced by the provider's
// own counts once the call returns.
export const UPPER_CHARS_PER_TOKEN = 3;
export const UPPER_TOKENS_PER_IMAGE = 1600;

export function worstCaseCostUsd(model: string, call: { inputChars: number; images?: number; maxTokens: number }): number {
  const inputTokens = Math.ceil(Math.max(0, call.inputChars) / UPPER_CHARS_PER_TOKEN)
    + Math.max(0, call.images ?? 0) * UPPER_TOKENS_PER_IMAGE;
  return estimateCostUsd(model, { inputTokens, outputTokens: Math.max(0, call.maxTokens) });
}
