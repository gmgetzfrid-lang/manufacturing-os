// lib/effectiveDate.ts
//
// Effective date — the date a controlled revision comes INTO FORCE, which may be
// later than its issue date (e.g. a procedure that takes effect after a training
// window). This is a date + badge + notification concept: the revision is still
// the current controlled version (which rev is served never changes here); it
// simply shows "Effective <date>" until the day arrives, then flips and the
// owner + acknowledgment assignees are told it's now in force.

import { supabase } from "@/lib/supabase";
import { notify } from "@/lib/inAppNotifications";
import { effectiveOwnerForDocument, getOrgControllers } from "@/lib/ownership";

export type EffectiveStatus = "none" | "pending" | "effective";

const todayISO = () => new Date().toISOString().slice(0, 10);

/** `none` = no future effective date (effective immediately / already in force);
 *  `pending` = a future effective date not yet reached; `effective` = the date
 *  has arrived/passed. Only `pending` warrants a badge. */
export function effectiveStatusFor(effectiveDate?: string | null): EffectiveStatus {
  if (!effectiveDate) return "none";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const eff = new Date(`${effectiveDate.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(eff.getTime())) return "none";
  if (eff.getTime() > today.getTime()) return "pending";
  return "effective";
}

/** Whole days until the effective date (negative = already effective). */
export function daysUntilEffective(effectiveDate?: string | null): number | null {
  if (!effectiveDate) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const eff = new Date(`${effectiveDate.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(eff.getTime())) return null;
  return Math.ceil((eff.getTime() - today.getTime()) / 86_400_000);
}

/** Persist an effective date onto a version + denormalize it onto the document.
 *  If the date is immediate (null / today / past) we pre-stamp the notify
 *  watermark so the "now in effect" notice never fires for it — only a genuinely
 *  FUTURE effective date gets announced when it arrives. */
export async function applyEffectiveDate(input: { documentId: string; versionId: string; effectiveDate: string | null }): Promise<void> {
  const eff = input.effectiveDate ? input.effectiveDate.slice(0, 10) : null;
  const suppress = !eff || eff <= todayISO();
  await supabase.from("document_versions").update({ effective_date: eff }).eq("id", input.versionId);
  await supabase.from("documents").update({
    effective_date: eff,
    effective_notified_at: suppress ? new Date().toISOString() : null,
  }).eq("id", input.documentId);
}

/** Daily scan: announce revisions whose future effective date has arrived. Fires
 *  once per document (watermark), telling the owner + Admin/DocCtrl (and anyone
 *  who had to acknowledge it) that the revision is now in force. */
export async function scanEffectiveDates(orgId: string): Promise<number> {
  const { data } = await supabase
    .from("documents")
    .select("id, library_id, collection_id, document_number, title, name, rev, effective_date, owner_user_id, owner_name")
    .eq("org_id", orgId)
    .not("effective_date", "is", null)
    .lte("effective_date", todayISO())
    .is("effective_notified_at", null);
  const docs = (data ?? []) as Array<Record<string, unknown>>;
  if (!docs.length) return 0;

  const controllers = await getOrgControllers(orgId);
  let n = 0;
  for (const d of docs) {
    const docId = d.id as string;
    const label = (d.document_number as string) || (d.title as string) || (d.name as string) || "Document";
    const link = `/documents/${d.library_id as string}?doc=${docId}`;
    const owner = await effectiveOwnerForDocument({
      ownerUserId: (d.owner_user_id as string | null) ?? null, ownerName: (d.owner_name as string | null) ?? null,
      collectionId: (d.collection_id as string | null) ?? null, libraryId: d.library_id as string,
    });
    // Owner (or the controllers if unowned) + anyone still/already on the ack roster.
    const { data: ackRows } = await supabase.from("document_acknowledgments")
      .select("assignee_user_id").eq("document_id", docId).in("status", ["pending", "acknowledged"]);
    const ackUsers = ((ackRows ?? []) as Array<Record<string, unknown>>).map((r) => r.assignee_user_id as string);
    const targets = Array.from(new Set([...(owner.userId ? [owner.userId] : controllers), ...ackUsers].filter(Boolean)));
    await Promise.all(targets.map((uid) =>
      notify({
        orgId, userId: uid, kind: "effective_now",
        title: `Now in effect: ${label}${d.rev ? ` Rev ${d.rev}` : ""}`,
        body: `This revision's effective date (${(d.effective_date as string).slice(0, 10)}) has arrived — it is now the in-force controlled copy.`,
        link, resourceType: "document", resourceId: docId,
      })
    ));
    await supabase.from("documents").update({ effective_notified_at: new Date().toISOString() }).eq("id", docId);
    n++;
  }
  return n;
}
