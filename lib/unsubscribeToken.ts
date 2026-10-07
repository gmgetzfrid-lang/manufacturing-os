// lib/unsubscribeToken.ts
//
// SERVER-ONLY. The signed one-click unsubscribe link a member email carries
// in its List-Unsubscribe header (notifications Round G, N6 — NEDGE-10
// done-when 1; RFC 8058). The link names the member and carries an HMAC of
// their uid AND the address it was mailed to, so it turns email off for that
// member and nobody else, with no session — a mail client's one-click POST
// has none.
//
// Why the address is in the token (N6 fix pass, the forged-row case): any
// member can queue a row naming another person's uid with their OWN address
// (email_notif_insert checks only that the address belongs to some member of
// the row's org — and an Admin of an org they created can add a membership
// row pairing any uid with any address). A token over the uid alone would
// then hand them a working link for the victim. The address a link may be
// issued for is the uid's own profile address (public.users.email — written
// only by that person, users_own, or by the server flows that resolved the
// uid FROM that address); the drain signs only when the row's to_email is
// that address, and the route re-reads it and re-derives the token, so a
// link minted for any other address is refused at the POST too.
//
// What it does: notification_preferences.email_enabled = false — the master
// switch, the documented meaning of that toggle (the plan's default). A
// drawing recall and a PSM alert still pass it (DEC-74 §9); the page says so.
//
// The key: EMAIL_UNSUBSCRIBE_SECRET when set, else the service-role key (always
// present where the drain runs), each under a fixed label so the token is
// useless anywhere else. With neither, no link is made and the header is left
// off — never an unsigned link.

import { createHmac, timingSafeEqual } from "node:crypto";

const LABEL = "manufacturing-os:email-unsubscribe:v2:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret(): string | null {
  const s = (process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return s || null;
}

/** An address as the app compares it (lib/identity.ts stores them trimmed and
 *  lowercased; 20261018 normalised the old rows): trimmed, lowercased, or
 *  null when it is not an address at all. */
export function normalizeAddress(address: string | null | undefined): string | null {
  const a = String(address ?? "").trim().toLowerCase();
  return a && a.includes("@") ? a : null;
}

/** Whether `to` (a queue row's to_email) is `profile` (the recipient's own
 *  profile address) — the only case a link is issued in. */
export function addressIsOwn(to: string | null | undefined, profile: string | null | undefined): boolean {
  const a = normalizeAddress(to);
  return a !== null && a === normalizeAddress(profile);
}

/** The token for `uid` mailed at `address`, or null (not a uid, not an
 *  address, or no key configured). */
export function signUnsubscribe(uid: string, address: string | null | undefined): string | null {
  const key = secret();
  const a = normalizeAddress(address);
  if (!key || !a || !UUID_RE.test(uid ?? "")) return null;
  return createHmac("sha256", key).update(`${LABEL}${uid.toLowerCase()}\n${a}`, "utf8").digest("base64url");
}

/** Whether `token` is the one for `uid` at `address` — constant-time. The
 *  route passes the uid's CURRENT profile address, so a link minted for any
 *  other address, or before the member changed theirs, does not verify. */
export function verifyUnsubscribe(
  uid: string | null | undefined, address: string | null | undefined, token: string | null | undefined,
): boolean {
  if (!uid || !token) return false;
  const want = signUnsubscribe(uid, address);
  if (!want) return false;
  const a = Buffer.from(want, "utf8");
  const b = Buffer.from(String(token), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The one-click link on `origin` for `uid` mailed at `address`, or null when
 *  no link can be signed. The address is not in the URL: the route reads the
 *  uid's own. */
export function unsubscribeUrl(origin: string, uid: string, address: string | null | undefined): string | null {
  const o = (origin ?? "").trim().replace(/\/+$/, "");
  const token = signUnsubscribe(uid, address);
  if (!o || !/^https?:\/\//i.test(o) || !token) return null;
  return `${o}/api/notifications/unsubscribe?u=${encodeURIComponent(uid)}&t=${encodeURIComponent(token)}`;
}
