// lib/ownership.ts
//
// Document ownership. An accountable owner can be delegated at the library,
// folder, or document level — most specific wins; unset falls back to the org's
// Admin/DocCtrl roles. The effective owner receives the document's notifications
// (Phase 1) and is granted CRUD on their scope (Phase 2). If a delegated owner
// falls behind on review upkeep, Admin/DocCtrl get a side escalation.

import { supabase } from "@/lib/supabase";
import { notify } from "@/lib/inAppNotifications";
import { logAuditAction } from "@/lib/audit";

type Level = "library" | "collection" | "document";
interface OwnerCols { owner_user_id?: string | null; owner_name?: string | null }

export interface EffectiveOwner {
  userId: string | null;
  name: string | null;
  source: Level | null; // where the owner was set; null = falls back to Admin/DocCtrl
}

/** Most-specific set owner wins (document > folder > library). null = no explicit
 *  owner, i.e. responsibility sits with the org's Admin/DocCtrl. */
export function resolveEffectiveOwner(doc?: OwnerCols | null, folder?: OwnerCols | null, library?: OwnerCols | null): EffectiveOwner {
  const levels: [OwnerCols | null | undefined, Level][] = [[doc, "document"], [folder, "collection"], [library, "library"]];
  for (const [lvl, source] of levels) {
    if (lvl?.owner_user_id) return { userId: lvl.owner_user_id, name: lvl.owner_name ?? null, source };
  }
  return { userId: null, name: null, source: null };
}

/** Resolve a document's effective owner by loading its folder + library owner. */
export async function effectiveOwnerForDocument(doc: {
  ownerUserId?: string | null; ownerName?: string | null; collectionId?: string | null; libraryId: string;
}): Promise<EffectiveOwner> {
  let folder: OwnerCols | null = null;
  if (doc.collectionId) {
    const { data } = await supabase.from("collections").select("owner_user_id, owner_name").eq("id", doc.collectionId).maybeSingle();
    folder = (data as OwnerCols) ?? null;
  }
  const { data: lib } = await supabase.from("libraries").select("owner_user_id, owner_name").eq("id", doc.libraryId).maybeSingle();
  return resolveEffectiveOwner({ owner_user_id: doc.ownerUserId, owner_name: doc.ownerName }, folder, (lib as OwnerCols) ?? null);
}

/** Is this user the effective owner of a document (by id)? Used to grant the
 *  owner publish/manage authority in the client publish check (the DB trigger
 *  enforces the same rule server-side — see 20260816_owner_publish_access.sql). */
export async function isEffectiveOwnerOfDocument(documentId: string, uid: string): Promise<boolean> {
  if (!uid) return false;
  const { data } = await supabase.from("documents").select("owner_user_id, owner_name, collection_id, library_id").eq("id", documentId).maybeSingle();
  if (!data) return false;
  const eff = await effectiveOwnerForDocument({
    ownerUserId: (data.owner_user_id as string | null) ?? null,
    ownerName: (data.owner_name as string | null) ?? null,
    collectionId: (data.collection_id as string | null) ?? null,
    libraryId: data.library_id as string,
  });
  return !!eff.userId && eff.userId === uid;
}

/** The org's Admin/DocCtrl user ids — the fallback owners and the escalation
 *  target when a delegated owner falls behind. */
export async function getOrgControllers(orgId: string): Promise<string[]> {
  const { data } = await supabase.from("org_members").select("uid").eq("org_id", orgId).eq("status", "active").in("role", ["Admin", "DocCtrl"]);
  return (data ?? []).map((r) => (r as { uid: string }).uid);
}

/** Phase 3: an owner (or anyone without direct delete rights) asks Admin/DocCtrl
 *  to delete a controlled document. Hard-delete stays controller-only to preserve
 *  the audit trail; this routes the request to them with a reason, logged. */
export async function requestDeletion(input: {
  orgId: string; documentId: string; docLabel: string; libraryId: string;
  requesterId: string; requesterName?: string | null; reason: string;
}): Promise<void> {
  await logAuditAction({
    action: "DELETION_REQUESTED", resourceType: "document", resourceId: input.documentId,
    orgId: input.orgId, userId: input.requesterId,
    details: { reason: input.reason, label: input.docLabel },
  });
  const controllers = await getOrgControllers(input.orgId);
  const link = `/documents/${input.libraryId}?doc=${input.documentId}`;
  await Promise.all(controllers.filter((c) => c !== input.requesterId).map((uid) =>
    notify({
      orgId: input.orgId, userId: uid, kind: "deletion_requested",
      title: `Deletion requested: ${input.docLabel}`,
      body: `${input.requesterName || "The owner"} asked to delete this document. Reason: ${input.reason}`,
      link, resourceType: "document", resourceId: input.documentId,
      actorUserId: input.requesterId, actorName: input.requesterName ?? undefined,
    })
  ));
}

/** Assign / reassign / clear the owner at a level. Logs to the audit trail and
 *  notifies the new owner. */
export async function setOwner(input: {
  level: Level; id: string; orgId?: string | null;
  userId: string | null; name: string | null;
  actorId: string; actorName?: string | null;
}): Promise<void> {
  const table = input.level === "library" ? "libraries" : input.level === "collection" ? "collections" : "documents";
  await supabase.from(table).update({ owner_user_id: input.userId, owner_name: input.name }).eq("id", input.id);

  await logAuditAction({
    action: input.userId ? "OWNER_ASSIGNED" : "OWNER_CLEARED",
    resourceType: input.level,
    resourceId: input.id,
    orgId: input.orgId ?? undefined,
    userId: input.actorId,
    details: { owner_user_id: input.userId, owner_name: input.name, level: input.level },
  });

  if (input.userId && input.orgId && input.userId !== input.actorId) {
    await notify({
      orgId: input.orgId, userId: input.userId, kind: "owner_assigned",
      title: `You're now the owner of a ${input.level === "document" ? "document" : input.level}`,
      body: "You'll receive its notifications and review reminders.",
      resourceType: input.level, resourceId: input.id,
      actorUserId: input.actorId, actorName: input.actorName ?? undefined,
    });
  }
}
