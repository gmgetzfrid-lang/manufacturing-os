// lib/docNumberMatch.ts — how a typed drawing number is matched (public-
// surfaces VFY-7, built by intelligence I-12 on the documents home's
// short-link resolver).

import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";

/** The identity a typed drawing number is matched on — case and
 *  punctuation forgiven ("2002 D 10001" is "2002-D-10001"). */
export const normalizeDocNumber = (v: string | null | undefined): string =>
  (v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A PostgreSQL regular expression, for a case-insensitive (`~*`, PostgREST
 *  `imatch`) read, matching exactly the document numbers whose normalized
 *  form is `norm`: its letters and digits in order, with only separators
 *  around and between them. `norm` is [a-z0-9] only (normalizeDocNumber),
 *  so nothing in it is a regex metacharacter. */
export const normalizedNumberPattern = (norm: string): string =>
  `^[^a-z0-9]*${norm.split("").join("[^a-z0-9]*")}[^a-z0-9]*$`;

/** VFY-7: every document a /d/<number> short link may mean — the rows whose
 *  normalized number IS the one typed, from two reads under the caller's own
 *  session: the app's search (`search`, which also covers a number too short
 *  to normalize usefully) and, whenever the normalized number has two or
 *  more characters, the read of the normalized number itself
 *  (`normalized(normalizedNumberPattern(norm))`). Both always run (I-12
 *  second review fix: the second ran only when the search found no exact
 *  match, so a search that found "P-101" alone never looked up "P101" and
 *  the link deep-linked to the one it found — the silent pick done-when 3
 *  forbids). The caller deep-links on exactly one, opens a chooser for more,
 *  and falls back to the search for none. Either read THROWING propagates:
 *  the caller cannot tell one match from two, so it never deep-links. The
 *  matches come back current-first (isCurrentMatch). */
/** A matched document's state, as the chooser needs it: number uniqueness
 *  binds ACTIVE documents only (lib/inputValidation), so a superseded,
 *  void or archived row can share the current one's number. */
type MatchState = { status?: unknown; rev?: unknown; archived_at?: unknown };

/** Is this match the document in force — not archived, and not of a status
 *  that is no longer current (lib/aiBoundary NOT_CURRENT_STATUSES)? */
export const isCurrentMatch = (r: MatchState): boolean =>
  !r.archived_at && !NOT_CURRENT_STATUSES.has(typeof r.status === "string" ? r.status : "");

/** What a chooser row shows beside the number and title, so two rows that
 *  share a number never look the same (I-12 third review fix): the
 *  revision, the status, and "archived" — e.g. "Rev C · Issued",
 *  "Rev B · Superseded · archived". */
export function shortLinkMatchState(r: MatchState): string {
  const parts: string[] = [];
  if (typeof r.rev === "string" && r.rev.trim()) parts.push(`Rev ${r.rev.trim()}`);
  if (typeof r.status === "string" && r.status.trim()) parts.push(r.status.trim());
  if (r.archived_at) parts.push("archived");
  return parts.join(" · ");
}

export async function shortLinkExactMatches<R extends { id: string; document_number: string | null }>(
  raw: string,
  reads: {
    search: (raw: string) => Promise<R[]>;
    normalized: (pattern: string) => Promise<R[]>;
  },
): Promise<R[]> {
  const norm = normalizeDocNumber(raw);
  const exact = new Map<string, R>();
  const take = (rows: R[]) => {
    for (const r of rows) if (normalizeDocNumber(r.document_number) === norm) exact.set(r.id, r);
  };
  take(await reads.search(raw));
  if (norm.length >= 2) take(await reads.normalized(normalizedNumberPattern(norm)));
  // Documents in force first, then the superseded / void / archived ones,
  // each group in the order found (I-12 third review fix). Both reads select
  // status, rev and archived_at, so the chooser can say which is which;
  // which one opens is still the reader's choice whenever two or more match
  // (done-when 3 — never a silent pick).
  const rows = [...exact.values()] as Array<R & MatchState>;
  return [...rows.filter(isCurrentMatch), ...rows.filter((r) => !isCurrentMatch(r))];
}
