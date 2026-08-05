// lib/postPublish.ts
//
// THE shared post-publish pipeline. Every path that changes a document's
// CURRENT revision must run the same side effects — otherwise the paths
// diverge and the most controlled route (review-gated finalize) quietly
// skips the protections the direct route provides. The audit found exactly
// that: finalizeReviewedRevision and revertToVersion changed
// current_version_id and told nobody.
//
// Callers: revUpDocument (direct publish), revertToVersion,
// finalizeReviewedRevision (review-approved promote). Everything here is
// fire-and-forget best-effort — the publish already committed; signals must
// never roll it back.

import { supabase } from "@/lib/supabase";
import { emit } from "@/lib/notify/dispatch";
import { onDocumentIssued } from "@/lib/reviewCycles";
import { onDocumentIssuedAck } from "@/lib/acknowledgments";
import { recomputeRetention } from "@/lib/retention";

/** "A doc you're working on just moved" — to live intent holders + watchers.
 *  Personal-interrupt rung of the signal ladder: in-app + email, no broadcast. */
export async function notifySuperseded(input: {
  orgId: string;
  documentId: string;
  libraryId: string;
  docLabel: string;
  newRev: string;
  actorUserId: string;
  actorName: string;
}): Promise<void> {
  try {
    const { listLiveIntents } = await import("@/lib/intents");
    const intents = await listLiveIntents(input.documentId);
    const involved = [...new Set(intents.map((i) => i.userId))];
    await emit({
      orgId: input.orgId,
      category: "watched",
      kind: "doc_superseded",
      title: `${input.docLabel} advanced to Rev ${input.newRev}`,
      body: `${input.actorName} published Rev ${input.newRev}. If you are holding an older copy (downloaded or checked out), it is now superseded — refresh before continuing.`,
      link: `/documents/${input.libraryId}?doc=${input.documentId}`,
      resource: { type: "document", id: input.documentId },
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      audience: { involved, followers: true },
    });
    // Library subscribers hear about every rev-up in the library they watch —
    // the "subscriptions" idea from Hermes, on the existing watch machinery.
    await emit({
      orgId: input.orgId,
      category: "watched",
      kind: "library_doc_revised",
      title: `${input.docLabel} → Rev ${input.newRev}`,
      body: `${input.actorName} published Rev ${input.newRev} in a library you subscribe to.`,
      link: `/documents/${input.libraryId}?doc=${input.documentId}`,
      resource: { type: "library", id: input.libraryId },
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      audience: { followers: true },
    });
  } catch (e) {
    console.warn("[postPublish] supersede notify failed (non-blocking)", e);
  }
}

export interface PostPublishInput {
  orgId: string;
  documentId: string;
  libraryId: string;
  docLabel: string;
  newRev: string;
  actorUserId: string;
  actorName: string;
  /** Actor email for the compliance-clock attribution (defaults to actorName). */
  actorEmail?: string | null;
  /** Skip the compliance clocks (issue/ack/retention) — e.g. the caller
   *  already ran them, or the change isn't an issue (branch publishes never
   *  come through here). */
  skipComplianceClocks?: boolean;
}

/**
 * Run every "the current revision just changed" side effect:
 *   1. Stale-copy signal to live intent holders + watchers.
 *   2. Work-package pin-drift alerts to each open package's owner.
 *   3. Compliance clocks: review-cycle reset, fresh read-&-understood
 *      roster, retention recompute.
 * All best-effort; failures log, never throw.
 */
export async function runPostPublishSideEffects(input: PostPublishInput): Promise<void> {
  void notifySuperseded({
    orgId: input.orgId,
    documentId: input.documentId,
    libraryId: input.libraryId,
    docLabel: input.docLabel,
    newRev: input.newRev,
    actorUserId: input.actorUserId,
    actorName: input.actorName,
  });

  void import("@/lib/workPackages").then(({ notifyPackagesOfRevUp }) =>
    notifyPackagesOfRevUp({
      orgId: input.orgId,
      documentId: input.documentId,
      docLabel: input.docLabel,
      newRev: input.newRev,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
    }),
  ).catch(() => { /* non-blocking */ });

  // Revision impact: walk one hop out along the real link web (continuation
  // sheets, shared equipment, curated pins) and warn anyone actively drafting
  // against a connected document. The blind spot watching can't cover — you
  // are working on sheet 13 and sheet 12 just changed under you.
  void import("@/lib/revisionImpact").then(({ notifyConnectedWork }) =>
    notifyConnectedWork({
      orgId: input.orgId,
      documentId: input.documentId,
      libraryId: input.libraryId,
      docLabel: input.docLabel,
      newRev: input.newRev,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
    }),
  ).catch(() => { /* non-blocking */ });

  // Proposals derived from the revision this one replaces are ghosts of a
  // drawing that no longer says that — retire them rather than let review
  // act on stale evidence.
  void import("@/lib/linkProposals").then(({ staleProposalsForDocument }) =>
    staleProposalsForDocument(input.documentId, input.newRev),
  ).catch(() => { /* non-blocking */ });

  if (!input.skipComplianceClocks) {
    try {
      await onDocumentIssued({ orgId: input.orgId, documentId: input.documentId, userId: input.actorUserId, userName: input.actorEmail ?? input.actorName });
    } catch { /* best-effort */ }
    try {
      await onDocumentIssuedAck({ orgId: input.orgId, documentId: input.documentId, actorId: input.actorUserId, actorName: input.actorEmail ?? input.actorName });
    } catch { /* best-effort */ }
    try { await recomputeRetention(input.documentId); } catch { /* best-effort */ }
  }
}

/** Retirement counterpart: tell open packages a pinned document was
 *  superseded/voided — a retired sheet in a job pack is worse than a stale
 *  one, and the pack UI can't see it via pin drift (the pin still matches). */
export async function notifyPackagesOfRetirement(input: {
  orgId: string;
  documentId: string;
  docLabel: string;
  newStatus: string;
  actorUserId: string;
  actorName: string;
}): Promise<void> {
  try {
    const { data: memberRows } = await supabase
      .from("work_package_documents")
      .select("package_id")
      .eq("document_id", input.documentId);
    const pkgIds = [...new Set(((memberRows as Array<{ package_id: string }>) ?? []).map((r) => r.package_id))];
    if (pkgIds.length === 0) return;
    const { data: pkgs } = await supabase
      .from("work_packages")
      .select("id, name, owner_user_id")
      .in("id", pkgIds)
      .neq("status", "closed");
    const { notifyMany } = await import("@/lib/inAppNotifications");
    for (const p of (pkgs as Array<{ id: string; name: string; owner_user_id: string }>) ?? []) {
      void notifyMany({
        orgId: input.orgId,
        userIds: [p.owner_user_id],
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        kind: "doc_superseded",
        title: `${input.docLabel} was ${input.newStatus.toLowerCase()} — it's in your pack "${p.name}"`,
        body: `A document pinned in your work package has been ${input.newStatus.toLowerCase()}. Pull it from the pack or replace it before the pack is used again.`,
        link: `/packages?pkg=${p.id}`,
        resourceType: "document",
        resourceId: input.documentId,
        metadata: { packageId: p.id, retirement: true },
      });
    }
  } catch { /* pre-migration env / non-blocking */ }
}
