// lib/holds.ts
//
// Phase 5 — Hold tracking & roadblock metrics.
//
// A hold is an explicit operational block on a document. Opening
// one announces "this drawing can't be advanced until X is cleared";
// releasing one records who cleared it and when. The duration
// (released_at - opened_at) is computed at read time so we never
// have to maintain a stale "total_hold_days" column.
//
// Multiple holds can be active on the same document simultaneously
// (e.g. "Awaiting Engineering" + "Missing Vendor Data" at once).
// The partial unique index in the migration prevents the same
// reason from being opened twice without first being released.
//
// Every open and release writes an audit_logs row via lib/audit.ts —
// the standard flow used by checkouts and revisions — so the events
// merge cleanly into the Phase 3 timeline.

import { supabase } from "@/lib/supabase";
import { logHoldEvent } from "@/lib/audit";
import type { DocumentHold, HoldReason } from "@/types/schema";

/** The default predefined reasons surfaced by the picker UI. Orgs
 *  with site-specific vocabulary can store free-form reason strings
 *  (the DB column has no CHECK); these are just the defaults. */
export const PREDEFINED_HOLD_REASONS: HoldReason[] = [
  "Awaiting Engineering",
  "Field Verification Needed",
  "Missing Vendor Data",
  "Client Review",
];

interface HoldRow {
  id: string;
  org_id: string;
  document_id: string;
  reason: string;
  notes: string | null;
  expected_release_at: string | null;
  opened_by: string;
  opened_by_name: string | null;
  opened_at: string;
  released_by: string | null;
  released_by_name: string | null;
  released_at: string | null;
  released_reason: string | null;
}

function rowToHold(r: HoldRow): DocumentHold {
  return {
    id: r.id,
    orgId: r.org_id,
    documentId: r.document_id,
    reason: r.reason,
    notes: r.notes,
    expectedReleaseAt: r.expected_release_at,
    openedBy: r.opened_by,
    openedByName: r.opened_by_name,
    openedAt: r.opened_at,
    releasedBy: r.released_by,
    releasedByName: r.released_by_name,
    releasedAt: r.released_at,
    releasedReason: r.released_reason,
  };
}

// ─── Mutations ──────────────────────────────────────────────────

export interface OpenHoldInput {
  orgId: string;
  documentId: string;
  reason: string;                   // canonical HoldReason or free text
  notes?: string;
  expectedReleaseAt?: string;       // ISO timestamp
  openedBy: string;
  openedByName?: string;
  openedByEmail?: string;
  openedByRole?: string;
}

export async function openHold(input: OpenHoldInput): Promise<DocumentHold> {
  if (!input.reason.trim()) throw new Error("Hold reason is required.");

  const { data, error } = await supabase
    .from("document_holds")
    .insert({
      org_id: input.orgId,
      document_id: input.documentId,
      reason: input.reason.trim(),
      notes: input.notes?.trim() || null,
      expected_release_at: input.expectedReleaseAt ?? null,
      opened_by: input.openedBy,
      opened_by_name: input.openedByName ?? null,
    })
    .select("*")
    .single();

  if (error) {
    // The partial unique index surfaces as a 23505 here when a hold
    // with the same reason is already active. Translate to a clearer
    // error so the UI can show "already on hold for that reason."
    if (error.code === "23505") {
      throw new Error(`A "${input.reason}" hold is already open on this document.`);
    }
    throw new Error(error.message);
  }
  const row = data as HoldRow;

  await logHoldEvent({
    orgId: input.orgId,
    documentId: input.documentId,
    holdId: row.id,
    userId: input.openedBy,
    userEmail: input.openedByEmail,
    userRole: input.openedByRole,
    type: "HOLD_OPENED",
    reason: row.reason,
    details: { notes: row.notes, expectedReleaseAt: row.expected_release_at },
  });

  return rowToHold(row);
}

export interface ReleaseHoldInput {
  holdId: string;
  releasedBy: string;
  releasedByName?: string;
  releasedByEmail?: string;
  releasedByRole?: string;
  releasedReason?: string;
}

export async function releaseHold(input: ReleaseHoldInput): Promise<DocumentHold> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("document_holds")
    .update({
      released_at: now,
      released_by: input.releasedBy,
      released_by_name: input.releasedByName ?? null,
      released_reason: input.releasedReason?.trim() || null,
    })
    .eq("id", input.holdId)
    .is("released_at", null)   // safety: don't double-release
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Hold already released or not found.");
  const row = data as HoldRow;

  await logHoldEvent({
    orgId: row.org_id,
    documentId: row.document_id,
    holdId: row.id,
    userId: input.releasedBy,
    userEmail: input.releasedByEmail,
    userRole: input.releasedByRole,
    type: "HOLD_RELEASED",
    reason: row.reason,
    details: { releasedReason: row.released_reason, durationMs: durationMs(row.opened_at, row.released_at) },
  });

  return rowToHold(row);
}

// ─── Reads ──────────────────────────────────────────────────────

/** All hold rows (active + released) for a document, newest first. */
export async function listHoldsForDocument(documentId: string): Promise<DocumentHold[]> {
  const { data, error } = await supabase
    .from("document_holds")
    .select("*")
    .eq("document_id", documentId)
    .order("opened_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data as HoldRow[]) ?? []).map(rowToHold);
}

/** Just the active holds (released_at IS NULL) for a document. */
export async function listActiveHoldsForDocument(documentId: string): Promise<DocumentHold[]> {
  const { data, error } = await supabase
    .from("document_holds")
    .select("*")
    .eq("document_id", documentId)
    .is("released_at", null)
    .order("opened_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data as HoldRow[]) ?? []).map(rowToHold);
}

/** Org-wide active hold queue for the bottleneck dashboard. */
export async function listActiveHoldsForOrg(orgId: string, opts?: { limit?: number }): Promise<DocumentHold[]> {
  const { data, error } = await supabase
    .from("document_holds")
    .select("*")
    .eq("org_id", orgId)
    .is("released_at", null)
    .order("opened_at", { ascending: true })   // oldest first — biggest blockers up top
    .limit(opts?.limit ?? 200);
  if (error) throw new Error(error.message);
  return ((data as HoldRow[]) ?? []).map(rowToHold);
}

// ─── Metrics ────────────────────────────────────────────────────
//
// Computed client-side so we don't add a SQL view in this phase.
// All input rows come from one org-scoped query, so the per-row
// math is cheap. If the active set grows beyond a few thousand we
// can swap in a Postgres view without changing this API.

export interface HoldMetrics {
  activeCount: number;
  /** Active count by reason, sorted descending. */
  activeByReason: Array<{ reason: string; count: number }>;
  /** Longest-running active hold in days (0 if no active holds). */
  longestActiveDays: number;
  /** Average duration of CLOSED holds in days (lookback window: 90d). */
  avgClosedDurationDays: number;
  /** Count of holds opened in the last 7 days. */
  openedLast7Days: number;
  /** Count of holds released in the last 7 days. */
  releasedLast7Days: number;
}

export async function getHoldMetrics(orgId: string, opts?: { windowDays?: number }): Promise<HoldMetrics> {
  // Default 90-day window for the closed-duration average, but fall back to
  // all-time when the window is empty. Multi-year turnaround sites can have
  // long gaps between holds, and a window that captures zero closed holds
  // would otherwise report a misleading "0 days" average. Caller can override
  // the window (e.g. an admin "all time" toggle passes a huge number).
  const windowDays = opts?.windowDays ?? 90;
  const windowStart = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const sevenDaysAgo  = new Date(Date.now() - 7  * 86400_000).toISOString();

  const [activeResult, closedResult] = await Promise.all([
    supabase
      .from("document_holds")
      .select("reason, opened_at")
      .eq("org_id", orgId)
      .is("released_at", null),
    supabase
      .from("document_holds")
      .select("opened_at, released_at")
      .eq("org_id", orgId)
      .gte("released_at", windowStart),
  ]);

  if (activeResult.error) throw new Error(activeResult.error.message);
  if (closedResult.error)  throw new Error(closedResult.error.message);

  const active = (activeResult.data as Array<{ reason: string; opened_at: string }>) ?? [];
  let closed = (closedResult.data as Array<{ opened_at: string; released_at: string }>) ?? [];

  // Fall back to all-time closed holds if the window came back empty, so the
  // average reflects real history rather than reading "0 days" on a quiet
  // quarter.
  if (closed.length === 0) {
    const { data: allClosed } = await supabase
      .from("document_holds")
      .select("opened_at, released_at")
      .eq("org_id", orgId)
      .not("released_at", "is", null);
    closed = (allClosed as Array<{ opened_at: string; released_at: string }>) ?? [];
  }

  const reasonCounts = new Map<string, number>();
  let longestMs = 0;
  let openedLast7 = 0;
  for (const a of active) {
    reasonCounts.set(a.reason, (reasonCounts.get(a.reason) ?? 0) + 1);
    const age = Date.now() - new Date(a.opened_at).getTime();
    if (age > longestMs) longestMs = age;
    if (a.opened_at >= sevenDaysAgo) openedLast7++;
  }

  let closedDurationSum = 0;
  let releasedLast7 = 0;
  for (const c of closed) {
    closedDurationSum += durationMs(c.opened_at, c.released_at);
    if (c.released_at >= sevenDaysAgo) releasedLast7++;
  }

  const activeByReason = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    activeCount: active.length,
    activeByReason,
    longestActiveDays: Math.round(longestMs / 86400_000),
    avgClosedDurationDays: closed.length ? Math.round((closedDurationSum / closed.length) / 86400_000) : 0,
    openedLast7Days: openedLast7,
    releasedLast7Days: releasedLast7,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function durationMs(openedAt: string, releasedAt: string | null): number {
  if (!releasedAt) return 0;
  return new Date(releasedAt).getTime() - new Date(openedAt).getTime();
}
