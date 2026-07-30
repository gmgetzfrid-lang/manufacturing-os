// lib/costs.ts — COST CONTROL data layer.
//
// The audit's verdict was "there is no cost control system" — four orphan
// tables, zero code. This is the system: parties (contractors/vendors with
// contract values), cost accounts (budgets, optionally pinned to a
// schedule milestone for earned value), and entries (commitments,
// actuals, adjustments). The rollup is a pure function so the math is
// unit-tested: budget vs committed vs actual per account and for the
// project, plus CPI — earned value over actual cost — which finally gives
// the schedule dashboard's SPI its missing partner.
//
// Writes are controller-only (RLS, 20260906) and every mutation lands in
// audit_logs as a COST_* action. Money never moves silently.

import { supabase } from "@/lib/supabase";

export type CostEntryType = "commitment" | "actual" | "adjustment";

export interface CostParty {
  id: string;
  projectId: string | null;
  name: string;
  kind: string | null;       // contractor / vendor / internal
  trade: string | null;
  defaultRate: number | null;
  contractValue: number | null;
  contactName: string | null;
  contactEmail: string | null;
  status: "active" | "inactive";
}

export interface CostAccount {
  id: string;
  projectId: string | null;
  code: string | null;
  name: string;
  costType: string | null;   // labor / material / equipment / subcontract / other
  budget: number;
  currency: string | null;
  partyId: string | null;
  wbsMilestoneId: string | null;
  status: "active" | "closed";
}

export interface CostEntry {
  id: string;
  costAccountId: string | null;
  projectId: string | null;
  partyId: string | null;
  entryType: CostEntryType;
  amount: number;
  entryDate: string | null;
  description: string | null;
  reference: string | null;
  status: "posted" | "void";
  createdByName?: string | null;
  createdAt?: string | null;
}

export interface Actor { uid: string; email: string | null; role?: string | null }

// ── mapping ─────────────────────────────────────────────────────────────

function mapParty(r: Record<string, unknown>): CostParty {
  return {
    id: String(r.id),
    projectId: (r.project_id as string | null) ?? null,
    name: String(r.name ?? ""),
    kind: (r.kind as string | null) ?? null,
    trade: (r.trade as string | null) ?? null,
    defaultRate: r.default_rate == null ? null : Number(r.default_rate),
    contractValue: r.contract_value == null ? null : Number(r.contract_value),
    contactName: (r.contact_name as string | null) ?? null,
    contactEmail: (r.contact_email as string | null) ?? null,
    status: (r.status as CostParty["status"]) ?? "active",
  };
}

function mapAccount(r: Record<string, unknown>): CostAccount {
  return {
    id: String(r.id),
    projectId: (r.project_id as string | null) ?? null,
    code: (r.code as string | null) ?? null,
    name: String(r.name ?? ""),
    costType: (r.cost_type as string | null) ?? null,
    budget: Number(r.budget ?? 0),
    currency: (r.currency as string | null) ?? null,
    partyId: (r.party_id as string | null) ?? null,
    wbsMilestoneId: (r.wbs_milestone_id as string | null) ?? null,
    status: (r.status as CostAccount["status"]) ?? "active",
  };
}

function mapEntry(r: Record<string, unknown>): CostEntry {
  return {
    id: String(r.id),
    costAccountId: (r.cost_account_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    partyId: (r.party_id as string | null) ?? null,
    entryType: (r.entry_type as CostEntryType) ?? "actual",
    amount: Number(r.amount ?? 0),
    entryDate: (r.entry_date as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    status: (r.status as CostEntry["status"]) ?? "posted",
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

async function audit(action: string, orgId: string, resourceId: string, actor: Actor, details: Record<string, unknown>) {
  await supabase.from("audit_logs").insert({
    action, resource_type: "cost", resource_id: resourceId,
    org_id: orgId, user_id: actor.uid, user_email: actor.email,
    details,
  }).then(() => undefined, () => undefined);
}

// ── parties ─────────────────────────────────────────────────────────────

export async function listParties(orgId: string, projectId: string): Promise<CostParty[]> {
  const { data } = await supabase.from("project_parties").select("*")
    .eq("org_id", orgId).eq("project_id", projectId).order("name");
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapParty);
}

export async function saveParty(input: {
  orgId: string; projectId: string; id?: string | null;
  patch: Partial<Pick<CostParty, "name" | "kind" | "trade" | "defaultRate" | "contractValue" | "contactName" | "contactEmail" | "status">>;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const row: Record<string, unknown> = {};
  if (input.patch.name !== undefined) row.name = input.patch.name?.trim();
  if (input.patch.kind !== undefined) row.kind = input.patch.kind || null;
  if (input.patch.trade !== undefined) row.trade = input.patch.trade?.trim() || null;
  if (input.patch.defaultRate !== undefined) row.default_rate = input.patch.defaultRate;
  if (input.patch.contractValue !== undefined) row.contract_value = input.patch.contractValue;
  if (input.patch.contactName !== undefined) row.contact_name = input.patch.contactName?.trim() || null;
  if (input.patch.contactEmail !== undefined) row.contact_email = input.patch.contactEmail?.trim() || null;
  if (input.patch.status !== undefined) row.status = input.patch.status;
  if (input.id) {
    const { error } = await supabase.from("project_parties").update(row).eq("id", input.id);
    if (error) return { ok: false, error: error.message };
    await audit("COST_PARTY_UPDATED", input.orgId, input.id, input.actor, { patch: input.patch });
    return { ok: true };
  }
  if (!row.name) return { ok: false, error: "Party name is required." };
  const { data, error } = await supabase.from("project_parties")
    .insert({ org_id: input.orgId, project_id: input.projectId, ...row })
    .select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't create the party." };
  await audit("COST_PARTY_CREATED", input.orgId, String(data.id), input.actor, { name: row.name });
  return { ok: true };
}

// ── accounts ────────────────────────────────────────────────────────────

export async function listAccounts(orgId: string, projectId: string): Promise<CostAccount[]> {
  const { data } = await supabase.from("cost_accounts").select("*")
    .eq("org_id", orgId).eq("project_id", projectId).order("code", { ascending: true, nullsFirst: false });
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapAccount);
}

export async function saveAccount(input: {
  orgId: string; projectId: string; id?: string | null;
  patch: Partial<Pick<CostAccount, "code" | "name" | "costType" | "budget" | "currency" | "partyId" | "wbsMilestoneId" | "status">>;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const row: Record<string, unknown> = {};
  if (input.patch.code !== undefined) row.code = input.patch.code?.trim() || null;
  if (input.patch.name !== undefined) row.name = input.patch.name?.trim();
  if (input.patch.costType !== undefined) row.cost_type = input.patch.costType || null;
  if (input.patch.budget !== undefined) {
    if (!Number.isFinite(input.patch.budget) || (input.patch.budget as number) < 0) {
      return { ok: false, error: "Budget must be a non-negative number." };
    }
    row.budget = input.patch.budget;
  }
  if (input.patch.currency !== undefined) row.currency = input.patch.currency || null;
  if (input.patch.partyId !== undefined) row.party_id = input.patch.partyId || null;
  if (input.patch.wbsMilestoneId !== undefined) row.wbs_milestone_id = input.patch.wbsMilestoneId || null;
  if (input.patch.status !== undefined) row.status = input.patch.status;
  if (input.id) {
    const { data: before } = await supabase.from("cost_accounts").select("budget, name").eq("id", input.id).maybeSingle();
    const { error } = await supabase.from("cost_accounts").update(row).eq("id", input.id);
    if (error) return { ok: false, error: error.message };
    await audit("COST_ACCOUNT_UPDATED", input.orgId, input.id, input.actor, {
      before: before ?? null, patch: input.patch,
    });
    return { ok: true };
  }
  if (!row.name) return { ok: false, error: "Account name is required." };
  const { data, error } = await supabase.from("cost_accounts")
    .insert({ org_id: input.orgId, project_id: input.projectId, budget: 0, ...row })
    .select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't create the account." };
  await audit("COST_ACCOUNT_CREATED", input.orgId, String(data.id), input.actor, { name: row.name, code: row.code ?? null });
  return { ok: true };
}

// ── entries ─────────────────────────────────────────────────────────────

export async function listEntries(orgId: string, projectId: string): Promise<CostEntry[]> {
  const { data } = await supabase.from("cost_entries").select("*")
    .eq("org_id", orgId).eq("project_id", projectId)
    .order("entry_date", { ascending: false })
    .limit(2000);
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapEntry);
}

export async function addEntry(input: {
  orgId: string; projectId: string; costAccountId: string;
  entryType: CostEntryType; amount: number; entryDate: string;
  partyId?: string | null; description?: string | null; reference?: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    return { ok: false, error: "Amount must be a non-zero number." };
  }
  if (input.entryType !== "adjustment" && input.amount < 0) {
    return { ok: false, error: "Only adjustments can be negative — use an adjustment to credit an account." };
  }
  const { data, error } = await supabase.from("cost_entries").insert({
    org_id: input.orgId, project_id: input.projectId,
    cost_account_id: input.costAccountId,
    party_id: input.partyId || null,
    entry_type: input.entryType,
    amount: input.amount,
    entry_date: input.entryDate,
    description: input.description?.trim() || null,
    reference: input.reference?.trim() || null,
    status: "posted",
    created_by: input.actor.uid,
    created_by_name: input.actor.email?.split("@")[0] ?? null,
  }).select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't post the entry." };
  await audit("COST_ENTRY_POSTED", input.orgId, String(data.id), input.actor, {
    accountId: input.costAccountId, type: input.entryType, amount: input.amount, reference: input.reference ?? null,
  });
  return { ok: true };
}

/** Financial records are never deleted — voiding keeps the row with a
 *  strikethrough and removes it from every total. */
export async function voidEntry(input: {
  orgId: string; entryId: string; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { data: before } = await supabase.from("cost_entries")
    .select("amount, entry_type, cost_account_id").eq("id", input.entryId).maybeSingle();
  const { error } = await supabase.from("cost_entries").update({ status: "void" }).eq("id", input.entryId);
  if (error) return { ok: false, error: error.message };
  await audit("COST_ENTRY_VOIDED", input.orgId, input.entryId, input.actor, { before: before ?? null });
  return { ok: true };
}

// ── rollup (pure — unit-tested) ─────────────────────────────────────────

export interface AccountRollup {
  account: CostAccount;
  committed: number;
  actual: number;
  adjustments: number;
  /** actual + adjustments — what the account has really consumed. */
  spent: number;
  remaining: number;      // budget - spent
  overBudget: boolean;
  /** Earned value when the account is pinned to a milestone: budget × its %. */
  earnedValue: number | null;
}

export interface ProjectCostRollup {
  accounts: AccountRollup[];
  budget: number;
  committed: number;
  actual: number;
  spent: number;
  remaining: number;
  /** EV summed over accounts that have a milestone pin. */
  earnedValue: number;
  /** EV / actual-cost over the pinned accounts — > 1 means under-running. */
  cpi: number | null;
  currencies: string[];
}

export function computeCostRollup(
  accounts: CostAccount[],
  entries: CostEntry[],
  milestonePct: Map<string, number>, // milestoneId → 0..100
): ProjectCostRollup {
  const byAccount = new Map<string, { committed: number; actual: number; adjustments: number }>();
  for (const e of entries) {
    if (e.status === "void" || !e.costAccountId) continue;
    const agg = byAccount.get(e.costAccountId) ?? { committed: 0, actual: 0, adjustments: 0 };
    if (e.entryType === "commitment") agg.committed += e.amount;
    else if (e.entryType === "actual") agg.actual += e.amount;
    else agg.adjustments += e.amount;
    byAccount.set(e.costAccountId, agg);
  }

  let evTotal = 0, evActual = 0;
  const rolled: AccountRollup[] = accounts.map((a) => {
    const agg = byAccount.get(a.id) ?? { committed: 0, actual: 0, adjustments: 0 };
    const spent = agg.actual + agg.adjustments;
    const pct = a.wbsMilestoneId ? milestonePct.get(a.wbsMilestoneId) : undefined;
    const earnedValue = pct !== undefined ? a.budget * (Math.max(0, Math.min(100, pct)) / 100) : null;
    if (earnedValue !== null) { evTotal += earnedValue; evActual += spent; }
    return {
      account: a,
      committed: agg.committed,
      actual: agg.actual,
      adjustments: agg.adjustments,
      spent,
      remaining: a.budget - spent,
      overBudget: a.budget > 0 && spent > a.budget,
      earnedValue,
    };
  });

  const sum = (f: (r: AccountRollup) => number) => rolled.reduce((t, r) => t + f(r), 0);
  const currencies = [...new Set(accounts.map((a) => (a.currency ?? "USD").toUpperCase()))];
  return {
    accounts: rolled,
    budget: sum((r) => r.account.budget),
    committed: sum((r) => r.committed),
    actual: sum((r) => r.actual),
    spent: sum((r) => r.spent),
    remaining: sum((r) => r.account.budget) - sum((r) => r.spent),
    earnedValue: evTotal,
    cpi: evActual > 0 ? evTotal / evActual : null,
    currencies,
  };
}

/** % complete per milestone id for EV: explicit percent, else status. */
export function milestonePctIndex(
  milestones: Array<{ id?: string; percentComplete?: number | null; status?: string }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of milestones) {
    if (!m.id) continue;
    const pct = m.percentComplete != null
      ? Math.round(m.percentComplete)
      : (m.status === "completed" ? 100 : 0);
    out.set(m.id, pct);
  }
  return out;
}

export function fmtMoney(n: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency, maximumFractionDigits: Math.abs(n) >= 10000 ? 0 : 2,
    }).format(n);
  } catch {
    return `$${n.toLocaleString()}`;
  }
}
