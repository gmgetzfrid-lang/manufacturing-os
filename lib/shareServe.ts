// lib/shareServe.ts — SERVER-ONLY. The one resolution both public share
// routes run before a byte or a line of metadata leaves.
//
// /api/share/resolve (the landing page) and /api/share/file (the bytes) used
// to carry two copies of the same lookup, and both decided "may this leave"
// from three facts: the token exists, revoked_at is null, expires_at is in
// the future. Neither read the document's status, its archive flag, or its
// holds, and the version they picked was filtered on review_state only on
// the fallback branch (DRLS-5 / SHR-3 / SHR-6 / EGR-5 / REV-10 / DIST-6).
//
// This module is the single decision, in the order the guards must run:
//
//   1. token shape → share row → revoked / expired (410)
//   2. the document, org-joined (EGRESS-1) — a cross-org share is a 404
//   3. the CREATOR's current authority (EGRESS-1 dw4) — lapsed is a 410
//   4. the document's control status: a Draft, a Superseded / Void /
//      Archived document (NOT_CURRENT_STATUSES — the shared set, never an
//      inline list) or one with archived_at set is REFUSED with the reason
//      (410 "withdrawn"). A share always serves the CURRENT revision (no
//      version pinning — see the modal and the landing page), so the only
//      honest answer for a retired document is to stop serving it.
//   5. holds: assertNotOnHold (lib/holdGate.ts, HLD-1) with the route's own
//      service-role client. FAILS CLOSED — an unreadable hold set refuses
//      (423 "on_hold", unreadable: true).
//   6. the version: the current_version_id row must be published (review_state
//      null/approved), not a branch, not superseded, and carry a file. The
//      fallback (no current pointer, or its row has no file) applies the SAME
//      filters. A current row that fails the filter is NOT served and NOT
//      fallen past — the pointer names an unpublished row, which is an
//      anomaly to refuse, not to paper over.
//
// Pure of Next: it takes any client with `.from()` and returns a
// discriminated result the routes turn into responses.

import { assertNotOnHold, isHoldBlockedError, type HoldGateClient } from "@/lib/holdGate";
import { shareStillAuthorized } from "@/lib/shareAuthorization";
import { shareStatusRefusal, versionServable } from "@/lib/shareRules";

/** A service-role client (createClient(...) in the route) — anything with `.from()`. */
export type ShareServeClient = HoldGateClient;

export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export interface ShareRow {
  id: string;
  org_id: string;
  document_id: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
}

export interface ShareDocument {
  id: string;
  document_number: string | null;
  title: string | null;
  name: string | null;
  rev: string | null;
  status: string | null;
  archived_at: string | null;
  current_version_id: string | null;
}

export interface ServableVersion {
  id: string;
  storagePath: string;
  /** document_versions.revision_label of the row actually served (SHR-7);
   *  falls back to documents.rev only when the row carries no label. */
  revLabel: string | null;
}

export type ShareRefusal = {
  ok: false;
  status: number;
  body: { error: string; reason?: string; documentStatus?: string; unreadable?: boolean };
};

export type ShareServeResult =
  | ShareRefusal
  | { ok: true; share: ShareRow; doc: ShareDocument; version: ServableVersion | null };

const refuse = (status: number, body: ShareRefusal["body"]): ShareRefusal => ({ ok: false, status, body });

export { shareStatusRefusal, versionServable };

const VERSION_COLUMNS = "id, file_url, revision_label, review_state, is_branch, superseded_at";

export async function resolveShareForServing(sb: ShareServeClient, token: string): Promise<ShareServeResult> {
  if (!SHARE_TOKEN_RE.test(token)) return refuse(400, { error: "invalid" });

  const { data: share } = await sb
    .from("document_shares")
    .select("id, org_id, document_id, expires_at, revoked_at, created_by")
    .eq("token", token)
    .maybeSingle();
  if (!share) return refuse(404, { error: "notfound" });
  const s = share as unknown as ShareRow;
  if (s.revoked_at) return refuse(410, { error: "revoked" });
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return refuse(410, { error: "expired" });

  // Join document to the share's org — a cross-org share (EGRESS-1) yields no
  // document and 404s before any byte is fetched.
  const { data: doc } = await sb
    .from("documents")
    .select("id, document_number, title, name, rev, status, archived_at, current_version_id")
    .eq("id", s.document_id)
    .eq("org_id", s.org_id)
    .maybeSingle();
  if (!doc) return refuse(404, { error: "notfound" });
  const d = doc as unknown as ShareDocument;

  // Serve only on the creator's CURRENT authority (EGRESS-1 dw4): if they
  // left the org or lost read access to this document, the link is dead.
  if (!(await shareStillAuthorized(s.org_id, s.created_by, d.id))) return refuse(410, { error: "revoked" });

  const withdrawn = shareStatusRefusal(d);
  if (withdrawn) return refuse(410, { error: "withdrawn", reason: withdrawn, documentStatus: d.status ?? undefined });

  try {
    await assertNotOnHold(d.id, { client: sb, action: "sharing it outside the organisation" });
  } catch (e) {
    if (isHoldBlockedError(e)) {
      return refuse(423, { error: "on_hold", reason: e.message, unreadable: e.unreadable, documentStatus: d.status ?? undefined });
    }
    throw e;
  }

  // The version: current pointer first, under the published/not-branch/not-
  // superseded filter; fallback under the same filter.
  let version: ServableVersion | null = null;
  if (d.current_version_id) {
    const { data: v } = await sb.from("document_versions").select(VERSION_COLUMNS).eq("id", d.current_version_id).maybeSingle();
    const row = v as { id: string; file_url: string | null; revision_label: string | null; review_state: string | null; is_branch: boolean | null; superseded_at: string | null } | null;
    if (row) {
      if (versionServable(row)) {
        version = { id: row.id, storagePath: row.file_url as string, revLabel: row.revision_label ?? null };
      } else if (row.file_url) {
        // The current pointer names an unpublished / branch / superseded row
        // that HAS a file: refuse rather than serve it or walk past it.
        return { ok: true, share: s, doc: d, version: null };
      }
    }
  }
  // No current pointer, its row is gone, or it carries no file (legacy):
  // the newest row that passes the SAME filter.
  if (!version) {
    const { data: latest } = await sb
      .from("document_versions")
      .select(VERSION_COLUMNS)
      .eq("record_id", d.id)
      .or("review_state.is.null,review_state.eq.approved")
      .eq("is_branch", false)
      .is("superseded_at", null)
      .not("file_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const rows = (latest as Array<{ id: string; file_url: string | null; revision_label: string | null; review_state: string | null; is_branch: boolean | null; superseded_at: string | null }> | null) ?? [];
    if (rows.length && versionServable(rows[0])) {
      version = { id: rows[0].id, storagePath: rows[0].file_url as string, revLabel: rows[0].revision_label ?? null };
    }
  }

  return { ok: true, share: s, doc: d, version };
}

/** The document label and the revision label of the copy being served —
 *  the version's own label first (SHR-7), documents.rev only as a fallback. */
export function servedLabels(doc: ShareDocument, version: ServableVersion | null): { label: string; rev: string | null } {
  const label = String(doc.document_number || doc.title || doc.name || "document");
  const rev = version?.revLabel ?? doc.rev ?? null;
  return { label, rev };
}

/** The footer on a shared copy: what it is, which revision, its control
 *  status at the moment it left — and an instruction to scan ONLY when a QR
 *  was actually stamped (SHR-11): no page ever tells a reader to scan a QR
 *  that is not there. */
export function shareFooterNotice(input: { label: string; rev: string | null; status: string | null; verifyUrl: string | undefined }): string {
  const state = input.status ? ` (${input.status})` : "";
  const head = `${input.label} Rev ${input.rev ?? "?"}${state} at time of download — a share always serves the current revision.`;
  return input.verifyUrl
    ? `${head} Scan the QR to confirm it is still current.`
    : `${head} Verify the current revision with the issuing organisation before use.`;
}

/** What a request honestly tells us about the accessor: the first
 *  forwarded-for hop and the user agent. No recipient identification. */
export function requestMeta(req: { headers: { get(name: string): string | null } }): { ip: string | null; userAgent: string | null } {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const first = fwd.split(",")[0]?.trim();
  const ip = first || req.headers.get("x-real-ip")?.trim() || null;
  const ua = (req.headers.get("user-agent") ?? "").trim();
  return { ip: ip ? ip.slice(0, 64) : null, userAgent: ua ? ua.slice(0, 512) : null };
}

/** One row per access (SHR-10): who-can-be-known (IP, UA), when, what kind.
 *  Checked write; a failure is logged loudly and reported to the caller —
 *  the download route treats the download_audits row as the record that
 *  must land, this row as the access trail. */
export async function recordShareAccess(
  sb: ShareServeClient,
  input: {
    share: ShareRow; documentId: string; versionId: string | null;
    kind: "resolve" | "download"; ip: string | null; userAgent: string | null;
  },
): Promise<{ error: string | null }> {
  const { error } = await sb.from("document_share_accesses").insert({
    share_id: input.share.id,
    org_id: input.share.org_id,
    document_id: input.documentId,
    version_id: input.versionId,
    kind: input.kind,
    ip: input.ip,
    user_agent: input.userAgent,
    created_at: new Date().toISOString(),
  });
  if (error) {
    console.error("[share] document_share_accesses insert failed", { kind: input.kind, share: input.share.id, message: error.message });
    return { error: error.message || "access row not written" };
  }
  return { error: null };
}
