// lib/ai/usageServer.ts — SERVER-ONLY (imports the service-role client).
//
// The month ledger behind the AI spend caps. ai_usage_events rows carry
// exact provider token counts + an estimated cost; these helpers roll them
// up per user per calendar month and resolve the applicable cap
// (per-user override → org default row → $10 hard default).
//
// Cap enforcement lives in the ask route and runs BEFORE any provider call,
// so a capped user costs zero. All reads are service-role: usage rows and
// limit rows are not client-readable (RLS, zero policies).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { estimateCostUsd, type AiUsage } from "@/lib/ai/pricing";

export const DEFAULT_MONTHLY_CAP_USD = 10;

/** First instant of the current UTC month — the ledger boundary. */
export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface MonthUsage {
  spentUsd: number;
  inputTokens: number;
  outputTokens: number;
  asks: number;
  avgPromptTokens: number;
}

const EMPTY_USAGE: MonthUsage = {
  spentUsd: 0, inputTokens: 0, outputTokens: 0, asks: 0, avgPromptTokens: 0,
};

type UsageRow = {
  user_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  est_cost_usd: number | string | null;
  ok: boolean | null;
};

function rollup(rows: UsageRow[]): MonthUsage {
  const out = { ...EMPTY_USAGE };
  for (const r of rows) {
    out.spentUsd += Number(r.est_cost_usd ?? 0) || 0;
    out.inputTokens += r.input_tokens ?? 0;
    out.outputTokens += r.output_tokens ?? 0;
    if (r.ok !== false) out.asks += 1;
  }
  out.avgPromptTokens = out.asks > 0 ? Math.round(out.inputTokens / out.asks) : 0;
  out.spentUsd = Math.round(out.spentUsd * 10000) / 10000;
  return out;
}

/** One user's current-month usage. Missing token columns (pre-migration DB)
 *  degrade to a zero ledger rather than erroring. */
export async function getMonthUsage(orgId: string, userId: string): Promise<MonthUsage> {
  const { data, error } = await supabaseAdmin
    .from("ai_usage_events")
    .select("user_id, input_tokens, output_tokens, est_cost_usd, ok")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("op", "knowledgeAsk")
    .gte("created_at", monthStartIso());
  if (error) return EMPTY_USAGE;
  return rollup((data ?? []) as UsageRow[]);
}

/** Whole-org current-month usage, keyed by user_id (controllers' team view). */
export async function getMonthUsageByUser(orgId: string): Promise<Map<string, MonthUsage>> {
  const { data, error } = await supabaseAdmin
    .from("ai_usage_events")
    .select("user_id, input_tokens, output_tokens, est_cost_usd, ok")
    .eq("org_id", orgId)
    .eq("op", "knowledgeAsk")
    .gte("created_at", monthStartIso());
  if (error) return new Map();
  const byUser = new Map<string, UsageRow[]>();
  for (const r of (data ?? []) as UsageRow[]) {
    if (!r.user_id) continue;
    const list = byUser.get(r.user_id) ?? [];
    list.push(r);
    byUser.set(r.user_id, list);
  }
  return new Map([...byUser].map(([uid, rows]) => [uid, rollup(rows)]));
}

/** The cap that applies to this user: per-user override → org default → $10.
 *  A missing ai_usage_limits table (pre-migration) resolves to the default. */
export async function getCapUsd(orgId: string, userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("ai_usage_limits")
    .select("user_id, monthly_cap_usd")
    .eq("org_id", orgId)
    .or(`user_id.is.null,user_id.eq.${userId}`);
  if (error || !data) return DEFAULT_MONTHLY_CAP_USD;
  const personal = data.find((r) => r.user_id === userId);
  const orgDefault = data.find((r) => r.user_id === null);
  const cap = Number((personal ?? orgDefault)?.monthly_cap_usd);
  return Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_MONTHLY_CAP_USD;
}

/** Write one ask's metering row. Token columns may not exist yet
 *  (pre-migration DB) — PGRST204 retries without them so metering never
 *  breaks an answer that already succeeded. */
export async function recordAskUsage(input: {
  orgId: string; userId: string; provider: string; model: string;
  usage: AiUsage; ok: boolean;
}): Promise<void> {
  const { orgId, userId, provider, model, usage, ok } = input;
  const base = { user_id: userId, org_id: orgId, op: "knowledgeAsk", provider, ok };
  const full = {
    ...base,
    model,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    est_cost_usd: estimateCostUsd(model, usage),
  };
  const { error } = await supabaseAdmin.from("ai_usage_events").insert(full);
  if (error && (error.code === "PGRST204" || /column/i.test(error.message))) {
    await supabaseAdmin.from("ai_usage_events").insert(base)
      .then(() => undefined, () => undefined);
  }
}
