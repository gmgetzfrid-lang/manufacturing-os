// lib/verifyVerdict.ts
//
// The ONE status decision the public verify surfaces share (public-surfaces
// VFY-1 / VFY-9, document-control PKG-8). /api/verify answers for a single
// printed sheet, /api/verify-package for every sheet of a printed pack; both
// ask the same question of documents.status — "may a field scan read this
// document as in force?" — and before Round F they answered it with two
// different inline lists (the package route's still left Draft green).
//
// The answer is an ALLOW-list: only Issued and Locked — the two states
// lib/downloads.ts viewerStatusBadge renders as "Controlled" — can ever read
// green. Every other value, including a status added to the vocabulary later
// and an empty / NULL status, is not in force. Retirement is still read from
// the shared not-current set (NOT_CURRENT_STATUSES, lib/aiBoundary.ts — never
// an inline list), so a status added to THAT set reads retired here too.
//
// Pure: no client, no I/O — importable from a route handler and a test alike.

import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";

/** The statuses a field scan may read as in force (VFY-1 done-when 2). */
export const IN_FORCE_STATUSES: ReadonlySet<string> = new Set(["Issued", "Locked"]);

/** A document's standing for a field scan, most specific first:
 *  `void` / `archived` / `superseded` name the three members of the shared
 *  not-current set; `retired` is any OTHER member (future-proofing — a new
 *  retired status can never default to green); `draft` is never issued;
 *  `not_issued` is any status outside the allow-list (an unknown or empty
 *  one); `in_force` is Issued or Locked. */
export type DocumentStanding = "in_force" | "void" | "archived" | "superseded" | "retired" | "draft" | "not_issued";

export function documentStanding(status: string | null | undefined): DocumentStanding {
  const s = status ?? "";
  if (NOT_CURRENT_STATUSES.has(s)) {
    if (s === "Void") return "void";
    if (s === "Archived") return "archived";
    if (s === "Superseded") return "superseded";
    return "retired";
  }
  if (s === "Draft") return "draft";
  if (IN_FORCE_STATUSES.has(s)) return "in_force";
  return "not_issued";
}

/** The ONE read error a verify route may tolerate on the effective-date read:
 *  Postgres' undefined_column (42703) — a database without the
 *  `document_versions.effective_date` column (pre-20260819) has no effective
 *  dates at all, so "no date" is the truth there. Any OTHER error (a
 *  transient PostgREST failure, a timeout) leaves the date UNKNOWN — and an
 *  unknown date could be a future one, so the route answers 503, never a
 *  verdict that might be green before the revision is in force (VFY-4 /
 *  PKG-8: late, never early). */
export function isUndefinedColumnError(error: { code?: string | null } | null | undefined): boolean {
  return !!error && error.code === "42703";
}
