// lib/documentNames.ts — which documents were named by the faulty filename
// reader, and what their names should be.
//
// Until 2026-10-21 the reader cut a-b-c numbers out as "dates" and read any
// word starting with r as a revision: "EP 5-3-10 - Relief Valves.pdf" became
// number "EP  - Valves", rev "elief". A field is corrected ONLY when it still
// holds exactly what that reader produced from the file name (or that plus
// the "-2" an upload added to dodge a clash) — anything a person typed, or a
// title block supplied, is left alone.

import { parseFilename } from "@/lib/filenameParser";
import { legacyParseFilename } from "@/lib/filenameParserLegacy";

export interface NamedDoc {
  id: string;
  name: string | null;
  original_name?: string | null;
  document_number: string | null;
  title: string | null;
  rev: string | null;
}

export interface NameFix {
  id: string;
  fileName: string;
  from: { documentNumber: string; title: string; rev: string };
  to: { documentNumber: string; title: string; rev: string };
  /** Set when the corrected number is already used — a person decides. */
  clash?: string | null;
}

export function planNameFix(d: NamedDoc): NameFix | null {
  const fileName = (d.original_name || d.name || "").trim();
  if (!fileName) return null;
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
  if (!numberChanges && !revChanges) return null;
  return { id: d.id, fileName, from: { documentNumber: number, title, rev }, to };
}
