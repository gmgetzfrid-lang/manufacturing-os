// lib/docControlRegister.ts
//
// The master document-control register — one org-wide compliance view across
// everything the control system tracks: the effective OWNER, the review-CYCLE
// status, the read-&-understood ACK completion, and any in-progress pre-publish
// REVIEW. This is the register + KPI feed an auditor or DocCtrl manager reads to
// answer "where do we stand?" in one place. It composes the existing per-feature
// data (it doesn't duplicate it), so every number stays consistent with the
// pills shown elsewhere.

import { supabase } from "@/lib/supabase";
import { resolveEffectiveOwner, teamSupervisorMap } from "@/lib/ownership";
import {
  reviewStatusFor, daysUntilReview, resolveVerificationPolicy, decidesVerificationCadence, summarizeFieldVerification, unknownFieldVerification,
  verificationPillText, verificationPillTitle, FIELD_OUTCOMES,
  type ReviewStatus, type FieldOutcomeRow, type FieldVerification,
} from "@/lib/reviewCycles";
import { getAckSummaries, ackStatusFor, type AckSummary, type AckStatus } from "@/lib/acknowledgments";
import { getReviewSummaries, type ReviewSummary } from "@/lib/reviewControl";
import { effectiveStatusFor } from "@/lib/effectiveDate";
import { retentionStatusFor } from "@/lib/retention";
import { resolveEffectiveRetentionPolicy, scheduledActionFor, scheduledActionLabel, describeRetentionPolicy, type ScheduledAction } from "@/lib/retentionPolicy";
import type { RetentionPolicy, ReviewPolicy } from "@/types/schema";
import { describeOrigin } from "@/lib/documentOrigin";
import { csvCell } from "@/lib/csvSafe";

export interface RegisterRow {
  id: string;
  number: string;
  title: string;
  libraryId: string;
  libraryName: string;
  status: string | null;
  rev: string | null;
  updatedAt: string | null;
  // Owner (effective — may be inherited from folder/library; null = Admin/DocCtrl)
  ownerName: string | null;
  ownerUserId: string | null;
  owned: boolean;
  // Review cycle
  nextReviewDate: string | null;
  reviewStatus: ReviewStatus;
  reviewDaysLeft: number | null;
  // Read-&-understood
  ack: AckSummary | null;
  ackStatus: AckStatus;
  // Outstanding distribution confirmations ("I have this revision")
  distributionAcksOutstanding: number;
  // Pre-publish review in progress
  review: ReviewSummary | null;
  // Effective date (a future date = issued but not yet in force)
  effectiveDate: string | null;
  effectivePending: boolean;
  // Records management
  retentionUntil: string | null;
  legalHold: boolean;
  dispositionEligible: boolean;
  // RET-11: the scheduled end-of-life action of the EFFECTIVE retention
  // policy (document → folder → library, P9's resolver) — null when no
  // policy is in force; `retentionSchedule` describes it ("Retain 7 years
  // from issued, then destroy"); `retentionScheduleUnknown` when the folder
  // or library policy could not be read (never shown as "no schedule").
  scheduledAction: ScheduledAction | null;
  scheduledActionLabel: string | null;
  retentionSchedule: string | null;
  retentionScheduleUnknown: boolean;
  // GAP-9: field-verification currency — the last walkdown (who, when,
  // against which revision), the verdict of the cadence the review policies
  // set (resolveVerificationPolicy), a later discrepancy superseding it; `unknown` (never "never
  // verified") when the register or an inherited policy could not be read.
  fieldVerification: FieldVerification | null;
  // Origin (ISO 9001 §7.5.3)
  external: boolean;
  originLabel: string;
}

export interface RegisterKpis {
  totalControlled: number;
  unowned: number;
  reviewsOverdue: number;
  reviewsDueSoon: number;
  acksOutstanding: number;
  inReview: number;
  reviewsReady: number;
  effectivePending: number;
  legalHolds: number;
  dispositionEligible: number;
  external: number;
}

/** Pure KPI roll-up from the composed rows — unit-testable, no I/O. */
export function computeRegisterKpis(rows: RegisterRow[]): RegisterKpis {
  let unowned = 0, reviewsOverdue = 0, reviewsDueSoon = 0, acksOutstanding = 0, inReview = 0, reviewsReady = 0, effectivePending = 0, legalHolds = 0, dispositionEligible = 0, external = 0;
  for (const r of rows) {
    if (!r.owned) unowned++;
    if (r.reviewStatus === "overdue") reviewsOverdue++;
    else if (r.reviewStatus === "due_soon") reviewsDueSoon++;
    if (r.ackStatus === "partial" || r.ackStatus === "overdue" || r.ackStatus === "blocked") acksOutstanding++;
    if (r.review?.inReview) { inReview++; if (r.review.ready) reviewsReady++; }
    if (r.effectivePending) effectivePending++;
    if (r.legalHold) legalHolds++;
    if (r.dispositionEligible) dispositionEligible++;
    if (r.external) external++;
  }
  return { totalControlled: rows.length, unowned, reviewsOverdue, reviewsDueSoon, acksOutstanding, inReview, reviewsReady, effectivePending, legalHolds, dispositionEligible, external };
}

type OwnerCols = { id: string; owner_user_id: string | null; owner_name: string | null; name?: string | null; owner_team_id?: string | null };

/** Load the whole register for an org. Controlled documents only (Issued /
 *  Locked — never Draft/Superseded/Void/Archived). ~5 queries total regardless
 *  of document count. `limit` caps very large orgs (flagged via `capped`). */
export async function loadDocControlRegister(orgId: string, opts?: { limit?: number }): Promise<{ rows: RegisterRow[]; kpis: RegisterKpis; capped: boolean }> {
  const limit = opts?.limit ?? 4000;
  const { data: docsData } = await supabase
    .from("documents")
    .select("id, document_number, title, name, library_id, collection_id, status, rev, updated_at, owner_user_id, owner_name, next_review_date, pending_version_id, effective_date, retention_until, disposition_state, legal_hold, retention_policy, review_policy, origin, external_source, external_reference")
    .eq("org_id", orgId)
    // or(): NULL-status documents are CONTROLLED records too — plain
    // not-in drops them via SQL NULL semantics, silently shrinking the
    // register and every KPI computed from it.
    .or("status.is.null,status.not.in.(Draft,Superseded,Void,Archived)")
    .order("updated_at", { ascending: false })
    .limit(limit);
  const docs = (docsData ?? []) as Array<Record<string, unknown>>;
  const capped = docs.length >= limit;
  if (!docs.length) return { rows: [], kpis: computeRegisterKpis([]), capped };

  const docIds = docs.map((d) => d.id as string);
  const [{ data: libs, error: libsErr }, { data: cols, error: colsErr }, ackMap, reviewMap, distAckRes, { data: activeRows }, fieldOutcomes] = await Promise.all([
    supabase.from("libraries").select("id, name, owner_user_id, owner_name, owner_team_id, retention_policy, review_policy").eq("org_id", orgId),
    supabase.from("collections").select("id, owner_user_id, owner_name, retention_policy, review_policy").eq("org_id", orgId),
    getAckSummaries(orgId, docIds),
    getReviewSummaries(orgId, docIds),
    // Outstanding DISTRIBUTION confirmations ("I have this revision") — the
    // other ack system; the register is the auditor artifact and must carry
    // the answer this feature exists to produce.
    supabase.from("distribution_acks").select("document_id, version_id").eq("org_id", orgId).is("acknowledged_at", null),
    // GAP-5 / OWN-12: only ACTIVE members can be effective owners — a departed
    // owner's documents show as UNOWNED here (the actionable signal).
    supabase.from("org_members").select("uid, display_name, email").eq("org_id", orgId).eq("status", "active"),
    // GAP-9: the check-in register's walkdown outcomes of THESE documents,
    // read CHECKED, chunked and paged.
    loadFieldOutcomes(orgId, docIds),
  ]);
  const activeUids = new Set((activeRows ?? []).map((r) => (r as { uid: string }).uid));
  // DEL-8: the owner's CURRENT name, never the owner_name snapshot.
  const activeName = new Map((activeRows ?? []).map((r) => {
    const m = r as { uid: string; display_name?: string | null; email?: string | null };
    return [m.uid, m.display_name || m.email || null] as const;
  }));
  // DIST-4: count only obligations that still bind — a pending ack on a
  // NON-CURRENT version is an orphan (the recipient's confirm bar is
  // version-scoped and can never clear it), and counting it inflated the
  // auditor-facing "unconfirmed" pill permanently.
  const currentVersionByDoc = new Map(docs.map((d) => [String(d.id), (d.current_version_id as string | null) ?? ""]));
  const distAckOutstanding = new Map<string, number>();
  for (const r of (((distAckRes as { data?: Array<{ document_id: string; version_id: string | null }> })?.data) ?? [])) {
    if (String(r.version_id ?? "") !== currentVersionByDoc.get(r.document_id)) continue;
    distAckOutstanding.set(r.document_id, (distAckOutstanding.get(r.document_id) ?? 0) + 1);
  }
  const libMap = new Map((libs ?? []).map((l) => [(l as OwnerCols).id, l as OwnerCols]));
  const colMap = new Map((cols ?? []).map((c) => [(c as OwnerCols).id, c as OwnerCols]));

  // OWN-16: the team rung comes from the ONE resolver (team-owned library →
  // the team's supervisor, ACTIVE members only via activeUids). The register
  // used to patch it in afterwards and label the source "library".
  const teamSupervisors = ((libs ?? []) as Array<Record<string, unknown>>).some((l) => !!l.owner_team_id)
    ? await teamSupervisorMap(orgId)
    : new Map();

  const rows: RegisterRow[] = docs.map((d) => {
    const libraryId = d.library_id as string;
    const collectionId = (d.collection_id as string | null) ?? null;
    const lib = libMap.get(libraryId);
    const owner = resolveEffectiveOwner(
      { owner_user_id: (d.owner_user_id as string | null) ?? null, owner_name: (d.owner_name as string | null) ?? null },
      collectionId ? colMap.get(collectionId) ?? null : null,
      lib ?? null,
      activeUids,
      teamSupervisors,
    );
    const nextReviewDate = (d.next_review_date as string | null) ?? null;
    // RET-11: the end-of-life action the record is scheduled for, from its
    // EFFECTIVE policy. A level is consulted only while every more specific
    // one is undefined, so a failed folder / library read makes the schedule
    // unknown only for a record that inherits it.
    const ownPolicy = (d.retention_policy as RetentionPolicy | null) ?? null;
    const folderPolicy = collectionId ? ((colMap.get(collectionId) as { retention_policy?: RetentionPolicy | null } | undefined)?.retention_policy ?? null) : null;
    const libPolicy = ((lib as { retention_policy?: RetentionPolicy | null } | undefined)?.retention_policy) ?? null;
    const scheduleUnknown = !ownPolicy && ((!!collectionId && !!colsErr && !folderPolicy) || (!folderPolicy && !!libsErr));
    const retention = scheduleUnknown ? null : resolveEffectiveRetentionPolicy(ownPolicy, folderPolicy, libPolicy);
    const inForce = !!retention && !!retention.years;
    const ack = ackMap.get(d.id as string) ?? null;
    const review = reviewMap.get(d.id as string) ?? null;
    // GAP-9: the verification cadence, resolved on its own from the review
    // policies (resolveVerificationPolicy: the most specific level that
    // DEFINES one — P14 review fix — so a document's own review cycle does not
    // drop its folder's cadence); a level is consulted only while every more
    // specific one decides nothing, so an inherited level that could not be
    // read makes the currency unknown, never "never verified".
    const ownReview = (d.review_policy as ReviewPolicy | null) ?? null;
    const folderReview = collectionId ? ((colMap.get(collectionId) as { review_policy?: ReviewPolicy | null } | undefined)?.review_policy ?? null) : null;
    const libReview = ((lib as { review_policy?: ReviewPolicy | null } | undefined)?.review_policy) ?? null;
    const verifyPolicyUnknown = !decidesVerificationCadence(ownReview)
      && ((!!collectionId && !!colsErr) || (!decidesVerificationCadence(folderReview) && !!libsErr));
    const outcomes = fieldOutcomes.byDoc.get(d.id as string) ?? [];
    const fieldVerification = fieldOutcomes.error
      ? unknownFieldVerification(`the check-in register could not be read (${fieldOutcomes.error})`)
      : verifyPolicyUnknown
        ? unknownFieldVerification("the review policy could not be read", summarizeFieldVerification(outcomes, null))
        : summarizeFieldVerification(outcomes, resolveVerificationPolicy(ownReview, folderReview, libReview));
    return {
      id: d.id as string,
      number: (d.document_number as string) || (d.title as string) || (d.name as string) || "—",
      title: (d.title as string) || (d.name as string) || "",
      libraryId,
      libraryName: (lib?.name as string) || "—",
      status: (d.status as string | null) ?? null,
      rev: (d.rev as string | null) ?? null,
      updatedAt: (d.updated_at as string | null) ?? null,
      ownerName: owner.userId ? (activeName.get(owner.userId) ?? owner.name ?? "assigned member") : null,
      ownerUserId: owner.userId,
      owned: !!owner.userId,
      nextReviewDate,
      reviewStatus: reviewStatusFor(nextReviewDate),
      reviewDaysLeft: daysUntilReview(nextReviewDate),
      ack,
      ackStatus: ackStatusFor(ack),
      distributionAcksOutstanding: distAckOutstanding.get(d.id as string) ?? 0,
      review,
      effectiveDate: (d.effective_date as string | null) ?? null,
      effectivePending: effectiveStatusFor((d.effective_date as string | null) ?? null) === "pending",
      retentionUntil: (d.retention_until as string | null) ?? null,
      legalHold: !!d.legal_hold,
      dispositionEligible: retentionStatusFor({ retentionUntil: (d.retention_until as string | null) ?? null, dispositionState: (d.disposition_state as string | null) ?? null, legalHold: !!d.legal_hold }) === "eligible",
      scheduledAction: inForce ? scheduledActionFor(retention) : null,
      scheduledActionLabel: inForce ? scheduledActionLabel(retention) : null,
      retentionSchedule: inForce ? describeRetentionPolicy(retention) : null,
      retentionScheduleUnknown: scheduleUnknown,
      fieldVerification,
      external: (d.origin as string | null) === "external",
      originLabel: describeOrigin({ origin: (d.origin as "internal" | "external" | null) ?? null, externalSource: (d.external_source as string | null) ?? null, externalReference: (d.external_reference as string | null) ?? null }),
    };
  });

  return { rows, kpis: computeRegisterKpis(rows), capped };
}

const FIELD_OUTCOME_PAGE = 1000;
const FIELD_OUTCOME_MAX_PAGES = 100;
/** Document ids per `.in()` — the register's own documents, a URL-safe slice. */
const FIELD_OUTCOME_IN_CHUNK = 150;

/** GAP-9: the walkdown outcomes (field_verified / discrepancy) of the
 *  register's OWN documents, grouped by document. CHECKED — a failed or
 *  truncated read would show a verified record as never verified, so either
 *  answers `error`. P14 review fix: the read is bounded by the register's
 *  documents (chunked `.in("document_id", …)`, never every walkdown in the
 *  org), and a page shorter than asked is NOT taken as the last page — a
 *  PostgREST whose max-rows is below the page size answers short pages — so
 *  each chunk advances by the rows the answer actually carried until the
 *  exact count its first answer reported is reached (or, without a count, an
 *  empty page); fewer rows than that count is a truncated read. */
async function loadFieldOutcomes(orgId: string, docIds: string[]): Promise<{ byDoc: Map<string, FieldOutcomeRow[]>; error: string | null }> {
  const byDoc = new Map<string, FieldOutcomeRow[]>();
  for (let c = 0; c < docIds.length; c += FIELD_OUTCOME_IN_CHUNK) {
    const chunk = docIds.slice(c, c + FIELD_OUTCOME_IN_CHUNK);
    let from = 0;
    let total: number | null = null;
    for (let page = 0; ; page++) {
      if (page >= FIELD_OUTCOME_MAX_PAGES) {
        return { byDoc, error: `more than ${FIELD_OUTCOME_MAX_PAGES} pages of walkdown outcomes — read a document's own panel` };
      }
      const { data, error, count } = await supabase
        .from("checkout_sessions")
        .select("id, document_id, outcome, ended_at, user_name, outcome_ref", { count: "exact" })
        .eq("org_id", orgId).in("document_id", chunk).in("outcome", [...FIELD_OUTCOMES])
        .order("ended_at", { ascending: false }).order("id", { ascending: true })
        .range(from, from + FIELD_OUTCOME_PAGE - 1);
      if (error) return { byDoc, error: error.message };
      if (total === null && typeof count === "number") total = count;
      const rows = (data ?? []) as Array<FieldOutcomeRow & { document_id: string }>;
      for (const r of rows) {
        const list = byDoc.get(r.document_id) ?? [];
        list.push(r);
        byDoc.set(r.document_id, list);
      }
      from += rows.length;
      if (total !== null && from >= total) break;
      if (rows.length === 0) {
        if (total !== null) return { byDoc, error: `the check-in register answered ${from} of ${total} walkdown outcomes` };
        break;
      }
    }
  }
  return { byDoc, error: null };
}

/** GAP-9: the currency as the CSV states it — the pill's words plus the facts
 *  (never blank when it could not be read). */
export function fieldVerificationCsv(v: FieldVerification | null): string {
  if (!v) return "";
  return `${verificationPillText(v).full}. ${verificationPillTitle(v)}`;
}

// ── Filtering (pure) ─────────────────────────────────────────────────────────

export type RegisterFilter = "all" | "unowned" | "review_overdue" | "review_due" | "acks_outstanding" | "in_review" | "effective_pending" | "legal_hold" | "disposition_eligible" | "external";

export function filterRegister(rows: RegisterRow[], filter: RegisterFilter, libraryId: string | null, query: string): RegisterRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (libraryId && r.libraryId !== libraryId) return false;
    if (filter === "unowned" && r.owned) return false;
    if (filter === "review_overdue" && r.reviewStatus !== "overdue") return false;
    if (filter === "review_due" && r.reviewStatus !== "due_soon") return false;
    if (filter === "acks_outstanding" && !(r.ackStatus === "partial" || r.ackStatus === "overdue" || r.ackStatus === "blocked")) return false;
    if (filter === "in_review" && !r.review?.inReview) return false;
    if (filter === "effective_pending" && !r.effectivePending) return false;
    if (filter === "legal_hold" && !r.legalHold) return false;
    if (filter === "disposition_eligible" && !r.dispositionEligible) return false;
    if (filter === "external" && !r.external) return false;
    if (q && !(`${r.number} ${r.title} ${r.libraryName} ${r.ownerName ?? ""} ${r.originLabel}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

// ── CSV export (pure) ────────────────────────────────────────────────────────

// PM-15: cells are encoded by lib/csvSafe's csvCell (PM-10) — a document
// titled `=HYPERLINK(...)` is written as text, never a live formula.

/** The master register as CSV — the artifact an auditor asks to be handed. */
export function registerToCsv(rows: RegisterRow[]): string {
  const header = ["Document", "Title", "Library", "Rev", "Status", "Owner", "Owner status", "Origin", "Effective", "Next review", "Review status", "Ack", "Distribution unconfirmed", "In review", "Retain until", "Legal hold", "Disposition", "Scheduled end of life", "Field verification"];
  const lines = rows.map((r) => [
    r.number, r.title, r.libraryName, r.rev ?? "", r.status ?? "",
    // DEL-8: branch on the id, not the name — an owned-but-unnamed row never
    // prints as if it fell to the controllers (same line as ownershipRegisterToCsv).
    r.ownerUserId ? (r.ownerName || "assigned member") : "— (falls to Admin/DocCtrl)",
    r.ownerUserId ? "active owner" : "unowned — falls to Admin/DocCtrl",
    r.originLabel,
    r.effectiveDate ? `${r.effectiveDate}${r.effectivePending ? " (pending)" : ""}` : "",
    r.nextReviewDate ?? "",
    r.reviewStatus,
    r.ack ? `${r.ack.done}/${r.ack.required}` : "",
    r.distributionAcksOutstanding > 0 ? String(r.distributionAcksOutstanding) : "",
    r.review?.inReview ? (r.review.revisionLabel || "yes") : "",
    r.retentionUntil ?? "",
    r.legalHold ? "HOLD" : "",
    r.dispositionEligible ? "eligible" : "",
    // RET-11: the schedule's action (never a guess when it could not be read)
    r.retentionScheduleUnknown ? "unknown (the retention policy could not be read)" : (r.retentionSchedule ?? ""),
    // GAP-9: the field-verification currency (the pill's words + the facts)
    fieldVerificationCsv(r.fieldVerification),
  ].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\n");
}
