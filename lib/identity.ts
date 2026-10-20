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

// ── Workspace names typed at a public door (admin-and-org Round G P5, the
//    integrator's ruling 1 at the AO-P5 merge, 2026-10-20, DEC-90) ──────────
//
// /api/auth/signup ("is this name taken?") and /api/auth/request-access
// ("which workspace is this request for?") both look a workspace up by the
// name a stranger typed. They used to hand that text to `ilike` as the
// pattern itself, so "%" or "_cme refining" matched a real workspace — a
// request was filed with, and its Admins notified about, a workspace whose
// name the person never typed, and signup refused "Acm%" as taken because
// "Acme" exists. The text is now matched LITERALLY: exactly the stored name,
// in any letter case, the typed text trimmed — what a legitimate exact name
// matched before, and nothing else.

/** `text` escaped for a LIKE / ILIKE pattern so it matches only itself:
 *  `\`, `%` and `_` are escaped (Postgres's default escape character is
 *  `\`, which PostgREST passes through — `emailLikePattern` above relies on
 *  the same). It does NOT make `*` safe: PostgREST rewrites every `*` in a
 *  like / ilike value to `%`, with no escape — see `findOrgByTypedName`. */
export function likeLiteral(text: string): string {
  return text.replace(/([\\%_])/g, "\\$1");
}

/** How many candidate rows a name holding `*` reads before the exact check
 *  (`findOrgByTypedName`). The candidates differ from the typed name only at
 *  the `*` positions and the unique `lower(name)` index allows one row per
 *  case-folded name, so a real workspace is always among them. */
export const STAR_NAME_CANDIDATES = 50;

/** Same text, any letter case — the comparison `ilike` makes on a literal
 *  pattern. Both foldings are checked so a character JavaScript upper- and
 *  lower-cases asymmetrically still compares as Postgres's ILIKE would. */
function sameNameAnyCase(stored: string, typed: string): boolean {
  return stored.toLowerCase() === typed.toLowerCase() || stored.toUpperCase() === typed.toUpperCase();
}

/** The workspace whose stored name IS `typed` (trimmed), compared
 *  case-insensitively, or null. Never a pattern match:
 *   · a name without `*`: one `ilike` on `likeLiteral(name)` — PostgreSQL's
 *     own case-insensitive comparison of the literal text, as before for
 *     every name that holds no LIKE metacharacter;
 *   · a name holding `*` (PostgREST would read it as `%`): each `*` is sent
 *     as a one-character `_` (the rest escaped), which only NARROWS the
 *     read to same-length names, and the row is kept only if its name equals
 *     the typed text, case-insensitively, compared here — so "R*Tech" finds
 *     the workspace "r*tech" and never "RxTech".
 *  A failed read answers null (no such workspace), as the doors always
 *  treated it: signup then meets the unique `lower(name)` index, the
 *  request door the neutral acknowledgement. */
export async function findOrgByTypedName(
  client: { from: (table: string) => unknown },
  typed: string,
): Promise<{ id: string; name: string } | null> {
  const name = typed.trim();
  if (!name) return null;
  // Unconstrained on purpose (see applyEmailLookup): the filter builder's
  // own generic types send tsc into TS2589; the three methods used are
  // asserted.
  const orgs = client.from("orgs") as {
    select: (cols: string) => {
      ilike: (col: string, pattern: string) => {
        maybeSingle: () => PromiseLike<{ data: unknown }>;
        limit: (n: number) => PromiseLike<{ data: unknown }>;
      };
    };
  };
  if (!name.includes("*")) {
    const { data } = await orgs.select("id, name").ilike("name", likeLiteral(name)).maybeSingle();
    const row = data as { id?: unknown; name?: unknown } | null;
    return row && typeof row.id === "string" && typeof row.name === "string" ? { id: row.id, name: row.name } : null;
  }
  const narrowed = likeLiteral(name).replace(/\*/g, "_");
  const { data } = await orgs.select("id, name").ilike("name", narrowed).limit(STAR_NAME_CANDIDATES);
  const rows = Array.isArray(data) ? (data as Array<{ id?: unknown; name?: unknown }>) : [];
  const hit = rows.find((r) => typeof r.id === "string" && typeof r.name === "string" && sameNameAnyCase(r.name, name));
  return hit ? { id: hit.id as string, name: hit.name as string } : null;
}
