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
import { normalizeRoles } from "@/lib/roleCapabilities";
import { notify } from "@/lib/inAppNotifications";
import { resolveEffectiveOwner, teamSupervisorMap } from "@/lib/ownership";
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

// ── GAP-9: field-verification currency — the SAME cycle machinery ───────────
//
// A walkdown attestation (`checkout_sessions.outcome = 'field_verified'`) is
// CURRENT for the cadence the document's review policies set
// (`fieldVerifyIntervalCount` / `fieldVerifyIntervalUnit`, resolved on its own
// by resolveVerificationPolicy: the most specific level that DEFINES a cadence
// — P14 review fix), and goes due-soon / overdue through reviewStatusFor with
// that level's own lead days — no third currency implementation. A `discrepancy` reported after the last
// verification supersedes it, whatever the cadence (GAP-9 acceptance 2).

/** The check-in register outcomes the currency reads. */
export const FIELD_OUTCOMES = ["field_verified", "discrepancy"] as const;

/** One register row (a checkout session with a recorded outcome). */
export interface FieldOutcomeRow {
  outcome: string | null; ended_at: string | null; user_name?: string | null;
  outcome_ref?: { rev?: string | null } | null;
}

/** `current` / `due_soon` / `overdue` — the cadence's verdict (reviewStatusFor);
 *  `verified` — verified, and no cadence applies; `never` — a cadence applies
 *  and nothing was ever verified; `discrepancy` — a discrepancy reported after
 *  the last verification (or with none) supersedes it; `unknown` — the
 *  register or the policy could not be read (never shown as "never"). */
export type FieldVerificationStatus = "current" | "due_soon" | "overdue" | "verified" | "never" | "discrepancy" | "unknown";

export interface FieldVerification {
  /** The last walkdown attestation: when, against which revision, by whom. */
  verifiedAt: string | null; rev: string | null; by: string | null;
  supersededBy: { at: string | null; by: string | null } | null;
  /** When the last verification stops being current (null: no cadence, or never verified). */
  nextVerificationDate: string | null;
  status: FieldVerificationStatus;
  /** The cadence in words ("Every 3 years"), null when none applies. */
  cadence: string | null;
  /** Why the status is `unknown`. */
  unknownReason?: string;
}

/** True when the policy sets a field-verification cadence. */
export function hasVerificationCadence(p?: ReviewPolicy | null): boolean {
  return !!p && p.enabled && !!p.fieldVerifyIntervalCount && !!p.fieldVerifyIntervalUnit;
}

/** GAP-9 (P14 review fix): does this level DECIDE the verification cadence —
 *  set one, or opt out of review altogether (`enabled: false`)? A level that
 *  sets a review cycle but no cadence decides nothing about it. */
export function decidesVerificationCadence(p?: ReviewPolicy | null): boolean {
  return !!p && (!p.enabled || hasVerificationCadence(p));
}

/** GAP-9 (P14 review fix): the policy whose field-verification cadence governs
 *  a document — resolved ON ITS OWN, not as part of the review cycle's
 *  wholesale policy: the most specific level (document > folder > library)
 *  that DEFINES a cadence wins, and a level that opts out (`enabled: false`)
 *  stops inheritance as it does for the cycle. A document given its own
 *  review cycle in the inspector (ReviewSection, which offers no cadence) so
 *  keeps the cadence its folder or library sets, instead of silently losing
 *  it (a stale walkdown shown as plain "Field-verified" rather than overdue).
 *  null: no cadence applies. */
export function resolveVerificationPolicy(
  docPolicy?: ReviewPolicy | null,
  folderPolicy?: ReviewPolicy | null,
  libraryPolicy?: ReviewPolicy | null,
): ReviewPolicy | null {
  for (const p of [docPolicy, folderPolicy, libraryPolicy]) {
    if (decidesVerificationCadence(p)) return hasVerificationCadence(p) ? p! : null;
  }
  return null;
}

/** The date the last verification stops being current — computeNextReviewDate's
 *  rule applied to the verification cadence. */
export function computeNextVerificationDate(lastVerifiedISO: string | null, policy: ReviewPolicy | null): string | null {
  if (!lastVerifiedISO || !policy || !hasVerificationCadence(policy)) return null;
  return addInterval(lastVerifiedISO, policy.fieldVerifyIntervalCount!, policy.fieldVerifyIntervalUnit!);
}

/** The verification cadence in words, through describeInterval. */
export function describeVerificationCadence(p?: ReviewPolicy | null): string | null {
  if (!p || !hasVerificationCadence(p)) return null;
  return describeInterval({ enabled: true, intervalCount: p.fieldVerifyIntervalCount, intervalUnit: p.fieldVerifyIntervalUnit });
}

/** Pure: the document's field-verification currency from its register rows
 *  and its effective policy. NULL when there is nothing to say (never
 *  verified, no discrepancy, and no cadence asks for one). */
export function summarizeFieldVerification(rows: FieldOutcomeRow[], policy: ReviewPolicy | null): FieldVerification | null {
  const byTime = rows
    .filter((r) => r.outcome === "field_verified" || r.outcome === "discrepancy")
    .sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""));
  const last = byTime.find((r) => r.outcome === "field_verified") ?? null;
  const lastAt = last?.ended_at ?? null;
  const later = byTime.find((r) => r.outcome === "discrepancy" && (r.ended_at ?? "") > (lastAt ?? "")) ?? null;
  const cadenceOn = hasVerificationCadence(policy);
  if (!last && !later && !cadenceOn) return null;
  const next = computeNextVerificationDate(lastAt, policy);
  let status: FieldVerificationStatus;
  if (later) status = "discrepancy";
  else if (!last) status = "never";
  else if (!cadenceOn) status = "verified";
  else status = reviewStatusFor(next, policy?.leadDays ?? 30) as FieldVerificationStatus;
  return {
    verifiedAt: lastAt, rev: last?.outcome_ref?.rev ?? null, by: last?.user_name ?? null,
    supersededBy: later ? { at: later.ended_at ?? null, by: later.user_name ?? null } : null,
    nextVerificationDate: next, status, cadence: describeVerificationCadence(policy),
  };
}

/** The currency when it could not be read: the facts we have, never "never". */
export function unknownFieldVerification(reason: string, known?: FieldVerification | null): FieldVerification {
  return {
    verifiedAt: known?.verifiedAt ?? null, rev: known?.rev ?? null, by: known?.by ?? null,
    supersededBy: known?.supersededBy ?? null, nextVerificationDate: null, status: "unknown", cadence: null, unknownReason: reason,
  };
}

const isoDay = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** GAP-9: the currency's words and tone — pure, so the pill, the register
 *  column and its CSV say the same thing. */
export function verificationPillText(v: FieldVerification): { full: string; short: string; tone: "ok" | "warn" | "bad" | "neutral" } {
  const days = daysUntilReview(v.nextVerificationDate);
  switch (v.status) {
    case "current": return { full: `Field-verified · current to ${isoDay(v.nextVerificationDate)}`, short: "Verified", tone: "ok" };
    case "due_soon": return { full: days != null ? `Field verification due in ${days}d` : "Field verification due", short: days != null ? `Verify ${days}d` : "Verify soon", tone: "warn" };
    case "overdue": return { full: days != null ? `Field verification overdue ${Math.abs(days)}d` : "Field verification overdue", short: days != null ? `Verify overdue ${Math.abs(days)}d` : "Verify overdue", tone: "bad" };
    case "never": return { full: "Never field-verified", short: "Never verified", tone: "warn" };
    case "discrepancy": return { full: "Field discrepancy — supersedes the last verification", short: "Discrepancy", tone: "bad" };
    case "verified": return { full: `Field-verified ${isoDay(v.verifiedAt)}`, short: `Verified ${isoDay(v.verifiedAt)}`, tone: "neutral" };
    default: return { full: "Field verification unknown", short: "Verify ?", tone: "neutral" };
  }
}

/** Hover text: who verified, when, against which revision; what superseded it. */
export function verificationPillTitle(v: FieldVerification): string {
  const parts: string[] = [];
  if (v.verifiedAt) {
    parts.push(`Last field-verified${v.rev ? ` against Rev ${v.rev}` : ""} on ${isoDay(v.verifiedAt)}${v.by ? ` by ${v.by}` : ""}.`);
  } else {
    parts.push("No field verification on record.");
  }
  if (v.supersededBy) parts.push(`Superseded by a field discrepancy${v.supersededBy.by ? ` reported by ${v.supersededBy.by}` : ""}${v.supersededBy.at ? ` on ${isoDay(v.supersededBy.at)}` : ""}.`);
  if (v.cadence) parts.push(`Verification cadence: ${v.cadence.toLowerCase()}${v.nextVerificationDate ? ` — current to ${isoDay(v.nextVerificationDate)}` : ""}.`);
  if (v.status === "unknown" && v.unknownReason) parts.push(`Currency unknown: ${v.unknownReason}.`);
  return parts.join(" ");
}

/** One document's field-verification currency, every read CHECKED: a failed
 *  register read or a failed policy read answers `unknown` (with whatever
 *  facts were read) — never "never verified" and never "current". The
 *  cadence is resolveVerificationPolicy's: a level is read only while every
 *  more specific one decides nothing about it. */
export async function loadFieldVerification(doc: {
  id: string; reviewPolicy?: ReviewPolicy | null; collectionId?: string | null; libraryId: string;
}): Promise<FieldVerification | null> {
  const { data, error } = await supabase
    .from("checkout_sessions").select("*")
    .eq("document_id", doc.id).in("outcome", [...FIELD_OUTCOMES])
    .order("ended_at", { ascending: false }).limit(50);
  if (error) return unknownFieldVerification(`the check-in register could not be read (${error.message})`);
  const rows = (data ?? []) as FieldOutcomeRow[];
  const own = doc.reviewPolicy ?? null;
  let folderPolicy: ReviewPolicy | null = null;
  let libPolicy: ReviewPolicy | null = null;
  if (!decidesVerificationCadence(own)) {
    if (doc.collectionId) {
      const { data: col, error: colErr } = await supabase.from("collections").select("review_policy").eq("id", doc.collectionId).maybeSingle();
      if (colErr) return unknownFieldVerification(`the folder's review policy could not be read (${colErr.message})`, summarizeFieldVerification(rows, null));
      folderPolicy = (col?.review_policy as ReviewPolicy | null) ?? null;
    }
    if (!decidesVerificationCadence(folderPolicy)) {
      const { data: lib, error: libErr } = await supabase.from("libraries").select("review_policy").eq("id", doc.libraryId).maybeSingle();
      if (libErr) return unknownFieldVerification(`the library's review policy could not be read (${libErr.message})`, summarizeFieldVerification(rows, null));
      libPolicy = (lib?.review_policy as ReviewPolicy | null) ?? null;
    }
  }
  return summarizeFieldVerification(rows, resolveVerificationPolicy(own, folderPolicy, libPolicy));
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Recompute and persist a single document's next_review_date from its effective
 *  policy and basis date. Returns the new date (or null when no cycle applies).
 *  REV-15: `writeErrors`, when given, collects the next_review_date write's
 *  error (the write is otherwise unchecked, as it always was); without it the
 *  behaviour is unchanged. */
export async function recomputeDocument(documentId: string, writeErrors?: string[]): Promise<string | null> {
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
  const saved = await supabase.from("documents").update({ next_review_date: next }).eq("id", documentId);
  const saveErr = (saved as { error?: { message?: string } | null } | undefined)?.error;
  if (saveErr) writeErrors?.push(`the next review date could not be saved (${saveErr.message ?? "the write was refused"})`);
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
  // A review that concludes "needs revision" is NOT a certification: the
  // clock does not reset (the document stays due/overdue until the revision
  // lands and onDocumentIssued resets it). Recording the event + clearing
  // the nag watermark still happens, so the outcome is on the record without
  // buying a broken document another full cycle of looking "current".
  const certifies = (input.outcome ?? "no_change") !== "needs_revision";
  if (certifies) {
    await supabase.from("documents")
      .update({ last_reviewed_at: now, last_reviewed_by: input.userId, review_notified_at: null })
      .eq("id", input.documentId);
  } else {
    await supabase.from("documents")
      .update({ last_reviewed_by: input.userId, review_notified_at: null })
      .eq("id", input.documentId);
  }
  const next = await recomputeDocument(input.documentId);
  await insertReviewEvent({
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

/** DRLS-4: the review-certification trail (ISO 9001 §7.5 / PSM §1910.119(f)(3))
 *  is written CHECKED — a refused insert (RLS, the org_id NOT NULL rail of
 *  20261077, a transport fault) throws instead of reading as a recorded
 *  certification. */
async function insertReviewEvent(row: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from("document_review_events").insert(row);
  if (error) {
    throw new Error(`The review was applied but its certification event could NOT be written (${error.message}). The review trail is incomplete — report this.`);
  }
}

/** Called when a document is (re)issued — a new revision IS a review, so the
 *  clock resets to "reviewed now". Safe to call from the publish paths.
 *  Its one checked write is the certification event, which throws when it
 *  cannot be written (DRLS-4).
 *  REV-15: `writeErrors`, when given, collects the error of each of the two
 *  clock writes this function does NOT throw on — the reset of the review
 *  basis (last_reviewed_at) and the next_review_date; without it the
 *  behaviour is unchanged (those two errors go unreported, as they always
 *  did). */
export async function onDocumentIssued(input: {
  orgId?: string | null; documentId: string; userId?: string | null; userName?: string | null;
  writeErrors?: string[];
}): Promise<void> {
  const now = new Date().toISOString();
  const reset = await supabase.from("documents")
    .update({ last_reviewed_at: now, last_reviewed_by: input.userId ?? null, review_notified_at: null })
    .eq("id", input.documentId);
  const resetErr = (reset as { error?: { message?: string } | null } | undefined)?.error;
  if (resetErr) input.writeErrors?.push(`the review clock could not be reset to this issue (${resetErr.message ?? "the write was refused"})`);
  const next = await recomputeDocument(input.documentId, input.writeErrors);
  if (next) {
    await insertReviewEvent({
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
  // OWN-14: checked write — a refused save must not read as success.
  const { data: polRows, error: polErr } = await supabase
    .from(table)
    .update({ review_policy: input.policy })
    .eq("id", input.id)
    .select("id");
  if (polErr) throw new Error(polErr.message);
  if (!polRows || polRows.length === 0) {
    throw new Error(`Review policy was NOT saved — you don't have authority over this ${input.level}.`);
  }

  if (input.level === "document") {
    await recomputeDocument(input.id);
    await insertReviewEvent({
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
  owner_user_id: string | null; owner_name: string | null;
}

/** Documents at or before `withinDays` from their review date (0 = overdue only,
 *  >0 also includes "due soon"). Excludes superseded/void/archived. */
export async function listDueReviews(orgId: string, withinDays = 0): Promise<DueDoc[]> {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + withinDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const { data } = await supabase
    .from("documents")
    .select("id, library_id, collection_id, document_number, title, name, review_policy, next_review_date, review_notified_at, owner_user_id, owner_name")
    .eq("org_id", orgId)
    .not("next_review_date", "is", null)
    .lte("next_review_date", cutoffStr)
    .not("status", "in", "(Archived,Void,Superseded)");
  return (data ?? []) as DueDoc[];
}

/** Review-cycle documents due (or due within `leadDays`) that THIS user is
 *  responsible for: their owned docs, or all due docs for Admin/DocCtrl. The
 *  inbox section the audit found missing — owners had no "reviews you owe"
 *  list anywhere they visit. */
export async function listMyDueReviews(orgId: string, uid: string, opts?: { leadDays?: number }): Promise<Array<{
  documentId: string; libraryId: string; label: string; nextReviewDate: string | null; overdue: boolean;
}>> {
  if (!uid) return [];
  const leadDays = opts?.leadDays ?? 30;
  const today = new Date().toISOString().slice(0, 10);
  const { data: me } = await supabase.from("org_members").select("role, roles").eq("org_id", orgId).eq("uid", uid).maybeSingle();
  const isController = normalizeRoles(me?.roles, me?.role).some((r) => r === "Admin" || r === "DocCtrl");
  const due = await listDueReviews(orgId, leadDays);
  return due
    .filter((d) => isController || d.owner_user_id === uid)
    .map((d) => ({
      documentId: d.id,
      libraryId: d.library_id,
      label: String(d.document_number || d.title || d.name || "Document"),
      nextReviewDate: d.next_review_date,
      overdue: !!d.next_review_date && d.next_review_date.slice(0, 10) <= today,
    }))
    .sort((a, b) => String(a.nextReviewDate ?? "").localeCompare(String(b.nextReviewDate ?? "")));
}

/** Scan an org for due/overdue documents and notify who's responsible, with a
 *  re-notify guard (`cooldownDays`). Routing honors ownership: a DELEGATED owner
 *  gets the notice (Admin/DocCtrl stay hands-off) and is escalated back to
 *  Admin/DocCtrl only once it's overdue past `graceDays`; an UNOWNED doc notifies
 *  Admin/DocCtrl directly (they're the fallback owner). Intended to run daily. */
export async function scanAndNotifyReviews(orgId: string, opts?: { leadDays?: number; cooldownDays?: number; graceDays?: number }): Promise<number> {
  const leadDays = opts?.leadDays ?? 30;
  const cooldownDays = opts?.cooldownDays ?? 7;
  const graceDays = opts?.graceDays ?? 14;
  const due = await listDueReviews(orgId, leadDays);
  if (due.length === 0) return 0;

  // Resolve folder/library policy + owner once for the whole org.
  const [{ data: libs }, { data: cols }, { data: ctrls }, { data: activeRows }, teamSupervisors] = await Promise.all([
    supabase.from("libraries").select("id, review_policy, owner_user_id, owner_name, owner_team_id").eq("org_id", orgId),
    supabase.from("collections").select("id, review_policy, owner_user_id, owner_name").eq("org_id", orgId),
    supabase.from("org_members").select("uid, role").eq("org_id", orgId).eq("status", "active")
      .or("role.in.(Admin,DocCtrl),roles.ov.{Admin,DocCtrl}"),
    supabase.from("org_members").select("uid").eq("org_id", orgId).eq("status", "active"),
    teamSupervisorMap(orgId), // OWN-16: the team rung of the one chain
  ]);
  // GAP-5 / OWN-12: a departed or suspended owner never routes a notice — the
  // resolver falls through to the next level and finally to the controllers.
  const activeUids = new Set((activeRows ?? []).map((r) => (r as { uid: string }).uid));
  type Row = { id: string; review_policy: ReviewPolicy | null; owner_user_id: string | null; owner_name: string | null; owner_team_id?: string | null };
  const libPol = new Map((libs as Row[] ?? []).map((l) => [l.id, l.review_policy ?? null]));
  const colPol = new Map((cols as Row[] ?? []).map((c) => [c.id, c.review_policy ?? null]));
  const libOwn = new Map((libs as Row[] ?? []).map((l) => [l.id, l]));
  const colOwn = new Map((cols as Row[] ?? []).map((c) => [c.id, c]));
  const controllers = (ctrls ?? []).map((c) => (c as { uid: string }).uid);

  const now = Date.now();
  const cooldownMs = cooldownDays * 86_400_000;
  let notified = 0;

  for (const doc of due) {
    if (doc.review_notified_at && now - new Date(doc.review_notified_at).getTime() < cooldownMs) continue;
    const eff = resolveEffectivePolicy(doc.review_policy, doc.collection_id ? colPol.get(doc.collection_id) ?? null : null, libPol.get(doc.library_id) ?? null);
    const reviewers = eff?.reviewerIds ?? [];
    const owner = resolveEffectiveOwner(
      { owner_user_id: doc.owner_user_id, owner_name: doc.owner_name },
      doc.collection_id ? colOwn.get(doc.collection_id) : null,
      libOwn.get(doc.library_id),
      activeUids,
      teamSupervisors,
    );

    // A delegated owner takes it off Admin/DocCtrl's plate; an unowned doc is
    // theirs by default.
    const primary = owner.userId ? [owner.userId, ...reviewers] : [...controllers, ...reviewers];
    const recipients = new Set<string>(primary);
    if (recipients.size === 0) continue;

    const days = daysUntilReview(doc.next_review_date) ?? 0;
    const overdue = days < 0;
    const label = doc.document_number || doc.title || doc.name || "Document";
    const link = `/documents/${doc.library_id}?doc=${doc.id}`;
    await Promise.all([...recipients].map((uid) =>
      notify({
        orgId, userId: uid, kind: "review_due",
        title: overdue ? `Review overdue: ${label}` : `Review due: ${label}`,
        body: overdue ? `This document's review was due ${doc.next_review_date}.` : `This document is due for review on ${doc.next_review_date}.`,
        link, resourceType: "document", resourceId: doc.id,
      })
    ));

    // Escalation: a delegated owner who's let it slide past the grace window gets
    // flagged to Admin/DocCtrl so responsibility is delegated, not abandoned.
    if (owner.userId && overdue && -days > graceDays) {
      const escalateTo = controllers.filter((c) => c !== owner.userId);
      await Promise.all(escalateTo.map((uid) =>
        notify({
          orgId, userId: uid, kind: "owner_behind",
          title: `Owner behind on review: ${label}`,
          body: `${owner.name || "The owner"} hasn't kept ${label} current — its review is ${-days} days overdue.`,
          link, resourceType: "document", resourceId: doc.id,
        })
      ));
    }

    await supabase.from("documents").update({ review_notified_at: new Date().toISOString() }).eq("id", doc.id);
    notified++;
  }
  return notified;
}
