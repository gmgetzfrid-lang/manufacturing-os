// lib/docNumberMatch.ts — how a typed drawing number is matched (public-
// surfaces VFY-7, built by intelligence I-12 on the documents home's
// short-link resolver).

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
 *  the caller cannot tell one match from two, so it never deep-links. */
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
  return [...exact.values()];
}
