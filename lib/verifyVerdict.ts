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
// Beside it: whether a page can NAME what a status means (isRecognisedStatus)
// and the pack print gate's file rule (isPdfFile — not a PDF only on positive
// evidence), which the pack route uses to tell a sheet a re-print would carry
// from one it never can.
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

/** The ONE read error a verify route may tolerate on a read of an optional
 *  (later-migration) column: Postgres' undefined_column (42703), which
 *  PostgREST raises for the whole select when it names a column the
 *  database does not have yet.
 *  - The effective-date read: a database without
 *    `document_versions.effective_date` (pre-20260819) has no effective dates
 *    at all, so "no date" is the truth there. Any OTHER error (a transient
 *    PostgREST failure, a timeout) leaves the date UNKNOWN — and an unknown
 *    date could be a future one, so the route answers 503, never a verdict
 *    that might be green before the revision is in force (VFY-4 / PKG-8:
 *    late, never early).
 *  - The hold card's read: a database without
 *    `document_holds.held_rev_label` (pre-20261073) retries without it, so
 *    the sibling / legal-hold verdict (VFY-10) still reaches the field; the
 *    held-at rev is then unknown (null). Any other error is a 503. */
export function isUndefinedColumnError(error: { code?: string | null } | null | undefined): boolean {
  return !!error && error.code === "42703";
}

/** Whether a scan can say what a document's status MEANS: the DocumentStatus
 *  vocabulary (types/schema.ts — the two in-force statuses, the shared
 *  not-current set, Draft) plus the "In Review" workflow state the editors
 *  offer (not yet issued — VFY-9). A non-empty status outside it — "IFC",
 *  which two editors still offer though nothing downstream accepts it
 *  (VFY-20), or any free value — is not in force either (documentStanding
 *  reads it `not_issued`), but the scan cannot tell what the status was
 *  meant to say, so the page says "status not recognised — check with
 *  Document Control" rather than asserting "not an approved revision"
 *  (lib/verifyPresent.ts). An empty (or blank) status is recognised: it says
 *  nothing, so it is not issued. Compared exactly, as documentStanding
 *  compares — " Issued" is not Issued there, so it is not recognised here. */
export function isRecognisedStatus(status: string | null | undefined): boolean {
  const s = status ?? "";
  if (!s.trim()) return true;
  return IN_FORCE_STATUSES.has(s) || NOT_CURRENT_STATUSES.has(s) || s === "Draft" || s === "In Review";
}

/** File extensions that are positive evidence of a non-PDF — formats a
 *  document-control library holds that pdf-lib's PDFDocument.load cannot
 *  open: CAD and model files, office files, images, archives, mail. */
const NON_PDF_EXTENSIONS: ReadonlySet<string> = new Set([
  // CAD / model
  "dwg", "dxf", "dgn", "dwf", "dwfx", "rvt", "rfa", "nwd", "nwc", "ifc", "step", "stp", "iges", "igs", "stl",
  "sldprt", "sldasm", "slddrw", "sat",
  // office / text
  "xlsx", "xls", "xlsm", "xlsb", "csv", "docx", "doc", "docm", "rtf", "txt", "pptx", "ppt", "odt", "ods", "odp",
  "vsd", "vsdx", "xml", "json", "htm", "html",
  // images
  "png", "jpg", "jpeg", "tif", "tiff", "gif", "bmp", "webp", "heic", "svg",
  // archives / mail / media
  "zip", "7z", "rar", "gz", "tar", "msg", "eml", "mp4", "mov",
]);

/** MIME types that are positive evidence of a non-PDF: a whole non-document
 *  family, or an application type that names a specific non-PDF format. A
 *  generic binary type (application/octet-stream, binary/octet-stream,
 *  application/x-download …) or an empty one says nothing and is NOT here. */
const NON_PDF_MIME = /^(?:image|video|audio|text|font|model)\/|^application\/(?:vnd\.|msword$|rtf$|zip$|x-zip|x-7z|x-rar|gzip$|x-gzip$|x-tar$|json$|xml$|(?:x-)?acad$|(?:x-)?autocad|(?:x-)?dwg$|(?:x-)?dxf$|step$|iges$)/;

/** The lower-cased extension of a file path's last segment (the URL path
 *  for an http(s) URL, so a query string or fragment cannot hide it), or ""
 *  when the last segment has none. */
function fileExtension(raw: string): string {
  let path = raw;
  if (/^https?:\/\//.test(raw)) {
    try { path = new URL(raw).pathname; } catch { return ""; }
  }
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1) : "";
}

/** Whether a version's file is one the pack print gate can print: a PDF.
 *  lib/docPack.ts buildAndDownloadDocPack stamps every sheet through
 *  pdf-lib's PDFDocument.load, so a DWG, XLSX, DOCX or image the package
 *  holds is skipped at print — every time. A doubtful file leans to "a PDF"
 *  — a sheet a re-print would carry, which /api/verify-package reports red
 *  (`notInPack`) — never to the amber "cannot be printed now". So:
 *  - PDF evidence wins: the MIME type names PDF, or the path ends .pdf (on
 *    an http(s) URL, its path — a query string or fragment does not hide it).
 *    lib/knowledgeSourceSync.ts isPdf's rule, plus the URL path.
 *  - Otherwise it is NOT a PDF only on positive evidence: a known non-PDF
 *    extension (NON_PDF_EXTENSIONS) or a specific non-PDF MIME type
 *    (NON_PDF_MIME).
 *  - Anything else — no recognisable extension and an empty or generic
 *    binary type (application/octet-stream), or no path at all — is read as
 *    a PDF. (The route never asks without a path: a missing file is the
 *    builder's "no current file", decided first.) */
export function isPdfFile(fileUrl: string | null | undefined, fileType: string | null | undefined): boolean {
  const type = (fileType ?? "").toLowerCase().split(";")[0].trim();
  if (type.includes("pdf")) return true;
  const raw = (fileUrl ?? "").trim().toLowerCase();
  if (raw.endsWith(".pdf")) return true;
  const ext = fileExtension(raw);
  if (ext === "pdf") return true;
  if (NON_PDF_EXTENSIONS.has(ext)) return false;
  if (NON_PDF_MIME.test(type)) return false;
  return true;
}
