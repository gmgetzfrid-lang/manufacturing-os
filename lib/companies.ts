// lib/companies.ts — the Known Companies registry data layer.
//
// Contractors, vendors, rental suppliers, and internal crews, org-scoped.
// Scores come from lib/companyScore (pure); this module gathers the
// EVIDENCE that feeds them — every query below reads records the platform
// already writes in the normal course of work (awards, change orders,
// turnover reviews, milestones, portal submissions, safety events). The
// scorecard can always show its work because its inputs are these rows.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import {
  computeCompanyScorecard,
  type CompanyEvidence,
  type CompanyScorecard,
} from "@/lib/companyScore";
import { normalizeCompanyName } from "@/lib/bidTab";

export interface Company {
  id: string;
  orgId: string;
  name: string;
  kind: "contractor" | "vendor" | "rental" | "internal";
  trade: string | null;
  status: "active" | "inactive" | "do_not_use";
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  qualityManualDocId: string | null;
  qualityManualScore: number | null;
  qualityManualGaps: Array<{ area: string; finding: string }> | null;
  qualityManualReviewedAt: string | null;
  /** How much of the manual the evaluation actually saw (COST-3): null =
   *  unknown (recorded before 20261096), never "all of it". */
  qualityManualPagesRead: number | null;
  qualityManualPagesTotal: number | null;
  notes: string | null;
  createdAt: string | null;
}

export interface CompanyEvent {
  id: string;
  companyId: string;
  projectId: string | null;
  kind: "recordable" | "near_miss" | "warning" | "stop_work" | "commendation" | "other";
  eventDate: string;
  description: string;
  createdByName: string | null;
}

export const COMPANY_KIND_LABEL: Record<Company["kind"], string> = {
  contractor: "Contractor",
  vendor: "Vendor",
  rental: "Rental / equipment",
  internal: "Internal crew",
};

export const EVENT_KIND_LABEL: Record<CompanyEvent["kind"], string> = {
  recordable: "Recordable injury",
  near_miss: "Near miss",
  warning: "Warning issued",
  stop_work: "Stop work",
  commendation: "Commendation",
  other: "Other",
};

function rowToCompany(r: Record<string, unknown>): Company {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    name: r.name as string,
    kind: (r.kind as Company["kind"]) ?? "contractor",
    trade: (r.trade as string | null) ?? null,
    status: (r.status as Company["status"]) ?? "active",
    contactName: (r.contact_name as string | null) ?? null,
    contactEmail: (r.contact_email as string | null) ?? null,
    contactPhone: (r.contact_phone as string | null) ?? null,
    qualityManualDocId: (r.quality_manual_doc_id as string | null) ?? null,
    qualityManualScore: (r.quality_manual_score as number | null) ?? null,
    qualityManualGaps: (r.quality_manual_gaps as Company["qualityManualGaps"]) ?? null,
    qualityManualReviewedAt: (r.quality_manual_reviewed_at as string | null) ?? null,
    qualityManualPagesRead: r.quality_manual_pages_read == null ? null : Number(r.quality_manual_pages_read),
    qualityManualPagesTotal: r.quality_manual_pages_total == null ? null : Number(r.quality_manual_pages_total),
    notes: (r.notes as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

/** Hard cap on an unpaged registry read — name-matching callers (the bid
 *  tab, the wizard) need every name, but never an unbounded scan. */
export const COMPANY_LIST_CAP = 1000;
export const COMPANY_PAGE_SIZE = 50;

export async function listCompanies(orgId: string): Promise<Company[]> {
  const { data, error } = await supabase
    .from("companies").select("*").eq("org_id", orgId).order("name").limit(COMPANY_LIST_CAP);
  if (error) throw new Error(error.message);
  return ((data as Record<string, unknown>[]) ?? []).map(rowToCompany);
}

/** One server-side page of the registry (PERF-1 / GAP-409): kind and
 *  search filters run in the database (ILIKE, trigram-indexed by
 *  20261095), sorted by name, COMPANY_PAGE_SIZE rows, with the total so the
 *  page can say where it is. */
export async function listCompaniesPage(orgId: string, opts: {
  search?: string | null;
  kind?: Company["kind"] | "all" | null;
  page?: number;              // 0-based
  pageSize?: number;
} = {}): Promise<{ rows: Company[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.max(1, Math.min(200, opts.pageSize ?? COMPANY_PAGE_SIZE));
  const page = Math.max(0, opts.page ?? 0);
  let q = supabase.from("companies").select("*", { count: "exact" }).eq("org_id", orgId);
  if (opts.kind && opts.kind !== "all") q = q.eq("kind", opts.kind);
  // PostgREST's or() grammar reserves , ( ) — strip them from the term so a
  // typed comma can't break the filter into something else.
  const term = (opts.search ?? "").replace(/[,()]/g, " ").replace(/\s+/g, " ").trim();
  if (term) q = q.or(`name.ilike.%${term}%,trade.ilike.%${term}%`);
  const { data, error, count } = await q.order("name").range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw new Error(error.message);
  return {
    rows: ((data as Record<string, unknown>[]) ?? []).map(rowToCompany),
    total: count ?? 0, page, pageSize,
  };
}

export async function getCompany(id: string): Promise<Company | null> {
  const { data, error } = await supabase.from("companies").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? rowToCompany(data as Record<string, unknown>) : null;
}

export async function saveCompany(input: {
  orgId: string;
  id?: string;
  name: string;
  kind: Company["kind"];
  trade?: string | null;
  status?: Company["status"];
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
  actorId: string;
}): Promise<Company> {
  if (!input.name.trim()) throw new Error("Company name is required.");
  const row = {
    org_id: input.orgId,
    name: input.name.trim(),
    kind: input.kind,
    trade: input.trade?.trim() || null,
    status: input.status ?? "active",
    contact_name: input.contactName?.trim() || null,
    contact_email: input.contactEmail?.trim() || null,
    contact_phone: input.contactPhone?.trim() || null,
    notes: input.notes?.trim() || null,
  };
  if (input.id) {
    const { data, error } = await supabase
      .from("companies").update({ ...row, updated_at: new Date().toISOString(), updated_by: input.actorId })
      .eq("id", input.id).select("*").single();
    if (error) throw new Error(error.message);
    await logAuditAction({
      action: "COMPANY_UPDATED", resourceType: "company", resourceId: input.id,
      orgId: input.orgId, userId: input.actorId, details: { name: row.name },
    });
    return rowToCompany(data as Record<string, unknown>);
  }
  const { data, error } = await supabase
    .from("companies").insert({ ...row, created_by: input.actorId }).select("*").single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new Error(`"${row.name}" is already in the registry.`);
    }
    throw new Error(error.message);
  }
  await logAuditAction({
    action: "COMPANY_CREATED", resourceType: "company", resourceId: (data as { id: string }).id,
    orgId: input.orgId, userId: input.actorId, details: { name: row.name, kind: row.kind },
  });
  return rowToCompany(data as Record<string, unknown>);
}

export async function listCompanyEvents(companyId: string): Promise<CompanyEvent[]> {
  const { data, error } = await supabase
    .from("company_events").select("*").eq("company_id", companyId)
    .order("event_date", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return ((data as Record<string, unknown>[]) ?? []).map((r) => ({
    id: r.id as string,
    companyId: r.company_id as string,
    projectId: (r.project_id as string | null) ?? null,
    kind: r.kind as CompanyEvent["kind"],
    eventDate: r.event_date as string,
    description: r.description as string,
    createdByName: (r.created_by_name as string | null) ?? null,
  }));
}

export async function addCompanyEvent(input: {
  orgId: string;
  companyId: string;
  projectId?: string | null;
  kind: CompanyEvent["kind"];
  eventDate: string;
  description: string;
  actorId: string;
  actorName?: string | null;
}): Promise<void> {
  if (!input.description.trim()) throw new Error("Describe what happened — this lands on the company's permanent record.");
  const { error } = await supabase.from("company_events").insert({
    org_id: input.orgId,
    company_id: input.companyId,
    project_id: input.projectId ?? null,
    kind: input.kind,
    event_date: input.eventDate,
    description: input.description.trim(),
    created_by: input.actorId,
    created_by_name: input.actorName ?? null,
  });
  if (error) throw new Error(error.message);
  await logAuditAction({
    action: "COMPANY_EVENT_LOGGED", resourceType: "company", resourceId: input.companyId,
    orgId: input.orgId, userId: input.actorId,
    details: { kind: input.kind, eventDate: input.eventDate },
  });
}

/** Persist the HUMAN-CONFIRMED quality-manual evaluation. The AI route only
 *  ever PROPOSES a score + gaps; nothing lands on the company's record until
 *  a controller reviews the findings and calls this. */
export async function confirmQualityManual(input: {
  orgId: string;
  companyId: string;
  documentId: string;
  score: number;
  /** The model's number, kept beside the confirmed one so a human
   *  adjustment (COST-3 dw4) is visible in the audit row. */
  proposedScore?: number | null;
  pagesRead?: number | null;
  pagesTotal?: number | null;
  gaps: Array<{ area: string; finding: string }>;
  actorId: string;
}): Promise<void> {
  const score = Math.max(0, Math.min(100, Math.round(input.score)));
  const patch: Record<string, unknown> = {
    quality_manual_doc_id: input.documentId,
    quality_manual_score: score,
    quality_manual_gaps: input.gaps,
    quality_manual_reviewed_at: new Date().toISOString(),
    quality_manual_reviewed_by: input.actorId,
    quality_manual_pages_read: input.pagesRead ?? null,
    quality_manual_pages_total: input.pagesTotal ?? null,
    updated_at: new Date().toISOString(),
    updated_by: input.actorId,
  };
  let { error } = await supabase.from("companies").update(patch)
    .eq("id", input.companyId).eq("org_id", input.orgId);
  if (error && (error.code === "PGRST204" || error.code === "42703")) {
    // Pre-migration tolerance: the read-extent columns land in 20261096.
    // The extent still travels in the audit row below.
    delete patch.quality_manual_pages_read;
    delete patch.quality_manual_pages_total;
    ({ error } = await supabase.from("companies").update(patch)
      .eq("id", input.companyId).eq("org_id", input.orgId));
  }
  if (error) throw new Error(error.message);
  await logAuditAction({
    action: "COMPANY_QM_CONFIRMED", resourceType: "company", resourceId: input.companyId,
    orgId: input.orgId, userId: input.actorId,
    details: {
      score, proposedScore: input.proposedScore ?? null, adjusted: input.proposedScore != null && input.proposedScore !== score,
      pagesRead: input.pagesRead ?? null, pagesTotal: input.pagesTotal ?? null,
      gapCount: input.gaps.length, documentId: input.documentId,
    },
  });
}

// ── Evidence gathering (the scorecard's raw material) ─────────────────────

export interface CompanyProfileData {
  company: Company;
  scorecard: CompanyScorecard;
  events: CompanyEvent[];
  /** 0 = no project party is linked to this registry row: the party-keyed
   *  evidence channels cannot reach it (COST-12) — shown, never hidden. */
  partiesLinked: number;
  awardsSource: "entries" | "contract_value" | "none";
  projects: Array<{ projectId: string; projectName: string; contractValue: number | null; trade: string | null }>;
  bids: Array<{ projectId: string; rfqGroup: string | null; total: number | null; won: boolean; docDate: string | null }>;
  changeOrders: Array<{ projectId: string; coNumber: string; title: string; amount: number; reasonCode: string; status: string }>;
}

/** Reason codes the CO module attributes to the CONTRACTOR (their miss).
 *  design_error / owner_request are ours; field_condition and other are
 *  nobody's (DEC-44) — shown on the record, excluded from the growth
 *  numerator. */
export const CONTRACTOR_CO_REASONS = new Set(["scope_gap"]);
export const OWNER_CO_REASONS = new Set(["design_error", "owner_request"]);

// Every batched read is chunked so a large registry never builds an
// unbounded IN () list; the query COUNT stays a small constant per chunk.
const IN_CHUNK = 200;
const chunks = <T,>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
};

type Row = Record<string, unknown>;

/** Run one bounded query per chunk of ids and flatten. A failed or
 *  missing table (pre-migration) degrades to no rows for that source. */
async function batched(ids: string[], run: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> {
  if (ids.length === 0) return [];
  const parts = await Promise.all(chunks(ids).map(async (c) => {
    try { const { data, error } = await run(c); return error ? [] : ((data as Row[] | null) ?? []); } catch { return []; }
  }));
  return parts.flat();
}

/** Everything the registry page and the profile page need for MANY
 *  companies in ONE batched gather — one query per evidence table per
 *  chunk of ids, never one per company (PERF-1 / GAP-409: no cache, the
 *  rows are read fresh and the query count is independent of the
 *  registry's size). */
export async function gatherCompanyProfiles(companies: Company[]): Promise<Map<string, CompanyProfileData>> {
  const out = new Map<string, CompanyProfileData>();
  if (companies.length === 0) return out;
  const companyIds = companies.map((c) => c.id);

  const [eventRows, partyRows] = await Promise.all([
    batched(companyIds, (c) => supabase.from("company_events").select("*").in("company_id", c)
      .order("event_date", { ascending: false }).limit(c.length * 200)),
    batched(companyIds, (c) => supabase.from("project_parties").select("id, project_id, company_id, trade, contract_value").in("company_id", c)
      .limit(c.length * 200)),
  ]);
  const parties = partyRows as Array<{ id: string; project_id: string; company_id: string; trade: string | null; contract_value: number | null }>;
  const partyIds = parties.map((p) => p.id);
  const projectIds = [...new Set(parties.map((p) => p.project_id))];

  const [projRows, coRows, turnRows, punchRows, quoteByParty, quoteByCompany, entryRows, intakeRows, msRows] = await Promise.all([
    batched(projectIds, (c) => supabase.from("projects").select("id, name").in("id", c)),
    batched(partyIds, (c) => supabase.from("change_orders").select("project_id, party_id, co_number, title, amount, reason_code, status").in("party_id", c).limit(c.length * 200)),
    batched(partyIds, (c) => supabase.from("turnover_items").select("party_id, status").in("party_id", c).limit(c.length * 500)),
    batched(partyIds, (c) => supabase.from("punch_items").select("party_id, status").in("party_id", c).limit(c.length * 500)),
    batched(partyIds, (c) => supabase.from("cost_documents").select("id, project_id, party_id, company_id, rfq_group, total_amount, status, doc_date, kind").in("party_id", c).eq("kind", "quote").limit(c.length * 200)),
    // The explicit registry link (20261096) — pre-migration this column is
    // absent and the read degrades to the party-keyed rows above.
    batched(companyIds, (c) => supabase.from("cost_documents").select("id, project_id, party_id, company_id, rfq_group, total_amount, status, doc_date, kind").in("company_id", c).eq("kind", "quote").limit(c.length * 200)),
    // Posted commitments ARE the awards (COST-12): derived, never typed.
    batched(partyIds, (c) => supabase.from("cost_entries").select("party_id, amount").in("party_id", c).eq("entry_type", "commitment").eq("status", "posted").limit(c.length * 500)),
    batched(projectIds, (c) => supabase.from("project_intake_links").select("project_id, company_name, submission_count, created_at, last_used_at").in("project_id", c).limit(c.length * 100)),
    batched(projectIds, (c) => supabase.from("milestones").select("project_id, status, planned_at, actual_at, responsible_party").in("project_id", c).limit(c.length * 500)),
  ]);

  const projectNames = new Map((projRows as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]));
  const partyCompany = new Map(parties.map((p) => [p.id, p.company_id]));
  const byCompany = <T extends Row>(rows: T[], key: (r: T) => string | null | undefined) => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const k = key(r); if (!k) continue; m.set(k, [...(m.get(k) ?? []), r]); }
    return m;
  };
  const viaParty = (r: Row) => partyCompany.get(String(r.party_id ?? "")) ?? null;

  const eventsBy = byCompany(eventRows, (r) => String(r.company_id));
  const partiesBy = byCompany(parties as unknown as Row[], (r) => String(r.company_id));
  const cosBy = byCompany(coRows, viaParty);
  const turnBy = byCompany(turnRows, viaParty);
  const punchBy = byCompany(punchRows, viaParty);
  const entriesBy = byCompany(entryRows, viaParty);
  // Quotes reach a company through the explicit link OR its party; dedupe.
  const quoteRows = [...quoteByCompany, ...quoteByParty.filter((q) => !quoteByCompany.some((x) => x.id === q.id))];
  const quotesBy = byCompany(quoteRows, (r) => (r.company_id ? String(r.company_id) : viaParty(r)));
  const intakeByProject = byCompany(intakeRows, (r) => String(r.project_id));
  const msByProject = byCompany(msRows, (r) => String(r.project_id));

  for (const company of companies) {
    const events: CompanyEvent[] = (eventsBy.get(company.id) ?? []).map((r) => ({
      id: r.id as string, companyId: r.company_id as string,
      projectId: (r.project_id as string | null) ?? null,
      kind: r.kind as CompanyEvent["kind"], eventDate: r.event_date as string,
      description: r.description as string, createdByName: (r.created_by_name as string | null) ?? null,
    }));
    const myParties = (partiesBy.get(company.id) ?? []) as unknown as typeof parties;
    const myProjectIds = [...new Set(myParties.map((p) => p.project_id))];
    const cos = (cosBy.get(company.id) ?? []).map((r) => ({
      projectId: r.project_id as string, coNumber: r.co_number as string, title: r.title as string,
      amount: Number(r.amount ?? 0), reasonCode: r.reason_code as string, status: r.status as string,
    }));
    const turnover = (turnBy.get(company.id) ?? []) as Array<{ status: string }>;
    const punch = (punchBy.get(company.id) ?? []) as Array<{ status: string }>;
    const quotes = (quotesBy.get(company.id) ?? []).map((r) => ({
      projectId: r.project_id as string, rfqGroup: (r.rfq_group as string | null) ?? null,
      total: r.total_amount != null ? Number(r.total_amount) : null,
      won: r.status === "awarded", docDate: (r.doc_date as string | null) ?? null,
    }));
    const nameKey = normalizeCompanyName(company.name);
    const intake = myProjectIds.flatMap((pid) => (intakeByProject.get(pid) ?? [])
      .filter((r) => normalizeCompanyName(String(r.company_name ?? "")) === nameKey));
    // Milestones on their scopes: responsible_party names the company.
    const milestones = myProjectIds.flatMap((pid) => (msByProject.get(pid) ?? [])
      .filter((r) => String(r.responsible_party ?? "").trim().toLowerCase() === company.name.trim().toLowerCase())) as Array<{ status: string; planned_at: string | null; actual_at: string | null }>;
    const hit = milestones.filter((m) =>
      m.status === "completed" && m.actual_at && m.planned_at && Date.parse(m.actual_at) <= Date.parse(m.planned_at) + 86_400_000,
    ).length;

    // Awards: posted commitments on their parties; the typed contract_value
    // only when nothing has posted — and then labelled as such.
    const postedAwards = (entriesBy.get(company.id) ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    const typedAwards = myParties.reduce((s, p) => s + (p.contract_value ? Number(p.contract_value) : 0), 0);
    const awardsSource: CompanyProfileData["awardsSource"] = postedAwards > 0 ? "entries" : typedAwards > 0 ? "contract_value" : "none";
    const awardsTotal = awardsSource === "entries" ? postedAwards : typedAwards;
    const approved = cos.filter((c) => c.status === "approved");
    const contractorCos = approved.filter((c) => CONTRACTOR_CO_REASONS.has(c.reasonCode));
    const ownerCos = approved.filter((c) => OWNER_CO_REASONS.has(c.reasonCode));
    const neutralCos = approved.filter((c) => !CONTRACTOR_CO_REASONS.has(c.reasonCode) && !OWNER_CO_REASONS.has(c.reasonCode));
    const sum = (xs: Array<{ amount: number }>) => xs.reduce((s, c) => s + c.amount, 0);

    const evidence: CompanyEvidence = {
      recordables: events.filter((e) => e.kind === "recordable").length,
      nearMisses: events.filter((e) => e.kind === "near_miss").length,
      warnings: events.filter((e) => e.kind === "warning").length,
      stopWorks: events.filter((e) => e.kind === "stop_work").length,
      commendations: events.filter((e) => e.kind === "commendation").length,
      qualityManualScore: company.qualityManualScore,
      turnoverAccepted: turnover.filter((t) => t.status === "accepted").length,
      turnoverRejected: turnover.filter((t) => t.status === "rejected").length,
      punchClosed: punch.filter((p) => p.status === "done").length,
      punchTotal: punch.filter((p) => p.status !== "void").length,
      awardsTotal,
      finalCostTotal: awardsTotal + sum(contractorCos),
      changeOrderCount: approved.length,
      changeOrderScopeGapCount: approved.filter((c) => c.reasonCode === "scope_gap").length,
      ownerDrivenCoCount: ownerCos.length,
      ownerDrivenCoTotal: sum(ownerCos),
      neutralCoCount: neutralCos.length,
      neutralCoTotal: sum(neutralCos),
      awardsSource,
      partiesLinked: myParties.length,
      milestonesOnTheirScopes: milestones.length,
      milestonesHitOnTime: hit,
      submissionCount: intake.reduce((s, r) => s + Number(r.submission_count ?? 0), 0),
      avgSubmitToReviewDays: null, // review-clock analytics need per-submission rows (future)
      avgAssignToSubmitDays: intake.length
        ? avgDays(intake.map((r) => ({ a: r.created_at as string | null, b: r.last_used_at as string | null })))
        : null,
    };

    out.set(company.id, {
      company,
      scorecard: computeCompanyScorecard(evidence),
      events,
      partiesLinked: myParties.length,
      awardsSource,
      projects: myParties.map((p) => ({
        projectId: p.project_id,
        projectName: projectNames.get(p.project_id) ?? "Project",
        contractValue: p.contract_value != null ? Number(p.contract_value) : null,
        trade: p.trade,
      })),
      bids: quotes,
      changeOrders: cos,
    });
  }
  return out;
}

/** One company's profile — the batched gather with a single id. */
export async function gatherCompanyProfile(company: Company): Promise<CompanyProfileData> {
  const m = await gatherCompanyProfiles([company]);
  return m.get(company.id)!;
}

function avgDays(pairs: Array<{ a: string | null; b: string | null }>): number | null {
  const ds = pairs
    .map(({ a, b }) => (a && b ? (Date.parse(b) - Date.parse(a)) / 86_400_000 : null))
    .filter((d): d is number => d != null && d >= 0);
  return ds.length ? ds.reduce((s, d) => s + d, 0) / ds.length : null;
}
