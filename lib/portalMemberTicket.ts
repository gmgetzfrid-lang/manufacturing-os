// lib/portalMemberTicket.ts
//
// SERVER-ONLY. DIST-17 (document-control P27; the integrator's ruling 3 under
// DEC-90): the transmittal portal token used by a SIGNED-IN MEMBER of the
// issuing workspace records the download as that member — never as the
// outside recipient. The recipient's portal works exactly as before.
//
// Why a ticket: the portal page saves a file by pointing a hidden frame at
// /api/transmittal?token=…&file=… (TRX-15 — the browser streams the
// attachment straight to disk), and a frame navigation carries no
// Authorization header; this app keeps its session in browser storage, not a
// cookie. So the snapshot GET — a fetch, which can carry the member's bearer
// token — identifies the member and hands the page a short-lived ticket
// naming them, bound to that one transmittal; the page adds it to each file
// address (`&member=`), and the route records the pull under that member.
// A ticket that does not verify (forged, for another transmittal, expired)
// refuses the download rather than record it as the recipient's.
//
// The ticket is an HMAC (under a fixed label, so it is useless anywhere
// else) of the transmittal id, the member's uid and an expiry. It grants
// nothing: the portal token is still the whole credential for the bytes —
// the ticket only says whose pull it is. The key: PORTAL_MEMBER_TICKET_SECRET
// when set, else the service-role key (always present where the route runs)
// — lib/unsubscribeToken.ts's pattern. With neither, no ticket is made: the
// snapshot then says the member could not be identified and the page refuses
// to download for a signed-in member rather than record them as the
// recipient.

import { createHmac, timingSafeEqual } from "node:crypto";

const LABEL = "manufacturing-os:transmittal-portal-member:v1:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a ticket names its member: the page re-reads the snapshot (and
 *  so renews it) after every download and asks for a fresh one before a
 *  download once it is older than half of this. */
export const PORTAL_MEMBER_TICKET_TTL_MS = 30 * 60 * 1000;

function secret(): string | null {
  const s = (process.env.PORTAL_MEMBER_TICKET_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return s || null;
}

function mac(key: string, transmittalId: string, uid: string, exp: number): string {
  return createHmac("sha256", key).update(`${LABEL}${transmittalId.toLowerCase()}\n${uid.toLowerCase()}\n${exp}`, "utf8").digest("base64url");
}

/** The ticket naming `uid` for downloads from `transmittalId`'s portal, or
 *  null (not ids, or no key configured). Shape: `<uid>.<exp>.<mac>`. */
export function signPortalMemberTicket(transmittalId: string, uid: string, now: number = Date.now()): string | null {
  const key = secret();
  if (!key || !UUID_RE.test(transmittalId ?? "") || !UUID_RE.test(uid ?? "")) return null;
  const exp = now + PORTAL_MEMBER_TICKET_TTL_MS;
  return `${uid.toLowerCase()}.${exp}.${mac(key, transmittalId, uid, exp)}`;
}

/** The member a ticket names for `transmittalId`, or null when it does not
 *  verify — forged, for another transmittal, expired, malformed, or no key
 *  configured. Constant-time on the MAC. */
export function verifyPortalMemberTicket(transmittalId: string, ticket: string | null | undefined, now: number = Date.now()): string | null {
  const key = secret();
  if (!key || !ticket || !UUID_RE.test(transmittalId ?? "")) return null;
  const parts = String(ticket).split(".");
  if (parts.length !== 3) return null;
  const [uid, expRaw, given] = parts;
  if (!UUID_RE.test(uid) || !/^\d{1,16}$/.test(expRaw)) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now || exp > now + PORTAL_MEMBER_TICKET_TTL_MS) return null;
  const want = Buffer.from(mac(key, transmittalId, uid, exp), "utf8");
  const got = Buffer.from(given, "utf8");
  return want.length === got.length && timingSafeEqual(want, got) ? uid : null;
}
