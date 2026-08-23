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
 *  form would miss them.
 *
 *  ⚠ Do not feed this an address containing `*`: PostgREST rewrites every
 *  `*` in a like/ilike value to `%` with NO escape sequence, so a literal
 *  asterisk is inexpressible and the pattern silently becomes a wildcard —
 *  `greg*@x.com` would match `gregory@x.com` (adversarial-review finding).
 *  Use `applyEmailLookup`, which routes those addresses to an exact match. */
export function emailLikePattern(email: string): string {
  return normalizeEmail(email).replace(/([\\%_])/g, "\\$1");
}

/** The one way to filter a query by email. Case-insensitive exact match via
 *  the escaped ilike pattern; addresses containing `*` (rare but RFC-legal,
 *  and inexpressible through PostgREST's ilike — see above) fall back to a
 *  case-SENSITIVE eq on the canonical form. That fallback is exact for all
 *  data written after normalization (and after migration 20261018's
 *  backfill); the residual pre-migration mixed-case `*`-address corner
 *  fails toward "not found", which every caller already handles safely —
 *  never toward matching a different person. */
export function applyEmailLookup<T>(query: T, column: string, email: string): T {
  // Unconstrained generic on purpose: checking the Supabase filter builder
  // against a structural constraint (or a self-referential `eq(...): T`)
  // sends tsc into excessively-deep instantiation (TS2589). The two methods
  // are asserted instead — both exist on every filter builder, and the unit
  // tests exercise the routing with a stub.
  const q = query as unknown as {
    eq: (column: string, value: string) => unknown;
    ilike: (column: string, pattern: string) => unknown;
  };
  const canonical = normalizeEmail(email);
  if (canonical.includes("*")) return q.eq(column, canonical) as T;
  return q.ilike(column, emailLikePattern(canonical)) as T;
}
