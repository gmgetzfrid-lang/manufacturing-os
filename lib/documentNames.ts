// lib/documentNames.ts — which documents were named by the faulty filename
// reader, and what their names should be.
//
// Until 2026-10-21 the reader cut a-b-c numbers out as "dates" and read any
// word starting with r as a revision: "EP 5-3-10 - Relief Valves.pdf" became
// number "EP  - Valves", rev "elief". A field is corrected ONLY when it still
// holds exactly what that reader produced from the file name (or that plus
// the "-2" an upload added to dodge a clash) — anything a person typed, or a
// title block supplied, is left alone.
//
// A second fault, from uploads up to 2026-11-10: in a library whose own rule
// is "a document is its number and its sheet", every sheet after the first
// still had "-2", "-3"… added to its number, in upload order. The suffix
// reads like a sheet number and usually is not one ("5602-D 1000-10" is
// sheet 11). It is taken off when the number is exactly the file name's
// number plus that suffix and the document has its sheet recorded: the
// number is the drawing's, the sheet says which sheet.

import { parseFilename } from "@/lib/filenameParser";
import { legacyParseFilename } from "@/lib/filenameParserLegacy";
import { readNameParts } from "@/lib/filenameRoles";

export interface NamedDoc {
  id: string;
  name: string | null;
  original_name?: string | null;
  document_number: string | null;
  title: string | null;
  rev: string | null;
  /** The sheet recorded on it, and whether the library's own rule names a
   *  document by its number and sheet together. */
  sheet?: string | null;
  sheetInKey?: boolean;
}

export interface NameFix {
  id: string;
  fileName: string;
  from: { documentNumber: string; title: string; rev: string };
  to: { documentNumber: string; title: string; rev: string };
  /** Set when the corrected number is already used — a person decides. */
  clash?: string | null;
  /** Why: the old reader's fault, or a suffix the upload added that the
   *  library's number-and-sheet rule never needed. */
  kind?: "reader" | "sheet-suffix";
  /** The sheet recorded on it, for the clash check and the wording. */
  sheet?: string | null;
}

/** The "-N" an upload added to a number the library keeps per sheet:
 *  the number without it, or null when this is not that case. */
export function sheetSuffixFix(d: NamedDoc, freshNumber: string): string | null {
  if (!d.sheetInKey || !String(d.sheet ?? "").trim()) return null;
  const number = d.document_number ?? "";
  if (!freshNumber || !number.startsWith(`${freshNumber}-`)) return null;
  return /^-\d{1,3}$/.test(number.slice(freshNumber.length)) ? freshNumber : null;
}

export function planNameFix(d: NamedDoc): NameFix | null {
  const fileName = (d.original_name || d.name || "").trim();
  if (!fileName) return null;
  // Only a confident reading corrects anything stored: a name the reader
  // could read two ways is left as it is.
  if (!readNameParts(fileName).sure) return null;
  const old = legacyParseFilename(fileName);
  const fresh = parseFilename(fileName);
  const number = d.document_number ?? "";
  const title = d.title ?? "";
  const rev = d.rev ?? "";

  const suffixed = number.startsWith(`${old.documentNumber}-`) && /^-\d+$/.test(number.slice(old.documentNumber.length));
  const numberIsOld = number === old.documentNumber || suffixed;
  const revIsOld = rev === old.rev;
  const titleIsOld = title === old.title;

  const to = {
    documentNumber: numberIsOld ? fresh.documentNumber : number,
    title: titleIsOld ? fresh.title : title,
    // Same revision in another case (b vs B) is not a fault.
    rev: revIsOld && fresh.rev.toUpperCase() !== rev.toUpperCase() ? fresh.rev : rev,
  };
  // The fault is in the number or the revision. A title alone is not a
  // fault (the old title was the whole file name, which was readable) — it
  // is only tidied alongside a real fix.
  const numberChanges = to.documentNumber !== number;
  const revChanges = to.rev !== rev;
  if (numberChanges || revChanges) return { id: d.id, fileName, from: { documentNumber: number, title, rev }, to, kind: "reader", sheet: d.sheet ?? null };
  // Nothing the old reader got wrong: a suffix the upload added?
  const bare = sheetSuffixFix(d, fresh.documentNumber);
  if (!bare) return null;
  return { id: d.id, fileName, from: { documentNumber: number, title, rev }, to: { documentNumber: bare, title, rev }, kind: "sheet-suffix", sheet: d.sheet ?? null };
}
