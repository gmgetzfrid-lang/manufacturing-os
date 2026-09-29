// lib/documentShares.ts
//
// Tokenized public share links for a single document. Token is a
// 32-char url-safe random string (collision-safe at this scale).
//
// Minting (document-control Round F, P1 SHARE — DIST-6 / SHR-4 / EGR-5):
//   * WHO: the controller tier (Admin / DocCtrl by collection) or a granted
//     publisher of the document's library — the same authority that issues
//     the revision the link will serve. `canMintShare` asks the database's
//     own evaluator (user_can_publish_on_library); the INSERT policy
//     (20261080) is the rail.
//   * WHAT: a Draft, a Superseded / Void / Archived or archived-record
//     document, or one under an active hold, is REFUSED with the reason
//     (`describeShareRefusal` — status via lib/shareRules, holds via
//     lib/holdGate, fail-closed). The database refuses the same set
//     (document_share_refusal, 20261080).
//   * HOW LONG: never-expires is gone; 90 days is the ceiling (lib/shareRules).
//   * RECORD: creating and revoking a share writes an audit_logs row.
// A share always serves the CURRENT issued revision — there is no pinning.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import { assertNotOnHold, isHoldBlockedError } from "@/lib/holdGate";
import { SHARE_DEFAULT_DAYS, SHARE_MAX_DAYS, shareExpiryFor, shareStatusRefusal } from "@/lib/shareRules";

export { SHARE_DEFAULT_DAYS, SHARE_MAX_DAYS };

export interface DocumentShare {
  id: string;
  /** null when the server withheld it: the caller cannot read the document
   *  (EGRESS-8), so the link is unusable and only revocation remains. */
  token: string | null;
  orgId: string;
  documentId: string;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  note: string | null;
  accessCount: number;
  accessLastAt: string | null;
}

function randomToken(len = 32): string {
  // url-safe base64 of crypto bytes — guaranteed unguessable at 32 chars
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
    .slice(0, len);
}

/** What the modal needs to know about the document before offering a link:
 *  the revision a new link would resolve to today, its control status, and
 *  the library whose publish grants decide who may mint. Throws on a read
 *  error — an unknown state must not render as "shareable". */
export async function loadShareDocumentContext(documentId: string): Promise<{
  rev: string | null; status: string | null; archivedAt: string | null; libraryId: string | null;
}> {
  const { data, error } = await supabase
    .from("documents")
    .select("rev, status, archived_at, library_id")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(error.message || "Couldn't read the document");
  if (!data) throw new Error("Document not found");
  return {
    rev: (data.rev as string | null) ?? null,
    status: (data.status as string | null) ?? null,
    archivedAt: (data.archived_at as string | null) ?? null,
    libraryId: (data.library_id as string | null) ?? null,
  };
}

/** May this member mint an external share on this document? Controllers
 *  (the caller passes the collection-derived answer from useRole) always;
 *  otherwise the library's granted publishers, asked of the database's own
 *  evaluator so the app and the INSERT policy agree. Fails CLOSED. */
export async function canMintShare(input: {
  orgId: string; uid: string; libraryId: string | null; isController: boolean;
}): Promise<boolean> {
  if (input.isController) return true;
  if (!input.libraryId) return false;
  const { data, error } = await supabase.rpc("user_can_publish_on_library", {
    p_library: input.libraryId, p_uid: input.uid, p_org: input.orgId,
  });
  if (error) return false;
  return data === true;
}

export const SHARE_MINT_REFUSED =
  "This link was not created. Only Document Control / Admin or a granted publisher of this library can share a document outside the organisation, and only an issued document that is not on hold.";

/** Why this document cannot be shared right now, or null. Reads the
 *  document's status / archive flag and its active holds (fail-closed: an
 *  unreadable hold set is a refusal). */
export async function describeShareRefusal(documentId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("documents")
    .select("status, archived_at")
    .eq("id", documentId)
    .maybeSingle();
  if (error) return `Couldn't confirm the document's status (${error.message}); it is treated as unshareable.`;
  if (!data) return "Document not found.";
  const byStatus = shareStatusRefusal({ status: data.status as string | null, archived_at: data.archived_at as string | null });
  if (byStatus) return byStatus;
  try {
    await assertNotOnHold(documentId, { action: "sharing it outside the organisation" });
  } catch (e) {
    if (isHoldBlockedError(e)) return e.message;
    throw e;
  }
  return null;
}

const isPolicyRefusal = (e: { code?: string; message?: string }) =>
  e.code === "42501" || /row-level security|violates row-level/i.test(e.message ?? "");

export async function createShareLink(input: {
  orgId: string;
  documentId: string;
  expiresInDays?: number;   // default SHARE_DEFAULT_DAYS; 1..SHARE_MAX_DAYS
  note?: string;
  createdBy: string;
  createdByName?: string;
}): Promise<DocumentShare> {
  const expiry = shareExpiryFor(input.expiresInDays);
  if (!expiry.ok) throw new Error(expiry.reason);
  const refusal = await describeShareRefusal(input.documentId);
  if (refusal) throw new Error(refusal);
  const { data, error } = await supabase.from("document_shares").insert({
    token: randomToken(),
    org_id: input.orgId,
    document_id: input.documentId,
    created_by: input.createdBy,
    created_by_name: input.createdByName ?? null,
    expires_at: expiry.expiresAt,
    note: input.note ?? null,
  }).select("*").single();
  if (error) throw new Error(isPolicyRefusal(error) ? SHARE_MINT_REFUSED : (error.message || "Failed to create the share link"));
  const share = rowToShare(data as Record<string, unknown>);
  await logAuditAction({
    action: "SHARE_LINK_CREATED",
    resourceId: input.documentId,
    resourceType: "document",
    orgId: input.orgId,
    userId: input.createdBy,
    details: { shareId: share.id, expiresAt: share.expiresAt, note: share.note },
  });
  return share;
}

export interface ShareLinkListing {
  /** Whether the caller can currently read the document. When false, only the
   *  caller's own links are listed and none of them carries a token. */
  readable: boolean;
  shares: DocumentShare[];
}

export async function listShareLinks(documentId: string): Promise<ShareLinkListing> {
  // Listed by the server (/api/share/list), never by a client-side SELECT:
  // the route applies the caller's OWN read decision on the document and
  // withholds tokens from anyone who cannot read it (EGRESS-8). Migration
  // 20261066 states the same rule at the database for direct PostgREST reads.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");
  const res = await fetch(`/api/share/list?documentId=${encodeURIComponent(documentId)}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const out = (await res.json().catch(() => ({}))) as {
    readable?: boolean; shares?: Array<Record<string, unknown>>; error?: string;
  };
  if (!res.ok) throw new Error(out.error || "Failed to load share links");
  return { readable: out.readable === true, shares: (out.shares ?? []).map(rowToShare) };
}

export async function revokeShareLink(id: string, actorUserId: string): Promise<void> {
  // .select() back the touched row: under the per-verb policies (20261022)
  // only the creator or an org controller matches the UPDATE, and RLS turns a
  // non-match into a 0-row success — error === null while the public token
  // keeps serving bytes. Zero rows here MUST throw, or the modal reports a
  // revocation that never happened (EGRESS-7).
  const { data, error } = await supabase.from("document_shares").update({
    revoked_at: new Date().toISOString(),
    revoked_by: actorUserId,
  }).eq("id", id).select("id, org_id, document_id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("This link was not revoked — only its creator or a Document Control/Admin can revoke it.");
  }
  const row = data[0] as { org_id?: string; document_id?: string };
  await logAuditAction({
    action: "SHARE_LINK_REVOKED",
    resourceId: row.document_id ?? id,
    resourceType: "document",
    orgId: row.org_id,
    userId: actorUserId,
    details: { shareId: id },
  });
}

function rowToShare(r: Record<string, unknown>): DocumentShare {
  return {
    id: r.id as string,
    token: (r.token as string | null) ?? null,
    orgId: r.org_id as string,
    documentId: r.document_id as string,
    createdBy: r.created_by as string,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: r.created_at as string,
    expiresAt: (r.expires_at as string | null) ?? null,
    revokedAt: (r.revoked_at as string | null) ?? null,
    revokedBy: (r.revoked_by as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    accessCount: (r.access_count as number) ?? 0,
    accessLastAt: (r.access_last_at as string | null) ?? null,
  };
}
