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
  source: Level | "team" | null; // where the owner was set; "team" = a team-owned library's supervisor; null = falls back to Admin/DocCtrl
}

/** Most-specific set owner wins (document > folder > library). null = no explicit
 *  owner, i.e. responsibility sits with the org's Admin/DocCtrl.
 *
 *  GAP-5 / OWN-12: when `activeUids` is supplied, a level whose owner is NOT an
 *  active member is skipped — the resolution falls through to the next level
 *  and ultimately to null, so a departed or suspended owner is never the
 *  effective owner for an authority decision or a notification route. The
 *  database's `user_is_effective_owner` applies the same fall-through. */
export function resolveEffectiveOwner(
  doc?: OwnerCols | null,
  folder?: OwnerCols | null,
  library?: OwnerCols | null,
  activeUids?: ReadonlySet<string> | null,
): EffectiveOwner {
  const levels: [OwnerCols | null | undefined, Level][] = [[doc, "document"], [folder, "collection"], [library, "library"]];
  for (const [lvl, source] of levels) {
    if (!lvl?.owner_user_id) continue;
    if (activeUids && !activeUids.has(lvl.owner_user_id)) continue;
    return { userId: lvl.owner_user_id, name: lvl.owner_name ?? null, source };
  }
  return { userId: null, name: null, source: null };
}

/** The subset of `uids` that are ACTIVE members of `orgId` (any uid when orgId
 *  is unknown is treated as active — never narrows on missing context). */
export async function activeMemberUids(orgId: string | null | undefined, uids: Array<string | null | undefined>): Promise<Set<string>> {
  const wanted = Array.from(new Set(uids.filter((u): u is string => !!u)));
  if (wanted.length === 0) return new Set();
  if (!orgId) return new Set(wanted);
  const { data, error } = await supabase
    .from("org_members").select("uid").eq("org_id", orgId).eq("status", "active").in("uid", wanted);
  if (error) return new Set(wanted); // fail-safe: an unreadable roster must not un-own everything
  return new Set((data ?? []).map((r) => (r as { uid: string }).uid));
}

/** Pure owner resolution for console/register rows: document > folder >
 *  library > the library's owning team's supervisor. Branches ONLY on
 *  owner_user_id / owner_team_id — never on owner_name, which is a write-once
 *  snapshot that drifts (DEL-8). Returns no name on purpose: callers resolve
 *  display names live from membership rows. */
export function resolveOwnerForNode(
  doc: OwnerCols | null | undefined,
  folder: OwnerCols | null | undefined,
  library: { owner_user_id?: string | null; owner_team_id?: string | null } | null | undefined,
  teamSupervisorId?: string | null,
): { userId: string | null; source: Level | "team" | null } {
  if (doc?.owner_user_id) return { userId: doc.owner_user_id, source: "document" };
  if (folder?.owner_user_id) return { userId: folder.owner_user_id, source: "collection" };
  if (library?.owner_user_id) return { userId: library.owner_user_id, source: "library" };
  if (library?.owner_team_id && teamSupervisorId) return { userId: teamSupervisorId, source: "team" };
  return { userId: null, source: null };
}

export interface OwnershipRegisterRow {
  nodeType: "library" | "folder" | "document";
  name: string;
  documentNumber?: string | null;
  libraryName?: string | null;
  ownerUserId: string | null;
  ownerName: string | null; // live-resolved by the caller, never owner_name
  source: Level | "team" | null;
}

function csvCell(v: string | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The ownership register as CSV — who is accountable for every library,
 *  folder and controlled document, and where that authority comes from. */
export function ownershipRegisterToCsv(rows: OwnershipRegisterRow[]): string {
  const header = ["Type", "Name", "Document #", "Library", "Owner", "Owner source"];
  const lines = rows.map((r) => [
    r.nodeType,
    r.name,
    r.documentNumber ?? "",
    r.libraryName ?? "",
    r.ownerUserId ? (r.ownerName || "assigned member") : "— (falls to Admin/DocCtrl)",
    r.source ?? "unowned",
  ].map(csvCell).join(","));
  return [header.map(csvCell).join(","), ...lines].join("\n");
}

/** Resolve a document's effective owner by loading its folder + library owner.
 *  Falls back to the supervisor of the library's owning TEAM (department) when no
 *  explicit owner is set at any level. */
export async function effectiveOwnerForDocument(doc: {
  ownerUserId?: string | null; ownerName?: string | null; collectionId?: string | null; libraryId: string;
  /** When known, lets the resolver require an ACTIVE membership at every
   *  level (GAP-5). Resolved from the library row when omitted. */
  orgId?: string | null;
}): Promise<EffectiveOwner> {
  let folder: OwnerCols | null = null;
  if (doc.collectionId) {
    const { data } = await supabase.from("collections").select("owner_user_id, owner_name").eq("id", doc.collectionId).maybeSingle();
    folder = (data as OwnerCols) ?? null;
  }
  const { data: lib } = await supabase.from("libraries").select("owner_user_id, owner_name, owner_team_id, org_id").eq("id", doc.libraryId).maybeSingle();
  const orgId = doc.orgId ?? ((lib as { org_id?: string | null } | null)?.org_id ?? null);
  const teamId = (lib as { owner_team_id?: string | null } | null)?.owner_team_id ?? null;
  let sup: string | null = null;
  let teamName: string | null = null;
  if (teamId) {
    const { data: team } = await supabase.from("teams").select("supervisor_user_id, name").eq("id", teamId).maybeSingle();
    sup = (team?.supervisor_user_id as string | null) ?? null;
    teamName = (team?.name as string | null) ?? null;
  }
  // GAP-5 / OWN-12: only ACTIVE members can be effective owners; an inactive
  // owner at any level falls through to the next (and the team rung, and null).
  const active = await activeMemberUids(orgId, [doc.ownerUserId, folder?.owner_user_id, (lib as OwnerCols | null)?.owner_user_id, sup]);
  const explicit = resolveEffectiveOwner({ owner_user_id: doc.ownerUserId, owner_name: doc.ownerName }, folder, (lib as OwnerCols) ?? null, active);
  if (explicit.userId) return explicit;

  // Team-owned library → the team's supervisor is the effective owner.
  if (sup && active.has(sup)) {
    const { data: m } = await supabase.from("org_members").select("display_name, email").eq("uid", sup).maybeSingle();
    const name = (m?.display_name as string) || (m?.email as string) || teamName || "Supervisor";
    return { userId: sup, name, source: "team" };
  }
  return { userId: null, name: null, source: null };
}

/** Assign (or clear) a library's owning team/department. The team's supervisor
 *  becomes the library's effective owner. */
export async function setLibraryOwnerTeam(input: {
  libraryId: string; orgId?: string | null; teamId: string | null; actorId: string; actorName?: string | null;
}): Promise<void> {
  // OWN-14: checked write — an RLS refusal returns 200 with zero rows, and
  // the old unchecked form then wrote a successful-looking audit entry for
  // an assignment that never happened.
  const { data, error } = await supabase
    .from("libraries")
    .update({ owner_team_id: input.teamId })
    .eq("id", input.libraryId)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error("Owning team was NOT changed — you don't have authority over this library (or it no longer exists).");
  }
  await logAuditAction({
    action: input.teamId ? "OWNER_TEAM_ASSIGNED" : "OWNER_TEAM_CLEARED",
    resourceType: "library", resourceId: input.libraryId,
    orgId: input.orgId ?? undefined, userId: input.actorId, details: { teamId: input.teamId },
  }).catch(() => {});
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
  // OWN-3: controllers are a property of the COLLECTION — a DocCtrl who also
  // holds Manager (headline Manager) is still a controller. Mirrors the DB's
  // is_org_controller: role IN (...) OR roles && ARRAY[...].
  const { data } = await supabase.from("org_members").select("uid").eq("org_id", orgId).eq("status", "active")
    .or("role.in.(Admin,DocCtrl),roles.ov.{Admin,DocCtrl}");
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
  // OWN-14: this is the SINGLE funnel for every ownership write at every
  // level — the exact site where a guard/policy refusal must fail loudly,
  // never write a phantom OWNER_ASSIGNED audit row, and never congratulate
  // a new owner who was not actually assigned.
  const { data, error } = await supabase
    .from(table)
    .update({ owner_user_id: input.userId, owner_name: input.name })
    .eq("id", input.id)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(`Owner was NOT changed — you don't have authority to reassign this ${input.level} (or it no longer exists).`);
  }

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
      link: input.level === "library" ? `/documents/${input.id}` : undefined,
      resourceType: input.level, resourceId: input.id,
      actorUserId: input.actorId, actorName: input.actorName ?? undefined,
    });
  }
}
