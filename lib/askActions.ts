// lib/askActions.ts - the few actions a "Needed from you" box offers that
// had no function of their own yet. Everything else it offers calls the
// same functions the document panel already uses (markReviewed,
// recordAcknowledgment, recordReviewSignoff, acknowledge,
// resolveMarkupRequest, the check-in flow).

import { supabase } from "@/lib/supabase";
import { notifyMany } from "@/lib/inAppNotifications";
import { logAuditAction } from "@/lib/audit";

/** A reviewer sends an in-review draft back: whoever put the draft up and
 *  the document's owner are told what needs to change. The reviewer's own
 *  sign-off stays open (nothing is signed or voided), so the draft can't
 *  publish without them; a corrected draft re-opens the review as usual.
 *  Returns how many people were told. */
export async function sendBackDraft(input: {
  orgId: string;
  documentId: string;
  libraryId: string;
  versionId: string;
  draftLabel: string | null;
  docLabel: string;
  reviewerId: string;
  reviewerName: string;
  note: string;
}): Promise<number> {
  const note = input.note.trim();
  if (!note) throw new Error("Say what needs to change first.");
  const [{ data: ver }, { data: doc }] = await Promise.all([
    supabase.from("document_versions").select("created_by").eq("id", input.versionId).maybeSingle(),
    supabase.from("documents").select("owner_user_id").eq("id", input.documentId).maybeSingle(),
  ]);
  const to = [ver?.created_by as string | null, doc?.owner_user_id as string | null].filter((u): u is string => !!u);
  const draft = input.draftLabel ? ` draft ${input.draftLabel}` : " draft";
  await notifyMany({
    orgId: input.orgId,
    userIds: to,
    actorUserId: input.reviewerId,
    actorName: input.reviewerName,
    kind: "review_sent_back",
    title: `Sent back: ${input.docLabel}${draft}`,
    body: `${input.reviewerName} sent it back: ${note}`,
    link: `/documents/${input.libraryId}?doc=${input.documentId}`,
    resourceType: "document",
    resourceId: input.documentId,
    metadata: { versionId: input.versionId, note },
  });
  await logAuditAction({
    action: "REVIEW_SENT_BACK",
    resourceId: input.documentId,
    resourceType: "document",
    orgId: input.orgId,
    userId: input.reviewerId,
    userEmail: input.reviewerName,
    details: { versionId: input.versionId, draft: input.draftLabel, note },
  });
  return new Set(to.filter((u) => u !== input.reviewerId)).size;
}

/** Keep a checkout longer: moves its expected release date `days` from now
 *  (the stale-checkout reminders count from that date). */
export async function extendCheckout(sessionId: string, days: number): Promise<string> {
  const until = new Date(Date.now() + days * 86_400_000).toISOString();
  const { error } = await supabase.from("checkout_sessions").update({ expected_release_at: until }).eq("id", sessionId).eq("status", "active");
  if (error) throw new Error(error.message);
  return until;
}
