// lib/ticketKeyOverwrite.ts — drafting-flow EVID-17: a request's stored file
// is never overwritten in place through the signed-upload doors.
//
// /api/storage/upload-url (a single signed PUT) and /api/storage/multipart
// (create / complete) authorize a key by its workspace prefix, and upload-url
// also refuses a published revision's bytes (document-control PKG-1). A
// drafting request's file — a Draft under review, an issued Final — lives
// under orgs/<org>/tickets/ and was signed for any member of the workspace,
// so anyone who knew its key could replace the bytes every record of it
// (the attach row's ETag and sha256, the approval, the issue) still names,
// with no audit row and no earlier version kept.
//
// The rule: a write to a key under orgs/<org>/tickets/ is refused when a
// request of that workspace lists the key in `attachments` AND the object is
// in storage. Every legitimate writer is untouched:
//   * an upload (lib/storage.ts uploadTicketAttachment, the requester's
//     staging folder) always targets a FRESH timestamped key, signed before
//     any request lists it;
//   * the backup restore's file put-back (app/(protected)/admin/restore)
//     writes a key the restored request lists, but only when the file is NOT
//     in storage (it skips what is live) — the object is absent, so it is
//     signed as before;
//   * the create route's copy, the intake portal's redline, the ticket shed
//     and its restore write server-side (never through these doors).
// Fail closed (503, plain words) when the request lookup or the storage
// check cannot be made — the write it would authorize cannot be undone.
// Any request row counts, archived or not (stricter than "live": an archived
// request's file that is still in storage is not overwritable either).

import { HeadObjectCommand } from "@aws-sdk/client-s3";
import type { SupabaseClient } from "@supabase/supabase-js";

export const TICKET_KEY_LISTED_REFUSAL =
  "That file is already attached to a request, so it can't be overwritten. Upload it as a new file instead.";
export const TICKET_KEY_UNVERIFIED =
  "Couldn't check whether that file is already attached to a request, so the upload was refused. Try again in a moment.";

const TICKET_KEY_RE = /^orgs\/([0-9a-fA-F-]{36})\/tickets\//;

/** The workspace of a key under orgs/<org>/tickets/, else null. Pure. */
export function ticketKeyOrg(path: string): string | null {
  const m = TICKET_KEY_RE.exec(path ?? "");
  return m ? m[1] : null;
}

type Head = (key: string) => Promise<unknown>;

/**
 * null when a write to `path` may be signed; otherwise the refusal
 * ({ status, error }). Reads nothing for a key outside orgs/<org>/tickets/.
 * `head` asks storage whether the object exists (it throws NotFound / 404
 * when it does not).
 */
export async function ticketKeyOverwriteRefusal(
  sb: Pick<SupabaseClient, "from">,
  head: Head,
  path: string,
): Promise<{ status: number; error: string } | null> {
  const orgId = ticketKeyOrg(path);
  if (!orgId) return null;
  let listed = false;
  try {
    const { data, error } = await sb
      .from("tickets")
      .select("id")
      .eq("org_id", orgId)
      .contains("attachments", JSON.stringify([{ url: path }]))
      .limit(1);
    if (error) return { status: 503, error: TICKET_KEY_UNVERIFIED };
    listed = Array.isArray(data) ? data.length > 0 : !!data;
  } catch {
    return { status: 503, error: TICKET_KEY_UNVERIFIED };
  }
  if (!listed) return null;
  try {
    await head(path);
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
    return { status: 503, error: TICKET_KEY_UNVERIFIED };
  }
  return { status: 409, error: TICKET_KEY_LISTED_REFUSAL };
}

/** The storage existence check the two routes pass in. */
export function r2Head(r2: { send: (cmd: never) => Promise<unknown> }, bucket: string): Head {
  return (key) => r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }) as never);
}
