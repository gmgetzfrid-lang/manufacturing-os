// lib/shareRules.ts — the PURE rules of an external share link, imported by
// the client mint path (lib/documentShares.ts, the modal) and the server
// serve path (lib/shareServe.ts, both /api/share routes) so the two cannot
// drift apart. No I/O, no client — safe in both worlds.
//
// Product defaults decided 2026-09-17 (document-control Round F, P1 SHARE):
//   * a share expires — "never expires" is gone; 90 days is the ceiling and
//     30 the default. The database enforces the same ceiling on INSERT and
//     on any later change to expires_at (20261080).
//   * a share to a Draft, a Superseded / Void / Archived document (the
//     shared NOT_CURRENT_STATUSES set — never an inline list) or an archived
//     record is REFUSED with the reason; holds are refused by lib/holdGate.
//   * a share always serves the CURRENT issued revision — no pinning.

import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";

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
