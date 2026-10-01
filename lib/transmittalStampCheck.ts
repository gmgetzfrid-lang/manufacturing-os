// lib/transmittalStampCheck.ts — SERVER-ONLY. document-control TRX-16: the
// issue-time stampability check.
//
// The transmittal portal stamps every PDF it serves (UNCONTROLLED, the
// as-issued footer, a /verify QR) — except one over PORTAL_STAMP_MAX_BYTES
// or one pdf-lib refuses to load (an owner-password / permission-restricted
// or certified vendor drawing opens in any viewer but pdf-lib's plain load
// refuses every encrypted PDF; a damaged file too). Under DEC-61 §5 such a
// PDF is released unmarked and the issuer is told AFTER the recipient pulls
// it (TRX-15). This check runs the portal's own test at ISSUE, against the
// file the issue will pin (the document's CURRENT version — the database
// pins it, 20261133), so the issuer is warned before anything is sent:
//   * the version's recorded size, then the object's length, against the
//     bound (an oversize file is never read whole);
//   * the first bytes: not "%PDF" → not a PDF (the portal does the same);
//   * PDFDocument.load(bytes) with no `ignoreEncryption` — exactly the
//     portal's call — then the portal's stamp (applyStampToPdfDoc) on the
//     loaded document, discarded (nothing is saved or kept).
// It reads with the caller's (service-role) client, scoped to the
// transmittal's org; a storage key outside the org is never fetched
// (portalKeyAllowed, the portal's rule). Nothing is written. A time budget
// bounds the whole check: items left when it runs out are `unchecked` (the
// issue is not blocked by them; DEC-61 §5 still governs the portal).

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { PDFDocument } from "pdf-lib";
import { r2, R2_BUCKET } from "@/lib/r2";
import { applyStampToPdfDoc } from "@/lib/stamping";
import type { supabase } from "@/lib/supabase";
import { PORTAL_STAMP_MAX_BYTES, STAMP_CHECK_TIME_BUDGET_MS, portalKeyAllowed, type ItemStampCheck, type TransmittalItem } from "@/lib/transmittals";

/** The check's total time budget across a transmittal's items (defined in
 *  lib/transmittals.ts, so the issuer's browser bounds its wait by it). */
export { STAMP_CHECK_TIME_BUDGET_MS };

/** Any client with `.from()` — the route's service-role client. */
type Reader = Pick<typeof supabase, "from">;

const looksLikePdf = (b: Uint8Array) => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

/** pdf-lib's refusal of an encrypted file (EncryptedPDFError). */
function isEncryptedRefusal(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? "";
  const msg = (e as { message?: string } | null)?.message ?? "";
  return name === "EncryptedPDFError" || /is encrypted/i.test(msg);
}

/** One item: the file the issue will pin, tested as the portal stamps it. */
async function checkOne(sb: Reader, orgId: string, it: TransmittalItem, outOfTime: () => boolean): Promise<ItemStampCheck> {
  const base = { documentId: it.documentId, number: it.number || "This document" };
  const unchecked = (detail: string): ItemStampCheck => ({ ...base, verdict: "unchecked", detail });
  const { data: doc, error: docErr } = await sb.from("documents").select("id, current_version_id").eq("id", it.documentId).eq("org_id", orgId).maybeSingle();
  if (docErr) return unchecked("the document could not be read");
  const current = (doc as { current_version_id?: string | null } | null)?.current_version_id ?? null;
  if (!current) return unchecked("no published file to check"); // the issue gate refuses it anyway
  const { data: ver, error: verErr } = await sb.from("document_versions").select("id, file_url, size").eq("id", current).eq("org_id", orgId).maybeSingle();
  if (verErr) return unchecked("the file's record could not be read");
  const v = ver as { file_url?: string | null; size?: number | null } | null;
  const key = v?.file_url ?? null;
  if (!key) return unchecked("no stored file to check");
  if (!portalKeyAllowed(key, orgId)) return unchecked("the stored file is outside this workspace");
  if (typeof v?.size === "number" && v.size > PORTAL_STAMP_MAX_BYTES) return { ...base, verdict: "oversize" };
  if (outOfTime()) return unchecked("not checked — the check ran out of time");
  let bytes: Uint8Array;
  try {
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const len = typeof obj.ContentLength === "number" ? obj.ContentLength : null;
    if (len !== null && len > PORTAL_STAMP_MAX_BYTES) {
      try { (obj.Body as { destroy?: () => void } | undefined)?.destroy?.(); } catch { /* already closed */ }
      return { ...base, verdict: "oversize" };
    }
    const read = await obj.Body?.transformToByteArray();
    if (!read) return unchecked("the file could not be fetched");
    bytes = read;
  } catch {
    return unchecked("the file could not be fetched");
  }
  if (bytes.byteLength > PORTAL_STAMP_MAX_BYTES) return { ...base, verdict: "oversize" };
  if (!looksLikePdf(bytes.subarray(0, 4))) return { ...base, verdict: "not_pdf" };
  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(bytes);
  } catch (e) {
    return {
      ...base,
      verdict: "unloadable",
      detail: isEncryptedRefusal(e) ? "encrypted (permission-restricted) PDF" : "the PDF could not be read (damaged or unsupported)",
    };
  }
  try {
    // The portal's stamp, on a document that is then dropped: a PDF that
    // loads but cannot take the marking fails here, as it would at download.
    await applyStampToPdfDoc(pdfDoc, {
      userLabel: "transmittal stamp check",
      timestamp: new Date(),
      watermarkText: "UNCONTROLLED — TRANSMITTAL COPY",
      footerNotice: `${base.number} as issued on a transmittal (issue-time stamp check).`,
      verifyUrl: "https://stamp-check.invalid/verify",
    });
  } catch {
    return { ...base, verdict: "unloadable", detail: "the PDF could not be stamped (damaged or unsupported)" };
  }
  return { ...base, verdict: "stampable" };
}

/** TRX-16: the portal's stamp test for every item of a draft, one item at a
 *  time (a file is held at most once, up to the bound), within the time
 *  budget. Each document is checked once even if it is listed twice. */
export async function checkItemsStampable(
  sb: Reader,
  input: { orgId: string; items: TransmittalItem[]; now?: () => number },
): Promise<ItemStampCheck[]> {
  const now = input.now ?? Date.now;
  const deadline = now() + STAMP_CHECK_TIME_BUDGET_MS;
  const outOfTime = () => now() > deadline;
  const out: ItemStampCheck[] = [];
  const seen = new Set<string>();
  for (const it of input.items) {
    if (!it?.documentId || seen.has(it.documentId)) continue;
    seen.add(it.documentId);
    out.push(await checkOne(sb, input.orgId, it, outOfTime));
  }
  return out;
}
