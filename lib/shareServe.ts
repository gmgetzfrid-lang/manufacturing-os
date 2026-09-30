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
//   3. the CREATOR's current authority (EGRESS-1 dw4) — lapsed is a 410:
//      they can still read the document (shareStillAuthorized) AND still
//      hold the minting tier (DEC-46 §1 — a controller by the role
//      collection, or a granted publisher of the document's library:
//      creatorMayShare). A link minted before the tier existed, or by a
//      publisher whose grant was since withdrawn, stops serving.
//   4. the document's control status: a Draft, a Superseded / Void /
//      Archived document (NOT_CURRENT_STATUSES — the shared set, never an
//      inline list) or one with archived_at set is REFUSED with the reason
//      (410 "withdrawn"). A share always serves the CURRENT revision (no
//      version pinning — see the modal and the landing page), so the only
//      honest answer for a retired document is to stop serving it.
//   5. holds: assertNotOnHold (lib/holdGate.ts, HLD-1) with the route's own
//      service-role client. FAILS CLOSED — an unreadable hold set refuses
//      (423 "on_hold", unreadable: true). This surface is UNAUTHENTICATED:
//      the refusal publishes only the hold's predefined CATEGORY
//      (publicHoldReason, the rule /api/verify-hold follows — HLD-7 /
//      VFY-6), never the operator's free-text reason and never a database
//      error; the detail of an unreadable hold set is logged server-side.
//   6. the version: lib/shareRules.ts resolveServedVersion — the
//      current_version_id row must be published (review_state null /
//      approved), not a branch, not superseded, and carry a file; the
//      fallback applies the SAME filters; a current row that fails the
//      filter is NOT served and NOT fallen past. The modal's "resolves to"
//      runs the same function.
//
// Every refusal AFTER the share row is known leaves one access row (kind
// "refused" + the reason, SHR-10) when the route passes the request's
// meta — bounded to one per share per minute by 20261081's unique index
// (and a served open to one per share per client IP per minute).
//
// Pure of Next: it takes any client with `.from()` and returns a
// discriminated result the routes turn into responses.

import type { supabase } from "@/lib/supabase";
import { assertNotOnHold, isHoldBlockedError, type HoldBlockedError } from "@/lib/holdGate";
import { publicHoldReason, PUBLIC_HOLD_REASON_FALLBACK } from "@/lib/holds";
import { memberHoldsAny } from "@/lib/roleHeld";
import { shareStillAuthorized } from "@/lib/shareAuthorization";
import { resolveServedVersion, shareStatusRefusal, versionServable, type ServableVersion } from "@/lib/shareRules";

/** A service-role client (createClient(...) in the route) — `.from()` and `.rpc()`. */
export type ShareServeClient = Pick<typeof supabase, "from" | "rpc">;

/** The controller tier by the role COLLECTION (is_org_controller's set). */
const SHARE_CONTROLLER_ROLES = ["Admin", "DocCtrl"] as const;

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
  library_id: string | null;
}

export type { ServableVersion };

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

/** What an outsider holding the link is told about a hold: the predefined
 *  category (or no category) — never the operator's free text, never the
 *  database's error. HLD-7 / VFY-6, the same rule as /api/verify-hold. */
export function publicShareHoldReason(e: Pick<HoldBlockedError, "holds" | "unreadable">): string {
  if (e.unreadable) {
    return "This document's hold status could not be confirmed, so it is being treated as on hold.";
  }
  const categories = [...new Set(e.holds.map((h) => publicHoldReason(h.reason)))].filter((c) => c !== PUBLIC_HOLD_REASON_FALLBACK);
  return categories.length
    ? `This document is under an active hold (${categories.join(", ")}).`
    : "This document is under an active hold.";
}

/** The request facts a refused attempt is recorded with (requestMeta). */
export type ShareAccessMeta = { ip: string | null; userAgent: string | null };

export async function resolveShareForServing(sb: ShareServeClient, token: string, access?: ShareAccessMeta): Promise<ShareServeResult> {
  if (!SHARE_TOKEN_RE.test(token)) return refuse(400, { error: "invalid" });

  const { data: share } = await sb
    .from("document_shares")
    .select("id, org_id, document_id, expires_at, revoked_at, created_by")
    .eq("token", token)
    .maybeSingle();
  if (!share) return refuse(404, { error: "notfound" });
  const s = share as unknown as ShareRow;
  // From here the share is known: a refusal is an attempt worth a row (SHR-10)
  // — someone still using a revoked link is the attempt a controller needs to see.
  const refuseKnown = async (status: number, body: ShareRefusal["body"], reason: string): Promise<ShareRefusal> => {
    if (access) {
      await recordShareAccess(sb, { share: s, documentId: s.document_id, versionId: null, kind: "refused", reason, ...access });
    }
    return refuse(status, body);
  };
  if (s.revoked_at) return refuseKnown(410, { error: "revoked" }, "revoked");
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return refuseKnown(410, { error: "expired" }, "expired");

  // Join document to the share's org — a cross-org share (EGRESS-1) yields no
  // document and 404s before any byte is fetched.
  const { data: doc } = await sb
    .from("documents")
    .select("id, document_number, title, name, rev, status, archived_at, current_version_id, library_id")
    .eq("id", s.document_id)
    .eq("org_id", s.org_id)
    .maybeSingle();
  if (!doc) return refuseKnown(404, { error: "notfound" }, "notfound");
  const d = doc as unknown as ShareDocument;

  // Serve only on the creator's CURRENT authority (EGRESS-1 dw4): if they
  // left the org or lost read access to this document, the link is dead.
  if (!(await shareStillAuthorized(s.org_id, s.created_by, d.id))) return refuseKnown(410, { error: "revoked" }, "authority_lapsed");
  // ... and on their CURRENT sharing authority (DEC-46 §1): the tier that
  // lets a copy out is checked when the copy leaves, not only when the link
  // was minted.
  if (!(await creatorMayShare(sb, s, d))) return refuseKnown(410, { error: "revoked" }, "authority_lapsed");

  const withdrawn = shareStatusRefusal(d);
  if (withdrawn) return refuseKnown(410, { error: "withdrawn", reason: withdrawn, documentStatus: d.status ?? undefined }, "withdrawn");

  try {
    await assertNotOnHold(d.id, { client: sb, action: "sharing it outside the organisation" });
  } catch (e) {
    if (isHoldBlockedError(e)) {
      // The internal message names the operator's free-text reason (or the
      // raw read error): logged here when it is an error, never sent out.
      if (e.unreadable) console.error("[share] hold state unreadable — share refused as held", { share: s.id, document: d.id, detail: e.message });
      return refuseKnown(423, { error: "on_hold", reason: publicShareHoldReason(e), unreadable: e.unreadable, documentStatus: d.status ?? undefined }, "on_hold");
    }
    throw e;
  }

  // The version — the one rule (lib/shareRules.ts), shared with the modal.
  const { version, error: versionError } = await resolveServedVersion(sb, d);
  if (versionError) console.error("[share] document_versions read failed — nothing served", { share: s.id, document: d.id, message: versionError });

  return { ok: true, share: s, doc: d, version };
}

/** May the share's creator STILL let this document out? The minting tier
 *  (DEC-46 §1, 20261080's INSERT arm) re-asked at serve time: an active
 *  member holding Admin / DocCtrl in the role COLLECTION (memberHoldsAny —
 *  never the headline alone), else a publisher granted on the document's
 *  library, asked of the database's own evaluator
 *  (user_can_publish_on_library, which applies the library's publish
 *  denies). Fails CLOSED on any read error. */
export async function creatorMayShare(sb: ShareServeClient, s: ShareRow, d: ShareDocument): Promise<boolean> {
  if (!s.created_by) return false;
  const { data: member, error } = await sb
    .from("org_members")
    .select("role, roles")
    .eq("org_id", s.org_id)
    .eq("uid", s.created_by)
    .eq("status", "active")
    .maybeSingle();
  if (error) {
    console.error("[share] creator membership unreadable — share refused", { share: s.id, message: error.message });
    return false;
  }
  if (!member) return false;
  if (memberHoldsAny(member as { role?: unknown; roles?: unknown }, SHARE_CONTROLLER_ROLES)) return true;
  if (!d.library_id) return false;
  const { data: canPublish, error: rpcError } = await sb.rpc("user_can_publish_on_library", {
    p_library: d.library_id, p_uid: s.created_by, p_org: s.org_id,
  });
  if (rpcError) {
    console.error("[share] publish grant unreadable — share refused", { share: s.id, message: rpcError.message });
    return false;
  }
  return canPublish === true;
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

/** One row per access (SHR-10): who-can-be-known (IP, UA), when, what kind
 *  — including a REFUSED attempt, with its reason. Checked write; a failure
 *  is logged loudly and reported to the caller — the download route treats
 *  the download_audits row as the record that must land, this row as the
 *  access trail. BOUNDED, because anyone holding a token (live or dead) can
 *  call the routes in a loop: refused rows carry the minute they fell in
 *  (20261081's unique (share_id, refused_minute) — one per share per
 *  minute), served opens carry theirs too (unique (share_id, ip,
 *  resolve_minute) — one per share per client IP per minute), and that
 *  unique violation is the bound working, not a failure. A download row is
 *  NOT bounded: each one is a copy that left, paired with its
 *  download_audits row. */
export async function recordShareAccess(
  sb: ShareServeClient,
  input: {
    share: ShareRow; documentId: string; versionId: string | null;
    kind: "resolve" | "download" | "refused"; reason?: string;
    ip: string | null; userAgent: string | null; now?: Date;
  },
): Promise<{ error: string | null; bounded?: true }> {
  const at = input.now ?? new Date();
  const row: Record<string, unknown> = {
    share_id: input.share.id,
    org_id: input.share.org_id,
    document_id: input.documentId,
    version_id: input.versionId,
    kind: input.kind,
    ip: input.ip,
    user_agent: input.userAgent,
    created_at: at.toISOString(),
  };
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString();
  if (input.kind === "refused") {
    row.reason = input.reason || "refused";
    row.refused_minute = minute;
  }
  if (input.kind === "resolve") row.resolve_minute = minute;
  const { error } = await sb.from("document_share_accesses").insert(row);
  if (error) {
    if (input.kind !== "download" && error.code === "23505") return { error: null, bounded: true };
    console.error("[share] document_share_accesses insert failed", { kind: input.kind, share: input.share.id, message: error.message });
    return { error: error.message || "access row not written" };
  }
  return { error: null };
}
