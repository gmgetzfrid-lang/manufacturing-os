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
