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
//
// Round G (SAF-3 / COST-11): every UPDATE here is a CHECKED write — the
// affected row count is the real signal (PostgREST reports an RLS-filtered
// zero-row UPDATE as success), and the audit row is written only after a
// confirmed match. The list readers THROW on a failed read (REL-2) so a
// broken tab is never pixel-identical to an empty one.

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
  /** Known-companies registry link (project_parties.company_id). Carried so
   *  the award path can read the company's status by id (MON-12) — the
   *  picker that writes it from the Costs tab is COST-12's. */
  companyId: string | null;
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
  /** The paper this entry came from (cost_entries.source_document_id):
   *  the awarded quote or the posted invoice. Null for hand-posted rows. */
  sourceDocumentId: string | null;
  createdByName?: string | null;
  createdAt?: string | null;
}

export interface Actor { uid: string; email: string | null; role?: string | null }

/** REL-4: a numeric column enters the model as a finite number or 0 —
 *  never NaN (which Intl renders as the literal "$NaN"). */
function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** The message a zero-row checked write reports (SAF-3): the two causes
 *  are indistinguishable from the client, so both are named. */
export const NO_ROW_MATCHED =
  "You do not have permission to change this record, or someone else changed it first — refresh to see the latest.";

// ── mapping ─────────────────────────────────────────────────────────────

function mapParty(r: Record<string, unknown>): CostParty {
  return {
    id: String(r.id),
    projectId: (r.project_id as string | null) ?? null,
    name: String(r.name ?? ""),
    kind: (r.kind as string | null) ?? null,
    trade: (r.trade as string | null) ?? null,
    defaultRate: r.default_rate == null ? null : num(r.default_rate),
    contractValue: r.contract_value == null ? null : num(r.contract_value),
    contactName: (r.contact_name as string | null) ?? null,
    contactEmail: (r.contact_email as string | null) ?? null,
    status: (r.status as CostParty["status"]) ?? "active",
    companyId: (r.company_id as string | null) ?? null,
  };
}

function mapAccount(r: Record<string, unknown>): CostAccount {
  return {
    id: String(r.id),
    projectId: (r.project_id as string | null) ?? null,
    code: (r.code as string | null) ?? null,
    name: String(r.name ?? ""),
    costType: (r.cost_type as string | null) ?? null,
    budget: num(r.budget),
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
    amount: num(r.amount),
    entryDate: (r.entry_date as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    status: (r.status as CostEntry["status"]) ?? "posted",
    sourceDocumentId: (r.source_document_id as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

/** Best-effort audit row. COST-11 dw4: a failed insert is LOGGED, never
 *  silently discarded (the audit-logger finding in roles-and-permissions —
 *  the row is evidence, and an evidence write that vanishes is a defect
 *  someone must be able to see in the console). */
async function audit(action: string, orgId: string, resourceId: string, actor: Actor, details: Record<string, unknown>) {
  try {
    const { error } = await supabase.from("audit_logs").insert({
      action, resource_type: "cost", resource_id: resourceId,
      org_id: orgId, user_id: actor.uid, user_email: actor.email,
      details,
    });
    if (error) console.warn(`[costs] audit row ${action} for ${resourceId} not written: ${error.message}`);
  } catch (e) {
    console.warn(`[costs] audit row ${action} for ${resourceId} threw: ${(e as Error).message}`);
  }
}

// ── parties ─────────────────────────────────────────────────────────────

export async function listParties(orgId: string, projectId: string): Promise<CostParty[]> {
  const { data, error } = await supabase.from("project_parties").select("*")
    .eq("org_id", orgId).eq("project_id", projectId).order("name");
  if (error) throw new Error(`Couldn't load contractors & vendors: ${error.message}`);
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapParty);
}

export async function saveParty(input: {
  orgId: string; projectId: string; id?: string | null;
  patch: Partial<Pick<CostParty, "name" | "kind" | "trade" | "defaultRate" | "contractValue" | "contactName" | "contactEmail" | "status" | "companyId">>;
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
  if (input.patch.companyId !== undefined) row.company_id = input.patch.companyId || null;
  if (input.id) {
    const { data: hit, error } = await supabase.from("project_parties").update(row).eq("id", input.id).select("id");
    if (error) return { ok: false, error: error.message };
    if (!hit || hit.length === 0) return { ok: false, error: NO_ROW_MATCHED };
    await audit("COST_PARTY_UPDATED", input.orgId, input.id, input.actor, { patch: input.patch });
    return { ok: true };
  }
  if (!row.name) return { ok: false, error: "Party name is required." };
  const { data, error } = await supabase.from("project_parties")
    .insert({ org_id: input.orgId, project_id: input.projectId, created_by: input.actor.uid, ...row })
    .select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't create the party." };
  await audit("COST_PARTY_CREATED", input.orgId, String(data.id), input.actor, { name: row.name });
  return { ok: true };
}

// ── accounts ────────────────────────────────────────────────────────────

export async function listAccounts(orgId: string, projectId: string): Promise<CostAccount[]> {
  const { data, error } = await supabase.from("cost_accounts").select("*")
    .eq("org_id", orgId).eq("project_id", projectId).order("code", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`Couldn't load cost accounts: ${error.message}`);
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
    const { data: hit, error } = await supabase.from("cost_accounts").update(row).eq("id", input.id).select("id");
    if (error) return { ok: false, error: error.message };
    if (!hit || hit.length === 0) return { ok: false, error: NO_ROW_MATCHED };
    await audit("COST_ACCOUNT_UPDATED", input.orgId, input.id, input.actor, {
      before: before ?? null, patch: input.patch,
    });
    return { ok: true };
  }
  if (!row.name) return { ok: false, error: "Account name is required." };
  const { data, error } = await supabase.from("cost_accounts")
    .insert({ org_id: input.orgId, project_id: input.projectId, budget: 0, created_by: input.actor.uid, ...row })
    .select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't create the account." };
  await audit("COST_ACCOUNT_CREATED", input.orgId, String(data.id), input.actor, { name: row.name, code: row.code ?? null });
  return { ok: true };
}

// ── entries ─────────────────────────────────────────────────────────────

export async function listEntries(orgId: string, projectId: string): Promise<CostEntry[]> {
  const { data, error } = await supabase.from("cost_entries").select("*")
    .eq("org_id", orgId).eq("project_id", projectId)
    .order("entry_date", { ascending: false })
    .limit(2000);
  if (error) throw new Error(`Couldn't load cost entries: ${error.message}`);
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapEntry);
}

export async function addEntry(input: {
  orgId: string; projectId: string; costAccountId: string;
  entryType: CostEntryType; amount: number; entryDate: string;
  partyId?: string | null; description?: string | null; reference?: string | null;
  /** COST-9: the cost document (quote / invoice) this entry came from. */
  sourceDocumentId?: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string; entryId?: string }> {
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    return { ok: false, error: "Amount must be a non-zero number." };
  }
  // Actuals record money that really left — never negative. Commitments may
  // be signed (a change-order CREDIT reduces the promised side, the same
  // side the original award lives on) and adjustments are signed by nature.
  if (input.entryType === "actual" && input.amount < 0) {
    return { ok: false, error: "Actuals can't be negative — post a credit as an adjustment (or a commitment credit for descoped awards)." };
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
    source_document_id: input.sourceDocumentId || null,
    status: "posted",
    created_by: input.actor.uid,
    created_by_name: input.actor.email?.split("@")[0] ?? null,
  }).select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't post the entry." };
  await audit("COST_ENTRY_POSTED", input.orgId, String(data.id), input.actor, {
    accountId: input.costAccountId, type: input.entryType, amount: input.amount, reference: input.reference ?? null,
    sourceDocumentId: input.sourceDocumentId ?? null,
  });
  return { ok: true, entryId: String(data.id) };
}

/** Financial records are never deleted — voiding keeps the row with a
 *  strikethrough and removes it from every total. The database holds the
 *  same line (COST-10): `enforce_cost_ledger_delete_guard` (20261093) is a
 *  BEFORE DELETE trigger on cost_entries / change_orders / cost_documents /
 *  cost_accounts that refuses every DELETE except an audited purge —
 *  `app.record_purge = 'project:<id>'` set by the project-purge RPC, or the
 *  service role, which the trigger audits first. */
export async function voidEntry(input: {
  orgId: string; entryId: string; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { data: before } = await supabase.from("cost_entries")
    .select("amount, entry_type, cost_account_id").eq("id", input.entryId).maybeSingle();
  // Checked write (SAF-3): the predicate carries the status so a second
  // void is a zero-row match, and a zero-row match writes NO audit row.
  const { data: hit, error } = await supabase.from("cost_entries").update({ status: "void" })
    .eq("id", input.entryId).eq("status", "posted").select("id");
  if (error) return { ok: false, error: error.message };
  if (!hit || hit.length === 0) return { ok: false, error: NO_ROW_MATCHED };
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
  /** COST-2: commitments not yet drawn down by actuals. A commitment counts
   *  until the actuals invoiced against it (matched by party) reach its
   *  amount — an awarded subcontract with no invoices is fully open. */
  openCommitments: number;
  /** COST-2: spent + open commitments — the money that is spoken for. */
  exposure: number;
  /** COST-4: approved change orders posted to this account (signed). */
  approvedChanges: number;
  /** COST-4: budget + approvedChanges. The original `account.budget` stays
   *  the visible baseline; every derived figure below uses this. */
  revisedBudget: number;
  /** revisedBudget − exposure: what is still UNCOMMITTED (MON-4 / COST-2). */
  remaining: number;
  /** revisedBudget − spent: the actuals-only figure, secondary. */
  remainingActualsOnly: number;
  /** Trips on EXPOSURE, not on spent alone. */
  overBudget: boolean;
  /** Earned value when the account is pinned to a milestone: revisedBudget × its %. */
  earnedValue: number | null;
}

export interface ProjectCostRollup {
  accounts: AccountRollup[];
  budget: number;
  approvedChanges: number;
  revisedBudget: number;
  committed: number;
  actual: number;
  spent: number;
  openCommitments: number;
  exposure: number;
  /** revisedBudget − exposure (uncommitted). */
  remaining: number;
  /** revisedBudget − spent (actuals-only, secondary). */
  remainingActualsOnly: number;
  /** EV summed over accounts that have a milestone pin. */
  earnedValue: number;
  /** EV / actual-cost over the pinned accounts — > 1 means under-running. */
  cpi: number | null;
  /** COST-1: the revised budget and spend of the PINNED accounts — the only
   *  portion `cpi` measures. A CPI-based forecast applies to this subset. */
  pinnedBudget: number;
  pinnedSpent: number;
  currencies: string[];
}

export function computeCostRollup(
  accounts: CostAccount[],
  entries: CostEntry[],
  milestonePct: Map<string, number>, // milestoneId → 0..100
  /** COST-4: approved change-order totals by cost_account_id (signed). */
  approvedChanges: Map<string, number> = new Map(),
): ProjectCostRollup {
  type Agg = { committed: number; actual: number; adjustments: number; byParty: Map<string, { committed: number; actual: number }> };
  const byAccount = new Map<string, Agg>();
  for (const e of entries) {
    if (e.status === "void" || !e.costAccountId) continue;
    const agg = byAccount.get(e.costAccountId) ?? { committed: 0, actual: 0, adjustments: 0, byParty: new Map() };
    const partyKey = e.partyId ?? "";
    const p = agg.byParty.get(partyKey) ?? { committed: 0, actual: 0 };
    if (e.entryType === "commitment") { agg.committed += e.amount; p.committed += e.amount; }
    else if (e.entryType === "actual") { agg.actual += e.amount; p.actual += e.amount; }
    else agg.adjustments += e.amount;
    agg.byParty.set(partyKey, p);
    byAccount.set(e.costAccountId, agg);
  }

  let evTotal = 0, evActual = 0, pinnedBudget = 0, pinnedSpent = 0;
  const rolled: AccountRollup[] = accounts.map((a) => {
    const agg = byAccount.get(a.id) ?? { committed: 0, actual: 0, adjustments: 0, byParty: new Map() };
    const spent = agg.actual + agg.adjustments;
    // Open commitment per party: what was promised minus what that party has
    // since invoiced, never below zero (a credit CO can leave it negative).
    let openCommitments = 0;
    for (const p of agg.byParty.values()) openCommitments += Math.max(0, p.committed - p.actual);
    const exposure = spent + openCommitments;
    const changes = num(approvedChanges.get(a.id));
    const revisedBudget = a.budget + changes;
    const pct = a.wbsMilestoneId ? milestonePct.get(a.wbsMilestoneId) : undefined;
    const earnedValue = pct !== undefined ? revisedBudget * (Math.max(0, Math.min(100, pct)) / 100) : null;
    if (earnedValue !== null) { evTotal += earnedValue; evActual += spent; pinnedBudget += revisedBudget; pinnedSpent += spent; }
    return {
      account: a,
      committed: agg.committed,
      actual: agg.actual,
      adjustments: agg.adjustments,
      spent,
      openCommitments,
      exposure,
      approvedChanges: changes,
      revisedBudget,
      remaining: revisedBudget - exposure,
      remainingActualsOnly: revisedBudget - spent,
      overBudget: revisedBudget > 0 && exposure > revisedBudget,
      earnedValue,
    };
  });

  const sum = (f: (r: AccountRollup) => number) => rolled.reduce((t, r) => t + f(r), 0);
  const currencies = [...new Set(accounts.map((a) => (a.currency ?? "USD").toUpperCase()))];
  const revisedBudget = sum((r) => r.revisedBudget);
  return {
    accounts: rolled,
    budget: sum((r) => r.account.budget),
    approvedChanges: sum((r) => r.approvedChanges),
    revisedBudget,
    committed: sum((r) => r.committed),
    actual: sum((r) => r.actual),
    spent: sum((r) => r.spent),
    openCommitments: sum((r) => r.openCommitments),
    exposure: sum((r) => r.exposure),
    remaining: revisedBudget - sum((r) => r.exposure),
    remainingActualsOnly: revisedBudget - sum((r) => r.spent),
    earnedValue: evTotal,
    cpi: evActual > 0 ? evTotal / evActual : null,
    pinnedBudget,
    pinnedSpent,
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

// PERF-10: one formatter per (currency, precision), built once. The tab
// formats hundreds of figures per render; Intl construction dominated.
const moneyFormatters = new Map<string, Intl.NumberFormat>();
function moneyFormatter(currency: string, digits: 0 | 2): Intl.NumberFormat {
  const key = `${currency}|${digits}`;
  let f = moneyFormatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: digits });
    moneyFormatters.set(key, f);
  }
  return f;
}

/** Money for humans. REL-4: a non-finite input renders an em-dash, never
 *  "$NaN" — the number that reached here is the defect, not the display. */
export function fmtMoney(n: number, currency = "USD"): string {
  if (!Number.isFinite(n)) return "—";
  try {
    return moneyFormatter(currency, Math.abs(n) >= 10000 ? 0 : 2).format(n);
  } catch {
    return `$${n.toLocaleString()}`;
  }
}
