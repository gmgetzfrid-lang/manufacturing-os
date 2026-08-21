// lib/projectSnapshot.ts — gather one ProjectStateSnapshot from the DB.
//
// The pure health/coach engine (lib/projectHealth) reasons about a
// snapshot; this module builds it. Every gather is bounded and
// fault-tolerant: a table that doesn't exist yet (pre-migration) simply
// contributes zeros, so the coach degrades to fewer suggestions instead of
// a crash. One round of parallel queries — the coach renders on every
// project open, so this stays cheap.

import { supabase } from "@/lib/supabase";
import { listAccounts, listEntries, computeCostRollup, milestonePctIndex } from "@/lib/costs";
import { quoteGroups, type CostDocument } from "@/lib/costDocs";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";

async function safe<T>(p: PromiseLike<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

export async function gatherProjectSnapshot(orgId: string, projectId: string): Promise<ProjectStateSnapshot> {
  const [projRow, accounts, entries, costDocRows, parties, coRows, msRows, checklists, turnover, punch, links, members] =
    await Promise.all([
      safe(supabase.from("projects").select("*").eq("id", projectId).maybeSingle().then((r) => r.data), null),
      safe(listAccounts(orgId, projectId), []),
      safe(listEntries(orgId, projectId), []),
      safe(supabase.from("cost_documents").select("*").eq("project_id", projectId).limit(500)
        .then((r) => (r.error ? [] : ((r.data ?? []) as Array<Record<string, unknown>>))), []),
      safe(supabase.from("project_parties").select("id").eq("project_id", projectId).limit(200)
        .then((r) => (r.error ? [] : (r.data ?? []))), []),
      safe(supabase.from("change_orders").select("status, amount").eq("project_id", projectId).limit(500)
        .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ status: string; amount: number }>))), []),
      safe(supabase.from("milestones").select("id, status, planned_at, percent_complete, baseline_finish_at, source")
        .eq("project_id", projectId).limit(1000)
        .then((r) => (r.error ? [] : ((r.data ?? []) as Array<Record<string, unknown>>))), []),
      safe(supabase.from("project_checklists").select("id, status").eq("project_id", projectId).limit(50)
        .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ id: string; status: string }>))), []),
      safe(supabase.from("turnover_items").select("required, status").eq("project_id", projectId).limit(300)
        .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ required: boolean; status: string }>))), []),
      safe(supabase.from("punch_items").select("status").eq("project_id", projectId).limit(500)
        .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ status: string }>))), []),
      safe(supabase.from("project_intake_links").select("id, revoked_at").eq("project_id", projectId).limit(100)
        .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ revoked_at: string | null }>))), []),
      safe(supabase.from("project_members").select("user_id").eq("project_id", projectId).limit(200)
        .then((r) => (r.error ? [] : (r.data ?? []))), []),
    ]);

  const proj = (projRow ?? {}) as Record<string, unknown>;

  // Cost rollup (CPI needs milestone % for pinned accounts).
  const live = msRows.filter((m) => (m.source as string | null) == null || m.source === "manual" || m.source === "app");
  const pctIdx = milestonePctIndex(live.map((m) => ({
    id: String(m.id),
    percentComplete: (m.percent_complete as number | null) ?? null,
    status: String(m.status ?? "planned"),
  })));
  const rollup = computeCostRollup(accounts, entries, pctIdx);

  // Quotes + pending reads (only quotes/invoices someone still has to act on).
  const docs = costDocRows.map((r) => ({
    kind: String(r.kind ?? "quote"),
    status: String(r.status ?? "draft"),
    rfqGroup: (r.rfq_group as string | null) ?? null,
    vendorName: (r.vendor_name as string | null) ?? null,
    fileName: (r.file_name as string | null) ?? null,
  }));
  const quotes = docs.filter((d) => d.kind === "quote" && d.status !== "void");
  const groups = quoteGroups(docs.map((d, i) => ({
    id: String(i), orgId, projectId, partyId: null,
    kind: d.kind as CostDocument["kind"], fileUrl: null, fileName: d.fileName, mimeType: null,
    docNumber: null, docDate: null, vendorName: d.vendorName, currency: null, totalAmount: null,
    status: d.status as CostDocument["status"], parsed: null, rfqGroup: d.rfqGroup,
    intakeLinkId: null, postedAt: null, createdAt: null,
  })));
  const unawardedRfqGroups = groups.filter((g) => !g.docs.some((d) => d.status === "awarded")).length;

  // Checklist item counts across open checklists.
  let checklistOpenItems = 0, checklistNeedsEvidence = 0;
  const openChecklistIds = checklists.filter((c) => c.status === "open").map((c) => c.id);
  if (openChecklistIds.length > 0) {
    const items = await safe(
      supabase.from("checklist_items").select("checklist_id, status, applicability")
        .in("checklist_id", openChecklistIds).limit(2000)
        .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ status: string; applicability: string }>))), []);
    for (const it of items) {
      if (it.applicability === "na" || it.status === "na" || it.status === "satisfied") continue;
      if (it.status === "needs_evidence") checklistNeedsEvidence += 1;
      else checklistOpenItems += 1;
    }
  }

  const now = Date.now();
  const reqTurnover = turnover.filter((t) => t.required !== false);
  const goals = proj.goals;

  return {
    hasPurpose: !!(proj.purpose as string | null)?.trim(),
    hasGoals: Array.isArray(goals) && goals.length > 0,
    hasSow: !!proj.sow_document_id,
    jobKind: (proj.job_kind as string | null) ?? null,

    budget: rollup.budget,
    committed: rollup.committed,
    spent: rollup.spent,
    cpi: rollup.cpi,
    accountCount: accounts.length,
    accountsPinned: accounts.filter((a) => a.wbsMilestoneId).length,
    partyCount: parties.length,
    quoteCount: quotes.length,
    unawardedRfqGroups,
    pendingCostDocs: docs.filter((d) => d.status === "parsed").length,

    openChangeOrders: coRows.filter((c) => c.status === "proposed").length,
    approvedCoAmount: coRows.filter((c) => c.status === "approved").reduce((s, c) => s + Number(c.amount ?? 0), 0),

    milestoneCount: live.length,
    overdueMilestones: live.filter((m) => {
      const planned = m.planned_at ? Date.parse(String(m.planned_at)) : NaN;
      const status = String(m.status ?? "planned");
      return Number.isFinite(planned) && planned < now && status !== "completed";
    }).length,
    spi: null, // needs the schedule tab's EV math + history; null stays honest
    hasBaseline: live.some((m) => !!m.baseline_finish_at),

    checklistCount: checklists.filter((c) => c.status !== "void").length,
    checklistOpenItems,
    checklistNeedsEvidence,
    turnoverRequired: reqTurnover.length,
    turnoverAccepted: reqTurnover.filter((t) => t.status === "accepted" || t.status === "waived").length,
    punchOpen: punch.filter((p) => p.status === "open").length,

    intakeLinkCount: links.filter((l) => !l.revoked_at).length,
    membersCount: members.length,
  };
}
