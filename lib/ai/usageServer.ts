// lib/ai/usageServer.ts — SERVER-ONLY (imports the service-role client).
//
// The month ledger behind the AI spend caps. ai_usage_events rows carry
// exact provider token counts + an estimated cost; these helpers roll them
// up per user per calendar month and resolve the applicable cap
// (per-user override → org default row → $10 hard default).
//
// ONE cap, every op (GOV-1 / GOV-5 / ORCH-5 / SEM-2): the rollup sums EVERY
// row the member's calls wrote — questions, vision indexing, the meaning
// index, the assistant, locate, flow reading, template drafting, imports,
// connection tests — so whatever a feature meters under its own op line is
// spend the same cap sees. The op is kept for the per-feature breakdown.
//
// FAIL CLOSED (GOV-4): a ledger or cap read that errors throws
// AiUsageUnavailableError (503) instead of reading as $0 spent — a gate that
// cannot read the spend refuses. A row written without a cost counts at
// UNPRICED_CALL_USD — over-counted, never $0, never a lock. A $0 cap LOCKS
// (GOV-3): see LOCKED_CAP_USD.
//
// RESERVE, THEN CALL (GOV-13 / ORCH-7): reserveWithinCap writes the worst
// case of the pending call as a ledger row BEFORE the provider is called,
// re-reads the month with it in, and refuses (releasing the row) when it does
// not fit; settleUsage replaces the reservation with the real figures.
// Concurrent calls see each other's reservations, so two can never spend the
// same headroom. All reads are service-role: usage rows and limit rows are
// not client-readable (RLS, zero policies).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { estimateCostUsd, type AiUsage } from "@/lib/ai/pricing";
import { GovernedCallError } from "@/lib/ai/gateError";

export const DEFAULT_MONTHLY_CAP_USD = 10;

/** GOV-3: a cap of $0 LOCKS — no spend at all. getCapUsd returns it as the
 *  smallest positive number, never 0, and getMonthUsage never reads a locked
 *  member's month below it: every gate written `cap > 0 && spent >= cap`
 *  (the shape the routes that do not go through lib/ai/aiGates still carry)
 *  then refuses, where a 0 short-circuited the check and uncapped everything.
 *  capReached() — what aiGates and governedCall read — refuses it outright.
 *  It prints as "$0.00" through toFixed, and displayCapUsd maps it to 0. */
export const LOCKED_CAP_USD = Number.MIN_VALUE;

export const capIsLocked = (capUsd: number): boolean => capUsd <= LOCKED_CAP_USD;

/** The ONE cap predicate: a locked cap refuses everything; otherwise the
 *  month's spend (reservations included) has reached the cap. */
export function capReached(spentUsd: number, capUsd: number): boolean {
  return capIsLocked(capUsd) || spentUsd >= capUsd;
}

/** The figure a person is shown: 0 for a locked cap. */
export const displayCapUsd = (capUsd: number): number => (capIsLocked(capUsd) ? 0 : capUsd);

/** GOV-4: the spend could not be read (or cannot be proven), so the call is
 *  refused — 503, never "$0 spent". Routes that map GovernedCallError onto
 *  their response answer with this status and sentence. */
export class AiUsageUnavailableError extends GovernedCallError {
  constructor(detail: string) {
    super(`AI usage can't be read right now, so AI calls are refused until it can (${detail}).`, 503, { usageUnavailable: true });
    this.name = "AiUsageUnavailableError";
  }
}

/** GOV-4: what one metering row written WITHOUT a cost or token counts is
 *  counted at. recordAskUsage writes such a row only when its full insert is
 *  refused for a column — a database without 20260916's cost columns, or a
 *  PostgREST schema cache gone stale after an unrelated migration — so the
 *  call happened and its price is unknown. It is priced as a frontier-rate
 *  call (an unknown model prices as frontier) with a 120,000-token prompt and
 *  a 16,000-token reply: $1.00, deliberately above what one call, one vision
 *  batch or one assistant run costs at the app's own limits. The month is
 *  over-counted, never under — and the member keeps working: a hard refusal
 *  would lock every gated feature until the 1st over a row nobody in the app
 *  can clear (the table is service-role only). */
export const UNPRICED_CALL_USD = estimateCostUsd("", { inputTokens: 120_000, outputTokens: 16_000 });

/** First instant of the current UTC month — the ledger boundary. */
export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface OpUsage { spentUsd: number; calls: number }

export interface MonthUsage {
  /** Every op, settled calls plus in-flight reservations. */
  spentUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Knowledge questions that succeeded (the "questions" line). */
  asks: number;
  /** Every settled call that succeeded, any op. */
  calls: number;
  /** Average prompt size of a knowledge question. */
  avgPromptTokens: number;
  /** Worst-case cost of calls reserved but not yet settled (inside spentUsd). */
  reservedUsd: number;
  /** Rows that carry neither a cost nor token counts (written by
   *  recordAskUsage's fallback insert) — spend the ledger cannot price, each
   *  counted inside spentUsd at UNPRICED_CALL_USD (GOV-4). */
  unpricedCalls: number;
  /** Spend per op line — which feature spent the money. */
  byOp: Record<string, OpUsage>;
}

const emptyUsage = (): MonthUsage => ({
  spentUsd: 0, inputTokens: 0, outputTokens: 0, asks: 0, calls: 0, avgPromptTokens: 0,
  reservedUsd: 0, unpricedCalls: 0, byOp: {},
});

export type UsageRow = {
  id?: string | null;
  created_at?: string | null;
  user_id: string | null;
  op: string | null;
  model?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  est_cost_usd: number | string | null;
  ok: boolean | null;
};

/** A reservation is a row with a cost and no token counts yet: written by
 *  reserveWithinCap, replaced by settleUsage. */
export const isReservationRow = (r: Pick<UsageRow, "est_cost_usd" | "input_tokens" | "output_tokens">): boolean =>
  r.est_cost_usd !== null && r.est_cost_usd !== undefined && r.input_tokens === null && r.output_tokens === null;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Pure: one member's rows → their month. Every op counts toward spentUsd. */
export function rollupUsage(rows: UsageRow[]): MonthUsage {
  const out = emptyUsage();
  let askInput = 0;
  for (const r of rows) {
    const op = r.op || "unknown";
    const line = (out.byOp[op] ??= { spentUsd: 0, calls: 0 });
    if (isReservationRow(r)) {
      const reserved = Number(r.est_cost_usd) || 0;
      out.spentUsd += reserved;
      out.reservedUsd += reserved;
      line.spentUsd += reserved;
      continue;
    }
    let cost = 0;
    if (r.est_cost_usd !== null && r.est_cost_usd !== undefined) {
      cost = Number(r.est_cost_usd) || 0;
    } else if (r.input_tokens != null || r.output_tokens != null) {
      // Tokens without a cost: price them (an unknown model prices as frontier).
      cost = estimateCostUsd(r.model ?? "", { inputTokens: r.input_tokens ?? 0, outputTokens: r.output_tokens ?? 0 });
    } else if (r.ok !== false) {
      // GOV-4: a call whose price was never recorded — unknown spend,
      // counted at the conservative figure, never as $0.
      out.unpricedCalls += 1;
      cost = UNPRICED_CALL_USD;
    }
    out.spentUsd += cost;
    line.spentUsd += cost;
    out.inputTokens += r.input_tokens ?? 0;
    out.outputTokens += r.output_tokens ?? 0;
    if (r.ok !== false) {
      out.calls += 1;
      line.calls += 1;
      if (op === "knowledgeAsk") {
        out.asks += 1;
        askInput += r.input_tokens ?? 0;
      }
    }
  }
  out.avgPromptTokens = out.asks > 0 ? Math.round(askInput / out.asks) : 0;
  out.spentUsd = round4(out.spentUsd);
  out.reservedUsd = round4(out.reservedUsd);
  for (const line of Object.values(out.byOp)) line.spentUsd = round4(line.spentUsd);
  return out;
}

const USAGE_COLUMNS = "id, created_at, user_id, op, model, input_tokens, output_tokens, est_cost_usd, ok";
const PAGE = 1000;
/** 100k rows in one month for one org is past anything metered today; a
 *  ledger that size is reported as unreadable rather than summed partially. */
const MAX_PAGES = 100;

/** Every current-month row matching the filter, paged past PostgREST's row
 *  cap (a partial sum would read as headroom that does not exist). A page
 *  shorter than asked for is NOT taken as the last one — the project's
 *  max-rows setting may be below PAGE — so the read continues from where the
 *  rows end until it holds the exact count PostgREST reports, or a page
 *  comes back empty. */
async function readMonthRows(orgId: string, userId: string | null): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = supabaseAdmin
      .from("ai_usage_events")
      .select(USAGE_COLUMNS, { count: "exact" })
      .eq("org_id", orgId);
    if (userId !== null) q = q.eq("user_id", userId);
    const from = rows.length;
    const { data, error, count } = await q
      .gte("created_at", monthStartIso())
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new AiUsageUnavailableError(`couldn't read the usage ledger: ${error.message}`);
    const batch = (data ?? []) as UsageRow[];
    rows.push(...batch);
    if (batch.length === 0) return rows;
    if (typeof count === "number" && rows.length >= count) return rows;
  }
  throw new AiUsageUnavailableError(`the usage ledger holds more than ${PAGE * MAX_PAGES} rows this month`);
}

/** One user's current-month usage, every op. Throws AiUsageUnavailableError
 *  when the ledger (or the cap) cannot be read (GOV-4) — never a zero ledger.
 *  GOV-3: a LOCKED member's month never reads below LOCKED_CAP_USD (it prints
 *  as $0.00), so a gate shaped `cap > 0 && spent >= cap` refuses them at $0
 *  spent as well — no first call slips through before anything is metered. */
export async function getMonthUsage(orgId: string, userId: string): Promise<MonthUsage> {
  const [rows, capUsd] = await Promise.all([readMonthRows(orgId, userId), getCapUsd(orgId, userId)]);
  const month = rollupUsage(rows);
  if (capIsLocked(capUsd) && month.spentUsd < LOCKED_CAP_USD) month.spentUsd = LOCKED_CAP_USD;
  return month;
}

/** Whole-org current-month usage, keyed by user_id (controllers' team view),
 *  every op — so the team table matches the provider bill. Throws
 *  AiUsageUnavailableError on a failed read. */
export async function getMonthUsageByUser(orgId: string): Promise<Map<string, MonthUsage>> {
  const byUser = new Map<string, UsageRow[]>();
  for (const r of await readMonthRows(orgId, null)) {
    if (!r.user_id) continue;
    const list = byUser.get(r.user_id) ?? [];
    list.push(r);
    byUser.set(r.user_id, list);
  }
  return new Map([...byUser].map(([uid, rows]) => [uid, rollupUsage(rows)]));
}

const tableMissing = (e: { code?: string; message: string }) =>
  e.code === "42P01" || /does not exist/i.test(e.message);

/** The cap that applies to this user: per-user override → org default → $10.
 *  A stored $0 returns LOCKED_CAP_USD (GOV-3). Two bound filters — the user
 *  id is never spliced into a filter string (GOV-14). A missing
 *  ai_usage_limits table (pre-migration) resolves to the default; any other
 *  read error throws AiUsageUnavailableError — a cap that cannot be read
 *  must not quietly become $10 for someone an Admin locked. */
export async function getCapUsd(orgId: string, userId: string): Promise<number> {
  const [own, org] = await Promise.all([
    supabaseAdmin.from("ai_usage_limits").select("user_id, monthly_cap_usd")
      .eq("org_id", orgId).eq("user_id", userId).limit(1),
    supabaseAdmin.from("ai_usage_limits").select("user_id, monthly_cap_usd")
      .eq("org_id", orgId).is("user_id", null).limit(1),
  ]);
  for (const res of [own, org]) {
    if (res.error) {
      if (tableMissing(res.error)) return DEFAULT_MONTHLY_CAP_USD;
      throw new AiUsageUnavailableError(`couldn't read the monthly caps: ${res.error.message}`);
    }
  }
  const row = ((own.data ?? [])[0] ?? (org.data ?? [])[0]) as { monthly_cap_usd?: number | string | null } | undefined;
  const raw = row?.monthly_cap_usd;
  if (raw === null || raw === undefined) return DEFAULT_MONTHLY_CAP_USD;
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap < 0) return DEFAULT_MONTHLY_CAP_USD;
  return cap === 0 ? LOCKED_CAP_USD : cap;
}

/** Write one call's metering row. Token columns may not exist yet
 *  (pre-migration DB, or a stale schema cache) — PGRST204 retries without
 *  them so metering never breaks an answer that already succeeded; such a
 *  row carries no cost and is counted at UNPRICED_CALL_USD
 *  (MonthUsage.unpricedCalls), never as $0.
 *  The op names the feature; every op shares the same cap (GOV-1). */
export async function recordAskUsage(input: {
  orgId: string; userId: string; provider: string; model: string;
  usage: AiUsage; ok: boolean;
  /** The feature's meter line ("knowledgeVision", "flowRead", …); defaults
   *  to the ask meter. Every line counts against the one monthly cap. */
  op?: string;
}): Promise<void> {
  const { orgId, userId, provider, model, usage, ok } = input;
  const base = { user_id: userId, org_id: orgId, op: input.op ?? "knowledgeAsk", provider, ok };
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

// ── Reservations (GOV-13 / ORCH-7) ─────────────────────────────────────────

export interface UsageReservation {
  id: string;
  reservedUsd: number;
}

/** In-flight window for maxInFlight: a reservation older than this is a run
 *  that died without settling — still counted as spend (the provider may
 *  have billed it), no longer counted as running. */
export const IN_FLIGHT_WINDOW_MS = 10 * 60_000;

/** Pure: the decision for reservation `mine` among the month's rows. A
 *  reservation is judged against settled spend plus the reservations made
 *  BEFORE it (created_at, then id) — so of two racing calls the earlier
 *  proceeds when it fits and the later one sees it, and neither sees "room"
 *  the other already took. */
export function reservationVerdict(rows: UsageRow[], mine: { id: string; reservedUsd: number }, capUsd: number, opts: {
  op?: string; maxInFlight?: number; now?: number;
} = {}): { ok: true } | { ok: false; status: 402 | 429; spentBeforeUsd: number; message: string } {
  const me = rows.find((r) => r.id === mine.id);
  const myKey = me ? `${me.created_at ?? ""}|${me.id}` : null;
  // A reservation the read did not return (it always should) is judged
  // against EVERY other reservation — the conservative reading.
  const earlier = (r: UsageRow) => myKey === null || `${r.created_at ?? ""}|${r.id ?? ""}` < myKey;
  const counted = rows.filter((r) => r.id !== mine.id && (!isReservationRow(r) || earlier(r)));
  // Unpriced rows are inside spentUsd at UNPRICED_CALL_USD (GOV-4).
  const month = rollupUsage(counted);
  const spentBeforeUsd = month.spentUsd;
  if (capIsLocked(capUsd)) {
    return { ok: false, status: 402, spentBeforeUsd, message: "Your monthly AI cap is set to $0, so AI is locked for you until someone who manages AI caps raises it." };
  }
  if (spentBeforeUsd >= capUsd) {
    return { ok: false, status: 402, spentBeforeUsd, message: `Monthly AI budget reached ($${spentBeforeUsd.toFixed(2)} of $${capUsd.toFixed(2)}).` };
  }
  if (spentBeforeUsd + mine.reservedUsd > capUsd) {
    const left = Math.max(0, capUsd - spentBeforeUsd);
    return {
      ok: false, status: 402, spentBeforeUsd,
      message: `This call could cost up to $${mine.reservedUsd.toFixed(2)} and $${left.toFixed(2)} is left of your $${capUsd.toFixed(2)} monthly AI cap, so it was not made.`,
    };
  }
  if (opts.maxInFlight !== undefined && opts.op) {
    const now = opts.now ?? Date.now();
    const running = rows.filter((r) => r.id !== mine.id && r.op === opts.op && isReservationRow(r) && earlier(r)
      && now - Date.parse(r.created_at ?? "") < IN_FLIGHT_WINDOW_MS).length;
    if (running >= opts.maxInFlight) {
      return { ok: false, status: 429, spentBeforeUsd, message: `You already have ${running} of these running — wait for one to finish.` };
    }
  }
  return { ok: true };
}

/** Reserve the worst case of ONE pending call, then verify it fits under the
 *  cap with every other reservation in view. Refused → the reservation is
 *  released and a GovernedCallError (402 / 429 / 503) is thrown, before any
 *  provider call. */
export async function reserveWithinCap(input: {
  orgId: string; userId: string; op: string; provider: string; model: string;
  worstCaseUsd: number; capUsd: number;
  /** Refuse (429) when this many reservations for the same op are already in
   *  flight for this member — a per-user concurrency limit. */
  maxInFlight?: number;
}): Promise<UsageReservation> {
  if (capIsLocked(input.capUsd)) {
    throw new GovernedCallError("Your monthly AI cap is set to $0, so AI is locked for you until someone who manages AI caps raises it.", 402, { locked: true });
  }
  const reservedUsd = Math.max(0, Math.round(input.worstCaseUsd * 1_000_000) / 1_000_000);
  const { data, error } = await supabaseAdmin.from("ai_usage_events").insert({
    user_id: input.userId, org_id: input.orgId, op: input.op, provider: input.provider, model: input.model,
    ok: true, est_cost_usd: reservedUsd, input_tokens: null, output_tokens: null,
  }).select("id").single();
  const id = (data as { id?: string } | null)?.id;
  if (error || !id) {
    throw new AiUsageUnavailableError(`couldn't reserve this call in the usage ledger: ${error?.message ?? "no row returned"}`);
  }
  let rows: UsageRow[];
  try {
    rows = await readMonthRows(input.orgId, input.userId);
  } catch (e) {
    await releaseUsage(id);
    throw e;
  }
  const verdict = reservationVerdict(rows, { id, reservedUsd }, input.capUsd, { op: input.op, maxInFlight: input.maxInFlight });
  if (!verdict.ok) {
    await releaseUsage(id);
    throw new GovernedCallError(verdict.message, verdict.status, {
      spentUsd: verdict.spentBeforeUsd, capUsd: displayCapUsd(input.capUsd), reservedUsd,
    });
  }
  return { id, reservedUsd };
}

/** Replace a reservation with the call's real figures. Never throws:
 *  metering must not mask the call's own outcome. A settle that fails leaves
 *  the reservation's worst case standing — over-counted, never under. */
export async function settleUsage(id: string, input: { model: string; usage: AiUsage; ok: boolean }): Promise<void> {
  try {
    await supabaseAdmin.from("ai_usage_events").update({
      model: input.model,
      input_tokens: Math.max(0, input.usage.inputTokens),
      output_tokens: Math.max(0, input.usage.outputTokens),
      est_cost_usd: estimateCostUsd(input.model, input.usage),
      ok: input.ok,
    }).eq("id", id);
  } catch { /* the reservation stands */ }
}

/** Drop a reservation for a call that was never made. If the delete fails
 *  the row is zeroed instead, so a refused call never stays counted. */
export async function releaseUsage(id: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("ai_usage_events").delete().eq("id", id);
    if (!error) return;
  } catch { /* fall through */ }
  try {
    await supabaseAdmin.from("ai_usage_events").update({
      ok: false, input_tokens: 0, output_tokens: 0, est_cost_usd: 0,
    }).eq("id", id);
  } catch { /* nothing more to do */ }
}
