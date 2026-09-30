// lib/projectSnapshot.ts — gather one ProjectStateSnapshot from the DB.
//
// The pure health/coach engine (lib/projectHealth) reasons about a
// snapshot; this module builds it. Every gather is bounded and
// fault-tolerant, and never presents a zero it did not read as the truth:
// a read that FAILS is named in `readFailures`, and a table or column that
// migration 20261013 has not created yet is named in `notMigrated`. The
// engine leaves out every health part and coach suggestion that depends on
// either (lib/projectHealth SNAPSHOT_READS), so the coach degrades to fewer
// suggestions instead of a crash or a false one.
// One round of parallel queries — the coach renders on every project open,
// so this stays cheap: each query selects only the columns it reads. A
// caller may opt in to sharing a round already in flight (`share: true` —
// the coach does, for the one re-key that no write can precede: a Costs or
// Quality tab mounting underneath it); every other gather is its own round.

import { supabase } from "@/lib/supabase";
import { listAccounts, listEntries, computeCostRollup, milestonePctIndex } from "@/lib/costs";
import { quoteGroups, type CostDocument } from "@/lib/costDocs";
import { computeScheduleMetrics } from "@/lib/milestones";
import { liveMilestones, isOverdueMilestone, PROJECT_MILESTONE_READ_LIMIT } from "@/lib/milestoneLiveness";
import { SNAPSHOT_READS as R, PROJECT_FIELDS_NOT_MIGRATED, type ProjectStateSnapshot } from "@/lib/projectHealth";
import type { Milestone, MilestoneSource, MilestoneStatus } from "@/types/schema";

type Row = Record<string, unknown>;
type QueryResult<T> = { data: T | null; error: { message: string; code?: string | null } | null };

/** A caller that opts in to sharing (`share: true`) is served from a round
 *  still in flight, or one that settled less than this long ago. The
 *  window exists for one reason: a tab mounting under the coach bumps the
 *  coach's key once with no write behind it (PERF-4's loop), and that bump
 *  must not cost thirteen queries. It is NOT safe across a write — a
 *  request inside it is answered from queries issued before it — which is
 *  why sharing is opt-in and the coach opts in only for that one re-key.
 *  Once PERF-4 moves `onDataChanged` out of the tabs' refresh, this can go
 *  to 0 and only in-flight sharing remains. */
export const SNAPSHOT_REUSE_MS = 1500;

/** PostgREST's "column does not exist" codes. */
const MISSING_COLUMN = new Set(["PGRST204", "42703"]);
/** "Relation does not exist" (Postgres) / "table not in the schema cache"
 *  (PostgREST). */
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

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

/** A surface that just wrote to this project calls this so no later
 *  sharing request is answered from a round whose queries were issued
 *  before the write. A round still in flight keeps serving the callers
 *  already waiting on it (their own surfaces re-key after the write); it
 *  is simply no longer offered to anyone else. */
export function invalidateProjectSnapshot(orgId: string, projectId: string): void {
  memo.delete(`${orgId}:${projectId}`);
}

/**
 * May this run of a keyed snapshot consumer (the coach) share a round?
 * Only the FIRST change of its key: the coach mounts together with the
 * active tab, and a Costs or Quality tab's mount-time refresh bumps the key
 * once with no write behind it (PERF-4). The mount run itself gathers its
 * own round — the page's refresh() remounts the coach after every write
 * (comment, status change, member added, project edited) — and every later
 * re-key follows a mutation inside the tab, so neither may be served from
 * a round issued before it.
 */
export function snapshotRekeyMayShare(
  initialKey: number | undefined,
  prevKey: number | undefined,
  key: number | undefined,
): boolean {
  return key !== prevKey && prevKey === initialKey;
}

function abortError(): Error {
  const e = new Error("Project snapshot gather aborted");
  e.name = "AbortError";
  return e;
}

/**
 * Gather the snapshot. Every call is its own round unless it passes
 * `share: true`, in which case it joins the project's round still in
 * flight (or settled within SNAPSHOT_REUSE_MS). Every round is recorded so
 * a later sharing request can join it. Pass `signal` to release your
 * interest — when the last interested caller aborts, the round's requests
 * are aborted too, one macrotask later: a consumer that re-keys releases
 * its old request and subscribes its new one in the same tick (React runs
 * the effect cleanup and then the next effect synchronously), and a
 * sharing request made in that tick keeps the round alive. `fresh: true`
 * is accepted for callers written against the earlier option; it never
 * shares, which is now the default.
 */
export function gatherProjectSnapshot(
  orgId: string,
  projectId: string,
  opts?: { signal?: AbortSignal; share?: boolean; fresh?: boolean },
): Promise<ProjectStateSnapshot> {
  if (opts?.signal?.aborted) return Promise.reject(abortError());
  const key = `${orgId}:${projectId}`;
  const existing = memo.get(key);
  const reusable = !!opts?.share && !opts?.fresh && !!existing && !existing.controller.signal.aborted
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
      if (entry.waiters > 0 || entry.settledAt != null) return;
      setTimeout(() => {
        if (entry.waiters > 0 || entry.settledAt != null) return;
        entry.controller.abort();
        if (memo.get(key) === entry) memo.delete(key);
      }, 0);
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
  const notMigrated: string[] = [];
  const fail = (label: string) => { if (!readFailures.includes(label)) readFailures.push(label); };

  const absent = (label: string) => { if (!notMigrated.includes(label)) notMigrated.push(label); };
  /** Await a PostgREST result; a thrown or returned error names the read
   *  in readFailures and yields the fallback. For a table migration
   *  20261013 creates (`since20261013`), "relation does not exist" is the
   *  known pre-migration state and is named in notMigrated instead. */
  const read = async <T>(label: string, q: PromiseLike<QueryResult<T>>, fallback: T, since20261013 = false): Promise<T> => {
    try {
      const r = await q;
      if (r.error) {
        if (since20261013 && r.error.code && MISSING_TABLE.has(r.error.code)) absent(label);
        else fail(label);
        return fallback;
      }
      return (r.data ?? fallback) as T;
    } catch (e) {
      if (signal?.aborted) throw e;
      fail(label);
      return fallback;
    }
  };
  /** The cost data layer's list functions: a throw names the read. NOTE
   *  listAccounts / listEntries (lib/costs.ts) still swallow a refused read
   *  and return [] — projects-tab REL-2 (P3) makes them surface it; until
   *  then a refused cost read reaches this wrapper as an empty ledger. */
  const call = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try { return await p; } catch (e) { if (signal?.aborted) throw e; fail(label); return fallback; }
  };
  const sig = <Q extends { abortSignal(s: AbortSignal): Q }>(q: Q): Q => (signal ? q.abortSignal(signal) : q);
  /** A read whose column list includes migration-20261013 columns: on a
   *  "column does not exist" answer, record WHICH fields the database has
   *  not been migrated for — a known state, not a failed read — and re-read
   *  with the pre-migration list when one exists (the way the wizard
   *  retries `company_id`). With no `legacy` read, the fallback stands. */
  const readOrLegacy = async <T>(
    label: string,
    fields: string,
    q: () => PromiseLike<QueryResult<T>>,
    legacy: (() => PromiseLike<QueryResult<T>>) | null,
    fallback: T,
  ): Promise<T> => {
    let r: QueryResult<T>;
    try {
      r = await q();
    } catch (e) {
      if (signal?.aborted) throw e;
      fail(label);
      return fallback;
    }
    if (!r.error) return (r.data ?? fallback) as T;
    if (!(r.error.code && MISSING_COLUMN.has(r.error.code))) { fail(label); return fallback; }
    absent(fields);
    return legacy ? read(label, legacy(), fallback) : fallback;
  };

  const [projRow, accounts, entries, costDocRows, parties, coRows, msRows, checklists, turnover, punch, links, members] =
    await Promise.all([
      // All four columns arrive with 20261013 — there is no pre-migration
      // column list worth reading, so a missing column leaves them unknown.
      readOrLegacy<Row | null>(R.project, PROJECT_FIELDS_NOT_MIGRATED,
        () => sig(supabase.from("projects").select("purpose, goals, sow_document_id, job_kind").eq("id", projectId)).maybeSingle(),
        null,
        null),
      call(R.costAccounts, listAccounts(orgId, projectId), []),
      call(R.costEntries, listEntries(orgId, projectId), []),
      readOrLegacy<Row[]>(R.costDocuments, "RFQ groups",
        () => sig(supabase.from("cost_documents").select("kind, status, rfq_group, vendor_name, file_name").eq("project_id", projectId).limit(500)),
        () => sig(supabase.from("cost_documents").select("kind, status, vendor_name, file_name").eq("project_id", projectId).limit(500)),
        []),
      read<Array<{ id: string }>>(R.parties, sig(supabase.from("project_parties")
        .select("id").eq("project_id", projectId).limit(200)), []),
      read<Array<{ status: string; amount: number }>>(R.changeOrders, sig(supabase.from("change_orders")
        .select("status, amount").eq("project_id", projectId).limit(500)), [], true),
      // Ordered and bounded exactly as the report reads it (and as the
      // Costs tab's capped read returns it), so all three see the same rows.
      read<Row[]>(R.milestones, sig(supabase.from("milestones")
        .select("id, parent_id, status, planned_at, percent_complete, weight, duration_hours, created_at, baseline_finish_at, source")
        .eq("project_id", projectId).order("planned_at").order("id").limit(PROJECT_MILESTONE_READ_LIMIT)), []),
      read<Array<{ id: string; status: string }>>(R.checklists, sig(supabase.from("project_checklists")
        .select("id, status").eq("project_id", projectId).limit(50)), [], true),
      read<Array<{ required: boolean; status: string }>>(R.turnover, sig(supabase.from("turnover_items")
        .select("required, status").eq("project_id", projectId).limit(300)), [], true),
      read<Array<{ status: string }>>(R.punch, sig(supabase.from("punch_items")
        .select("status").eq("project_id", projectId).limit(500)), [], true),
      read<Array<{ revoked_at: string | null }>>(R.intakeLinks, sig(supabase.from("project_intake_links")
        .select("id, revoked_at").eq("project_id", projectId).limit(100)), []),
      read<Array<{ user_id: string }>>(R.members, sig(supabase.from("project_members")
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
    const items = await read<Array<{ status: string; applicability: string }>>(R.checklistItems,
      sig(supabase.from("checklist_items").select("checklist_id, status, applicability")
        .in("checklist_id", openChecklistIds).limit(2000)), [], true);
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
    notMigrated,
  };
}
