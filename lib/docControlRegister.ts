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
import { resolveEffectiveOwner } from "@/lib/ownership";
import { reviewStatusFor, daysUntilReview, type ReviewStatus } from "@/lib/reviewCycles";
import { getAckSummaries, ackStatusFor, type AckSummary, type AckStatus } from "@/lib/acknowledgments";
import { getReviewSummaries, type ReviewSummary } from "@/lib/reviewControl";
import { effectiveStatusFor } from "@/lib/effectiveDate";
import { retentionStatusFor } from "@/lib/retention";
import { describeOrigin } from "@/lib/documentOrigin";

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
  // Pre-publish review in progress
  review: ReviewSummary | null;
  // Effective date (a future date = issued but not yet in force)
  effectiveDate: string | null;
  effectivePending: boolean;
  // Records management
  retentionUntil: string | null;
  legalHold: boolean;
  dispositionEligible: boolean;
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

type OwnerCols = { id: string; owner_user_id: string | null; owner_name: string | null; name?: string | null };

/** Load the whole register for an org. Controlled documents only (Issued /
 *  Locked — never Draft/Superseded/Void/Archived). ~5 queries total regardless
 *  of document count. `limit` caps very large orgs (flagged via `capped`). */
export async function loadDocControlRegister(orgId: string, opts?: { limit?: number }): Promise<{ rows: RegisterRow[]; kpis: RegisterKpis; capped: boolean }> {
  const limit = opts?.limit ?? 4000;
  const { data: docsData } = await supabase
    .from("documents")
    .select("id, document_number, title, name, library_id, collection_id, status, rev, updated_at, owner_user_id, owner_name, next_review_date, pending_version_id, effective_date, retention_until, disposition_state, legal_hold, origin, external_source, external_reference")
    .eq("org_id", orgId)
    .not("status", "in", "(Draft,Superseded,Void,Archived)")
    .order("updated_at", { ascending: false })
    .limit(limit);
  const docs = (docsData ?? []) as Array<Record<string, unknown>>;
  const capped = docs.length >= limit;
  if (!docs.length) return { rows: [], kpis: computeRegisterKpis([]), capped };

  const docIds = docs.map((d) => d.id as string);
  const [{ data: libs }, { data: cols }, ackMap, reviewMap] = await Promise.all([
    supabase.from("libraries").select("id, name, owner_user_id, owner_name").eq("org_id", orgId),
    supabase.from("collections").select("id, owner_user_id, owner_name").eq("org_id", orgId),
    getAckSummaries(orgId, docIds),
    getReviewSummaries(orgId, docIds),
  ]);
  const libMap = new Map((libs ?? []).map((l) => [(l as OwnerCols).id, l as OwnerCols]));
  const colMap = new Map((cols ?? []).map((c) => [(c as OwnerCols).id, c as OwnerCols]));

  const rows: RegisterRow[] = docs.map((d) => {
    const libraryId = d.library_id as string;
    const collectionId = (d.collection_id as string | null) ?? null;
    const lib = libMap.get(libraryId);
    const owner = resolveEffectiveOwner(
      { owner_user_id: (d.owner_user_id as string | null) ?? null, owner_name: (d.owner_name as string | null) ?? null },
      collectionId ? colMap.get(collectionId) ?? null : null,
      lib ?? null,
    );
    const nextReviewDate = (d.next_review_date as string | null) ?? null;
    const ack = ackMap.get(d.id as string) ?? null;
    const review = reviewMap.get(d.id as string) ?? null;
    return {
      id: d.id as string,
      number: (d.document_number as string) || (d.title as string) || (d.name as string) || "—",
      title: (d.title as string) || (d.name as string) || "",
      libraryId,
      libraryName: (lib?.name as string) || "—",
      status: (d.status as string | null) ?? null,
      rev: (d.rev as string | null) ?? null,
      updatedAt: (d.updated_at as string | null) ?? null,
      ownerName: owner.name,
      ownerUserId: owner.userId,
      owned: !!owner.userId,
      nextReviewDate,
      reviewStatus: reviewStatusFor(nextReviewDate),
      reviewDaysLeft: daysUntilReview(nextReviewDate),
      ack,
      ackStatus: ackStatusFor(ack),
      review,
      effectiveDate: (d.effective_date as string | null) ?? null,
      effectivePending: effectiveStatusFor((d.effective_date as string | null) ?? null) === "pending",
      retentionUntil: (d.retention_until as string | null) ?? null,
      legalHold: !!d.legal_hold,
      dispositionEligible: retentionStatusFor({ retentionUntil: (d.retention_until as string | null) ?? null, dispositionState: (d.disposition_state as string | null) ?? null, legalHold: !!d.legal_hold }) === "eligible",
      external: (d.origin as string | null) === "external",
      originLabel: describeOrigin({ origin: (d.origin as "internal" | "external" | null) ?? null, externalSource: (d.external_source as string | null) ?? null, externalReference: (d.external_reference as string | null) ?? null }),
    };
  });

  return { rows, kpis: computeRegisterKpis(rows), capped };
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

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The master register as CSV — the artifact an auditor asks to be handed. */
export function registerToCsv(rows: RegisterRow[]): string {
  const header = ["Document", "Title", "Library", "Rev", "Status", "Owner", "Origin", "Effective", "Next review", "Review status", "Ack", "In review", "Retain until", "Legal hold", "Disposition"];
  const lines = rows.map((r) => [
    r.number, r.title, r.libraryName, r.rev ?? "", r.status ?? "",
    r.ownerName ?? "Admin/DocCtrl",
    r.originLabel,
    r.effectiveDate ? `${r.effectiveDate}${r.effectivePending ? " (pending)" : ""}` : "",
    r.nextReviewDate ?? "",
    r.reviewStatus,
    r.ack ? `${r.ack.done}/${r.ack.required}` : "",
    r.review?.inReview ? (r.review.revisionLabel || "yes") : "",
    r.retentionUntil ?? "",
    r.legalHold ? "HOLD" : "",
    r.dispositionEligible ? "eligible" : "",
  ].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\n");
}
