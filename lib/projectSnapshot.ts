// lib/projectSnapshot.ts — gather one ProjectStateSnapshot from the DB.
//
// The pure health/coach engine (lib/projectHealth) reasons about a
// snapshot; this module builds it. Every gather is bounded and
// fault-tolerant: a table that doesn't exist yet (pre-migration) simply
// contributes zeros, so the coach degrades to fewer suggestions instead of
// a crash — but a read that FAILS is named in `readFailures`, so the coach
// can say "could not read X" instead of presenting zeros as the truth.
// One round of parallel queries — the coach renders on every project open,
// so this stays cheap: each query selects only the columns it reads, and
// concurrent gathers for the same project share one in-flight round
// (the Costs and Quality tabs bump the coach on mount, which used to
// re-run all thirteen queries while the first round was still landing).

import { supabase } from "@/lib/supabase";
import { listAccounts, listEntries, computeCostRollup, milestonePctIndex } from "@/lib/costs";
import { quoteGroups, type CostDocument } from "@/lib/costDocs";
import { computeScheduleMetrics } from "@/lib/milestones";
import { liveMilestones, isOverdueMilestone } from "@/lib/milestoneLiveness";
import type { ProjectStateSnapshot } from "@/lib/projectHealth";
import type { Milestone, MilestoneSource, MilestoneStatus } from "@/types/schema";

type Row = Record<string, unknown>;
type QueryResult<T> = { data: T | null; error: { message: string } | null };

/** A snapshot gathered less recently than this is re-gathered; within it,
 *  a second request for the same project is served from the last round.
 *  Short on purpose: a mutation made after a tab mount must re-gather. */
export const SNAPSHOT_REUSE_MS = 1500;

interface MemoEntry {
  promise: Promise<ProjectStateSnapshot>;
  controller: AbortController;
  waiters: number;
  settledAt: number | null;
}
const memo = new Map<string, MemoEntry>();

/** Drop every memoised round (tests, or a caller that must observe a write
 *  it just made). */
export function resetProjectSnapshotMemo(): void {
  memo.clear();
}

function abortError(): Error {
  const e = new Error("Project snapshot gather aborted");
  e.name = "AbortError";
  return e;
}

/**
 * Gather the snapshot. Rounds are memoised per project: a caller arriving
 * while a round is in flight (or within SNAPSHOT_REUSE_MS of one settling)
 * shares that round's result. Pass `signal` to release your interest —
 * when the last interested caller aborts, the underlying requests are
 * aborted too. `fresh: true` bypasses the memo.
 */
export function gatherProjectSnapshot(
  orgId: string,
  projectId: string,
  opts?: { signal?: AbortSignal; fresh?: boolean },
): Promise<ProjectStateSnapshot> {
  if (opts?.signal?.aborted) return Promise.reject(abortError());
  const key = `${orgId}:${projectId}`;
  const existing = memo.get(key);
  const reusable = !!existing && !opts?.fresh && !existing.controller.signal.aborted
    && (existing.settledAt == null || Date.now() - existing.settledAt < SNAPSHOT_REUSE_MS);
  let entry: MemoEntry;
  if (reusable) {
    entry = existing as MemoEntry;
  } else {
    const controller = new AbortController();
    const created: MemoEntry = { controller, waiters: 0, settledAt: null, promise: Promise.resolve() as unknown as Promise<ProjectStateSnapshot> };
    created.promise = gatherProjectSnapshotUncached(orgId, projectId, controller.signal).then(
      (snap) => { created.settledAt = Date.now(); return snap; },
      (err) => { if (memo.get(key) === created) memo.delete(key); throw err; },
    );
    memo.set(key, created);
    entry = created;
  }
  entry.waiters += 1;
  const signal = opts?.signal;
  if (signal) {
    signal.addEventListener("abort", () => {
      entry.waiters -= 1;
      if (entry.waiters <= 0 && entry.settledAt == null) {
        entry.controller.abort();
        if (memo.get(key) === entry) memo.delete(key);
      }
    }, { once: true });
  }
  return entry.promise;
}

export async function gatherProjectSnapshotUncached(
  orgId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectStateSnapshot> {
  const readFailures: string[] = [];
  const fail = (label: string) => { if (!readFailures.includes(label)) readFailures.push(label); };

  /** Await a PostgREST result; a thrown or returned error names the table
   *  in readFailures and yields the fallback. */
  const read = async <T>(label: string, q: PromiseLike<QueryResult<T>>, fallback: T): Promise<T> => {
    try {
      const r = await q;
      if (r.error) { fail(label); return fallback; }
      return (r.data ?? fallback) as T;
    } catch (e) {
      if (signal?.aborted) throw e;
      fail(label);
      return fallback;
    }
  };
  /** The cost data layer throws instead of returning { error }. */
  const call = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try { return await p; } catch (e) { if (signal?.aborted) throw e; fail(label); return fallback; }
  };
  const sig = <Q extends { abortSignal(s: AbortSignal): Q }>(q: Q): Q => (signal ? q.abortSignal(signal) : q);

  const [projRow, accounts, entries, costDocRows, parties, coRows, msRows, checklists, turnover, punch, links, members] =
    await Promise.all([
      read<Row | null>("project", sig(supabase.from("projects")
        .select("purpose, goals, sow_document_id, job_kind").eq("id", projectId)).maybeSingle(), null),
      call("cost accounts", listAccounts(orgId, projectId), []),
      call("cost entries", listEntries(orgId, projectId), []),
      read<Row[]>("cost documents", sig(supabase.from("cost_documents")
        .select("kind, status, rfq_group, vendor_name, file_name").eq("project_id", projectId).limit(500)), []),
      read<Array<{ id: string }>>("companies on the job", sig(supabase.from("project_parties")
        .select("id").eq("project_id", projectId).limit(200)), []),
      read<Array<{ status: string; amount: number }>>("change orders", sig(supabase.from("change_orders")
        .select("status, amount").eq("project_id", projectId).limit(500)), []),
      read<Row[]>("milestones", sig(supabase.from("milestones")
        .select("id, parent_id, status, planned_at, percent_complete, weight, duration_hours, created_at, baseline_finish_at, source")
        .eq("project_id", projectId).limit(1000)), []),
      read<Array<{ id: string; status: string }>>("checklists", sig(supabase.from("project_checklists")
        .select("id, status").eq("project_id", projectId).limit(50)), []),
      read<Array<{ required: boolean; status: string }>>("turnover items", sig(supabase.from("turnover_items")
        .select("required, status").eq("project_id", projectId).limit(300)), []),
      read<Array<{ status: string }>>("punch items", sig(supabase.from("punch_items")
        .select("status").eq("project_id", projectId).limit(500)), []),
      read<Array<{ revoked_at: string | null }>>("intake links", sig(supabase.from("project_intake_links")
        .select("id, revoked_at").eq("project_id", projectId).limit(100)), []),
      read<Array<{ user_id: string }>>("members", sig(supabase.from("project_members")
        .select("user_id").eq("project_id", projectId).limit(200)), []),
    ]);
  if (signal?.aborted) throw abortError();

  const proj = (projRow ?? {}) as Row;

  // Schedule: every stored row counts (lib/milestoneLiveness). The cost
  // rollup's CPI needs milestone % for pinned accounts, keyed by id.
  const live = liveMilestones(msRows as Array<Row & { source?: string | null }>);
  const pctIdx = milestonePctIndex(live.map((m) => ({
    id: String(m.id),
    percentComplete: (m.percent_complete as number | null) ?? null,
    status: String(m.status ?? "planned"),
  })));
  const rollup = computeCostRollup(accounts, entries, pctIdx);

  // SPI from the schedule engine's own earned-value math — the same
  // numbers the Schedule tab shows. Null until something is actually due
  // (planned value 0 would otherwise read as a fabricated "on schedule").
  const now = Date.now();
  const metrics = computeScheduleMetrics(live.map((m): Milestone => ({
    id: String(m.id),
    orgId,
    projectId,
    parentId: (m.parent_id as string | null) ?? null,
    name: "",
    weight: Number(m.weight ?? 1),
    percentComplete: m.percent_complete != null ? Number(m.percent_complete) : 0,
    plannedAt: (m.planned_at as string | null) ?? "",
    status: String(m.status ?? "planned") as MilestoneStatus,
    durationHours: m.duration_hours != null ? Number(m.duration_hours) : null,
    createdAt: (m.created_at as string | null) ?? undefined,
    createdBy: "",
    source: String(m.source ?? "manual") as MilestoneSource,
  })), { now: new Date(now) });
  const spi = live.length > 0 && metrics.plannedValue > 0 ? metrics.spi : null;

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
    const items = await read<Array<{ status: string; applicability: string }>>("checklist items",
      sig(supabase.from("checklist_items").select("checklist_id, status, applicability")
        .in("checklist_id", openChecklistIds).limit(2000)), []);
    for (const it of items) {
      if (it.applicability === "na" || it.status === "na" || it.status === "satisfied") continue;
      if (it.status === "needs_evidence") checklistNeedsEvidence += 1;
      else checklistOpenItems += 1;
    }
  }
  if (signal?.aborted) throw abortError();

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
    overdueMilestones: live.filter((m) => isOverdueMilestone(m as { planned_at?: string | null; status?: string | null }, now)).length,
    spi,
    hasBaseline: live.some((m) => !!m.baseline_finish_at),

    checklistCount: checklists.filter((c) => c.status !== "void").length,
    checklistOpenItems,
    checklistNeedsEvidence,
    turnoverRequired: reqTurnover.length,
    turnoverAccepted: reqTurnover.filter((t) => t.status === "accepted" || t.status === "waived").length,
    punchOpen: punch.filter((p) => p.status === "open").length,

    intakeLinkCount: links.filter((l) => !l.revoked_at).length,
    membersCount: members.length,

    readFailures,
  };
}
