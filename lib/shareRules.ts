// lib/shareRules.ts — the rules of an external share link, imported by the
// client mint path (lib/documentShares.ts, the modal) and the server serve
// path (lib/shareServe.ts, both /api/share routes) so the two cannot drift
// apart. Safe in both worlds: everything here is pure except
// `resolveServedVersion`, which reads only through the client its CALLER
// passes (the routes' service-role client; the browser client in the modal)
// — one query, one filter, whichever side asks "which revision does a link
// serve right now".
//
// Product defaults decided 2026-09-17 (document-control Round F, P1 SHARE):
//   * a share expires — "never expires" is gone; 90 days is the ceiling and
//     30 the default. The database enforces the same ceiling on INSERT and
//     on any later change to expires_at (20261080), measured from its OWN
//     clock (a live share is stamped created_at := now()); a browser clock
//     running up to an hour ahead has its 90-day pick clamped to the
//     ceiling there rather than refused.
//   * a share to a Draft, a Superseded / Void / Archived document (the
//     shared NOT_CURRENT_STATUSES set — never an inline list) or an archived
//     record is REFUSED with the reason; holds are refused by lib/holdGate.
//   * a share always serves the CURRENT issued revision — no pinning.

import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import type { HoldGateClient } from "@/lib/holdGate";

export const SHARE_DEFAULT_DAYS = 30;
export const SHARE_MAX_DAYS = 90;

/** The expiry a mint request lands with, or a refusal. `days` undefined is
 *  the default; 0 / negative / non-finite (the old "never expires") and
 *  anything past the ceiling are refused, never silently clamped — the
 *  person asked for something the policy does not allow, and should know. */
export function shareExpiryFor(days: number | undefined, now: number = Date.now()): { ok: true; expiresAt: string } | { ok: false; reason: string } {
  const d = days === undefined ? SHARE_DEFAULT_DAYS : days;
  if (!Number.isFinite(d) || d <= 0) {
    return { ok: false, reason: `A share link must expire — choose up to ${SHARE_MAX_DAYS} days.` };
  }
  if (d > SHARE_MAX_DAYS) {
    return { ok: false, reason: `A share link may last at most ${SHARE_MAX_DAYS} days.` };
  }
  return { ok: true, expiresAt: new Date(now + d * 86_400_000).toISOString() };
}

/** Why a document cannot be shared (or served through a share) by its
 *  control status, or null when it can. Names the state so the modal and the
 *  landing page can say it. */
export function shareStatusRefusal(doc: { status?: string | null; archived_at?: string | null }): string | null {
  const status = String(doc.status ?? "");
  if (status === "Draft") return "This document is a draft — it has not been issued.";
  if (NOT_CURRENT_STATUSES.has(status)) return `This document has been withdrawn (${status.toLowerCase()}) and cannot be shared.`;
  if (doc.archived_at) return "This document has been archived and cannot be shared.";
  return null;
}

/** Published (review_state null / approved), not a branch, not superseded,
 *  has a file — the one test on BOTH resolution branches (DRLS-5 / SHR-6). */
export function versionServable(v: {
  file_url?: string | null; review_state?: string | null; is_branch?: boolean | null; superseded_at?: string | null;
} | null | undefined): boolean {
  if (!v || !v.file_url) return false;
  if (v.review_state != null && v.review_state !== "approved") return false;
  if (v.is_branch === true) return false;
  if (v.superseded_at) return false;
  return true;
}

export interface ServableVersion {
  id: string;
  storagePath: string;
  /** document_versions.revision_label of the row actually served (SHR-7);
   *  the caller falls back to documents.rev only when the row has no label. */
  revLabel: string | null;
}

type VersionRow = {
  id: string; file_url: string | null; revision_label: string | null;
  review_state: string | null; is_branch: boolean | null; superseded_at: string | null;
};

const VERSION_COLUMNS = "id, file_url, revision_label, review_state, is_branch, superseded_at";

/** Which version a share of this document serves right now, or null — the
 *  one resolution both /api/share routes and the modal's "resolves to" run:
 *  the current_version_id row must pass `versionServable` (published, not a
 *  branch, not superseded, has a file); a current row that FAILS the filter
 *  but has a file is refused, never walked past — the pointer names an
 *  unpublished row, an anomaly to refuse, not to paper over. No pointer, a
 *  missing row, or a row with no file (legacy) falls back to the newest row
 *  under the SAME filter. `error` carries a read failure so a caller can say
 *  "couldn't confirm" instead of "nothing to serve". */
export async function resolveServedVersion(
  client: HoldGateClient,
  d: { id: string; current_version_id: string | null },
): Promise<{ version: ServableVersion | null; error: string | null }> {
  if (d.current_version_id) {
    const { data: v, error } = await client.from("document_versions").select(VERSION_COLUMNS).eq("id", d.current_version_id).maybeSingle();
    if (error) return { version: null, error: error.message || "version read failed" };
    const row = v as VersionRow | null;
    if (row) {
      if (versionServable(row)) {
        return { version: { id: row.id, storagePath: row.file_url as string, revLabel: row.revision_label ?? null }, error: null };
      } else if (row.file_url) {
        return { version: null, error: null };
      }
    }
  }
  const { data: latest, error } = await client
    .from("document_versions")
    .select(VERSION_COLUMNS)
    .eq("record_id", d.id)
    .or("review_state.is.null,review_state.eq.approved")
    .eq("is_branch", false)
    .is("superseded_at", null)
    .not("file_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return { version: null, error: error.message || "version read failed" };
  const rows = (latest as VersionRow[] | null) ?? [];
  if (rows.length && versionServable(rows[0])) {
    return { version: { id: rows[0].id, storagePath: rows[0].file_url as string, revLabel: rows[0].revision_label ?? null }, error: null };
  }
  return { version: null, error: null };
}
