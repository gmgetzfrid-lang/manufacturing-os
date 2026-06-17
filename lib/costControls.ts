// lib/costControls.ts
//
// Multi-contractor cost controls — the Cost Breakdown Structure layer.
//
// The blended-rate model (lib/evm.ts) is the single-tier fallback. THIS is the
// scalable one: budgets live on Control Accounts (CBS = WBS phase × party × cost
// type), each fed by a ledger of commitments (POs) and actuals (invoices). EVM
// rolls up three ways — by control account, by party (OBS: per contractor /
// department), and by cost type — into a project total, every level a full
// earned-value picture.
//
// The rollup math is PURE and unit-tested (computeCostRollup). The Supabase CRUD
// around it is thin and follows the row-mapper convention used across lib/.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import { computeEvm, type EvmResult } from "@/lib/evm";
import { scheduledFraction } from "@/lib/evm";
import { buildProgressIndex, effectiveWeight } from "@/lib/scheduleProgress";
import type {
  Milestone, ProjectParty, CostAccount, CostEntry, CostDocument,
  CostType, CostExtraction, Timestamp,
} from "@/types/schema";

// ─── Row mappers ─────────────────────────────────────────────────

function n(v: unknown): number | null { return v == null ? null : Number(v); }

/** True when an error means the cost-controls tables aren't there yet — the
 *  pre-migration case (20260803 not applied). PostgREST returns PGRST205 /
 *  "Could not find the table … in the schema cache"; raw Postgres 42P01 /
 *  "relation … does not exist". The list helpers wrap the message, so we match
 *  on it. Lets the UI prompt "run the migration" instead of hard-erroring. */
export function isMissingRelation(err: unknown): boolean {
  const msg = (
    err instanceof Error ? err.message
    : typeof err === "string" ? err
    : ((err as { message?: string })?.message ?? "")
  ).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("could not find the table")
    || msg.includes("schema cache")
    || (msg.includes("does not exist") && /project_parties|cost_accounts|cost_entries|cost_documents/.test(msg))
  );
}

export function rowToParty(r: Record<string, unknown>): ProjectParty {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    kind: r.kind as ProjectParty["kind"],
    trade: (r.trade as string | null) ?? null,
    defaultRate: n(r.default_rate),
    contractValue: n(r.contract_value),
    contactName: (r.contact_name as string | null) ?? null,
    contactEmail: (r.contact_email as string | null) ?? null,
    camUserId: (r.cam_user_id as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    status: (r.status as ProjectParty["status"]) ?? "active",
    createdAt: r.created_at as Timestamp,
    createdBy: r.created_by as string,
    updatedAt: r.updated_at as Timestamp,
    updatedBy: (r.updated_by as string | null) ?? null,
  };
}

export function rowToAccount(r: Record<string, unknown>): CostAccount {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string,
    partyId: (r.party_id as string | null) ?? null,
    wbsMilestoneId: (r.wbs_milestone_id as string | null) ?? null,
    code: (r.code as string | null) ?? null,
    name: r.name as string,
    costType: r.cost_type as CostType,
    budget: Number(r.budget ?? 0),
    currency: (r.currency as string | null) ?? "USD",
    camUserId: (r.cam_user_id as string | null) ?? null,
    status: (r.status as CostAccount["status"]) ?? "open",
    createdAt: r.created_at as Timestamp,
    createdBy: r.created_by as string,
    updatedAt: r.updated_at as Timestamp,
    updatedBy: (r.updated_by as string | null) ?? null,
  };
}

export function rowToEntry(r: Record<string, unknown>): CostEntry {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string,
    costAccountId: r.cost_account_id as string,
    partyId: (r.party_id as string | null) ?? null,
    entryType: r.entry_type as CostEntry["entryType"],
    amount: Number(r.amount ?? 0),
    entryDate: (r.entry_date as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    sourceDocumentId: (r.source_document_id as string | null) ?? null,
    status: (r.status as CostEntry["status"]) ?? "posted",
    createdAt: r.created_at as Timestamp,
    createdBy: r.created_by as string,
    updatedAt: r.updated_at as Timestamp,
    updatedBy: (r.updated_by as string | null) ?? null,
  };
}

export function rowToDocument(r: Record<string, unknown>): CostDocument {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string,
    partyId: (r.party_id as string | null) ?? null,
    kind: r.kind as CostDocument["kind"],
    fileUrl: (r.file_url as string | null) ?? null,
    fileName: (r.file_name as string | null) ?? null,
    mimeType: (r.mime_type as string | null) ?? null,
    docNumber: (r.doc_number as string | null) ?? null,
    docDate: (r.doc_date as string | null) ?? null,
    vendorName: (r.vendor_name as string | null) ?? null,
    currency: (r.currency as string | null) ?? null,
    totalAmount: n(r.total_amount),
    status: r.status as CostDocument["status"],
    parsed: (r.parsed as CostExtraction | null) ?? null,
    postedAt: r.posted_at as Timestamp,
    postedBy: (r.posted_by as string | null) ?? null,
    createdAt: r.created_at as Timestamp,
    createdBy: r.created_by as string,
  };
}

// ─── Pure rollup engine ──────────────────────────────────────────

export interface ScheduleProgress {
  /** 0..1 physical complete (rolled up for a phase). */
  percentComplete: number;
  /** 0..1 time-phased schedule fraction (BCWS point). */
  scheduledFraction: number;
}

export interface AccountRollup {
  account: CostAccount;
  budget: number;
  committed: number;
  actual: number;
  ev: number;
  pv: number;
  result: EvmResult;
}

export interface GroupRollup {
  key: string;
  label: string;
  budget: number;
  committed: number;
  actual: number;
  ev: number;
  pv: number;
  accountCount: number;
  result: EvmResult;
}

export interface CostRollup {
  hasAccounts: boolean;
  hasActuals: boolean;
  totalBudget: number;
  totalCommitted: number;
  totalActual: number;
  totalEv: number;
  totalPv: number;
  /** Budget not yet committed (BAC − commitments). */
  uncommitted: number;
  /** Project-level EVM over every control account. */
  result: EvmResult;
  byAccount: AccountRollup[];
  byParty: GroupRollup[];
  byCostType: GroupRollup[];
  currency: string;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export interface RollupOptions {
  /** WBS progress by milestone id (0..1). Drives EV/PV per account. */
  progressByMilestone?: Map<string, ScheduleProgress>;
  /** Fallback progress for accounts with no WBS link. */
  overallPercent?: number;
  overallScheduled?: number;
  /** Party id → display name, for the OBS rollup labels. */
  partyNames?: Map<string, string>;
  currency?: string;
}

/**
 * Roll budgets + ledger entries into EVM at the account, party (OBS) and
 * cost-type levels, plus the project total. Pure — the EVM math is delegated to
 * computeEvm so the indices match the rest of the app exactly.
 */
export function computeCostRollup(
  accounts: CostAccount[],
  entries: CostEntry[],
  opts: RollupOptions = {},
): CostRollup {
  const currency = opts.currency
    ?? accounts.find((a) => a.currency)?.currency
    ?? "USD";

  // Sum posted ledger amounts per account by type.
  const actualByAcct = new Map<string, number>();
  const committedByAcct = new Map<string, number>();
  let anyActualEntry = false;
  for (const e of entries) {
    if (e.status === "void") continue;
    if (e.entryType === "actual") {
      anyActualEntry = true;
      actualByAcct.set(e.costAccountId, (actualByAcct.get(e.costAccountId) ?? 0) + e.amount);
    } else if (e.entryType === "commitment") {
      committedByAcct.set(e.costAccountId, (committedByAcct.get(e.costAccountId) ?? 0) + e.amount);
    }
  }

  const progressFor = (a: CostAccount): ScheduleProgress => {
    if (a.wbsMilestoneId && opts.progressByMilestone?.has(a.wbsMilestoneId)) {
      return opts.progressByMilestone.get(a.wbsMilestoneId)!;
    }
    return {
      percentComplete: opts.overallPercent ?? 0,
      scheduledFraction: opts.overallScheduled ?? 0,
    };
  };

  const byAccount: AccountRollup[] = [];
  let totalBudget = 0, totalCommitted = 0, totalActual = 0, totalEv = 0, totalPv = 0;

  for (const a of accounts) {
    if (a.status === "closed" && (a.budget ?? 0) === 0) { /* still include for completeness */ }
    const budget = a.budget ?? 0;
    const prog = progressFor(a);
    const ev = budget * prog.percentComplete;
    const pv = budget * prog.scheduledFraction;
    const committed = committedByAcct.get(a.id ?? "") ?? 0;
    const actualRaw = actualByAcct.get(a.id ?? "");
    const actual = actualRaw ?? 0;
    // AC is null for an account with no actuals so its CPI is honestly undefined.
    const acctAc = actualRaw == null ? null : round2(actual);
    const result = computeEvm({ bac: budget, pv, ev, ac: acctAc });

    byAccount.push({
      account: a,
      budget: round2(budget),
      committed: round2(committed),
      actual: round2(actual),
      ev: round2(ev),
      pv: round2(pv),
      result,
    });

    totalBudget += budget;
    totalCommitted += committed;
    totalActual += actual;
    totalEv += ev;
    totalPv += pv;
  }

  const group = (keyOf: (a: CostAccount) => string, labelOf: (a: CostAccount) => string): GroupRollup[] => {
    const buckets = new Map<string, { budget: number; committed: number; actual: number; ev: number; pv: number; label: string; count: number }>();
    for (const r of byAccount) {
      const key = keyOf(r.account);
      const b = buckets.get(key) ?? { budget: 0, committed: 0, actual: 0, ev: 0, pv: 0, label: labelOf(r.account), count: 0 };
      b.budget += r.budget; b.committed += r.committed; b.actual += r.actual; b.ev += r.ev; b.pv += r.pv; b.count += 1;
      buckets.set(key, b);
    }
    return [...buckets.entries()].map(([key, b]) => ({
      key,
      label: b.label,
      budget: round2(b.budget),
      committed: round2(b.committed),
      actual: round2(b.actual),
      ev: round2(b.ev),
      pv: round2(b.pv),
      accountCount: b.count,
      result: computeEvm({ bac: b.budget, pv: b.pv, ev: b.ev, ac: b.actual > 0 ? b.actual : null }),
    })).sort((x, y) => y.budget - x.budget);
  };

  const byParty = group(
    (a) => a.partyId ?? "__unassigned",
    (a) => (a.partyId ? (opts.partyNames?.get(a.partyId) ?? "Contractor") : "Unassigned"),
  );
  const byCostType = group(
    (a) => a.costType,
    (a) => COST_TYPE_LABEL[a.costType] ?? a.costType,
  );

  const projectAc = anyActualEntry ? round2(totalActual) : null;
  const result = computeEvm({ bac: totalBudget, pv: totalPv, ev: totalEv, ac: projectAc });

  return {
    hasAccounts: accounts.length > 0,
    hasActuals: anyActualEntry,
    totalBudget: round2(totalBudget),
    totalCommitted: round2(totalCommitted),
    totalActual: round2(totalActual),
    totalEv: round2(totalEv),
    totalPv: round2(totalPv),
    uncommitted: round2(totalBudget - totalCommitted),
    result,
    byAccount,
    byParty,
    byCostType,
    currency,
  };
}

export const COST_TYPE_LABEL: Record<CostType, string> = {
  labor: "Labor",
  material: "Material",
  equipment: "Equipment",
  subcontract: "Subcontract",
  odc: "Other (ODC)",
};

/** Build the WBS progress map the rollup needs from the live schedule. */
export function buildScheduleProgressMap(milestones: Milestone[], now = new Date()): Map<string, ScheduleProgress> {
  const idx = buildProgressIndex(milestones);
  const nowMs = now.getTime();
  const map = new Map<string, ScheduleProgress>();
  for (const m of milestones) {
    if (!m.id) continue;
    const info = idx.get(m.id);
    map.set(m.id, {
      percentComplete: (info?.percent ?? 0) / 100,
      scheduledFraction: scheduledFraction(m, nowMs),
    });
  }
  return map;
}

// ─── Planned-value S-curve (BCWS over time) ──────────────────────

export interface CurvePoint {
  /** Epoch ms for this point on the timeline. */
  t: number;
  /** Cumulative planned value (BCWS) by t. */
  pv: number;
}

export interface CostCurve {
  points: CurvePoint[];
  startMs: number;
  finishMs: number;
  nowMs: number;
  /** Planned value at "now" — the on-plan spend the project should have reached. */
  pvNow: number;
}

const startOf = (m: Milestone) =>
  Date.parse((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string));
const finishOf = (m: Milestone) => Date.parse(m.plannedAt as string);

/**
 * The planned-value S-curve: cumulative budget the schedule says should be
 * earned by each point in time, scaled so the curve ends at BAC. Pure — used to
 * draw the EVM chart. PV(t) = BAC × Σ(leaf weight × scheduledFraction(leaf,t)) /
 * Σ(leaf weight), sampled across `buckets` points from the first start to the
 * last finish. Returns an empty curve when there's no dated schedule.
 */
export function buildCostCurve(
  milestones: Milestone[],
  bac: number,
  opts?: { buckets?: number; now?: Date },
): CostCurve {
  const nowMs = (opts?.now ?? new Date()).getTime();
  const buckets = Math.max(2, opts?.buckets ?? 32);

  const parentIds = new Set<string>();
  for (const m of milestones) if (m.parentId) parentIds.add(m.parentId);
  const leaves = milestones.filter(
    (m) => !(m.id && parentIds.has(m.id)) && Number.isFinite(finishOf(m)),
  );
  if (leaves.length === 0) return { points: [], startMs: nowMs, finishMs: nowMs, nowMs, pvNow: 0 };

  let startMs = Infinity, finishMs = -Infinity, totalWeight = 0;
  for (const m of leaves) {
    const s = Number.isFinite(startOf(m)) ? startOf(m) : finishOf(m);
    startMs = Math.min(startMs, s);
    finishMs = Math.max(finishMs, finishOf(m));
    totalWeight += effectiveWeight(m);
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs <= startMs || totalWeight <= 0) {
    return { points: [], startMs: nowMs, finishMs: nowMs, nowMs, pvNow: 0 };
  }

  const pvAt = (t: number): number => {
    let acc = 0;
    for (const m of leaves) acc += effectiveWeight(m) * scheduledFraction(m, t);
    return bac * (acc / totalWeight);
  };

  const points: CurvePoint[] = [];
  for (let i = 0; i < buckets; i++) {
    const t = startMs + (i / (buckets - 1)) * (finishMs - startMs);
    points.push({ t, pv: Math.round(pvAt(t) * 100) / 100 });
  }
  return { points, startMs, finishMs, nowMs, pvNow: Math.round(pvAt(nowMs) * 100) / 100 };
}

// ─── CRUD: parties ───────────────────────────────────────────────

export async function listParties(projectId: string): Promise<ProjectParty[]> {
  const { data, error } = await supabase
    .from("project_parties").select("*").eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => rowToParty(r as Record<string, unknown>));
}

export async function createParty(input: Omit<ProjectParty, "id" | "createdAt" | "updatedAt"> & { actorUserId: string }): Promise<ProjectParty> {
  if (!input.name?.trim()) throw new Error("Party name is required");
  const { actorUserId, ...p } = input;
  const { data, error } = await supabase.from("project_parties").insert({
    org_id: p.orgId, project_id: p.projectId, name: p.name.trim(), kind: p.kind,
    trade: p.trade ?? null, default_rate: p.defaultRate ?? null, contract_value: p.contractValue ?? null,
    contact_name: p.contactName ?? null, contact_email: p.contactEmail ?? null,
    cam_user_id: p.camUserId ?? null, notes: p.notes ?? null, status: p.status ?? "active",
    created_by: actorUserId, updated_by: actorUserId,
  }).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Failed to create party");
  await logAuditAction({ action: "COST_PARTY_CREATED", resourceId: data.id as string, resourceType: "project", orgId: p.orgId, userId: actorUserId, details: { name: p.name, kind: p.kind } });
  return rowToParty(data as Record<string, unknown>);
}

export async function updateParty(id: string, patch: Partial<ProjectParty>, actorUserId: string): Promise<void> {
  const col: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: actorUserId };
  const map: Record<string, string> = {
    name: "name", kind: "kind", trade: "trade", defaultRate: "default_rate", contractValue: "contract_value",
    contactName: "contact_name", contactEmail: "contact_email", camUserId: "cam_user_id", notes: "notes", status: "status",
  };
  for (const [k, c] of Object.entries(map)) if (k in patch) col[c] = (patch as Record<string, unknown>)[k] ?? null;
  const { error } = await supabase.from("project_parties").update(col).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteParty(id: string): Promise<void> {
  const { error } = await supabase.from("project_parties").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ─── CRUD: cost accounts ─────────────────────────────────────────

export async function listAccounts(projectId: string): Promise<CostAccount[]> {
  const { data, error } = await supabase
    .from("cost_accounts").select("*").eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => rowToAccount(r as Record<string, unknown>));
}

export async function createAccount(input: Omit<CostAccount, "id" | "createdAt" | "updatedAt"> & { actorUserId: string }): Promise<CostAccount> {
  if (!input.name?.trim()) throw new Error("Account name is required");
  const { actorUserId, ...a } = input;
  const { data, error } = await supabase.from("cost_accounts").insert({
    org_id: a.orgId, project_id: a.projectId, party_id: a.partyId ?? null, wbs_milestone_id: a.wbsMilestoneId ?? null,
    code: a.code ?? null, name: a.name.trim(), cost_type: a.costType, budget: a.budget ?? 0,
    currency: a.currency ?? "USD", cam_user_id: a.camUserId ?? null, status: a.status ?? "open",
    created_by: actorUserId, updated_by: actorUserId,
  }).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Failed to create cost account");
  await logAuditAction({ action: "COST_ACCOUNT_CREATED", resourceId: data.id as string, resourceType: "project", orgId: a.orgId, userId: actorUserId, details: { name: a.name, budget: a.budget, costType: a.costType } });
  return rowToAccount(data as Record<string, unknown>);
}

export async function updateAccount(id: string, patch: Partial<CostAccount>, actorUserId: string): Promise<void> {
  const col: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: actorUserId };
  const map: Record<string, string> = {
    partyId: "party_id", wbsMilestoneId: "wbs_milestone_id", code: "code", name: "name",
    costType: "cost_type", budget: "budget", currency: "currency", camUserId: "cam_user_id", status: "status",
  };
  for (const [k, c] of Object.entries(map)) if (k in patch) col[c] = (patch as Record<string, unknown>)[k] ?? null;
  const { error } = await supabase.from("cost_accounts").update(col).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteAccount(id: string): Promise<void> {
  const { error } = await supabase.from("cost_accounts").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ─── CRUD: cost entries ──────────────────────────────────────────

export async function listEntries(projectId: string): Promise<CostEntry[]> {
  const { data, error } = await supabase
    .from("cost_entries").select("*").eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => rowToEntry(r as Record<string, unknown>));
}

export async function createEntry(input: Omit<CostEntry, "id" | "createdAt" | "updatedAt"> & { actorUserId: string }): Promise<CostEntry> {
  const { actorUserId, ...e } = input;
  const { data, error } = await supabase.from("cost_entries").insert({
    org_id: e.orgId, project_id: e.projectId, cost_account_id: e.costAccountId, party_id: e.partyId ?? null,
    entry_type: e.entryType, amount: e.amount, entry_date: e.entryDate ?? null,
    description: e.description ?? null, reference: e.reference ?? null,
    source_document_id: e.sourceDocumentId ?? null, status: e.status ?? "posted",
    created_by: actorUserId, updated_by: actorUserId,
  }).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Failed to create cost entry");
  return rowToEntry(data as Record<string, unknown>);
}

export async function deleteEntry(id: string): Promise<void> {
  const { error } = await supabase.from("cost_entries").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ─── CRUD: cost documents ────────────────────────────────────────

export async function listDocuments(projectId: string): Promise<CostDocument[]> {
  const { data, error } = await supabase
    .from("cost_documents").select("*").eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => rowToDocument(r as Record<string, unknown>));
}

export async function createDocument(input: Omit<CostDocument, "id" | "createdAt"> & { actorUserId: string }): Promise<CostDocument> {
  const { actorUserId, ...d } = input;
  const { data, error } = await supabase.from("cost_documents").insert({
    org_id: d.orgId, project_id: d.projectId, party_id: d.partyId ?? null, kind: d.kind,
    file_url: d.fileUrl ?? null, file_name: d.fileName ?? null, mime_type: d.mimeType ?? null,
    doc_number: d.docNumber ?? null, doc_date: d.docDate ?? null, vendor_name: d.vendorName ?? null,
    currency: d.currency ?? null, total_amount: d.totalAmount ?? null, status: d.status,
    parsed: d.parsed ?? null, posted_at: d.postedAt ?? null, posted_by: d.postedBy ?? null,
    created_by: actorUserId,
  }).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Failed to create cost document");
  return rowToDocument(data as Record<string, unknown>);
}

export async function updateDocument(id: string, patch: Partial<CostDocument>): Promise<void> {
  const col: Record<string, unknown> = {};
  const map: Record<string, string> = {
    partyId: "party_id", kind: "kind", docNumber: "doc_number", docDate: "doc_date",
    vendorName: "vendor_name", currency: "currency", totalAmount: "total_amount",
    status: "status", parsed: "parsed", postedAt: "posted_at", postedBy: "posted_by",
  };
  for (const [k, c] of Object.entries(map)) if (k in patch) col[c] = (patch as Record<string, unknown>)[k] ?? null;
  if (Object.keys(col).length === 0) return;
  const { error } = await supabase.from("cost_documents").update(col).eq("id", id);
  if (error) throw new Error(error.message);
}
