// lib/reviewCycles.ts
//
// Periodic review of controlled documents. A ReviewPolicy can live on a library,
// a folder (collection), or a single document; the most specific DEFINED level
// wins (document > folder > library), and any level may set enabled:false to opt
// out of an inherited cycle.
//
// The per-document `next_review_date` is denormalized so the pill, the sortable
// column, and the daily due-scan are all cheap. It is (re)computed from the
// document's BASIS date (the later of "last reviewed/certified" and "last
// issued") whenever the doc is issued, reviewed, or has a policy set — and for
// every affected doc when a library/folder policy changes.

import { supabase } from "@/lib/supabase";
import { notify } from "@/lib/inAppNotifications";
import type { ReviewPolicy } from "@/types/schema";

export type ReviewStatus = "none" | "current" | "due_soon" | "overdue";

// ── Pure helpers ─────────────────────────────────────────────────────────────

function addInterval(fromISO: string, count: number, unit: "days" | "months" | "years"): string {
  const d = new Date(fromISO);
  if (unit === "days") d.setDate(d.getDate() + count);
  else if (unit === "months") d.setMonth(d.getMonth() + count);
  else d.setFullYear(d.getFullYear() + count);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** The effective policy for a document: the most specific DEFINED level wins; an
 *  explicit enabled:false (at any level) means "no cycle". null = no review. */
export function resolveEffectivePolicy(
  docPolicy?: ReviewPolicy | null,
  folderPolicy?: ReviewPolicy | null,
  libraryPolicy?: ReviewPolicy | null,
): ReviewPolicy | null {
  for (const p of [docPolicy, folderPolicy, libraryPolicy]) {
    if (p) return p.enabled ? p : null;
  }
  return null;
}

export function computeNextReviewDate(basisISO: string, policy: ReviewPolicy | null): string | null {
  if (!policy || !policy.enabled || !policy.intervalCount || !policy.intervalUnit) return null;
  return addInterval(basisISO, policy.intervalCount, policy.intervalUnit);
}

export function reviewStatusFor(nextReviewDate?: string | null, leadDays = 30): ReviewStatus {
  if (!nextReviewDate) return "none";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(`${nextReviewDate.slice(0, 10)}T00:00:00`);
  const days = Math.ceil((due.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return "overdue";
  if (days <= leadDays) return "due_soon";
  return "current";
}

/** Whole-number days until (negative = past) the review date. */
export function daysUntilReview(nextReviewDate?: string | null): number | null {
  if (!nextReviewDate) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(`${nextReviewDate.slice(0, 10)}T00:00:00`);
  return Math.ceil((due.getTime() - today.getTime()) / 86_400_000);
}

export function describeInterval(p?: ReviewPolicy | null): string {
  if (!p || !p.enabled || !p.intervalCount || !p.intervalUnit) return "No review cycle";
  const n = p.intervalCount;
  const u = p.intervalUnit === "days" ? "day" : p.intervalUnit === "months" ? "month" : "year";
  return `Every ${n} ${u}${n === 1 ? "" : "s"}`;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Resolve a document's effective policy by loading its folder + library policy. */
export async function effectivePolicyForDocument(doc: {
  reviewPolicy?: ReviewPolicy | null; collectionId?: string | null; libraryId: string;
}): Promise<ReviewPolicy | null> {
  let folderPolicy: ReviewPolicy | null = null;
  if (doc.collectionId) {
    const { data } = await supabase.from("collections").select("review_policy").eq("id", doc.collectionId).maybeSingle();
    folderPolicy = (data?.review_policy as ReviewPolicy) ?? null;
  }
  const { data: lib } = await supabase.from("libraries").select("review_policy").eq("id", doc.libraryId).maybeSingle();
  return resolveEffectivePolicy(doc.reviewPolicy ?? null, folderPolicy, (lib?.review_policy as ReviewPolicy) ?? null);
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Recompute and persist a single document's next_review_date from its effective
 *  policy and basis date. Returns the new date (or null when no cycle applies). */
export async function recomputeDocument(documentId: string): Promise<string | null> {
  const { data: doc } = await supabase
    .from("documents")
    .select("id, library_id, collection_id, review_policy, last_reviewed_at, updated_at, created_at")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc) return null;
  const eff = await effectivePolicyForDocument({
    reviewPolicy: (doc.review_policy as ReviewPolicy) ?? null,
    collectionId: (doc.collection_id as string | null) ?? null,
    libraryId: doc.library_id as string,
  });
  const basis = (doc.last_reviewed_at as string) || (doc.updated_at as string) || (doc.created_at as string) || new Date().toISOString();
  const next = computeNextReviewDate(basis, eff);
  await supabase.from("documents").update({ next_review_date: next }).eq("id", documentId);
  return next;
}

/** Mark a document reviewed / certified-current — resets the clock WITHOUT a new
 *  revision (the PSM annual-certification path). A rev-up calls onIssued instead. */
export async function markReviewed(input: {
  orgId?: string | null;
  documentId: string;
  userId: string;
  userName?: string | null;
  outcome?: "no_change" | "minor" | "needs_revision";
  note?: string;
}): Promise<{ nextReviewDate: string | null }> {
  const now = new Date().toISOString();
  await supabase.from("documents")
    .update({ last_reviewed_at: now, last_reviewed_by: input.userId, review_notified_at: null })
    .eq("id", input.documentId);
  const next = await recomputeDocument(input.documentId);
  await supabase.from("document_review_events").insert({
    org_id: input.orgId ?? null,
    document_id: input.documentId,
    action: "certified",
    outcome: input.outcome ?? "no_change",
    note: input.note ?? null,
    next_review_date: next,
    performed_by: input.userId,
    performed_by_name: input.userName ?? null,
    performed_at: now,
  });
  return { nextReviewDate: next };
}

/** Called when a document is (re)issued — a new revision IS a review, so the
 *  clock resets to "reviewed now". Safe to call from the publish paths. */
export async function onDocumentIssued(input: {
  orgId?: string | null; documentId: string; userId?: string | null; userName?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("documents")
    .update({ last_reviewed_at: now, last_reviewed_by: input.userId ?? null, review_notified_at: null })
    .eq("id", input.documentId);
  const next = await recomputeDocument(input.documentId);
  if (next) {
    await supabase.from("document_review_events").insert({
      org_id: input.orgId ?? null, document_id: input.documentId, action: "issued",
      next_review_date: next, performed_by: input.userId ?? null, performed_by_name: input.userName ?? null, performed_at: now,
    });
  }
}

/** Set (or clear) the review policy at a level and recompute the affected docs. */
export async function setReviewPolicy(input: {
  level: "library" | "collection" | "document";
  id: string;
  orgId?: string | null;
  policy: ReviewPolicy | null;
  userId?: string | null;
  userName?: string | null;
}): Promise<void> {
  const table = input.level === "library" ? "libraries" : input.level === "collection" ? "collections" : "documents";
  await supabase.from(table).update({ review_policy: input.policy }).eq("id", input.id);

  if (input.level === "document") {
    await recomputeDocument(input.id);
    await supabase.from("document_review_events").insert({
      org_id: input.orgId ?? null, document_id: input.id, action: "policy_set",
      performed_by: input.userId ?? null, performed_by_name: input.userName ?? null,
    });
    return;
  }
  // Library / folder change: recompute every document it covers, in small batches.
  const col = input.level === "library" ? "library_id" : "collection_id";
  const { data } = await supabase.from("documents").select("id").eq(col, input.id);
  const ids = (data ?? []).map((r) => (r as { id: string }).id);
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map((id) => recomputeDocument(id)));
  }
}

// ── Due scan + notifications ─────────────────────────────────────────────────

export interface DueDoc {
  id: string; library_id: string; collection_id: string | null;
  document_number: string | null; title: string | null; name: string | null;
  review_policy: ReviewPolicy | null; next_review_date: string | null;
  review_notified_at: string | null;
}

/** Documents at or before `withinDays` from their review date (0 = overdue only,
 *  >0 also includes "due soon"). Excludes superseded/void/archived. */
export async function listDueReviews(orgId: string, withinDays = 0): Promise<DueDoc[]> {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + withinDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const { data } = await supabase
    .from("documents")
    .select("id, library_id, collection_id, document_number, title, name, review_policy, next_review_date, review_notified_at")
    .eq("org_id", orgId)
    .not("next_review_date", "is", null)
    .lte("next_review_date", cutoffStr)
    .not("status", "in", "(Archived,Void,Superseded)");
  return (data ?? []) as DueDoc[];
}

/** Scan an org for due/overdue documents and fan a notification out to each
 *  document's reviewers + the org's Admin/DocCtrl, with a re-notify guard so the
 *  same doc isn't pinged more than once per `cooldownDays`. Returns how many
 *  documents triggered a notice. Intended to run daily (cron or daily-digest). */
export async function scanAndNotifyReviews(orgId: string, opts?: { leadDays?: number; cooldownDays?: number }): Promise<number> {
  const leadDays = opts?.leadDays ?? 30;
  const cooldownDays = opts?.cooldownDays ?? 7;
  const due = await listDueReviews(orgId, leadDays);
  if (due.length === 0) return 0;

  // Resolve folder/library policies once for the whole org (for reviewerIds).
  const [{ data: libs }, { data: cols }, { data: ctrls }] = await Promise.all([
    supabase.from("libraries").select("id, review_policy").eq("org_id", orgId),
    supabase.from("collections").select("id, review_policy").eq("org_id", orgId),
    supabase.from("org_members").select("uid, role").eq("org_id", orgId).eq("status", "active").in("role", ["Admin", "DocCtrl"]),
  ]);
  const libPol = new Map((libs ?? []).map((l) => [l.id as string, (l.review_policy as ReviewPolicy) ?? null]));
  const colPol = new Map((cols ?? []).map((c) => [c.id as string, (c.review_policy as ReviewPolicy) ?? null]));
  const controllers = (ctrls ?? []).map((c) => (c as { uid: string }).uid);

  const now = Date.now();
  const cooldownMs = cooldownDays * 86_400_000;
  let notified = 0;

  for (const doc of due) {
    if (doc.review_notified_at && now - new Date(doc.review_notified_at).getTime() < cooldownMs) continue;
    const eff = resolveEffectivePolicy(doc.review_policy, doc.collection_id ? colPol.get(doc.collection_id) ?? null : null, libPol.get(doc.library_id) ?? null);
    const recipients = new Set<string>([...controllers, ...((eff?.reviewerIds) ?? [])]);
    if (recipients.size === 0) continue;
    const overdue = reviewStatusFor(doc.next_review_date, leadDays) === "overdue";
    const label = doc.document_number || doc.title || doc.name || "Document";
    const title = overdue ? `Review overdue: ${label}` : `Review due: ${label}`;
    const body = overdue
      ? `This document's review was due ${doc.next_review_date}.`
      : `This document is due for review on ${doc.next_review_date}.`;
    const link = `/documents/${doc.library_id}?doc=${doc.id}`;
    await Promise.all([...recipients].map((uid) =>
      notify({ orgId, userId: uid, kind: "review_due", title, body, link, resourceType: "document", resourceId: doc.id })
    ));
    await supabase.from("documents").update({ review_notified_at: new Date().toISOString() }).eq("id", doc.id);
    notified++;
  }
  return notified;
}
