// lib/packLeftOut.ts
//
// Why a sheet was LEFT OUT of a printed pack — one small vocabulary shared by
// the three places that must agree on it (document-control Round F, P8 FIELD;
// public-surfaces VFY-19):
//
//   * lib/docPack.ts — the print gate (filterPackDocs) and the builder tag
//     every sheet they drop with a code beside the free-text reason the
//     printer reads in the toast;
//   * lib/workPackages.ts recordPackagePrint — the print snapshot records the
//     left-out sheets WITH their code, so the record of a printing says what
//     the paper does not hold and why;
//   * /api/verify-package — reads the code back from the snapshot and
//     publishes it (never the free text: the public contract is revision
//     facts only — no file names, no error strings, no people, DEC-65), and
//     the pack page words it through `packLeftOutText`.
//
// Pure: no client, no I/O — importable from a browser lib, a route handler
// and a test alike.

export type PackLeftOutCode =
  /** Status outside the in-force allow-list: Draft, In Review, an empty
   *  legacy status, a value the vocabulary does not know (VFY-17 / VFY-20). */
  | "not_issued"
  /** Void, Superseded, Archived — the shared not-current set. */
  | "withdrawn"
  /** An active document_holds row (stop-work). */
  | "on_hold"
  /** The hold state could not be read — treated as held (fail closed). */
  | "hold_unknown"
  /** The person printing could not read the document (an ACL-hidden member —
   *  PKG-7): never silently omitted. */
  | "unreadable"
  /** A hard read-&-understood gate with the printer's sign-off outstanding
   *  (PKG-9). */
  | "ack_required"
  /** The current revision has no file on record. */
  | "no_file"
  /** The file could not be fetched at print time (a re-print may carry it). */
  | "fetch_failed"
  /** The file was fetched but could not be read or stamped as a PDF: pdf-lib
   *  could not load it (unparseable, a file that is not a PDF) or it is
   *  encrypted (the stamper's refusal). A re-print would leave it out too. */
  | "unreadable_pdf"
  /** The file was fetched and read, but adding it to the pack failed (a page
   *  copy that threw, a device out of memory merging a large valid PDF) — a
   *  re-print, e.g. on a desktop, may carry it. */
  | "build_failed";

const TEXT: Record<PackLeftOutCode, string> = {
  not_issued: "not an issued revision when printed",
  withdrawn: "withdrawn when printed",
  on_hold: "on hold when printed",
  hold_unknown: "hold status could not be confirmed when printed",
  unreadable: "not visible to the person who printed it",
  ack_required: "an acknowledgment was outstanding when printed",
  no_file: "no current file when printed",
  fetch_failed: "its file could not be fetched when printed",
  unreadable_pdf: "its file could not be read as a PDF when printed",
  build_failed: "its file could not be added to the pack when printed",
};

export function isPackLeftOutCode(v: unknown): v is PackLeftOutCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(TEXT, v);
}

/** The public words for a left-out code; an unknown value reads as a plain
 *  "left out of this printing" (never a guess at why). */
export function packLeftOutText(code: unknown): string {
  return isPackLeftOutCode(code) ? TEXT[code] : "left out of this printing";
}

/** VFY-19: what the pack page says about WHEN a package sheet missing from
 *  the paper went missing — only from a snapshot that records its left-out
 *  sheets (the route sets one of the two fields, or neither for an older
 *  snapshot, which then says nothing about when). */
export function missingSheetWhen(item: { leftOutAtPrint?: string | null; addedSincePrint?: boolean | null }): string | null {
  if (item.addedSincePrint) return "added since this pack was printed";
  if (item.leftOutAtPrint) {
    return isPackLeftOutCode(item.leftOutAtPrint)
      ? `left out of this printing — ${TEXT[item.leftOutAtPrint]}`
      : "left out of this printing";
  }
  return null;
}
