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
//   * DOWNLOAD DENY (public-surfaces SHR-14): a creator an ACL download deny
//     names (by uid, role or team) is refused at the INSERT by 20261140
//     (user_download_denied, the SQL twin of lib/downloadDeny.ts). The modal
//     asks the same predicate first (`shareMintDownloadDenial`) and says why
//     instead of offering the Create box; createShareLink names the deny when
//     the policy refuses for it.
//   * HOW LONG: never-expires is gone; 90 days is the ceiling (lib/shareRules).
//   * RECORD: creating and revoking a share writes an audit_logs row — a
//     checked write: if it is refused the link change still stands, and the
//     caller is handed `auditWarning` to say so (never a silent success).
// A share always serves the CURRENT issued revision — there is no pinning.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import { assertNotOnHold, isHoldBlockedError } from "@/lib/holdGate";
import { SHARE_DEFAULT_DAYS, SHARE_MAX_DAYS, resolveServedVersion, shareExpiryFor, shareStatusRefusal } from "@/lib/shareRules";

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

/** What a link to this document serves right now, by the SAME rule the
 *  public routes run (lib/shareRules resolveServedVersion — SHR-7):
 *  `served` is the revision label a download would carry, `none` means no
 *  published file can be served, `unknown` means the version read failed. */
export type ShareServedState =
  | { kind: "served"; rev: string | null }
  | { kind: "none" }
  | { kind: "unknown"; error: string };

/** What the modal needs to know about the document before offering a link:
 *  the revision a link serves today (resolved as the routes resolve it), its
 *  control status, and the library whose publish grants decide who may
 *  mint. Throws on a read error — an unknown state must not render as
 *  "shareable". */
export async function loadShareDocumentContext(documentId: string): Promise<{
  rev: string | null; status: string | null; archivedAt: string | null; libraryId: string | null;
  served: ShareServedState;
  /** The document's chain-resolved ACL index — what the download-deny
   *  predicate reads (SHR-14). */
  aclIndex: unknown;
}> {
  const { data, error } = await supabase
    .from("documents")
    .select("rev, status, archived_at, library_id, current_version_id, acl_index")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(error.message || "Couldn't read the document");
  if (!data) throw new Error("Document not found");
  const rev = (data.rev as string | null) ?? null;
  const resolved = await resolveServedVersion(supabase, {
    id: documentId, current_version_id: (data.current_version_id as string | null) ?? null,
  });
  const served: ShareServedState = resolved.error
    ? { kind: "unknown", error: resolved.error }
    : resolved.version
      // the label a download carries: the served row's own, documents.rev only as the fallback (servedLabels)
      ? { kind: "served", rev: resolved.version.revLabel ?? rev }
      : { kind: "none" };
  return {
    rev,
    status: (data.status as string | null) ?? null,
    archivedAt: (data.archived_at as string | null) ?? null,
    libraryId: (data.library_id as string | null) ?? null,
    served,
    aclIndex: (data as { acl_index?: unknown }).acl_index ?? null,
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

/** SHR-14: the sentence for a creator an ACL download deny names. */
export const SHARE_DOWNLOAD_DENIED =
  "You are denied download on this document — an access rule names you, one of your roles or a team you are on — so a link you create could never serve a copy. Ask Document Control to share it, or to review the rule.";

/** SHR-14: whether the creator may mint as far as the download deny goes —
 *  asked of the database's own predicate, so the modal and the INSERT
 *  policy (20261140) cannot disagree.
 *  - `clear`: no deny names them;
 *  - `denied`: one does — the policy refuses the mint, so say why;
 *  - `unknown`: the predicate could not be asked (an error other than its
 *    absence) — fail CLOSED: nothing is offered, the reason is said;
 *  - `unchecked`: the predicate is not installed (20261140 not pasted). The
 *    database then has no such rail either, so the mint behaves as before
 *    (offered), and the reason is logged — never a refusal the server would
 *    not make, never an admission it would refuse. */
export type ShareMintDenial =
  | { kind: "clear" }
  | { kind: "denied"; reason: string }
  | { kind: "unknown"; reason: string }
  | { kind: "unchecked"; reason: string };

/** PostgREST's answer for a function that does not exist yet (PGRST202 — its
 *  schema cache — or Postgres' undefined_function). */
function isMissingDenyPredicate(e: { code?: string; message?: string }): boolean {
  return e.code === "PGRST202" || e.code === "42883"
    || /could not find the function|function .*user_download_denied.* does not exist/i.test(e.message ?? "");
}

export async function shareMintDownloadDenial(input: {
  orgId: string; uid: string; aclIndex: unknown;
}): Promise<ShareMintDenial> {
  let data: unknown;
  let error: { code?: string; message?: string } | null;
  try {
    // Callable for oneself only (20261140 refuses another uid): the caller IS the creator.
    ({ data, error } = await supabase.rpc("user_download_denied", {
      p_acl_index: input.aclIndex ?? null, p_uid: input.uid, p_org: input.orgId,
    }));
  } catch (e) {
    error = { message: (e as Error)?.message || String(e) };
  }
  if (error) {
    if (isMissingDenyPredicate(error)) {
      const reason = "user_download_denied is not installed (migration 20261140 is not applied): the download-deny check before minting is skipped, as before; the share routes still refuse to serve a link whose creator is denied download.";
      console.warn(`[share] ${reason}`);
      return { kind: "unchecked", reason };
    }
    return { kind: "unknown", reason: `Couldn't confirm that you may download this document (${error.message || "the check failed"}), so no link can be created from here right now. Try again.` };
  }
  return data === true ? { kind: "denied", reason: SHARE_DOWNLOAD_DENIED } : { kind: "clear" };
}

/** SHR-14: what the modal shows INSTEAD of the Create box, or null to offer
 *  it — a deny that names the creator, or a check that failed (fail closed).
 *  `unchecked` (the predicate is not installed, and so neither is the rail)
 *  and `clear` offer the box exactly as before. */
export function mintDenialNotice(d: ShareMintDenial): string | null {
  return d.kind === "denied" || d.kind === "unknown" ? d.reason : null;
}

/** SHR-14: the sentence for a policy-refused mint — the download deny named
 *  when the predicate says it was the cause, the general sentence otherwise
 *  (or when the cause cannot be told). Reads only after a refusal. */
async function explainMintRefusal(input: { orgId: string; documentId: string; createdBy: string }): Promise<string> {
  try {
    const { data, error } = await supabase.from("documents").select("acl_index").eq("id", input.documentId).maybeSingle();
    if (error || !data) return SHARE_MINT_REFUSED;
    const denial = await shareMintDownloadDenial({ orgId: input.orgId, uid: input.createdBy, aclIndex: (data as { acl_index?: unknown }).acl_index ?? null });
    return denial.kind === "denied" ? `This link was not created. ${SHARE_DOWNLOAD_DENIED}` : SHARE_MINT_REFUSED;
  } catch {
    return SHARE_MINT_REFUSED;
  }
}

/** Why this document cannot be shared right now, or null — and whether
 *  that is CONFIRMED (the document's status / archive flag / an open hold,
 *  the same set the public routes refuse) or only UNCONFIRMED (this
 *  browser's read of the document or of its holds failed: minting is still
 *  refused — fail-closed — but the service-role routes may well be serving
 *  its existing links, so nothing may say they are not). */
export type ShareRefusalState = { reason: string; confirmed: boolean };

export async function shareRefusalState(documentId: string): Promise<ShareRefusalState | null> {
  const { data, error } = await supabase
    .from("documents")
    .select("status, archived_at")
    .eq("id", documentId)
    .maybeSingle();
  if (error) return { reason: `Couldn't confirm the document's status (${error.message}); it is treated as unshareable.`, confirmed: false };
  if (!data) return { reason: "Document not found.", confirmed: false };
  const byStatus = shareStatusRefusal({ status: data.status as string | null, archived_at: data.archived_at as string | null });
  if (byStatus) return { reason: byStatus, confirmed: true };
  try {
    await assertNotOnHold(documentId, { action: "sharing it outside the organisation" });
  } catch (e) {
    if (isHoldBlockedError(e)) return { reason: e.message, confirmed: !e.unreadable };
    throw e;
  }
  return null;
}

/** Why this document cannot be shared right now, or null (fail-closed: an
 *  unreadable document or hold set is a refusal). */
export async function describeShareRefusal(documentId: string): Promise<string | null> {
  return (await shareRefusalState(documentId))?.reason ?? null;
}

/** The sentence a caller shows when the link change stood but its
 *  audit_logs row was refused. */
export function shareAuditUnwritten(what: "created" | "revoked", detail: string): string {
  return `The link was ${what}, but its audit record could not be written (${detail}). Tell Document Control so the record can be completed.`;
}

const isPolicyRefusal = (e: { code?: string; message?: string }) =>
  e.code === "42501" || /row-level security|violates row-level/i.test(e.message ?? "");

/** 20261080's anchor guard refusing the expiry: the database measures the
 *  90-day ceiling on ITS clock and clamps up to an hour of browser-clock
 *  skew, so reaching this means the expiry was missing or far past it. */
export const SHARE_EXPIRY_REFUSED =
  `This link was not created: a share link must expire within ${SHARE_MAX_DAYS} days of being created, measured on the server's clock. If this computer's clock is set well ahead, correct it and try again.`;
const isExpiryRefusal = (e: { message?: string }) => /must expire within 90 days of its creation/.test(e.message ?? "");

export async function createShareLink(input: {
  orgId: string;
  documentId: string;
  expiresInDays?: number;   // default SHARE_DEFAULT_DAYS; 1..SHARE_MAX_DAYS
  note?: string;
  createdBy: string;
  createdByName?: string;
}): Promise<DocumentShare & { auditWarning: string | null }> {
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
  if (error) {
    throw new Error(
      isPolicyRefusal(error) ? await explainMintRefusal(input)
        : isExpiryRefusal(error) ? SHARE_EXPIRY_REFUSED
        : (error.message || "Failed to create the share link"),
    );
  }
  const share = rowToShare(data as Record<string, unknown>);
  const { error: auditError } = await logAuditAction({
    action: "SHARE_LINK_CREATED",
    resourceId: input.documentId,
    resourceType: "document",
    orgId: input.orgId,
    userId: input.createdBy,
    details: { shareId: share.id, expiresAt: share.expiresAt, note: share.note },
  });
  return { ...share, auditWarning: auditError ? shareAuditUnwritten("created", auditError) : null };
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

export async function revokeShareLink(id: string, actorUserId: string): Promise<{ auditWarning: string | null }> {
  // .select() back the touched row: under the per-verb policies (20261022)
  // only the creator or an org controller matches the UPDATE, and RLS turns a
  // non-match into a 0-row success — error === null while the public token
  // keeps serving bytes. Zero rows here MUST throw, or the modal reports a
  // revocation that never happened (EGRESS-7).
  // Only a LIVE row is touched (.is revoked_at null): 20261080 refuses any
  // change to revoked_at once set, so a double click, a stale modal or a
  // second controller revoking concurrently would otherwise hit the guard.
  const { data, error } = await supabase.from("document_shares").update({
    revoked_at: new Date().toISOString(),
    revoked_by: actorUserId,
  }).eq("id", id).is("revoked_at", null).select("id, org_id, document_id");
  if (error) throw error;
  if (!data || data.length === 0) {
    // Zero rows: already revoked (the outcome asked for — a no-op, and no
    // second audit row), or the policy refused the caller.
    const { data: current, error: readError } = await supabase
      .from("document_shares")
      .select("id, revoked_at")
      .eq("id", id)
      .maybeSingle();
    if (!readError && (current as { revoked_at?: string | null } | null)?.revoked_at) return { auditWarning: null };
    throw new Error("This link was not revoked — only its creator or a Document Control/Admin can revoke it.");
  }
  const row = data[0] as { org_id?: string; document_id?: string };
  const { error: auditError } = await logAuditAction({
    action: "SHARE_LINK_REVOKED",
    resourceId: row.document_id ?? id,
    resourceType: "document",
    orgId: row.org_id,
    userId: actorUserId,
    details: { shareId: id },
  });
  return { auditWarning: auditError ? shareAuditUnwritten("revoked", auditError) : null };
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
