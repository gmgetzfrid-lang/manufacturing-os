// lib/revisionShown.ts - the revision to show for a document, or none.
//
// Until 2026-10-21 the file-name reader took any word starting with "r"
// after a space as a revision: "1-Emergency Planning and Response ERP.docx"
// was stored as Rev "esponse", "EP 5-3-10 - Relief Valve.pdf" as Rev
// "elief". Uploads since then use lib/filenameRoles.ts, which only reads
// R7, Rev 3, RevA, Revision B and the like. Documents uploaded before keep
// the bad value until someone corrects it (Knowledge health's name repair,
// lib/documentNameRepair.ts, or Edit metadata).
//
// So a stored revision is not shown when it is exactly what that old reader
// cut out of a word in the file name and the file name has no real
// revision in it. Nothing here writes anything: the stored value stays as
// it is for the repair to find.

import { readNameParts } from "@/lib/filenameRoles";

/** The old reader's revision pattern (lib/filenameParserLegacy.ts). */
const OLD_REV = /[_\- ](?:r(?:ev)?[.-]?)([A-Z0-9]+)\b/i;

/** True when `rev` is the old reader's guess from a word in `fileName`. */
export function isGuessedFromWord(rev: string | null | undefined, fileName: string | null | undefined): boolean {
  const r = (rev ?? "").trim();
  const name = (fileName ?? "").trim();
  if (!r || !name) return false;
  const base = name.replace(/\.[^.]+$/, "");
  const m = base.match(OLD_REV);
  if (!m || m[1].toUpperCase() !== r.toUpperCase()) return false;
  // A real revision in the name (R7, Rev 3, RevA) is the reader's to give.
  return !readNameParts(name).parts.some((p) => p.role === "rev");
}

/** The revision to show, or null when none is set (empty, or a guess from a
 *  word in the file name). `fileName` is the uploaded file's name. */
export function shownRevision(rev: string | null | undefined, fileName?: string | null): string | null {
  const r = (rev ?? "").trim();
  if (!r) return null;
  return isGuessedFromWord(r, fileName) ? null : r;
}

/** The file name a document was uploaded as (the original, when kept). */
export function uploadedName(doc: { name?: string | null; metadata?: unknown } | null | undefined): string {
  const meta = (doc?.metadata ?? {}) as Record<string, unknown>;
  const original = typeof meta.original_name === "string" ? meta.original_name : "";
  return original || doc?.name || "";
}
