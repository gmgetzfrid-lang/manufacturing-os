// lib/accessRequestOutcome.ts
//
// SERVER-ONLY. The answer to an access request, emailed to the address the
// person gave at the door (notifications PROD-2 done-when 2, N8 PRODUCERS-
// FREE), and the pool told about a new request (ACCESS_REQUEST_AUDIENCE).
// Two service-role routes call the outcome email after their own write succeeded:
//
//   · /api/admin/access-requests — a decline (the person has no account:
//     the row is EXTERNAL mail, queued from the stored request, never from a
//     request body — the SURF-17 shape /api/transmittal/send-email uses);
//   · /api/admin/create-user — the membership that answered a pending
//     request (the address is now the new member's own).
//
// email_notifications.to_user_id is NOT NULL (20260529): an external row
// carries the deciding controller as its owner and metadata.external = true,
// as the transmittal route's does; the approval row carries the new member.
// Best-effort: a queue failure is logged and never fails the decision, which
// is already recorded. The maintenance cron drains the queue.
//
// Also here (N8's review fix): what text from the public door a notice may
// carry (wellFormedAddress, noticeSafeName), the per-org notice cap
// (ACCESS_REQUEST_NOTICES_PER_ORG_HOUR — the bell and the email legs both),
// and the clearing of the pool's notices once a request is decided
// (clearAccessRequestNotices).

import type { SupabaseClient } from "@supabase/supabase-js";
import { configuredPublicOrigin } from "@/lib/publicOrigin";

/** The roles told about a NEW request (the request door, PROD-2 dw1): the
 *  org's Admin / DocCtrl pool — DEC-44 (N8) item 1, the pool the holds
 *  audience uses; both may grant the membership at /api/admin/create-user
 *  and decline at /api/admin/access-requests. */
export const ACCESS_REQUEST_AUDIENCE = ["Admin", "DocCtrl"] as const;

// ── What a stranger at the public door may put into a notice ─────────────
//
// The request door is public and unauthenticated; its notice fans one request
// out to every Admin / DocCtrl, by bell and by email from the app's own sender
// (PROD-2). So nothing typed there reaches a notice unchecked (the review of
// N8: a "name" or "address" carrying a phishing line and a link, multiplied
// by the pool and repeated by rotating the address):
//   · the address must be ONE well-formed address — `wellFormedAddress`;
//     anything else is shown as "invalid address" and gets no email leg;
//   · the name loses control, line-break and invisible formatting characters,
//     and any token that reads as a link is replaced — `noticeSafeName`;
//   · the notice is capped per org (`ACCESS_REQUEST_NOTICES_PER_ORG_HOUR`):
//     past it — or when the count cannot be read — a request gets neither
//     its own bell row nor an email; each pool member holds at most ONE
//     unread "more access requests are waiting" row for the org instead
//     (the route counts and writes it). The pending list on Admin → Users
//     still lists every request.

/** The shape every address this module mails or shows must have: one token,
 *  an @, a dotted domain (the decline path's check before N8's review fix). */
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** RFC 5321's limit on a forward path. */
export const ADDRESS_MAX = 254;
/** C0 / C1 controls (line breaks among them) and the line / paragraph
 *  separators: in a name each becomes a space. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** The invisible formatting characters (zero-width, bidi embeddings,
 *  overrides and isolates, word joiners, BOM): in a name each is dropped. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const HAS_CONTROL_OR_INVISIBLE = new RegExp(`${CONTROL.source}|${INVISIBLE.source}`);

/** The address, trimmed, when it is a single well-formed address: at most
 *  254 characters, no control or invisible character, `ADDRESS_SHAPE` — and
 *  no "/" or ":" (a path or a scheme: text a mail client could turn into a
 *  web link; neither appears in an ordinary address). Otherwise null. */
export function wellFormedAddress(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || s.length > ADDRESS_MAX) return null;
  if (HAS_CONTROL_OR_INVISIBLE.test(s) || /[/:]/.test(s) || !ADDRESS_SHAPE.test(s)) return null;
  return s;
}

/** A token that reads as a link: a scheme (`https://`, `mailto:`), `www.`,
 *  or a dotted host name (`acme-sso.evil.example`, `evil.example/login`). */
const LINKISH = /(?:[a-z][a-z0-9+.-]*:\/\/|^www\.|[a-z0-9-]\.[a-z]{2,}|^[a-z][a-z0-9+.-]*:\S)/i;

/** The display name typed at the door, made safe for a bell row and an email:
 *  control and line-break characters become spaces, invisible formatting
 *  characters are dropped, runs of whitespace collapse, every token that
 *  reads as a link becomes "[link removed]", and the result is cut to `max`
 *  characters. A name written like a host ("St.John") loses that token too
 *  — the price of never relaying a link from a stranger. */
export function noticeSafeName(raw: string | null | undefined, max = 80): string {
  const flat = String(raw ?? "").replace(INVISIBLE, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  const tokens = flat ? flat.split(" ").map((t) => (LINKISH.test(t) ? "[link removed]" : t)) : [];
  return tokens.join(" ").slice(0, max).trim();
}

/** Past this many requests to one org in an hour (the new one included), a
 *  request gets no bell row and no email of its own: anyone can reach this
 *  door, and one request must not become an unbounded run of bell rows,
 *  toasts and mail to every Admin / DocCtrl — burying their compliance
 *  notices under the bell's 50-row list (TAX-6). The pool is told ONCE that
 *  more are waiting (ACCESS_REQUEST_BURST_RESOURCE_TYPE). N8's review fix. */
export const ACCESS_REQUEST_NOTICES_PER_ORG_HOUR = 5;

/** The resource the burst notice is keyed on: the org itself (resource_type
 *  'org', resource_id = the org id) — never a request id, so deciding one
 *  request (clearAccessRequestNotices) does not clear it. */
export const ACCESS_REQUEST_BURST_RESOURCE_TYPE = "org";

export type AccessRequestOutcome = "approved" | "declined";

export interface AccessRequestOutcomeInput {
  outcome: AccessRequestOutcome;
  orgId: string;
  orgName: string | null;
  /** The access_requests rows this decision answered. */
  requestIds: string[];
  /** The address on the request. Nothing is queued without one. */
  toEmail: string | null;
  /** The row's owner: the deciding controller (a decline), or the new
   *  member (an approval). */
  queuedBy: string;
  /** The address belongs to a member of the org now (an approval). */
  toMember?: boolean;
}

/** The message, rendered from the stored request only. Exported for the test. */
export function renderAccessRequestOutcome(input: Pick<AccessRequestOutcomeInput, "outcome" | "orgName">, origin = configuredPublicOrigin()): {
  subject: string; text: string;
} {
  const org = input.orgName?.trim() || "the workspace";
  if (input.outcome === "approved") {
    const where = origin ? ` Sign in at ${origin}/login.` : " Sign in to the app to get started.";
    return {
      subject: `Your request to join ${org} was approved`,
      text: `Your request to join ${org} was approved — you now have access.${where}`,
    };
  }
  return {
    subject: `Your request to join ${org}`,
    text: `Your request to join ${org} was declined. If you think this is a mistake, contact the workspace's administrator.`,
  };
}

/** Queue the outcome email. Never throws. Answers whether a row was queued. */
export async function queueAccessRequestOutcome(
  sb: SupabaseClient,
  input: AccessRequestOutcomeInput,
): Promise<boolean> {
  const to = wellFormedAddress(input.toEmail);
  if (!to || input.requestIds.length === 0) return false;
  const { subject, text } = renderAccessRequestOutcome(input);
  try {
    const { error } = await sb.from("email_notifications").insert({
      org_id: input.orgId,
      to_user_id: input.queuedBy,
      to_email: to,
      subject,
      body_text: text,
      body_html: null,
      resource_type: null,
      resource_id: input.requestIds[0],
      event_type: input.outcome === "approved" ? "access_request_approved" : "access_request_declined",
      metadata: {
        accessRequestIds: input.requestIds,
        sentVia: "server",
        ...(input.toMember ? {} : { external: true }),
      },
      status: "queued",
    });
    if (error) {
      console.warn(`[access-request] the ${input.outcome} email was not queued: ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[access-request] the ${input.outcome} email was not queued: ${(e as Error).message}`);
    return false;
  }
}

/** PROD-2 (N8 review fix): once a request is decided, the pool's
 *  access_request_pending rows about it are marked read for every recipient
 *  — the request is closed, so the notice waits on nobody (the PROD-3 rule
 *  for branch alerts). Keyed on the row's resource (resource_type
 *  'access_request', resource_id = the request id — what the request door
 *  writes, and the (org_id, resource_type, resource_id) index covers). The
 *  service role writes read_at only (20261161's read_at-only trigger passes a
 *  server write). Best-effort: answers how many rows were cleared, or null
 *  when the write failed (logged) — the decision is already recorded. */
export async function clearAccessRequestNotices(sb: SupabaseClient, orgId: string, requestIds: string[]): Promise<number | null> {
  const ids = Array.from(new Set(requestIds.filter(Boolean)));
  if (!orgId || ids.length === 0) return 0;
  try {
    const { data, error } = await sb.from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("kind", "access_request_pending")
      .eq("resource_type", "access_request")
      .in("resource_id", ids)
      .is("read_at", null)
      .select("id");
    if (error) {
      console.warn(`[access-request] the pool's notices were not cleared: ${error.message}`);
      return null;
    }
    return Array.isArray(data) ? data.length : 0;
  } catch (e) {
    console.warn(`[access-request] the pool's notices were not cleared: ${(e as Error).message}`);
    return null;
  }
}
