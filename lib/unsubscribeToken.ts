// lib/unsubscribeToken.ts
//
// SERVER-ONLY. The signed one-click unsubscribe link every member email
// carries in its List-Unsubscribe header (notifications Round G, N6 —
// NEDGE-10 done-when 1; RFC 8058). The link names the member and carries an
// HMAC of their uid, so it turns email off for that member and nobody else,
// with no session — a mail client's one-click POST has none.
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

const LABEL = "manufacturing-os:email-unsubscribe:v1:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret(): string | null {
  const s = (process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return s || null;
}

/** The token for `uid`, or null (not a uid, or no key configured). */
export function signUnsubscribe(uid: string): string | null {
  const key = secret();
  if (!key || !UUID_RE.test(uid ?? "")) return null;
  return createHmac("sha256", key).update(`${LABEL}${uid.toLowerCase()}`, "utf8").digest("base64url");
}

/** Whether `token` is `uid`'s — constant-time. */
export function verifyUnsubscribe(uid: string | null | undefined, token: string | null | undefined): boolean {
  if (!uid || !token) return false;
  const want = signUnsubscribe(uid);
  if (!want) return false;
  const a = Buffer.from(want, "utf8");
  const b = Buffer.from(String(token), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The one-click link on `origin` for `uid`, or null when no link can be signed. */
export function unsubscribeUrl(origin: string, uid: string): string | null {
  const o = (origin ?? "").trim().replace(/\/+$/, "");
  const token = signUnsubscribe(uid);
  if (!o || !/^https?:\/\//i.test(o) || !token) return null;
  return `${o}/api/notifications/unsubscribe?u=${encodeURIComponent(uid)}&t=${encodeURIComponent(token)}`;
}
