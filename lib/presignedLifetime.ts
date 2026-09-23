// lib/presignedLifetime.ts
//
// The lifetime of a presigned R2 URL is a SERVER decision (EGR-4 / PKG-11 /
// XEDGE-6, DEC-44 §2). A presigned URL is a bearer capability: it carries no
// session, is bound to nobody, and cannot be revoked short of rotating the
// bucket credentials — every authorization the issuing route performs
// (membership, the ACL, the download deny, a hold) is spent at issuance. So
// the window it opens IS the control, and it is not the caller's to choose.
// Long-lived or forwardable access belongs on the share surface
// (document_shares: an expiry and a revoked_at), never on a presigned URL.
//
// One resolver, three outcomes:
//   absent / blank   → the default (the app's own 3600 — the only value any
//                       in-repo caller has ever asked for);
//   not an integer   → refused (the route answers 400) — never NaN-through;
//   otherwise        → clamped into [MIN, MAX], with `clamped` set so the
//                       route can report what it actually granted.

export const PRESIGNED_MIN_SECONDS = 60;
export const PRESIGNED_MAX_SECONDS = 3600;
export const PRESIGNED_DEFAULT_SECONDS = 3600;

export type PresignedLifetime =
  | { ok: true; seconds: number; clamped: boolean }
  | { ok: false; reason: string };

const NOT_AN_INTEGER = "expiresIn must be an integer number of seconds";

export function resolvePresignedLifetime(raw: string | null | undefined): PresignedLifetime {
  const s = (raw ?? "").trim();
  if (s === "") return { ok: true, seconds: PRESIGNED_DEFAULT_SECONDS, clamped: false };
  if (!/^-?\d+$/.test(s)) return { ok: false, reason: NOT_AN_INTEGER };
  const asked = Number(s);
  if (!Number.isSafeInteger(asked)) return { ok: false, reason: NOT_AN_INTEGER };
  const seconds = Math.min(PRESIGNED_MAX_SECONDS, Math.max(PRESIGNED_MIN_SECONDS, asked));
  return { ok: true, seconds, clamped: seconds !== asked };
}
