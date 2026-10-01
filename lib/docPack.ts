// lib/docPack.ts
//
// DOC PACK — one click from an equipment tag to a single stamped PDF of
// every current-revision drawing for that asset. The person heading to the
// field gets the right, current, stamped set in seconds — and every sheet
// carries the verify-QR, so the pack keeps protecting itself after it's
// printed.
//
// Client-side assembly with pdf-lib: fetch each current revision, stamp it
// (uncontrolled footer + per-document QR), merge, download. Every included
// document is download-audited and leaves a 'reference' intent, exactly
// like an individual download would — written AFTER the download is
// triggered, so the record names only paper that left (EGR-6 / PKG-6).
//
// Document-control Round F (P8 FIELD): every requested document is accounted
// for — one the person printing cannot read is an explicit skip, never a
// silent hole (PKG-7); the hard read-&-understood gate applies sheet by sheet
// through the same helper a single download uses (PKG-9); the print gate is
// the verify allow-list (VFY-17); a pack has a budget and keeps the caller's
// order (PKG-12); every skip carries a code the print snapshot records
// (VFY-19, lib/packLeftOut.ts).

import { PDFDocument } from "pdf-lib";
import { supabase } from "@/lib/supabase";
import { applyStampToPdfDoc } from "@/lib/stamping";
import { recordIntent } from "@/lib/intents";
import { publicOrigin } from "@/lib/publicOrigin";
import { documentStanding, isUndefinedColumnError } from "@/lib/verifyVerdict";
import { ackGatedDocumentIds } from "@/lib/downloads";
import type { PackLeftOutCode } from "@/lib/packLeftOut";
import type { DocumentRecord } from "@/types/schema";

/** One sheet left out of a pack: the reason the printer reads, the code the
 *  print snapshot records (VFY-19), and the document it was. */
export interface PackSkip {
  documentId?: string;
  label: string;
  reason: string;
  code?: PackLeftOutCode;
  /** The revision the builder tried to print, when it got that far (a file
   *  that was missing, failed to fetch or could not be read) — so the
   *  snapshot can say WHICH file failed (VFY-19). */
  versionId?: string | null;
}

export interface DocPackResult {
  included: number;
  skipped: PackSkip[];
  /** EGR-6: the included sheets whose distribution record (download_audits)
   *  could not be written — empty when every copy is on the record. A
   *  refused write never blocks the pack, but it is never silent either. */
  unrecorded: string[];
}

/** A sheet that actually made it into the merged PDF. */
export interface PackSheetRef {
  documentId: string;
  versionId: string | null;
  label: string;
  /** PKG-12: how many pages this sheet occupies in the merged pack, in pack
   *  order — so a cover can give each entry its page number. */
  pageCount: number;
}

/** PKG-12: a field pack's budget. The builder merges in browser memory
 *  (pdf-lib holds every copied page, then writes the whole pack again), so an
 *  unbounded pack locks up or kills a field tablet. A pack over the sheet
 *  count, or whose sheets TOGETHER pass the page / byte budget, is REFUSED
 *  before anything is recorded or downloaded, with a split the person can
 *  act on. A sheet over the page / byte budget ON ITS OWN cannot be helped by
 *  any split: it is left out (`too_large`, named in the toast and on the
 *  print record) and the rest of the pack is built. Stated defaults
 *  (document-control Round F, P8). */
export const PACK_MAX_SHEETS = 150;
export const PACK_MAX_PAGES = 1000;
export const PACK_MAX_BYTES = 150 * 1024 * 1024;

/** The number of packs `count` sheets split into at `perPack` each. */
export function packPartsFor(count: number, perPack: number): number {
  if (count <= 0) return 0;
  return Math.ceil(count / Math.max(1, Math.floor(perPack)));
}

/** PKG-12: `ids` in consecutive packs of at most `perPack` sheets, in order —
 *  the split a refused pack offers. */
export function splitPackIds(ids: string[], perPack: number = PACK_MAX_SHEETS): string[][] {
  const size = Math.max(1, Math.floor(perPack));
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** PKG-12: a pack over its budget. Nothing was recorded or downloaded; the
 *  message names the budget and the split (`parts` packs of at most
 *  `perPack` sheets). `split`, when the builder knew the sheets' sizes, is
 *  the split itself — the requested ids in consecutive parts, filled from
 *  their sizes (`packSplitPlan`), so one large sheet costs its own part
 *  rather than a one-sheet-per-pack split of everything; without it,
 *  splitPackIds(ids, perPack) makes uniform parts. */
export class PackTooLargeError extends Error {
  readonly code = "pack_too_large" as const;
  constructor(message: string, readonly parts: number, readonly perPack: number, readonly split: string[][] | null = null) {
    super(message);
    this.name = "PackTooLargeError";
  }
}

/** PKG-12: one sheet of a split plan — its bytes (the recorded
 *  `document_versions.size`, or the fetched length) and pages (once loaded),
 *  null when unknown; `weightless` for a sheet the gate or its own budget
 *  already leaves out (it rides with a part only so that part's print names
 *  it). */
export interface PackPlanSheet { id: string; bytes: number | null; pages: number | null; weightless?: boolean }

/** PKG-12: the split a refused pack offers — the sheets in their order, in
 *  consecutive parts, each filled greedily up to PACK_MAX_SHEETS,
 *  PACK_MAX_PAGES and PACK_MAX_BYTES from what is known of them. An unknown
 *  size counts as the mean of the known sizes; an unknown page count as the
 *  sheet's bytes at the pages-per-byte of the sheets measured so far, else
 *  the mean of the known page counts (nothing known: no limit from it). One
 *  large sheet thus costs its own part, never a one-sheet-per-pack split of a
 *  whole tag. A part the estimate got wrong is refused on its own print with
 *  a finer split. Pure. */
export function packSplitPlan(sheets: PackPlanSheet[]): string[][] {
  const known = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const weighted = sheets.filter((s) => !s.weightless);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
  const estBytes = mean(weighted.map((s) => s.bytes).filter(known));
  const estPages = mean(weighted.map((s) => s.pages).filter(known));
  const both = weighted.filter((s) => known(s.bytes) && known(s.pages));
  const bothBytes = sum(both.map((s) => s.bytes as number));
  const pagesPerByte = bothBytes > 0 ? sum(both.map((s) => s.pages as number)) / bothBytes : null;
  const parts: string[][] = [];
  let cur: string[] = [];
  let n = 0;
  let bytes = 0;
  let pages = 0;
  for (const s of sheets) {
    if (s.weightless) { cur.push(s.id); continue; }
    const b = known(s.bytes) ? s.bytes : estBytes;
    const p = known(s.pages) ? s.pages : known(s.bytes) && pagesPerByte !== null ? s.bytes * pagesPerByte : estPages;
    if (n > 0 && (n + 1 > PACK_MAX_SHEETS || bytes + b > PACK_MAX_BYTES || pages + p > PACK_MAX_PAGES)) {
      parts.push(cur);
      cur = [];
      n = 0; bytes = 0; pages = 0;
    }
    cur.push(s.id);
    n += 1; bytes += b; pages += p;
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

/** The largest part of a split (its sheet count). */
function largestPart(split: string[][]): number {
  return split.reduce((m, p) => Math.max(m, p.length), 0);
}

/** PKG-12: the sheet-count refusal, decided before any fetch. Null when the
 *  pack is within budget. With `plan` (the requested sheets and their
 *  recorded sizes) the split is filled from the sizes (`packSplitPlan`);
 *  without it, uniform packs of PACK_MAX_SHEETS. Pure. */
export function packSheetBudgetRefusal(count: number, plan?: PackPlanSheet[]): PackTooLargeError | null {
  if (count <= PACK_MAX_SHEETS) return null;
  const split = plan ? packSplitPlan(plan) : null;
  const parts = split ? split.length : packPartsFor(count, PACK_MAX_SHEETS);
  const perPack = split ? largestPart(split) : PACK_MAX_SHEETS;
  return new PackTooLargeError(
    `This pack has ${count} sheets — a field pack holds at most ${PACK_MAX_SHEETS}, because it is assembled in this ` +
    `browser's memory. Nothing was printed. Split it into ${parts} packs of at most ${perPack} sheets each ` +
    "(e.g. one work package per area) and print them separately.",
    parts, perPack, split,
  );
}

const MB = 1024 * 1024;

/** PKG-12: why ONE sheet is over a field pack's budget on its own — its file
 *  over the byte budget (known from the fetched bytes, before pdf-lib parses
 *  anything) or its pages over the page budget — or null when it fits. Such a
 *  sheet is left out (`too_large`), never the reason a whole pack is refused:
 *  no split could carry it. Pure. */
export function packSheetOverBudget(sheet: { bytes?: number | null; pages?: number | null }): string | null {
  if (typeof sheet.bytes === "number" && sheet.bytes > PACK_MAX_BYTES) {
    return `${Math.ceil(sheet.bytes / MB)} MB on its own — over a field pack's ${Math.round(PACK_MAX_BYTES / MB)} MB budget, ` +
      "so it was left out; download it on its own";
  }
  if (typeof sheet.pages === "number" && sheet.pages > PACK_MAX_PAGES) {
    return `${sheet.pages} pages on its own — over a field pack's ${PACK_MAX_PAGES}-page budget, ` +
      "so it was left out; download it on its own";
  }
  return null;
}

/** PKG-12: the CUMULATIVE page / byte budget, checked as sheets are merged.
 *  `merged` sheets are already in; `total` is the gated sheet count. Every
 *  sheet that reaches this check fits the budget on its own
 *  (`packSheetOverBudget` left the others out), so the overflow is the
 *  pack's. With `plan` (every requested sheet, with the bytes and pages
 *  known so far — the merged sheets' and the overflowing sheet's measured)
 *  the split is filled from the sizes (`packSplitPlan`): the parts follow
 *  where the weight is, so one large early sheet no longer makes every part
 *  one sheet. Without it, the fallback is packs of at most `merged` sheets.
 *  Pure. */
export function packContentBudgetRefusal(input: {
  label: string; merged: number; total: number; pages: number; bytes: number; plan?: PackPlanSheet[];
}): PackTooLargeError | null {
  const overPages = input.pages > PACK_MAX_PAGES;
  const overBytes = input.bytes > PACK_MAX_BYTES;
  if (!overPages && !overBytes) return null;
  const budget = overPages
    ? `${PACK_MAX_PAGES}-page budget (${input.pages} pages)`
    : `${Math.round(PACK_MAX_BYTES / MB)} MB budget (${Math.ceil(input.bytes / MB)} MB)`;
  const planned = input.plan ? packSplitPlan(input.plan) : null;
  // The overflow is real: a plan that (from estimates) fits in one part is
  // not a split — fall back to the count that fitted.
  const split = planned && planned.length >= 2 ? planned : null;
  const perPack = split ? largestPart(split) : Math.max(1, input.merged);
  const parts = split ? split.length : Math.max(2, packPartsFor(input.total, perPack));
  return new PackTooLargeError(
    `This pack passed a field pack's ${budget} at ${input.label} (sheet ${input.merged + 1} of ${input.total}), ` +
    `so it was not built and nothing was printed. Split it into ${parts} packs of at most ${perPack} sheet${perPack === 1 ? "" : "s"} each ` +
    "and print them separately.",
    parts, perPack, split,
  );
}

/** VFY-19: a device that ran out of memory — at ANY stage, pdf-lib's load
 *  included (it parses the whole file there) — never a property of the file.
 *  A RangeError ("Array buffer allocation failed", "Invalid array length")
 *  or an allocation / out-of-memory message. Pure. */
export function isOutOfMemoryError(e: unknown): boolean {
  if (e instanceof RangeError) return true;
  const msg = String((e as { message?: unknown } | null)?.message ?? e ?? "");
  return /allocation|out of memory/i.test(msg);
}

/** pdf-lib's own parse / format refusals. Its error classes compile to plain
 *  `Error` (no working `instanceof` — checked against pdf-lib 1.17), so the
 *  test is the message every one of them carries: PDFParsingError and its
 *  subclasses ("Failed to parse PDF document … No PDF header found",
 *  "Failed to parse PDF object …", "Parser stalled", "Expected next byte …",
 *  "Did not find expected keyword …") and NumberParsingError ("Failed to
 *  parse number …"). */
const PDF_FORMAT_ERROR = /^(Failed to parse\b|No PDF header found|Parser stalled|Expected next byte\b|Did not find expected keyword\b)/;

/** VFY-19: the code for a sheet whose build failed AFTER its file was
 *  fetched. `unreadable_pdf` — "could not be read as a PDF; a re-print would
 *  leave it out too", which the verify door reads amber — ONLY when pdf-lib
 *  refused the file with its own parse / format error at load, or loaded it
 *  encrypted (the stamper's refusal). An out-of-memory failure at ANY stage
 *  (load included), and anything else, is `build_failed`, which the verify
 *  door keeps red: a re-print, e.g. on a desktop, may well carry it. Pure. */
export function packBuildFailureCode(
  e: unknown,
  at: { loaded: boolean; encrypted: boolean },
): "unreadable_pdf" | "build_failed" {
  if (isOutOfMemoryError(e)) return "build_failed";
  if (!at.loaded) {
    const msg = String((e as { message?: unknown } | null)?.message ?? "");
    return PDF_FORMAT_ERROR.test(msg) ? "unreadable_pdf" : "build_failed";
  }
  return at.encrypted ? "unreadable_pdf" : "build_failed";
}

const packLabel = (d: Record<string, unknown>) => String(d.document_number || d.title || d.name || "Document");

/** PKG-7: `.in()` reads are chunked (150 ids, the lib/acknowledgments.ts and
 *  lib/workPackages.ts size) so a large asset tag or package stays under
 *  PostgREST's URL limit. */
const IN_CHUNK = 150;
function chunkIds<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
}

/** PKG-7: the label of a requested document the person printing cannot read
 *  (an ACL-hidden member) — named as what it is, not a blank "Document". */
export const RESTRICTED_DOCUMENT_LABEL = "Restricted document";

/** PKG-7 / PKG-12: the rows read back for `documentIds`, in the caller's
 *  order, plus an explicit skip for every requested id the read did not
 *  return — RLS hides a document its reader may not see, and a silently
 *  shorter list is how a hidden member used to vanish from a pack while the
 *  cover still listed it. Pure. */
export function accountForRequested(
  documentIds: string[],
  rows: Array<Record<string, unknown>>,
): { rows: Array<Record<string, unknown>>; skipped: PackSkip[] } {
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const ordered: Array<Record<string, unknown>> = [];
  const skipped: PackSkip[] = [];
  const seen = new Set<string>();
  for (const id of documentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    if (row) ordered.push(row);
    else skipped.push({
      documentId: id,
      label: RESTRICTED_DOCUMENT_LABEL,
      reason: "you cannot open this document, so it could not be checked or printed — ask Document Control",
      code: "unreadable",
    });
  }
  return { rows: ordered, skipped };
}

/** PKG-9: the hard read-&-understood gate over a pack's rows, through the
 *  ONE helper a single download uses (lib/downloads.ts ackGatedDocumentIds).
 *  A gated sheet is left out with the reason — never merged. */
async function ackGatePackRows(
  rows: Array<Record<string, unknown>>,
  userId: string | null | undefined,
): Promise<{ rows: Array<Record<string, unknown>>; skipped: PackSkip[] }> {
  if (!userId || rows.length === 0) return { rows, skipped: [] };
  const gated = await ackGatedDocumentIds(
    rows.map((d) => ({
      id: String(d.id),
      libraryId: (d.library_id as string | null) ?? null,
      collectionId: (d.collection_id as string | null) ?? null,
      ackPolicy: d.ack_policy ?? null,
    })),
    userId,
  );
  const kept: Array<Record<string, unknown>> = [];
  const skipped: PackSkip[] = [];
  for (const d of rows) {
    if (gated.has(String(d.id))) {
      skipped.push({
        documentId: String(d.id),
        label: packLabel(d),
        reason: "read-&-understood sign-off outstanding — sign it before taking a copy",
        code: "ack_required",
      });
    } else kept.push(d);
  }
  return { rows: kept, skipped };
}

/** PKG-4: the field pack is the highest-consequence egress surface — a sheet
 *  that is not an in-force controlled revision must never ride into it
 *  looking like one. Anything outside the verify allow-list is REFUSED with
 *  the reason recorded in `skipped` (the crew sees what was left out and
 *  why), and a sheet under an ACTIVE HOLD is refused too: holds already block
 *  rev-up/revert/supersede as authoritative, so they bind egress the same
 *  way — "work from this document should stop" cannot coexist with putting
 *  it in a work pack. Fail CLOSED: an errored hold read excludes the sheet.
 *  VFY-17: "in force" is decided by the SAME rule the field scan uses
 *  (lib/verifyVerdict.ts documentStanding — Issued / Locked only), never a
 *  parallel list: a legacy row with an EMPTY status used to print here and
 *  then scan red ("not issued") the minute it reached the field.
 *  Pure, so the refusal rules are unit-tested without pdf-lib or a DB. */
export function filterPackDocs(
  allDocs: Array<Record<string, unknown>>,
  heldIds: Set<string>,
  holdReadFailed: boolean,
): { docs: Array<Record<string, unknown>>; skipped: PackSkip[] } {
  const docs: Array<Record<string, unknown>> = [];
  const skipped: PackSkip[] = [];
  for (const d of allDocs) {
    const documentId = String(d.id);
    const label = packLabel(d);
    const status = d.status == null ? "" : String(d.status);
    const standing = documentStanding(status);
    if (standing !== "in_force") {
      const withdrawn = standing === "void" || standing === "archived" || standing === "superseded" || standing === "retired";
      skipped.push({
        documentId,
        label,
        reason: status.trim()
          ? `${status.toLowerCase()} — not an in-force controlled revision`
          : "no status — not an issued, controlled revision",
        code: withdrawn ? "withdrawn" : "not_issued",
      });
      continue;
    }
    if (holdReadFailed) {
      skipped.push({ documentId, label, reason: "hold status could not be verified", code: "hold_unknown" });
      continue;
    }
    if (heldIds.has(documentId)) {
      skipped.push({ documentId, label, reason: "under an active hold — work from this document should stop", code: "on_hold" });
      continue;
    }
    docs.push(d);
  }
  return { docs, skipped };
}

export interface PackAssessment {
  /** In-force, hold-free sheets — safe to snapshot, list on a cover, print. */
  packable: Array<{ id: string; label: string; rev: string | null; currentVersionId: string | null }>;
  skipped: PackSkip[];
}

/** Read the requested documents (in the caller's order) and run the whole
 *  print gate over them: every requested id accounted for (PKG-7), the
 *  status / hold gate (PKG-4, VFY-17) and the read-&-understood gate
 *  (PKG-9). A read that FAILS is not an empty pack — it throws. */
async function readAndGatePackDocs(
  documentIds: string[],
  columns: string,
  userId: string | null | undefined,
): Promise<{ docs: Array<Record<string, unknown>>; skipped: PackSkip[] }> {
  if (documentIds.length === 0) return { docs: [], skipped: [] };
  const requested = [...new Set(documentIds)];
  const docRows: Array<Record<string, unknown>> = [];
  for (const ids of chunkIds(requested)) {
    const { data, error: docErr } = await supabase
      .from("documents")
      .select(columns)
      .in("id", ids);
    if (docErr) throw new Error(`Couldn't read the pack's documents (${docErr.message}) — nothing was printed.`);
    docRows.push(...((data as unknown as Array<Record<string, unknown>>) ?? []));
  }
  const accounted = accountForRequested(documentIds, docRows);
  // Fail CLOSED: a hold read that errors on any chunk treats every sheet as
  // held-unknown (PKG-4).
  const heldIds = new Set<string>();
  let holdErr = false;
  for (const ids of chunkIds(requested)) {
    const { data: holdRows, error } = await supabase
      .from("document_holds")
      .select("document_id")
      .in("document_id", ids)
      .is("released_at", null);
    if (error) { holdErr = true; break; }
    for (const h of (holdRows as Array<{ document_id: string }> | null) ?? []) heldIds.add(h.document_id);
  }
  const gated = filterPackDocs(accounted.rows, heldIds, holdErr);
  const acked = await ackGatePackRows(gated.docs, userId);
  return { docs: acked.rows, skipped: [...accounted.skipped, ...gated.skipped, ...acked.skipped] };
}

/** PKG-4's gate, runnable BEFORE any print side-effect. A caller that
 *  records an immutable print snapshot or builds a cover sheet must know
 *  which sheets will actually ride into the pack FIRST — otherwise the
 *  snapshot and the QR verdict describe paper the crew never received.
 *  Pass the printer's `userId` so the read-&-understood gate (PKG-9) is
 *  applied here too. */
export async function assessPackDocs(
  documentIds: string[],
  opts?: { userId?: string | null },
): Promise<PackAssessment> {
  const { docs, skipped } = await readAndGatePackDocs(
    documentIds,
    "id, document_number, title, name, rev, status, current_version_id, library_id, collection_id, ack_policy",
    opts?.userId,
  );
  return {
    packable: docs.map((d) => ({
      id: String(d.id),
      label: packLabel(d),
      rev: (d.rev as string | null) ?? null,
      currentVersionId: (d.current_version_id as string | null) ?? null,
    })),
    skipped,
  };
}

async function resolveToHttpUrl(raw: string): Promise<string> {
  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("blob:")) return raw;
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(
    `/api/storage/download-url?path=${encodeURIComponent(raw)}&expiresIn=3600`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Storage resolve failed (HTTP ${res.status})`);
  const { url } = await res.json();
  return url as string;
}

export async function buildAndDownloadDocPack(input: {
  orgId: string;
  packLabel: string;               // e.g. the asset tag — used in the filename
  documentIds: string[];
  userId: string;
  userEmail?: string | null;
  /** PKG-6: builds the cover AFTER the content pack has fully assembled, so
   *  it (and anything recorded inside it, like an immutable print snapshot)
   *  describes exactly the sheets that are in the PDF — never one that
   *  failed to fetch. The returned document is PREPENDED. A throw here
   *  aborts the print with nothing downloaded and no pins moved.
   *  VFY-19: it also receives every sheet THIS build left out, with its
   *  code, so the snapshot can record what the paper does not hold. */
  buildCoverAfter?: (included: PackSheetRef[], skipped: PackSkip[]) => Promise<PDFDocument | null>;
  /** PKG-6: runs after the download has been triggered — the place for
   *  state that must only ever assert an EXISTING print (pin refresh).
   *  Must not throw: the paper is already in the user's hands, so the
   *  caller reports its own failures as warnings, not as a failed print. */
  afterDownload?: (included: PackSheetRef[]) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}): Promise<DocPackResult> {
  const { docs, skipped } = await readAndGatePackDocs(
    input.documentIds,
    "id, org_id, document_number, title, name, rev, status, library_id, collection_id, ack_policy, current_version_id, checked_out_by, checked_out_by_name, checkout_note",
    input.userId,
  );

  // The current files, with their RECORDED size (document_versions.size,
  // base schema; a database without the column — 42703 — reads the path
  // alone): a file recorded over the byte budget is left out before it is
  // fetched, and a refusal's split is filled from the sizes (PKG-12).
  const versionIds = docs
    .map((d) => d.current_version_id as string | null)
    .filter((v): v is string => !!v);
  const urlByVersion = new Map<string, string>();
  const sizeByVersion = new Map<string, number>();
  for (const ids of chunkIds([...new Set(versionIds)])) {
    const first = await supabase.from("document_versions").select("id, file_url, size").in("id", ids);
    let versionErr: { message: string; code?: string } | null = first.error;
    let versionRows = first.data as unknown;
    if (versionErr && isUndefinedColumnError(versionErr)) {
      const retry = await supabase.from("document_versions").select("id, file_url").in("id", ids);
      versionErr = retry.error;
      versionRows = retry.data;
    }
    if (versionErr) throw new Error(`Couldn't read the pack's files (${versionErr.message}) — nothing was printed.`);
    for (const v of (versionRows as Array<{ id: string; file_url: string; size?: number | string | null }> | null) ?? []) {
      urlByVersion.set(v.id, v.file_url);
      const size = typeof v.size === "string" ? Number(v.size) : v.size;
      if (typeof size === "number" && Number.isFinite(size) && size >= 0) sizeByVersion.set(v.id, size);
    }
  }
  const recordedBytes = (d: Record<string, unknown>): number | null => {
    const v = (d.current_version_id as string | null) ?? null;
    return v ? sizeByVersion.get(v) ?? null : null;
  };
  // PKG-12: a split plan over EVERY requested sheet, in the caller's order —
  // the gate's refusals ride weightless (each part's print names its own),
  // and so does a file recorded over the byte budget on its own.
  const packableIds = new Set(docs.map((d) => String(d.id)));
  const docById = new Map(docs.map((d) => [String(d.id), d]));
  const measured = new Map<string, { bytes: number; pages: number }>();
  const tooLargeIds = new Set<string>();
  const planSheets = (): PackPlanSheet[] => [...new Set(input.documentIds)].map((id) => {
    const d = docById.get(id);
    if (!d || !packableIds.has(id) || tooLargeIds.has(id)) return { id, bytes: null, pages: null, weightless: true };
    const m = measured.get(id);
    const rec = recordedBytes(d);
    if (!m && packSheetOverBudget({ bytes: rec })) return { id, bytes: null, pages: null, weightless: true };
    return { id, bytes: m?.bytes ?? rec, pages: m?.pages ?? null };
  });

  // PKG-12: refuse an over-budget pack before a single byte is fetched —
  // counting the sheets that can be merged (a file recorded over the byte
  // budget on its own is left out below, never merged).
  const mergeable = docs.filter((d) => !packSheetOverBudget({ bytes: recordedBytes(d) })).length;
  const tooMany = mergeable > PACK_MAX_SHEETS ? packSheetBudgetRefusal(mergeable, planSheets()) : null;
  if (tooMany) throw tooMany;

  const merged = await PDFDocument.create();
  let included = 0;
  let done = 0;
  let pageTotal = 0;
  let byteTotal = 0;
  const includedSheets: PackSheetRef[] = [];
  const includedRows: Array<Record<string, unknown>> = [];

  for (const d of docs) {
    const documentId = String(d.id);
    const label = packLabel(d);
    const versionId = (d.current_version_id as string | null) ?? null;
    // The parsed file, once pdf-lib has loaded it — what tells "could not be
    // read as a PDF" from any other build failure (VFY-19, below).
    let single: PDFDocument | null = null;
    try {
      const rawUrl = versionId ? urlByVersion.get(versionId) : undefined;
      if (!rawUrl) { skipped.push({ documentId, label, reason: "no current file", code: "no_file", versionId }); continue; }

      // PKG-12: a file over the byte budget on its own is left out BEFORE it
      // is fetched whole — by its recorded size, then by the response's
      // declared length — so the device never allocates it; the fetched
      // length is the last check, for a file with neither.
      const leaveOutTooLarge = (why: string) => {
        tooLargeIds.add(documentId);
        skipped.push({ documentId, label, reason: why, code: "too_large", versionId });
      };
      const recordedTooBig = packSheetOverBudget({ bytes: recordedBytes(d) });
      if (recordedTooBig) { leaveOutTooLarge(recordedTooBig); continue; }

      let bytes: ArrayBuffer;
      let declaredTooBig: string | null = null;
      try {
        const httpUrl = await resolveToHttpUrl(rawUrl);
        const res = await fetch(httpUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const declared = Number(res.headers?.get("content-length") ?? NaN);
        declaredTooBig = Number.isFinite(declared) ? packSheetOverBudget({ bytes: declared }) : null;
        if (declaredTooBig) {
          try { await res.body?.cancel(); } catch { /* nothing to release */ }
          bytes = new ArrayBuffer(0);
        } else {
          bytes = await res.arrayBuffer();
        }
      } catch (e) {
        // VFY-19: a fetch that failed is told apart from a file that is not
        // a readable PDF — a re-print may well carry this one.
        skipped.push({ documentId, label, reason: `the file could not be fetched (${(e as Error).message})`, code: "fetch_failed", versionId });
        continue;
      }
      if (declaredTooBig) { leaveOutTooLarge(declaredTooBig); continue; }

      // PKG-12: …and one with no recorded or declared size is checked on its
      // fetched length, still BEFORE pdf-lib parses it (parsing it is what
      // would exhaust the device).
      const tooBig = packSheetOverBudget({ bytes: bytes.byteLength });
      if (tooBig) { leaveOutTooLarge(tooBig); continue; }

      // Stamp each document individually so its footer + QR are its own.
      single = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pageCount = single.getPageCount();
      // PKG-12: so is one whose pages alone are over the page budget — the
      // sheet is checked on its own before the pack's running total, so the
      // pack is refused (with a split) only when its sheets TOGETHER pass it.
      const tooLong = packSheetOverBudget({ pages: pageCount });
      if (tooLong) { leaveOutTooLarge(tooLong); continue; }
      measured.set(documentId, { bytes: bytes.byteLength, pages: pageCount });
      const running = { pages: pageTotal + pageCount, bytes: byteTotal + bytes.byteLength };
      const over = packContentBudgetRefusal({
        label, merged: included, total: docs.length, ...running,
        // the split plan is built only for a refusal
        plan: running.pages > PACK_MAX_PAGES || running.bytes > PACK_MAX_BYTES ? planSheets() : undefined,
      });
      if (over) throw over;
      const holderWarning = d.checked_out_by && (
        ` ACTIVE CHANGE IN PROGRESS: checked out by ${(d.checked_out_by_name as string) || "another user"} at time of issue.`
      );
      await applyStampToPdfDoc(single, {
        sourceBytes: bytes,
        userLabel: input.userEmail?.split("@")[0] ?? undefined,
        email: input.userEmail ?? undefined,
        timestamp: new Date(),
        watermarkText: "UNCONTROLLED — FIELD PACK",
        footerNotice:
          `${label} Rev ${(d.rev as string) ?? "?"} at time of issue — verify current revision before use.` +
          (holderWarning || ""),
        verifyUrl: versionId && publicOrigin()
          ? `${publicOrigin()}/verify/${String(d.id)}?v=${versionId}`
          : undefined,
      });

      const pages = await merged.copyPages(single, single.getPageIndices());
      for (const p of pages) merged.addPage(p);
      included += 1;
      pageTotal += pageCount;
      byteTotal += bytes.byteLength;
      includedSheets.push({ documentId, versionId, label, pageCount: pages.length });
      includedRows.push(d);
    } catch (e) {
      if (e instanceof PackTooLargeError) throw e;
      // VFY-19: "could not be read as a PDF" (unreadable_pdf — a re-print
      // would leave it out too, so /verify-package reads it amber) ONLY when
      // pdf-lib refused the file with its own parse / format error at load,
      // or loaded an encrypted one the stamper refuses. A tablet running out
      // of memory — at load (pdf-lib parses the whole file there) or merging —
      // and anything else is build_failed: a desktop re-print may well carry
      // it, so the verify door keeps it red ("not in this pack").
      const code = packBuildFailureCode(e, { loaded: !!single, encrypted: !!single?.isEncrypted });
      skipped.push({ documentId, label, reason: (e as Error)?.message || String(e), code, versionId });
    } finally {
      done += 1;
      input.onProgress?.(done, docs.length);
    }
  }

  if (included === 0) {
    throw new Error(
      skipped.length > 0
        ? `No documents could be packed (${skipped[0].label}: ${skipped[0].reason})`
        : "Nothing to pack",
    );
  }

  // Cover LAST (PKG-6): only now is it known exactly which sheets the paper
  // will hold, so the cover's contents list — and any print snapshot the
  // caller records while building it — cannot describe a sheet that isn't
  // in the PDF.
  if (input.buildCoverAfter) {
    const cover = await input.buildCoverAfter([...includedSheets], [...skipped]);
    if (cover) {
      const coverPages = await merged.copyPages(cover, cover.getPageIndices());
      coverPages.forEach((p, i) => merged.insertPage(i, p));
    }
  }

  const bytes = await merged.save();
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `DocPack_${input.packLabel.replace(/[^\w.\-]+/g, "_")}_${dateStr}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  // The distribution record and the reference intents name only paper that
  // left: written once the download is triggered (a failed build records
  // nothing), in one insert, and CHECKED (EGR-6) — a refused record never
  // blocks the pack, but the caller is told which sheets are unrecorded.
  const unrecorded = await recordPackDownloads(input, includedRows);

  // Pins (or any other state that asserts a print) move only AFTER the
  // download is on its way — a failed build leaves them untouched (PKG-6).
  if (input.afterDownload) await input.afterDownload([...includedSheets]);

  return { included, skipped, unrecorded };
}

/** EGR-6: one checked download_audits insert for every sheet in the pack,
 *  plus the same 'reference' intent an individual pull leaves. Returns the
 *  labels of the sheets whose record could not be written. Never throws. */
async function recordPackDownloads(
  input: { orgId: string; userId: string; userEmail?: string | null },
  rows: Array<Record<string, unknown>>,
): Promise<string[]> {
  if (rows.length === 0) return [];
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
  let unrecorded: string[] = [];
  try {
    const { error } = await supabase.from("download_audits").insert(rows.map((d) => ({
      org_id: input.orgId,
      document_id: String(d.id),
      version_id: (d.current_version_id as string | null) ?? null,
      user_id: input.userId,
      user_email: input.userEmail ?? null,
      created_at: now.toISOString(),
      expires_at: expiresAt,
      watermark_policy_id: null,
    })));
    if (error) {
      console.error("[download_audits] REFUSED — this pack is missing from the distribution record:", error.message);
      unrecorded = rows.map(packLabel);
    }
  } catch (e) {
    console.error("[download_audits] insert failed — this pack is missing from the distribution record:", (e as Error)?.message);
    unrecorded = rows.map(packLabel);
  }
  for (const d of rows) {
    const doc = d as unknown as DocumentRecord;
    void recordIntent({
      orgId: input.orgId,
      documentId: String(d.id),
      libraryId: (d.library_id as string | null) ?? null,
      userId: input.userId,
      userName: input.userEmail?.split("@")[0] ?? null,
      kind: doc.checkedOutBy === input.userId ? "edit" : "reference",
      source: "download",
      baseVersionId: (d.current_version_id as string | null) ?? null,
    });
  }
  return unrecorded;
}
