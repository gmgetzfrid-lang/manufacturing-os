// lib/reviewControl.ts
//
// Review & approval BEFORE publish — the 2A -> 2B -> 2 lifecycle. In a library
// whose change-control mode requires it, a non-minor, non-ticket rev-up opens an
// in-review DRAFT that required reviewers must e-sign before it becomes the
// controlled revision. The currently published rev stays live the whole time.
//
// This module owns the POLICY (mode resolution + escape hatches), the reviewer
// ROSTER (primaries + alternates), the SIGN-OFF integrity (each signature binds
// to the exact draft's content hash; a new draft voids prior sign-offs), the
// FINALIZE step (promote the approved draft to the controlled rev), and the daily
// SCAN (auto-activate alternates on timeout, escalate stalled reviews). File
// upload + draft-version creation live in lib/revisions.ts (submitForReview).

import { supabase } from "@/lib/supabase";
import { notify } from "@/lib/inAppNotifications";
import { logAuditAction } from "@/lib/audit";
import { recordSignature } from "@/lib/eSignatures";
import { effectiveOwnerForDocument, resolveEffectiveOwner, getOrgControllers } from "@/lib/ownership";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";
import { applyEffectiveDate } from "@/lib/effectiveDate";
import type { ReviewControl, ReviewControlMode } from "@/types/schema";

type Level = "library" | "collection" | "document";
interface ControlCols { review_control?: ReviewControl | null }
const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));
const NONE: ReviewControl = { mode: "none" };
const DEFAULT_TIMEOUT_DAYS = 7;

// ── Policy resolution (most specific DEFINED level wins) ──────────────────────

export function resolveEffectiveReviewControl(
  docControl?: ReviewControl | null, folderControl?: ReviewControl | null, libraryControl?: ReviewControl | null,
): ReviewControl {
  for (const c of [docControl, folderControl, libraryControl]) {
    if (c) return c;
  }
  return NONE;
}

export async function effectiveReviewControlForDocument(doc: {
  reviewControl?: ReviewControl | null; collectionId?: string | null; libraryId: string;
}): Promise<ReviewControl> {
  let folder: ReviewControl | null = null;
  if (doc.collectionId) {
    const { data } = await supabase.from("collections").select("review_control").eq("id", doc.collectionId).maybeSingle();
    folder = (data as ControlCols)?.review_control ?? null;
  }
  const { data: lib } = await supabase.from("libraries").select("review_control").eq("id", doc.libraryId).maybeSingle();
  return resolveEffectiveReviewControl(doc.reviewControl ?? null, folder, (lib as ControlCols)?.review_control ?? null);
}

/** The mode that actually applies to THIS rev-up, after the two escape hatches:
 *  a Minor/Correction change and a rev that came from a drafting ticket always
 *  skip the gate (they don't need — or already had — review). */
export function effectiveModeForRevUp(input: {
  control: ReviewControl; changeType?: string | null; relatedTicketId?: string | null;
}): ReviewControlMode {
  if (input.control.mode === "none") return "none";
  if (input.changeType === "Minor" || input.changeType === "Correction") return "none";
  if (input.relatedTicketId) return "none";
  return input.control.mode; // 'require' or 'publisher_choice'
}

// ── Reviewer expansion ───────────────────────────────────────────────────────

export interface Reviewer { uid: string; name: string | null; role: string | null; source: "person" | "role" }

async function expandSet(orgId: string, ids: string[], roles: string[], warnings: string[], label: string): Promise<Map<string, Reviewer>> {
  const out = new Map<string, Reviewer>();
  const idList = uniq(ids);
  if (idList.length) {
    const { data } = await supabase.from("org_members").select("uid, display_name, email, status").eq("org_id", orgId).in("uid", idList);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const found = new Set(rows.map((r) => r.uid as string));
    for (const r of rows) {
      const name = (r.display_name as string) || (r.email as string) || null;
      if (r.status !== "active") { warnings.push(`${label}: ${name || r.uid} is not an active member`); continue; }
      out.set(r.uid as string, { uid: r.uid as string, name, role: null, source: "person" });
    }
    for (const id of idList) if (!found.has(id)) warnings.push(`${label}: an assigned person is no longer in the organization`);
  }
  const roleList = uniq(roles);
  if (roleList.length) {
    const { data } = await supabase.from("org_members").select("uid, display_name, email, role").eq("org_id", orgId).eq("status", "active").in("role", roleList);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const covered = new Set(rows.map((r) => r.role as string));
    for (const r of rows) {
      const uidv = r.uid as string;
      if (!out.has(uidv)) out.set(uidv, { uid: uidv, name: (r.display_name as string) || (r.email as string) || null, role: r.role as string, source: "role" });
    }
    for (const role of roleList) if (!covered.has(role)) warnings.push(`${label}: role "${role}" has no active members`);
  }
  return out;
}

/** Resolve primaries + alternates. Someone listed as both is treated as a primary
 *  (accountable), never double-counted. */
export async function expandReviewers(orgId: string, control: ReviewControl): Promise<{ primaries: Reviewer[]; alternates: Reviewer[]; warnings: string[] }> {
  const warnings: string[] = [];
  const primaryMap = await expandSet(orgId, control.reviewerIds ?? [], control.reviewerRoles ?? [], warnings, "Reviewer");
  const alternateMap = await expandSet(orgId, control.alternateIds ?? [], control.alternateRoles ?? [], warnings, "Alternate");
  for (const uid of primaryMap.keys()) alternateMap.delete(uid); // primary wins
  return { primaries: Array.from(primaryMap.values()), alternates: Array.from(alternateMap.values()), warnings };
}

// ── Policy set (doc / folder / library) — authority-gated in the UI ──────────

/** Persist the change-control policy at a level. Configuring it is restricted to
 *  Admin/DocCtrl or a delegated owner (enforced in the UI); this just writes +
 *  logs. New rosters open at the next rev-up, so no recompute is needed here. */
export async function setReviewControlPolicy(input: {
  level: Level; id: string; orgId: string; control: ReviewControl | null;
  actorId?: string | null; actorName?: string | null;
}): Promise<void> {
  const table = input.level === "library" ? "libraries" : input.level === "collection" ? "collections" : "documents";
  await supabase.from(table).update({ review_control: input.control }).eq("id", input.id);
  await logAuditAction({
    action: input.control ? "REVIEW_CONTROL_SET" : "REVIEW_CONTROL_CLEARED",
    resourceType: input.level, resourceId: input.id, orgId: input.orgId, userId: input.actorId ?? "",
    details: { control: input.control },
  }).catch(() => {});
}

// ── Rev-letter helper ────────────────────────────────────────────────────────

/** The in-review letter label. From a numeric base "2" -> "2A"; bumping an
 *  existing draft "2A" -> "2B". Falls back to appending "A" for odd bases. */
export function letterLabelFor(baseRev: string, existingDraftLabel?: string | null): string {
  if (existingDraftLabel) {
    const m = existingDraftLabel.match(/^(.*?)([A-Y])$/i);
    if (m) return `${m[1]}${String.fromCharCode(m[2].toUpperCase().charCodeAt(0) + 1)}`;
    return `${existingDraftLabel}A`;
  }
  return `${baseRev}A`;
}

// ── Roster open / invalidate ─────────────────────────────────────────────────

export interface ReviewSignoffRow {
  id: string; documentVersionId: string | null; revisionLabel: string | null; contentHash: string | null;
  reviewerUserId: string; reviewerName: string | null; reviewerRole: string | null;
  slot: "primary" | "alternate"; source: string; activated: boolean;
  status: "pending" | "signed" | "invalidated" | "void"; signatureId: string | null; signedAt: string | null; assignedAt: string;
}

function rowToSignoff(r: Record<string, unknown>): ReviewSignoffRow {
  return {
    id: r.id as string,
    documentVersionId: (r.document_version_id as string) ?? null,
    revisionLabel: (r.revision_label as string) ?? null,
    contentHash: (r.content_hash as string) ?? null,
    reviewerUserId: r.reviewer_user_id as string,
    reviewerName: (r.reviewer_name as string) ?? null,
    reviewerRole: (r.reviewer_role as string) ?? null,
    slot: (r.slot as ReviewSignoffRow["slot"]) ?? "primary",
    source: (r.source as string) ?? "person",
    activated: r.activated !== false,
    status: r.status as ReviewSignoffRow["status"],
    signatureId: (r.signature_id as string) ?? null,
    signedAt: (r.signed_at as string) ?? null,
    assignedAt: r.assigned_at as string,
  };
}

/** Open a fresh reviewer roster for an in-review draft: primaries active + notified,
 *  alternates inactive (they wait for the timeout or a manual activation). Flags a
 *  gap to owner + Admin/DocCtrl if no primary reviewer resolves. */
export async function openReviewRoster(input: {
  orgId: string; documentId: string; libraryId: string; versionId: string;
  revisionLabel: string; contentHash: string | null; control: ReviewControl;
  actorId?: string | null; actorName?: string | null;
}): Promise<void> {
  const { primaries, alternates, warnings } = await expandReviewers(input.orgId, input.control);
  const nowIso = new Date().toISOString();
  const link = `/documents/${input.libraryId}?doc=${input.documentId}`;
  const rows = [
    ...primaries.map((r) => ({ r, slot: "primary" as const, activated: true })),
    ...alternates.map((r) => ({ r, slot: "alternate" as const, activated: false })),
  ];
  if (rows.length) {
    await supabase.from("document_review_signoffs").upsert(
      rows.map(({ r, slot, activated }) => ({
        org_id: input.orgId, document_id: input.documentId, document_version_id: input.versionId,
        revision_label: input.revisionLabel, content_hash: input.contentHash,
        reviewer_user_id: r.uid, reviewer_name: r.name, reviewer_role: r.role, slot, source: r.source,
        activated, status: "pending", assigned_by: input.actorId ?? null, assigned_at: nowIso, notified_at: activated ? nowIso : null,
      })),
      { onConflict: "document_version_id,reviewer_user_id", ignoreDuplicates: true },
    );
    await Promise.all(primaries.filter((r) => r.uid !== input.actorId).map((r) =>
      notify({
        orgId: input.orgId, userId: r.uid, kind: "review_requested",
        title: `Review requested: ${input.revisionLabel}`,
        body: "A draft revision is waiting for your sign-off before it can publish.",
        link, resourceType: "document", resourceId: input.documentId,
        actorUserId: input.actorId ?? undefined, actorName: input.actorName ?? undefined,
      })
    ));
    await logAuditAction({
      action: "REVIEW_REQUESTED", resourceType: "document", resourceId: input.documentId,
      orgId: input.orgId, userId: input.actorId ?? "",
      details: { revision: input.revisionLabel, primaries: primaries.length, alternates: alternates.length },
    }).catch(() => {});
  }
  if (primaries.length === 0 || warnings.length) {
    const owner = await effectiveOwnerForDocument({ ownerUserId: null, ownerName: null, collectionId: null, libraryId: input.libraryId });
    const controllers = await getOrgControllers(input.orgId);
    const targets = uniq([...(owner.userId ? [owner.userId] : []), ...controllers]);
    const msg = primaries.length === 0
      ? `A rev of ${input.revisionLabel} needs review, but no reviewer resolved — it can't publish until reviewers are set.`
      : `The reviewer roster for ${input.revisionLabel} has gaps: ${warnings.join("; ")}.`;
    await Promise.all(targets.map((uid) =>
      notify({ orgId: input.orgId, userId: uid, kind: "review_overdue", title: `Review needs attention: ${input.revisionLabel}`, body: msg, link, resourceType: "document", resourceId: input.documentId })
    ));
  }
}

/** A new draft (2A -> 2B) voids the prior draft's sign-offs and tells the earlier
 *  signers their approval no longer applies. */
export async function invalidateDraftSignoffs(input: {
  orgId: string; documentId: string; libraryId: string; oldVersionId: string; newRevisionLabel: string;
}): Promise<void> {
  const { data } = await supabase.from("document_review_signoffs")
    .select("id, reviewer_user_id, status").eq("document_id", input.documentId).eq("document_version_id", input.oldVersionId).eq("status", "signed");
  const signed = (data ?? []) as Array<Record<string, unknown>>;
  await supabase.from("document_review_signoffs")
    .update({ status: "invalidated", updated_at: new Date().toISOString() })
    .eq("document_id", input.documentId).eq("document_version_id", input.oldVersionId).in("status", ["pending", "signed"]);
  const link = `/documents/${input.libraryId}?doc=${input.documentId}`;
  await Promise.all(signed.map((r) =>
    notify({
      orgId: input.orgId, userId: r.reviewer_user_id as string, kind: "review_invalidated",
      title: `Re-review needed: ${input.newRevisionLabel}`,
      body: "The draft you approved was changed. Your sign-off was voided — please review the new draft.",
      link, resourceType: "document", resourceId: input.documentId,
    })
  ));
}

// ── Signing ──────────────────────────────────────────────────────────────────

/** Record a reviewer's sign-off (e-signature bound to the draft's content hash),
 *  mark their roster row signed, and notify the owner/publisher when the last
 *  required sign-off lands. */
export async function recordReviewSignoff(input: {
  orgId: string; documentId: string; libraryId: string; versionId: string; revisionLabel: string; contentHash?: string | null;
  signoffId: string; signerUserId: string; signerName: string; signerRole?: string | null; signerEmail?: string | null;
  statement: string; signatureImage?: string | null;
}): Promise<void> {
  const sig = await recordSignature({
    orgId: input.orgId, resourceType: "document_version", resourceId: input.versionId,
    documentVersionId: input.versionId, contentHash: input.contentHash ?? null,
    intent: "Reviewed", statement: input.statement,
    signerUserId: input.signerUserId, signerName: input.signerName,
    signerRole: input.signerRole ?? undefined, signerEmail: input.signerEmail ?? undefined,
    signatureImage: input.signatureImage ?? undefined,
  });
  const nowIso = new Date().toISOString();
  await supabase.from("document_review_signoffs")
    .update({ status: "signed", signature_id: sig.id, signed_at: nowIso, updated_at: nowIso })
    .eq("id", input.signoffId);

  const { complete } = await reviewCompletionForDraft(input.documentId, input.versionId);
  const owner = await effectiveOwnerForDocument({ ownerUserId: null, ownerName: null, collectionId: null, libraryId: input.libraryId });
  const controllers = await getOrgControllers(input.orgId);
  const link = `/documents/${input.libraryId}?doc=${input.documentId}`;
  const watchers = uniq([...(owner.userId ? [owner.userId] : controllers)]).filter((u) => u !== input.signerUserId);
  await Promise.all(watchers.map((uid) =>
    notify({
      orgId: input.orgId, userId: uid, kind: complete ? "review_complete" : "review_signed",
      title: complete ? `Ready to publish: ${input.revisionLabel}` : `Reviewer signed: ${input.revisionLabel}`,
      body: complete ? "All required reviewers have signed off — the revision can be published." : `${input.signerName} signed off on the draft.`,
      link, resourceType: "document", resourceId: input.documentId,
      actorUserId: input.signerUserId, actorName: input.signerName,
    })
  ));
}

// ── Completion + roster reads ────────────────────────────────────────────────

export async function listDraftRoster(documentId: string, versionId?: string | null): Promise<ReviewSignoffRow[]> {
  let q = supabase.from("document_review_signoffs").select("*").eq("document_id", documentId).in("status", ["pending", "signed"]);
  if (versionId) q = q.eq("document_version_id", versionId);
  const { data } = await q.order("slot", { ascending: true }).order("reviewer_name", { ascending: true });
  return ((data ?? []) as Array<Record<string, unknown>>).map(rowToSignoff);
}

/** Completion for a draft: required = number of PRIMARY reviewers; a signature
 *  from a primary OR an activated alternate counts. Complete when signed >= required. */
export async function reviewCompletionForDraft(documentId: string, versionId: string): Promise<{ requiredPrimaries: number; signed: number; complete: boolean; roster: ReviewSignoffRow[] }> {
  const roster = await listDraftRoster(documentId, versionId);
  const requiredPrimaries = roster.filter((r) => r.slot === "primary").length;
  const signed = roster.filter((r) => r.status === "signed").length;
  const complete = requiredPrimaries > 0 && signed >= requiredPrimaries;
  return { requiredPrimaries, signed, complete, roster };
}

// ── Alternates ───────────────────────────────────────────────────────────────

/** Manually activate an alternate (Admin/DocCtrl action when a primary is out). */
export async function activateAlternate(input: { orgId: string; documentId: string; libraryId: string; signoffId: string; actorId?: string | null }): Promise<void> {
  const { data } = await supabase.from("document_review_signoffs")
    .update({ activated: true, notified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", input.signoffId).select("reviewer_user_id, revision_label").maybeSingle();
  if (!data) return;
  await notify({
    orgId: input.orgId, userId: data.reviewer_user_id as string, kind: "review_alternate_activated",
    title: `You're now an active reviewer: ${(data.revision_label as string) || "a draft"}`,
    body: "You've been activated as an alternate reviewer — a draft is waiting for your sign-off.",
    link: `/documents/${input.libraryId}?doc=${input.documentId}`, resourceType: "document", resourceId: input.documentId,
    actorUserId: input.actorId ?? undefined,
  });
  await logAuditAction({ action: "REVIEW_ALTERNATE_ACTIVATED", resourceType: "document", resourceId: input.documentId, orgId: input.orgId, userId: input.actorId ?? "", details: { signoffId: input.signoffId } }).catch(() => {});
}

// ── Finalize (promote the approved draft to the controlled rev) ───────────────

/** Publish an approved in-review draft: promote it to current, drop the letter
 *  (2A -> 2), supersede the prior rev, and run the issue hooks (review clock +
 *  read-&-understood roster). The document UPDATE is guarded server-side by the
 *  existing publish trigger, so only an authorized publisher/owner can finalize. */
export async function finalizeReviewedRevision(input: {
  orgId: string; documentId: string; actorId?: string | null; actorName?: string | null;
}): Promise<{ published: boolean; reason?: string }> {
  const { data: docRow } = await supabase.from("documents")
    .select("id, library_id, rev, current_version_id, pending_version_id").eq("id", input.documentId).maybeSingle();
  if (!docRow) return { published: false, reason: "not_found" };
  const pendingId = docRow.pending_version_id as string | null;
  if (!pendingId) return { published: false, reason: "no_pending_draft" };

  const { complete } = await reviewCompletionForDraft(input.documentId, pendingId);
  if (!complete) return { published: false, reason: "incomplete" };

  const { data: ver } = await supabase.from("document_versions").select("base_rev, revision_label, effective_date").eq("id", pendingId).maybeSingle();
  const baseRev = (ver?.base_rev as string) || (ver?.revision_label as string) || "";
  const effectiveDate = (ver?.effective_date as string | null) ?? null;
  const previousVersionId = (docRow.current_version_id as string | null) ?? null;
  const nowIso = new Date().toISOString();

  await supabase.from("document_versions")
    .update({ review_state: "approved", revision_label: baseRev, released_at: nowIso, supersedes_version_id: previousVersionId, updated_at: nowIso })
    .eq("id", pendingId);
  if (previousVersionId) {
    await supabase.from("document_versions").update({ superseded_at: nowIso }).eq("id", previousVersionId);
  }
  const { error: docErr } = await supabase.from("documents")
    .update({ current_version_id: pendingId, rev: baseRev, revision: baseRev, status: "Issued", pending_version_id: null, updated_at: nowIso, updated_by: input.actorId })
    .eq("id", input.documentId);
  if (docErr) return { published: false, reason: docErr.message };

  // Carry the draft's effective date onto the now-controlled document.
  await applyEffectiveDate({ documentId: input.documentId, versionId: pendingId, effectiveDate });

  await logAuditAction({
    action: "REVISION_PUBLISHED_AFTER_REVIEW", resourceType: "document", resourceId: input.documentId,
    orgId: input.orgId, userId: input.actorId ?? "", details: { rev: baseRev, versionId: pendingId },
  }).catch(() => {});
  await onDocumentIssued({ orgId: input.orgId, documentId: input.documentId, userId: input.actorId ?? null, userName: input.actorName ?? null });
  await onDocumentIssuedAck({ orgId: input.orgId, documentId: input.documentId, actorId: input.actorId, actorName: input.actorName });
  return { published: true };
}

// ── Daily scan: activate alternates on timeout + escalate ─────────────────────

export async function scanReviews(orgId: string, opts?: { cooldownDays?: number }): Promise<number> {
  const cooldownDays = opts?.cooldownDays ?? 5;
  const { data } = await supabase.from("document_review_signoffs")
    .select("id, document_id, document_version_id, reviewer_user_id, reviewer_name, revision_label, slot, activated, notified_at, assigned_at")
    .eq("org_id", orgId).eq("status", "pending");
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return 0;

  const docIds = uniq(rows.map((r) => r.document_id as string));
  const [{ data: docs }, { data: libs }, { data: cols }, controllers] = await Promise.all([
    supabase.from("documents").select("id, library_id, collection_id, review_control, owner_user_id, owner_name").in("id", docIds),
    supabase.from("libraries").select("id, review_control, owner_user_id, owner_name").eq("org_id", orgId),
    supabase.from("collections").select("id, review_control, owner_user_id, owner_name").eq("org_id", orgId),
    getOrgControllers(orgId),
  ]);
  const dm = new Map((docs ?? []).map((d) => [(d as Record<string, unknown>).id as string, d as Record<string, unknown>]));
  const libMap = new Map((libs ?? []).map((l) => [(l as Record<string, unknown>).id as string, l as Record<string, unknown>]));
  const colMap = new Map((cols ?? []).map((c) => [(c as Record<string, unknown>).id as string, c as Record<string, unknown>]));

  const now = Date.now();
  const cooldownMs = cooldownDays * 86_400_000;
  let n = 0;

  for (const r of rows) {
    const doc = dm.get(r.document_id as string);
    if (!doc) continue;
    const control = resolveEffectiveReviewControl(
      (doc.review_control as ReviewControl | null) ?? null,
      doc.collection_id ? ((colMap.get(doc.collection_id as string)?.review_control as ReviewControl | null) ?? null) : null,
      (libMap.get(doc.library_id as string)?.review_control as ReviewControl | null) ?? null,
    );
    const timeoutDays = control.timeoutDays ?? DEFAULT_TIMEOUT_DAYS;
    const ageDays = Math.floor((now - new Date(r.assigned_at as string).getTime()) / 86_400_000);
    const label = (r.revision_label as string) || "a draft";
    const link = `/documents/${doc.library_id as string}?doc=${r.document_id as string}`;

    // Auto-activate a still-inactive alternate once the review is past timeout.
    if (r.slot === "alternate" && r.activated === false && ageDays >= timeoutDays) {
      await activateAlternate({ orgId, documentId: r.document_id as string, libraryId: doc.library_id as string, signoffId: r.id as string, actorId: null });
      n++;
      continue;
    }
    if (r.slot === "alternate" && r.activated === false) continue; // inactive alternate, not yet due

    if (r.notified_at && now - new Date(r.notified_at as string).getTime() < cooldownMs) continue;

    await notify({
      orgId, userId: r.reviewer_user_id as string, kind: "review_requested",
      title: `Reminder — review ${label}`,
      body: "A draft revision is still waiting on your sign-off.",
      link, resourceType: "document", resourceId: r.document_id as string,
    });
    if (ageDays >= timeoutDays) {
      const owner = resolveEffectiveOwner(
        { owner_user_id: doc.owner_user_id as string | null, owner_name: doc.owner_name as string | null },
        doc.collection_id ? (colMap.get(doc.collection_id as string) as { owner_user_id?: string | null; owner_name?: string | null } | undefined) : null,
        libMap.get(doc.library_id as string) as { owner_user_id?: string | null; owner_name?: string | null } | undefined,
      );
      const escalateTo = uniq([...(owner.userId ? [owner.userId] : []), ...controllers]).filter((u) => u !== (r.reviewer_user_id as string));
      await Promise.all(escalateTo.map((uid) =>
        notify({ orgId, userId: uid, kind: "review_overdue", title: `Review overdue: ${label}`, body: `${(r.reviewer_name as string) || "A reviewer"} hasn't signed off — ${ageDays} days outstanding.`, link, resourceType: "document", resourceId: r.document_id as string })
      ));
    }
    await supabase.from("document_review_signoffs").update({ notified_at: new Date().toISOString() }).eq("id", r.id as string);
    n++;
  }
  return n;
}

// ── Queue + summaries (column-independent surfaces) ───────────────────────────

export interface MyPendingReview { signoffId: string; documentId: string; libraryId: string; label: string; revisionLabel: string | null; assignedAt: string }

export async function listMyPendingReviews(orgId: string, uid: string): Promise<MyPendingReview[]> {
  if (!uid) return [];
  const { data } = await supabase.from("document_review_signoffs")
    .select("id, document_id, revision_label, assigned_at, slot, activated")
    .eq("org_id", orgId).eq("reviewer_user_id", uid).eq("status", "pending").order("assigned_at", { ascending: true });
  // Only surface work the reviewer can actually do (primaries, or activated alternates).
  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((r) => r.slot === "primary" || r.activated !== false);
  if (!rows.length) return [];
  const docIds = uniq(rows.map((r) => r.document_id as string));
  const { data: docs } = await supabase.from("documents").select("id, library_id, document_number, title, name").in("id", docIds);
  const dm = new Map((docs ?? []).map((d) => [(d as Record<string, unknown>).id as string, d as Record<string, unknown>]));
  return rows.map((r) => {
    const d = dm.get(r.document_id as string);
    return {
      signoffId: r.id as string, documentId: r.document_id as string,
      libraryId: (d?.library_id as string) ?? "",
      label: (d?.document_number as string) || (d?.title as string) || (d?.name as string) || "Document",
      revisionLabel: (r.revision_label as string) ?? null, assignedAt: r.assigned_at as string,
    };
  });
}

export type ReviewGateStatus = "none" | "in_review" | "ready";
export interface ReviewSummary { inReview: boolean; requiredPrimaries: number; signed: number; ready: boolean; revisionLabel: string | null }

/** Per-document in-review status for the list pill. One query over the pending
 *  drafts of the visible docs; completion computed from the roster. */
export async function getReviewSummaries(orgId: string, documentIds: string[]): Promise<Map<string, ReviewSummary>> {
  const map = new Map<string, ReviewSummary>();
  const ids = uniq(documentIds);
  if (!ids.length) return map;
  const { data: docs } = await supabase.from("documents").select("id, pending_version_id").in("id", ids).not("pending_version_id", "is", null);
  const pend = (docs ?? []) as Array<Record<string, unknown>>;
  if (!pend.length) return map;
  const versionIds = pend.map((d) => d.pending_version_id as string);
  const { data: signoffs } = await supabase.from("document_review_signoffs")
    .select("document_id, document_version_id, revision_label, slot, status")
    .in("document_version_id", versionIds).in("status", ["pending", "signed"]);
  const byDoc = new Map<string, { primaries: number; signed: number; label: string | null }>();
  for (const s of (signoffs ?? []) as Array<Record<string, unknown>>) {
    const did = s.document_id as string;
    const agg = byDoc.get(did) ?? { primaries: 0, signed: 0, label: null };
    if (s.slot === "primary") agg.primaries++;
    if (s.status === "signed") agg.signed++;
    agg.label = (s.revision_label as string) ?? agg.label;
    byDoc.set(did, agg);
  }
  for (const d of pend) {
    const did = d.id as string;
    const agg = byDoc.get(did) ?? { primaries: 0, signed: 0, label: null };
    map.set(did, { inReview: true, requiredPrimaries: agg.primaries, signed: agg.signed, ready: agg.primaries > 0 && agg.signed >= agg.primaries, revisionLabel: agg.label });
  }
  return map;
}

export function reviewStatusFor(summary?: ReviewSummary | null): ReviewGateStatus {
  if (!summary || !summary.inReview) return "none";
  return summary.ready ? "ready" : "in_review";
}
