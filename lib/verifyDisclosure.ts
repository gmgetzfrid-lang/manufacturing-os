// lib/verifyDisclosure.ts — what a PUBLIC verify answer may name about a
// document (public-surfaces VFY-16; intelligence DACL-8 / DACL-3).
//
// The verify endpoints are unauthenticated by design (PHYS-4): whoever holds
// the paper scans it. For a private or hidden document the verdict is still
// answered — current, stale, held — but without its number or title: the
// fail-safe default DEC-90 recorded (less disclosure). A visibility the
// route could not read is treated as hidden.

/** The label a verify answer shows in place of a restricted document's. */
export const RESTRICTED_DOCUMENT_LABEL = "Restricted document";

/** May a public verify answer name this document (number, title, name)?
 *  Only when its row was read WITH `visibility` and that is "normal" or
 *  unset (NULL — the database's "normal", node_visible's first branch).
 *  Private, hidden, any other value, or a row read without the column
 *  (undefined) — not named. */
export function verifyMayNameDocument(row: { visibility?: unknown } | null | undefined): boolean {
  if (!row || !("visibility" in row)) return false;
  return row.visibility === null || row.visibility === "normal";
}

/** DACL-8 criterion 3 (intelligence I-12, the DEC-90 less-disclosing
 *  default): a work-pack cover QR WITHOUT a print id cannot say which
 *  printing it is — its sheet list would be the package's LIVE membership,
 *  which is not what the paper carries (it is never green, DEC-65 §2). Its
 *  verdict is still answered, sheet by sheet, but each sheet is named only
 *  by its place in the list, never by the live membership's number or
 *  title. A cover QR that names its print (`?print=`) answers exactly the
 *  printed sheets, named as before. */
export function legacyCoverSheetLabel(position: number): string {
  return `Sheet ${position}`;
}
