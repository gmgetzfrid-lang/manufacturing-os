// lib/ai/aiGates.ts — SERVER-ONLY. THE gate stack in front of every provider
// call made on a member's key (GOV-11 / PR-12 / GOV-13).
//
// governedCall.ts's header named the failure: "Duplicating that stack per
// route is how one of them eventually forgets the cap." It happened — routes
// that re-implemented the stack inline forgot the agreement, and the cap
// never saw most of the spend. This is the stack, once, for every caller
// whatever it sends (text, page images, embeddings, several calls in a loop):
//
//   1. the member's OWN key — no workspace fallback (412 when missing)
//   2. the provider allowlist for that key's kind: ALLOWED_PROVIDERS for the
//      chat key, ALLOWED_EMBEDDING_PROVIDERS for the embeddings key (412)
//   3. the signed acceptable-use agreement at AGREEMENT_VERSION (428, with
//      the text to sign in `details`)
//   4. the monthly cap over EVERY op — locked at $0, refused when reached,
//      refused when the ledger cannot be read (402 / 503); a row recorded
//      without a cost counts at UNPRICED_CALL_USD, never as $0 and never as
//      a lock (GOV-4)
//   5. a reservation per call: pass.reserve(estimate) writes the call's worst
//      case BEFORE the call and refuses when it does not fit beside every
//      other in-flight call; reservation.settle(...) meters the real figures
//
// Every refusal is a GovernedCallError, so a route maps it onto its response
// with `e instanceof GovernedCallError ? bad(e.message, e.status) : …`.
//
// Wired here into lib/ai/governedCall.ts, app/api/ai/connection and
// app/api/templates/generate; flows/read (I-09), knowledge/locate (I-07),
// knowledge/embed (I-02) and the ask / orchestrator / codebook / ingest
// routes adopt it in their own files.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { AiProviderId } from "@/lib/ai/providerCall";
import { openAiKey } from "@/lib/ai/keyVault";
import {
  ALLOWED_PROVIDERS, ALLOWED_EMBEDDING_PROVIDERS, AGREEMENT_VERSION, buildAgreementText,
  worstCaseCostUsd, type AiUsage,
} from "@/lib/ai/pricing";
import { embeddingConnectionFrom } from "@/lib/ai/embeddings";
import {
  getMonthUsage, getCapUsd, capReached, capIsLocked, displayCapUsd, reserveWithinCap, settleUsage, releaseUsage,
  type MonthUsage,
} from "@/lib/ai/usageServer";
import { GovernedCallError } from "@/lib/ai/gateError";

export { GovernedCallError };

export type AiKeyKind = "chat" | "embedding";

export interface AiGateConnection {
  provider: string;
  model: string;
  /** The OPENED key — never logged, never returned to a client. */
  apiKey: string;
}

export interface AiGateInput {
  orgId: string;
  userId: string;
  /** The meter line every reservation of this pass is written under. */
  op: string;
  /** Which of the member's keys the call spends. Default "chat". */
  key?: AiKeyKind;
  /** The agreement gate. Off ONLY for a key-liveness probe that sends no org
   *  content (the connection test, GOV-11 done-when 4). Default true. */
  requireAgreement?: boolean;
  /** Gate a key the caller supplies (a key being tested before it is saved)
   *  instead of the member's saved one. The allowlist still applies. */
  connection?: AiGateConnection;
  /** ORCH-7: refuse (429) a call when this many of the member's calls for
   *  the same op are already in flight. */
  maxInFlight?: number;
}

export interface AiCallEstimate {
  /** Characters of system + user text the call sends. */
  inputChars: number;
  /** Page images attached. */
  images?: number;
  /** The call's output ceiling (0 for embeddings). */
  maxTokens: number;
  /** Price at this model instead of the connection's (a vision tier). */
  model?: string;
}

export interface AiReservation {
  id: string;
  reservedUsd: number;
  /** Meter the call's real figures. Never throws. */
  settle(result: { usage: AiUsage; ok: boolean; model?: string }): Promise<void>;
  /** The call was not made after all. Never throws. */
  release(): Promise<void>;
}

export interface AiGatePass {
  connection: AiGateConnection;
  /** The applicable cap (LOCKED_CAP_USD when locked — use displayCapUsd). */
  capUsd: number;
  /** The month as it stood when the gate passed. */
  month: MonthUsage;
  /** Reserve ONE pending call's worst case; throws GovernedCallError (402 /
   *  429 / 503) when it does not fit under the cap. */
  reserve(estimate: AiCallEstimate): Promise<AiReservation>;
}

export const NO_KEY_MESSAGE = "Add your Claude or OpenAI key in AI settings first — AI features run on your own key.";
export const NO_EMBEDDING_KEY_MESSAGE =
  "Add an embeddings key (Voyage AI or OpenAI) in AI settings first — the meaning index runs on your own key.";
export const AGREEMENT_MESSAGE =
  "Accept the AI acceptable-use agreement first (ask any question in Knowledge to be prompted).";

const columnMissing = (e: { code?: string; message: string } | null) =>
  !!e && (e.code === "42703" || /column/i.test(e.message));

async function loadConnection(input: AiGateInput, kind: AiKeyKind): Promise<{ connection: AiGateConnection; chatProvider?: string }> {
  if (input.connection) {
    const allowed = kind === "chat"
      ? (ALLOWED_PROVIDERS as readonly string[]).includes(input.connection.provider)
      : (ALLOWED_EMBEDDING_PROVIDERS as readonly string[]).includes(input.connection.provider);
    if (!allowed) throw new GovernedCallError(kind === "chat" ? NO_KEY_MESSAGE : NO_EMBEDDING_KEY_MESSAGE, 412);
    return { connection: input.connection };
  }
  if (kind === "chat") {
    const { data: conn } = await supabaseAdmin
      .from("ai_connections").select("provider, model, api_key")
      .eq("org_id", input.orgId).eq("user_id", input.userId).maybeSingle();
    if (!conn || !ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId)) {
      throw new GovernedCallError(NO_KEY_MESSAGE, 412);
    }
    return {
      connection: { provider: String(conn.provider), model: String(conn.model), apiKey: openAiKey(String(conn.api_key)) },
      chatProvider: String(conn.provider),
    };
  }
  const { data: row, error } = await supabaseAdmin
    .from("ai_connections").select("provider, api_key, embedding_provider, embedding_model, embedding_api_key")
    .eq("org_id", input.orgId).eq("user_id", input.userId).maybeSingle();
  if (columnMissing(error)) {
    throw new GovernedCallError("Meaning-based search needs migration 20260930 — run it in Supabase, then try again.", 412);
  }
  const r = row as Record<string, string | null> | null;
  const emb = r ? embeddingConnectionFrom({
    provider: r.provider, api_key: r.api_key ? openAiKey(r.api_key) : null,
    embedding_provider: r.embedding_provider, embedding_model: r.embedding_model,
    embedding_api_key: r.embedding_api_key ? openAiKey(r.embedding_api_key) : null,
  }) : null;
  if (!emb || !(ALLOWED_EMBEDDING_PROVIDERS as readonly string[]).includes(emb.provider)) {
    throw new GovernedCallError(NO_EMBEDDING_KEY_MESSAGE, 412);
  }
  return { connection: { provider: emb.provider, model: emb.model, apiKey: emb.apiKey }, chatProvider: r?.provider ?? undefined };
}

async function assertAgreement(input: AiGateInput, chatProvider: string | undefined, kind: AiKeyKind, provider: string) {
  const { data: agree, error: agreeError } = await supabaseAdmin
    .from("ai_key_agreements").select("id")
    .eq("org_id", input.orgId).eq("user_id", input.userId)
    .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION).limit(1);
  // A pre-migration database (no table) cannot record an acceptance at all.
  const tableMissing = !!agreeError && (agreeError.code === "42P01" || /does not exist/i.test(agreeError.message));
  if (tableMissing || (agree ?? []).length > 0) return;
  throw new GovernedCallError(AGREEMENT_MESSAGE, 428, {
    agreementRequired: true,
    agreementText: buildAgreementText(kind === "chat" ? provider : chatProvider, kind === "embedding" ? provider : undefined),
    agreementVersion: AGREEMENT_VERSION,
  });
}

/** Run gates 1–4 for one member and one op. Throws GovernedCallError on the
 *  first refusal; returns the pass whose reserve() is gate 5, per call. */
export async function assertAiGates(input: AiGateInput): Promise<AiGatePass> {
  const kind: AiKeyKind = input.key ?? "chat";
  const { connection, chatProvider } = await loadConnection(input, kind);

  if (input.requireAgreement !== false) {
    await assertAgreement(input, chatProvider, kind, connection.provider);
  }

  // A read error throws AiUsageUnavailableError (503). Rows recorded
  // without a cost are already inside spentUsd at the conservative figure.
  const [month, capUsd] = await Promise.all([
    getMonthUsage(input.orgId, input.userId), getCapUsd(input.orgId, input.userId),
  ]);
  if (capReached(month.spentUsd, capUsd)) {
    throw new GovernedCallError(
      capIsLocked(capUsd)
        ? "Your monthly AI cap is set to $0, so AI is locked for you until someone who manages AI caps raises it."
        : `Monthly AI budget reached ($${month.spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}).`,
      402,
      { spentUsd: month.spentUsd, capUsd: displayCapUsd(capUsd), locked: capIsLocked(capUsd) },
    );
  }

  return {
    connection,
    capUsd,
    month,
    async reserve(estimate) {
      const model = estimate.model ?? connection.model;
      const r = await reserveWithinCap({
        orgId: input.orgId, userId: input.userId, op: input.op,
        provider: connection.provider, model,
        worstCaseUsd: worstCaseCostUsd(model, estimate),
        capUsd,
        maxInFlight: input.maxInFlight,
      });
      return {
        id: r.id,
        reservedUsd: r.reservedUsd,
        settle: (result) => settleUsage(r.id, { model: result.model ?? model, usage: result.usage, ok: result.ok }),
        release: () => releaseUsage(r.id),
      };
    },
  };
}
