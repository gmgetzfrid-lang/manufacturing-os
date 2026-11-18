// lib/storageWriteAllowList.ts — drafting-flow EVID-19 (DEC-90: deny by
// default, allow-list what legitimately exists): who may get a signed write
// for a storage key OUTSIDE orgs/<uuid>/.
//
// /api/storage/upload-url and /api/storage/multipart (create and complete)
// authorize an orgs/<uuid>/… key by active membership of that workspace (and
// its logo / cover / subscription rules). Before EVID-19 any other key was
// signed for ANY signed-in user of ANY workspace, so a legacy object another
// tenant's request still lists, or another person's avatar, could be
// overwritten across tenants. Both doors now ask this one helper for every
// key the orgs/ branch does not match, and sign only what it allows.
//
// The allow-list — every legitimate writer of a non-orgs/ key through these
// two doors, traced at EVID-19's fix (the record lists the inventory):
//
//   1. `avatars/<uid>/…` — lib/userProfiles.ts saveMyAvatar, the profile
//      page's photo (the signed-in person's own id, from the session). Allowed
//      for that uid alone; nothing is read.
//   2. A legacy request file in the ONE historical shape the code ever
//      named outside orgs/: `tickets/<ticketId>/attachments/<filename>`, each
//      segment of [A-Za-z0-9._-] (the initial commit's lib/paths.ts
//      storageTicketAttachmentPath, "legacy single-tenant", cleanSegment;
//      removed as dead code in #97). Every ticket key the app minted since
//      storage moved to R2 is orgs/<uuid>/tickets/… (lib/storage.ts
//      makeTicketAttachmentPath, unchanged since that commit; orgs.id has
//      been a UUID since the first schema). This is the backup restore's
//      "Put the files back" (app/(protected)/admin/restore/page.tsx), which
//      asks upload-url only for a file its existence probe
//      (/api/storage/resolve?exists=1, held to the restore surface) found NOT
//      in storage. Allowed only when a request lists the key, the caller is
//      an active Admin (the restore surface's entry rule, by the full role
//      collection) of EVERY workspace whose request lists it, each of those
//      workspaces passes the subscription gate (BILL-10, as the same restore's
//      orgs/ files do), and the object is absent; listed and stored is
//      refused with EVID-17's words (409). A key of any other shape is never
//      looked up: a restored row can list anything (the restore writes
//      tickets.attachments as the service role), so a listing alone is not
//      an allow-list.
//
// Everything else outside orgs/<uuid>/ is refused (403, plain words, nothing
// signed). Every other writer in the app mints an orgs/<uuid>/ key or writes
// server-side (never through these doors). Fail closed: a lookup or storage
// check that cannot be made refuses (503).

import type { SupabaseClient } from "@supabase/supabase-js";
import { TICKET_KEY_LISTED_REFUSAL } from "@/lib/ticketKeyOverwrite";
import { adminSurface, adminSurfaceAllows } from "@/lib/adminSurfaces";
import { heldRoles } from "@/lib/roleHeld";
import { enforceOrgAccess } from "@/lib/serverAuth";

export const OUTSIDE_ORG_REFUSAL =
  "Files can only be uploaded into a workspace you belong to, or as your own profile picture. This file location is neither, so nothing was signed.";
export const AVATAR_NOT_YOURS_REFUSAL =
  "You can only upload your own profile picture, so nothing was signed.";
export const LEGACY_KEY_NOT_ADMIN_REFUSAL =
  "That older file can only be put back by an Admin of the workspace whose request lists it, while restoring a backup. Nothing was signed.";
export const OUTSIDE_ORG_UNVERIFIED =
  "Couldn't check who may upload to that file location, so the upload was refused. Try again in a moment.";

/** The orgs/<uuid>/ prefix both doors match (character for character). */
const ORG_KEY_RE = /^orgs\/([0-9a-fA-F-]{36})\//;
const AVATAR_KEY_RE = /^avatars\/([^/]+)\/[^/]+/;
/** The one legacy request-file shape (rule 2): lib/paths.ts
 *  storageTicketAttachmentPath without an org, cleanSegment's alphabet. */
const LEGACY_TICKET_KEY_RE = /^tickets\/[A-Za-z0-9._-]+\/attachments\/[A-Za-z0-9._-]+$/;
/** More request rows than this naming one legacy key cannot be cleared in
 *  one read: refused as unverified rather than decided on a partial list
 *  (LISTING_PAGE + 1 rows are read, so exactly LISTING_PAGE is decided). */
const LISTING_PAGE = 1000;

type Refusal = { status: number; error: string };
type Head = (key: string) => Promise<unknown>;

/** True when `path` is in the orgs/<uuid>/ layout (the doors' own branch). Pure. */
export function isOrgKey(path: string): boolean {
  return ORG_KEY_RE.test(path ?? "");
}

/** True when `path` has the one legacy request-file shape rule 2 admits. Pure. */
export function isLegacyTicketKey(path: string): boolean {
  return LEGACY_TICKET_KEY_RE.test(path ?? "");
}

/** The uid an `avatars/<uid>/…` key belongs to, else null. Pure. */
export function avatarKeyOwner(path: string): string | null {
  const m = AVATAR_KEY_RE.exec(path ?? "");
  return m ? m[1] : null;
}

function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return !!err && (err.name === "NotFound" || err.name === "NoSuchKey" || err.Code === "NoSuchKey" || err.$metadata?.httpStatusCode === 404);
}

/**
 * null when a write to `path` — a key OUTSIDE orgs/<uuid>/ — may be signed
 * for `uid`; otherwise the refusal. Callers ask it only for a key their
 * orgs/<uuid>/ branch did not match (an orgs/ key reaching here is refused:
 * no request lists it as a legacy key). `head` asks storage whether the
 * object exists (it throws NotFound / 404 when it does not).
 * `subscriptionGate` names the door for BILL-10's gate (`enforceOrgAccess`,
 * asked for each listing workspace before signing — refused only with
 * SUBSCRIPTION_ENFORCE on, logged otherwise); null skips it, as the
 * multipart door's orgs/ branch skips it after create.
 */
export async function outsideOrgWriteRefusal(
  sb: Pick<SupabaseClient, "from">,
  head: Head,
  path: string,
  uid: string,
  subscriptionGate: string | null,
): Promise<Refusal | null> {
  // 1. The caller's own avatar folder — pure, nothing read.
  const avatarOwner = avatarKeyOwner(path);
  if (avatarOwner !== null) {
    return avatarOwner === uid ? null : { status: 403, error: AVATAR_NOT_YOURS_REFUSAL };
  }

  // 2. A legacy request file, for the backup restore's put-back — only in
  // its one historical shape; anything else is refused without a read.
  if (!isLegacyTicketKey(path)) return { status: 403, error: OUTSIDE_ORG_REFUSAL };
  let orgIds: Array<string | null>;
  try {
    const { data, error } = await sb
      .from("tickets")
      .select("org_id")
      .contains("attachments", JSON.stringify([{ url: path }]))
      .limit(LISTING_PAGE + 1);
    if (error) return { status: 503, error: OUTSIDE_ORG_UNVERIFIED };
    const rows = Array.isArray(data) ? (data as Array<{ org_id?: string | null }>) : [];
    if (rows.length > LISTING_PAGE) return { status: 503, error: OUTSIDE_ORG_UNVERIFIED };
    orgIds = [...new Set(rows.map((r) => (typeof r?.org_id === "string" && r.org_id ? r.org_id : null)))];
  } catch {
    return { status: 503, error: OUTSIDE_ORG_UNVERIFIED };
  }
  if (orgIds.length === 0) return { status: 403, error: OUTSIDE_ORG_REFUSAL };
  // A request row with no workspace cannot be matched to an Admin.
  if (orgIds.some((o) => o === null)) return { status: 403, error: LEGACY_KEY_NOT_ADMIN_REFUSAL };

  let adminOf: Set<string>;
  try {
    const { data, error } = await sb
      .from("org_members")
      .select("org_id, role, roles")
      .in("org_id", orgIds as string[])
      .eq("uid", uid)
      .eq("status", "active");
    if (error) return { status: 503, error: OUTSIDE_ORG_UNVERIFIED };
    const restore = adminSurface("restore");
    if (!restore) return { status: 503, error: OUTSIDE_ORG_UNVERIFIED };
    adminOf = new Set(
      (Array.isArray(data) ? (data as Array<{ org_id?: string; role?: unknown; roles?: unknown }>) : [])
        .filter((m) => typeof m?.org_id === "string" && adminSurfaceAllows(restore, heldRoles(m), null, uid))
        .map((m) => m.org_id as string),
    );
  } catch {
    return { status: 503, error: OUTSIDE_ORG_UNVERIFIED };
  }
  // An Admin of EVERY workspace whose request lists the key (done-when 2: a
  // listed legacy key is signed only for a member of that workspace).
  if (!(orgIds as string[]).every((o) => adminOf.has(o))) {
    return { status: 403, error: LEGACY_KEY_NOT_ADMIN_REFUSAL };
  }

  // BILL-10: new stored bytes for a workspace are billable — the same gate,
  // words and codes as the orgs/ branch (402 with SUBSCRIPTION_ENFORCE on,
  // logged off), for every workspace whose request lists the key.
  if (subscriptionGate) {
    for (const orgId of orgIds as string[]) {
      const gate = await enforceOrgAccess(sb as SupabaseClient, orgId, subscriptionGate);
      if (gate) return { status: gate.status, error: gate.error };
    }
  }

  // EVID-17's rule: listed and stored is never overwritten; absent is the
  // restore's put-back.
  try {
    await head(path);
  } catch (e) {
    if (isNotFound(e)) return null;
    return { status: 503, error: OUTSIDE_ORG_UNVERIFIED };
  }
  return { status: 409, error: TICKET_KEY_LISTED_REFUSAL };
}
