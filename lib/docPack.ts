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
import { documentStanding } from "@/lib/verifyVerdict";
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
 *  unbounded pack locks up or kills a field tablet. Above any of these the
 *  pack is REFUSED before anything is recorded or downloaded, with a split
 *  the person can act on. Stated defaults (document-control Round F, P8). */
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
 *  `perPack` sheets — splitPackIds makes them). */
export class PackTooLargeError extends Error {
  readonly code = "pack_too_large" as const;
  constructor(message: string, readonly parts: number, readonly perPack: number) {
    super(message);
    this.name = "PackTooLargeError";
  }
}

/** PKG-12: the sheet-count refusal, decided before any fetch. Null when the
 *  pack is within budget. Pure. */
export function packSheetBudgetRefusal(count: number): PackTooLargeError | null {
  if (count <= PACK_MAX_SHEETS) return null;
  const parts = packPartsFor(count, PACK_MAX_SHEETS);
  return new PackTooLargeError(
    `This pack has ${count} sheets — a field pack holds at most ${PACK_MAX_SHEETS}, because it is assembled in this ` +
    `browser's memory. Nothing was printed. Split it into ${parts} packs of at most ${PACK_MAX_SHEETS} sheets each ` +
    "(e.g. one work package per area) and print them separately.",
    parts, PACK_MAX_SHEETS,
  );
}

/** PKG-12: the page / byte budget, checked as sheets are merged. `merged`
 *  sheets are already in; `total` is the gated sheet count. Pure. */
function packContentBudgetRefusal(input: {
  label: string; merged: number; total: number; pages: number; bytes: number;
}): PackTooLargeError | null {
  const overPages = input.pages > PACK_MAX_PAGES;
  const overBytes = input.bytes > PACK_MAX_BYTES;
  if (!overPages && !overBytes) return null;
  const budget = overPages
    ? `${PACK_MAX_PAGES}-page budget (${input.pages} pages)`
    : `${Math.round(PACK_MAX_BYTES / (1024 * 1024))} MB budget (${Math.ceil(input.bytes / (1024 * 1024))} MB)`;
  if (input.merged === 0) {
    return new PackTooLargeError(
      `${input.label} alone is over a field pack's ${budget}, so the pack was not built and nothing was printed. ` +
      "Download that sheet on its own, and pack the others without it.",
      1, 1,
    );
  }
  const parts = Math.max(2, packPartsFor(input.total, input.merged));
  return new PackTooLargeError(
    `This pack passed a field pack's ${budget} at ${input.label} (sheet ${input.merged + 1} of ${input.total}), ` +
    `so it was not built and nothing was printed. Split it into ${parts} packs of at most ${input.merged} sheets each ` +
    "and print them separately.",
    parts, input.merged,
  );
}

const packLabel = (d: Record<string, unknown>) => String(d.document_number || d.title || d.name || "Document");

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
  const { data: docRows, error: docErr } = await supabase
    .from("documents")
    .select(columns)
    .in("id", documentIds);
  if (docErr) throw new Error(`Couldn't read the pack's documents (${docErr.message}) — nothing was printed.`);
  const accounted = accountForRequested(documentIds, (docRows as unknown as Array<Record<string, unknown>>) ?? []);
  const { data: holdRows, error: holdErr } = await supabase
    .from("document_holds")
    .select("document_id")
    .in("document_id", documentIds)
    .is("released_at", null);
  const heldIds = new Set(
    ((holdRows as Array<{ document_id: string }> | null) ?? []).map((h) => h.document_id),
  );
  const gated = filterPackDocs(accounted.rows, heldIds, !!holdErr);
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

  // PKG-12: refuse an over-budget pack before a single byte is fetched.
  const tooMany = packSheetBudgetRefusal(docs.length);
  if (tooMany) throw tooMany;

  const versionIds = docs
    .map((d) => d.current_version_id as string | null)
    .filter((v): v is string => !!v);
  const urlByVersion = new Map<string, string>();
  if (versionIds.length > 0) {
    const { data: versionRows, error: versionErr } = await supabase
      .from("document_versions")
      .select("id, file_url")
      .in("id", versionIds);
    if (versionErr) throw new Error(`Couldn't read the pack's files (${versionErr.message}) — nothing was printed.`);
    for (const v of (versionRows as Array<{ id: string; file_url: string }>) ?? []) urlByVersion.set(v.id, v.file_url);
  }

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
    // read as a PDF" from a later build failure (VFY-19, below).
    let single: PDFDocument | null = null;
    try {
      const rawUrl = versionId ? urlByVersion.get(versionId) : undefined;
      if (!rawUrl) { skipped.push({ documentId, label, reason: "no current file", code: "no_file", versionId }); continue; }

      let bytes: ArrayBuffer;
      try {
        const httpUrl = await resolveToHttpUrl(rawUrl);
        const res = await fetch(httpUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = await res.arrayBuffer();
      } catch (e) {
        // VFY-19: a fetch that failed is told apart from a file that is not
        // a readable PDF — a re-print may well carry this one.
        skipped.push({ documentId, label, reason: `the file could not be fetched (${(e as Error).message})`, code: "fetch_failed", versionId });
        continue;
      }

      // Stamp each document individually so its footer + QR are its own.
      single = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pageCount = single.getPageCount();
      const over = packContentBudgetRefusal({
        label, merged: included, total: docs.length,
        pages: pageTotal + pageCount, bytes: byteTotal + bytes.byteLength,
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
      // pdf-lib could not load the file (unparseable, not a PDF at all) or
      // loaded an encrypted one the stamper refuses. Anything else after the
      // fetch — a copyPages failure, a tablet running out of memory merging a
      // large valid PDF — is build_failed: a desktop re-print may well carry
      // it, so the verify door keeps it red ("not in this pack").
      const unreadablePdf = !single || single.isEncrypted;
      skipped.push({ documentId, label, reason: (e as Error).message, code: unreadablePdf ? "unreadable_pdf" : "build_failed", versionId });
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
