// lib/identity.ts
//
// Email identity helpers (audit findings IDENT-1…IDENT-3). Identity in this
// system is keyed by auth uid, but every door that ADMITS an identity —
// signup, Team Management "Add member", access requests — matches people by
// email. Three routes compared emails case-sensitively while a fourth
// case-folded in the same file, so one address written two ways could both
// miss its existing account and mint a second one. Normalize once, here, and
// compare case-insensitively everywhere. The database backstop is the
// lower(email) unique index pair in
// supabase/migrations/20261018_identity_email_unique.sql.

/** Canonical form of an email for storage and comparison: trimmed and
 *  lowercased. Every write of an email column and every equality check goes
 *  through this, so `users.email` and `org_members.email` can never disagree
 *  about the same person by case alone. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** PostgREST `ilike` pattern that matches exactly this email,
 *  case-insensitively. Emails may legally contain `%` and `_` — LIKE
 *  wildcards — so the address is escaped, otherwise `a_b@x.com` would also
 *  match `axb@x.com`. Needed for lookups because rows written before
 *  normalization may be stored mixed-case; a plain `eq` on the normalized
 *  form would miss them. */
export function emailLikePattern(email: string): string {
  return normalizeEmail(email).replace(/([\\%_])/g, "\\$1");
}
