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
    notes: (r.notes as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

export async function listCompanies(orgId: string): Promise<Company[]> {
  const { data, error } = await supabase
    .from("companies").select("*").eq("org_id", orgId).order("name");
  if (error) throw new Error(error.message);
  return ((data as Record<string, unknown>[]) ?? []).map(rowToCompany);
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
  gaps: Array<{ area: string; finding: string }>;
  actorId: string;
}): Promise<void> {
  const score = Math.max(0, Math.min(100, Math.round(input.score)));
  const { error } = await supabase.from("companies").update({
    quality_manual_doc_id: input.documentId,
    quality_manual_score: score,
    quality_manual_gaps: input.gaps,
    quality_manual_reviewed_at: new Date().toISOString(),
    quality_manual_reviewed_by: input.actorId,
    updated_at: new Date().toISOString(),
    updated_by: input.actorId,
  }).eq("id", input.companyId).eq("org_id", input.orgId);
  if (error) throw new Error(error.message);
  await logAuditAction({
    action: "COMPANY_QM_CONFIRMED", resourceType: "company", resourceId: input.companyId,
    orgId: input.orgId, userId: input.actorId,
    details: { score, gapCount: input.gaps.length, documentId: input.documentId },
  });
}

// ── Evidence gathering (the scorecard's raw material) ─────────────────────

export interface CompanyProfileData {
  company: Company;
  scorecard: CompanyScorecard;
  events: CompanyEvent[];
  projects: Array<{ projectId: string; projectName: string; contractValue: number | null; trade: string | null }>;
  bids: Array<{ projectId: string; rfqGroup: string | null; total: number | null; won: boolean; docDate: string | null }>;
  changeOrders: Array<{ projectId: string; coNumber: string; title: string; amount: number; reasonCode: string; status: string }>;
}

/** Everything the profile page and the juicy card need, one gather. Each
 *  query is bounded; a missing table (pre-migration) degrades to empty. */
export async function gatherCompanyProfile(company: Company): Promise<CompanyProfileData> {
  const safe = async <T,>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T | null> => {
    try { const { data, error } = await p; return error ? null : data; } catch { return null; }
  };

  const [events, partyRows] = await Promise.all([
    listCompanyEvents(company.id).catch(() => [] as CompanyEvent[]),
    safe(supabase.from("project_parties").select("id, project_id, trade, contract_value").eq("company_id", company.id).limit(200)),
  ]);
  const parties = (partyRows ?? []) as Array<{ id: string; project_id: string; trade: string | null; contract_value: number | null }>;
  const partyIds = parties.map((p) => p.id);
  const projectIds = [...new Set(parties.map((p) => p.project_id))];

  const [projRows, coRows, turnRows, punchRows, quoteRows, intakeRows] = await Promise.all([
    projectIds.length ? safe(supabase.from("projects").select("id, name").in("id", projectIds)) : Promise.resolve([]),
    partyIds.length ? safe(supabase.from("change_orders").select("project_id, co_number, title, amount, reason_code, status").in("party_id", partyIds).limit(200)) : Promise.resolve([]),
    partyIds.length ? safe(supabase.from("turnover_items").select("status").in("party_id", partyIds).limit(500)) : Promise.resolve([]),
    partyIds.length ? safe(supabase.from("punch_items").select("status").in("party_id", partyIds).limit(500)) : Promise.resolve([]),
    partyIds.length ? safe(supabase.from("cost_documents").select("project_id, rfq_group, total_amount, status, doc_date, kind").in("party_id", partyIds).eq("kind", "quote").limit(200)) : Promise.resolve([]),
    projectIds.length ? safe(supabase.from("project_intake_links").select("company_name, submission_count, created_at, last_used_at").in("project_id", projectIds).ilike("company_name", company.name).limit(100)) : Promise.resolve([]),
  ]);

  const projectNames = new Map(((projRows ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]));
  const cos = ((coRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    projectId: r.project_id as string,
    coNumber: r.co_number as string,
    title: r.title as string,
    amount: Number(r.amount ?? 0),
    reasonCode: r.reason_code as string,
    status: r.status as string,
  }));
  const turnover = (turnRows ?? []) as Array<{ status: string }>;
  const punch = (punchRows ?? []) as Array<{ status: string }>;
  const quotes = ((quoteRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    projectId: r.project_id as string,
    rfqGroup: (r.rfq_group as string | null) ?? null,
    total: r.total_amount != null ? Number(r.total_amount) : null,
    won: r.status === "awarded",
    docDate: (r.doc_date as string | null) ?? null,
  }));
  const intake = ((intakeRows ?? []) as Array<Record<string, unknown>>);

  // Milestones on their scopes: responsible_party matches the company name.
  const msRows = projectIds.length
    ? await safe(supabase.from("milestones").select("status, planned_at, actual_at").in("project_id", projectIds).ilike("responsible_party", company.name).limit(500))
    : [];
  const milestones = ((msRows ?? []) as Array<{ status: string; planned_at: string | null; actual_at: string | null }>);
  const hit = milestones.filter((m) =>
    m.status === "completed" && m.actual_at && m.planned_at && Date.parse(m.actual_at) <= Date.parse(m.planned_at) + 86_400_000,
  ).length;

  const awardsTotal = parties.reduce((s, p) => s + (p.contract_value ? Number(p.contract_value) : 0), 0);
  const approvedCoTotal = cos.filter((c) => c.status === "approved").reduce((s, c) => s + c.amount, 0);

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
    finalCostTotal: awardsTotal + approvedCoTotal,
    changeOrderCount: cos.filter((c) => c.status === "approved").length,
    changeOrderScopeGapCount: cos.filter((c) => c.status === "approved" && c.reasonCode === "scope_gap").length,
    milestonesOnTheirScopes: milestones.length,
    milestonesHitOnTime: hit,
    submissionCount: intake.reduce((s, r) => s + Number(r.submission_count ?? 0), 0),
    avgSubmitToReviewDays: null, // review-clock analytics need per-submission rows (future)
    avgAssignToSubmitDays: intake.length
      ? avgDays(intake.map((r) => ({ a: r.created_at as string | null, b: r.last_used_at as string | null })))
      : null,
  };

  return {
    company,
    scorecard: computeCompanyScorecard(evidence),
    events,
    projects: parties.map((p) => ({
      projectId: p.project_id,
      projectName: projectNames.get(p.project_id) ?? "Project",
      contractValue: p.contract_value != null ? Number(p.contract_value) : null,
      trade: p.trade,
    })),
    bids: quotes,
    changeOrders: cos,
  };
}

function avgDays(pairs: Array<{ a: string | null; b: string | null }>): number | null {
  const ds = pairs
    .map(({ a, b }) => (a && b ? (Date.parse(b) - Date.parse(a)) / 86_400_000 : null))
    .filter((d): d is number => d != null && d >= 0);
  return ds.length ? ds.reduce((s, d) => s + d, 0) / ds.length : null;
}
