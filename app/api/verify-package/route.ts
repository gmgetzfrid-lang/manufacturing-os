// GET /api/verify-package?p=<uuid>[&print=<uuid>]
//
// The endpoint behind the QR on a printed work-package cover sheet.
// UNAUTHENTICATED by design — the crew member holding the pack in the field
// has no account, and "SCAN BEFORE STARTING WORK" must not land on a login
// wall. Same exposure contract as /api/verify: an unguessable UUID that only
// appears on paper the org itself printed, and a response of revision-status
// facts only (labels, revs, per-sheet state, a hold's public CATEGORY) — no
// files, no URLs, no people. Every answered scan leaves a verify_scans row
// and counts toward a generous per-IP cap (VFY-12); every answer is
// Cache-Control: no-store (VFY-13).
//
// Answers: "is every sheet in this printed pack still the current revision,
// and may I work from it?" — green ONLY when the QR names a recorded print
// (PKG-2), the package is open (VFY-8), it has sheets (VFY-11), and every
// printed sheet is Issued / Locked (the shared allow-list, lib/verifyVerdict),
// hold-free (one document_holds read; an unreadable hold state is a hold —
// HLD-3 / PHYS-1 / VFY-5), still the current version, in force, and still in
// the package — and every sheet the package holds is in the pack (VFY-2). A
// package sheet missing from the paper is split by what is true of it NOW:
// one that could be printed makes the pack red (`notInPack` — "in the
// package but not in this pack"); one that cannot be printed now (not
// issued, status not recognised, withdrawn, under a document hold, no
// current file, a file that is not a PDF — the print gate's refusals, and
// only those: a legal hold alone is not one) is listed with why and makes an
// otherwise current pack amber "incomplete", never stale: a re-print would
// leave it out too.
// A cover QR with no print id cannot say which printing it is and is never
// green (VFY-2's fail-safe default, 2026-09-17).
// VFY-19 (document-control P8 FIELD): a print recorded since then also lists
// the package sheets it LEFT OUT (`printed: false`, a lib/packLeftOut.ts
// code). From such a snapshot each missing sheet also says WHEN: "left out of
// this printing — <code>" or "added to the package since this printing". The
// verdict is unchanged: the same present-tense split decides red or amber.
// An older snapshot (no marker) keeps the split alone and never claims
// "added since printing". Only the CODE is published — never the printer's
// free-text reason.

import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { documentStanding, isPdfFile, isRecognisedStatus, isUndefinedColumnError } from "@/lib/verifyVerdict";
import { effectiveStatusFor } from "@/lib/effectiveDate";
import { publicHoldReason } from "@/lib/holds";
import { checkVerifyRate, clientIp, verifyJson, verifyRateLimitedResponse } from "@/lib/verifyRateLimit";
import { recordVerifyScan } from "@/lib/verifyScanLog";
import { isPackLeftOutCode } from "@/lib/packLeftOut";
import type { NotPrintableReason, PackVerdict, SheetState } from "@/lib/verifyPresent";

// A pack verdict is never prerendered or cached (VFY-13; OFF-1 dw3).
export const dynamic = "force-dynamic";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// VFY-14: rows typed to exactly the columns selected.
interface PackageRow { id: string; org_id: string | null; name: string | null; status: string | null; closed_at: string | null }
interface PrintRow { id: string; printed_at: string | null; sheets: unknown }
interface MemberRow { document_id: string; pinned_version_id: string | null; pinned_rev_label: string | null }
interface DocRow {
  id: string; document_number: string | null; title: string | null; name: string | null;
  rev: string | null; current_version_id: string | null; status: string | null; legal_hold: boolean | null;
}
interface HoldRow { document_id: string; reason: string | null }
interface VersionDateRow { id: string; effective_date: string | null }
interface VersionFileRow { id: string; file_url: string | null; file_type?: string | null }

/** One sheet as the paper (or, for a legacy QR, the live pin) records it. */
interface SheetSource { document_id: string; version_id: string | null; rev_label: string | null; label: string | null }

const WITHDRAWN_STATES: ReadonlySet<SheetState> = new Set(["void", "archived", "superseded", "retired"]);
const NOT_GOOD_STATES: ReadonlySet<SheetState> = new Set([
  "stale", "void", "archived", "superseded", "retired", "draft", "not_issued", "status_unrecognised", "missing", "removed",
]);
/** Not an issued revision at all — says nothing about "since printing" (a
 *  legacy no-status sheet can be printed that way), so the page counts these
 *  apart from the changed / withdrawn ones. A status the vocabulary does not
 *  know ("IFC", a free value — VFY-20) is not Issued / Locked either. */
const NOT_ISSUED_STATES: ReadonlySet<SheetState> = new Set(["draft", "not_issued", "status_unrecognised"]);

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return verifyJson({ error: "Verification unavailable" }, 503);
  }
  const pkgId = req.nextUrl.searchParams.get("p") ?? "";
  // The immutable print id, when the QR carries one (PKG-2). Its recorded
  // per-sheet versions are compared against current, so the verdict reflects
  // WHAT WAS PRINTED — a later pin refresh cannot flip this paper to green.
  const printId = req.nextUrl.searchParams.get("print") ?? "";
  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const ip = clientIp(req);
  const userAgent = req.headers.get("user-agent");
  // The scan row keeps WHICH printing was scanned (the ?print= id), so two
  // papers of the same package stay distinguishable as evidence (VFY-12).
  const scan = (verdict: string) =>
    recordVerifyScan(sb, { endpoint: "verify-package", targetId: pkgId, printedRef: printId || null, verdict, ip, userAgent });
  const unavailable = async () => {
    await scan("error");
    return verifyJson({ error: "Verification unavailable — try again" }, 503);
  };

  const rate = await checkVerifyRate(sb, { ip });
  if (rate.limited) return verifyRateLimitedResponse(rate);

  if (!UUID_RE.test(pkgId) || (printId && !UUID_RE.test(printId))) {
    await scan("invalid");
    return verifyJson({ error: "Invalid code" }, 400);
  }

  const { data: pkgData, error: pkgErr } = await sb
    .from("work_packages")
    .select("id, org_id, name, status, closed_at")
    .eq("id", pkgId)
    .maybeSingle();
  if (pkgErr) return unavailable();
  if (!pkgData) {
    await scan("unknown");
    return verifyJson({ error: "Unknown package" }, 404);
  }
  const pkg = pkgData as PackageRow;
  const pkgOrgId = pkg.org_id ?? "";
  const closed = !!pkg.closed_at || pkg.status === "closed";

  // The package's membership NOW — the legacy QR's only source, and what a
  // recorded print is compared against (VFY-2: a package sheet missing from
  // the paper is not in the crew's folder; a sheet removed since is still in it).
  const { data: memberData, error: memberErr } = await sb
    .from("work_package_documents")
    .select("document_id, pinned_version_id, pinned_rev_label")
    .eq("package_id", pkgId)
    .eq("org_id", pkgOrgId);
  if (memberErr) return unavailable();
  const members = (memberData as MemberRow[] | null) ?? [];

  let printedAt: string | null = null;
  let snapshotMissing = false;
  let sources: SheetSource[];
  // VFY-19: what the print left out (document id → the code it recorded),
  // and whether the snapshot records left-outs at all.
  const leftOutAtPrint = new Map<string, string>();
  let recordsLeftOut = false;
  const printConfirmed = !!printId;
  if (printId) {
    const { data: printData, error: printErr } = await sb
      .from("work_package_prints")
      .select("id, printed_at, sheets")
      .eq("id", printId)
      .eq("package_id", pkgId)
      .eq("org_id", pkgOrgId)
      .maybeSingle();
    if (printErr) return unavailable();
    const print = printData as PrintRow | null;
    if (print) {
      printedAt = print.printed_at ?? null;
      const raw = Array.isArray(print.sheets) ? (print.sheets as Array<Record<string, unknown>>) : [];
      recordsLeftOut = raw.some((s) => typeof s.printed === "boolean");
      for (const s of raw) {
        if (s.printed !== false || !s.documentId) continue;
        leftOutAtPrint.set(String(s.documentId), isPackLeftOutCode(s.leftOutCode) ? s.leftOutCode : "left_out");
      }
      sources = raw.filter((s) => s.printed !== false).map((s) => ({
        document_id: String(s.documentId ?? ""),
        version_id: (s.versionId as string | null) ?? null,
        rev_label: (s.revLabel as string | null) ?? null,
        label: (s.label as string | null) ?? null,
      })).filter((s) => s.document_id);
    } else {
      // The QR names a print we can't find — never fall back to the live pins
      // and paint green; say the snapshot is unavailable.
      sources = [];
      snapshotMissing = true;
    }
  } else {
    sources = members.map((m) => ({
      document_id: m.document_id, version_id: m.pinned_version_id, rev_label: m.pinned_rev_label, label: null,
    }));
  }

  const onPaper = new Set(sources.map((s) => s.document_id));
  const inPackage = new Set(members.map((m) => m.document_id));
  // In the package, not on this paper. Only a recorded print can say what is
  // on the paper; a legacy QR's "paper" IS the live membership.
  const offPaperIds = printConfirmed && !snapshotMissing ? [...inPackage].filter((id) => !onPaper.has(id)) : [];

  const docIds = [...new Set([...onPaper, ...offPaperIds])];
  const byId = new Map<string, DocRow>();
  if (docIds.length) {
    const { data: docData, error: docErr } = await sb
      .from("documents")
      .select("id, document_number, title, name, rev, current_version_id, status, legal_hold")
      .in("id", docIds)
      .eq("org_id", pkgOrgId);
    if (docErr) return unavailable();
    for (const d of (docData as DocRow[] | null) ?? []) byId.set(String(d.id), d);
  }

  // ONE hold read for every printed sheet and every package sheet missing
  // from the paper. Unreadable → every printed sheet is held (fail closed: a
  // stop-work signal is never assumed absent), and a missing sheet's hold
  // state is unknown — which is a reason it cannot be printed now.
  const holdsByDoc = new Map<string, string[]>();
  let holdsUnreadable = false;
  if (docIds.length) {
    const { data: holdData, error: holdErr } = await sb
      .from("document_holds")
      .select("document_id, reason")
      .in("document_id", docIds)
      .is("released_at", null);
    if (holdErr) holdsUnreadable = true;
    else {
      for (const h of (holdData as HoldRow[] | null) ?? []) {
        const list = holdsByDoc.get(h.document_id) ?? [];
        list.push(publicHoldReason(h.reason));
        holdsByDoc.set(h.document_id, list);
      }
    }
  }

  // The current revisions' effective dates (PKG-8: the pack applies the same
  // not-yet-in-force qualification /api/verify does). Only a missing COLUMN
  // (42703 — a pre-20260819 database, which has no dates at all) means "no
  // date"; any other read error leaves the dates unknown, and an unknown date
  // may be a future one — 503, never a green pack before a sheet is in force.
  const curIds = [...new Set([...byId.values()].map((d) => d.current_version_id).filter((v): v is string => !!v))];
  const effectiveByVersion = new Map<string, string | null>();
  if (curIds.length) {
    const { data: verData, error: verErr } = await sb
      .from("document_versions")
      .select("id, effective_date")
      .in("id", curIds);
    if (verErr && !isUndefinedColumnError(verErr)) return unavailable();
    if (!verErr) for (const v of (verData as VersionDateRow[] | null) ?? []) effectiveByVersion.set(String(v.id), v.effective_date ?? null);
  }

  const labelOf = (id: string, fallback: string | null) => {
    const d = byId.get(id);
    return String(d?.document_number || d?.title || d?.name || fallback || "Document");
  };

  const sheets = sources.map((s) => {
    const d = byId.get(s.document_id);
    const reasons = holdsByDoc.get(s.document_id) ?? [];
    const held = !!d && (holdsUnreadable || d.legal_hold === true || reasons.length > 0);
    const standing = documentStanding(d?.status);
    let state: SheetState;
    if (!d) state = "missing";
    else if (held) state = "held";
    // A non-empty status outside the vocabulary is not in force, but the page
    // cannot say what it meant — "STATUS NOT RECOGNISED", as /verify says.
    else if (standing === "not_issued" && !isRecognisedStatus(d.status)) state = "status_unrecognised";
    else if (standing !== "in_force") state = standing;
    else if (!printConfirmed) state = "unconfirmed";
    else if (!s.version_id || s.version_id !== d.current_version_id) state = "stale";
    else if (!inPackage.has(s.document_id)) state = "removed";
    else if (effectiveStatusFor(d.current_version_id ? effectiveByVersion.get(d.current_version_id) : null) === "pending") state = "not_yet_effective";
    else state = "fresh";
    return {
      label: labelOf(s.document_id, s.label),
      // A legacy QR records no printing: its live pin is not "what was printed".
      printedRev: printConfirmed ? s.rev_label : null,
      currentRev: d?.rev ?? null,
      state,
      fresh: state === "fresh",
      retired: WITHDRAWN_STATES.has(state),
      held,
      holdReasons: held && !holdsUnreadable ? [...new Set(reasons)] : [],
    };
  });
  // Each package sheet missing from the paper, by what is true of it NOW.
  // Not printable now — the print gate's own refusals and no others:
  // lib/docPack.ts filterPackDocs refuses a status outside Issued / Locked
  // (read through the shared allow-list here, so an empty status is "not
  // issued" — VFY-17 — and a status the vocabulary does not know is "status
  // not recognised" — VFY-20), an active document_holds row (stop-work) and
  // an unreadable hold state; buildAndDownloadDocPack then skips a current
  // revision with no file on record ("no current file") and a file pdf-lib
  // cannot load — a DWG, XLSX, DOCX or image (`not_pdf`, isPdfFile); an
  // unreadable document is never packed either. The document's LEGAL hold is
  // not a refusal: it is preservation, not stop-work, and the gate never
  // reads it, so a legally held sheet with a PDF on file is one a re-print
  // carries — notInPack, like any printable sheet missing from the pack (on
  // the paper it then reads "held": a field scan is never green under a legal
  // hold — DEC-65 §1). A refused sheet would be left out of a
  // re-print too: listed with why, never "stale". What stays in notInPack is
  // an in-force sheet with no document_holds row and a PDF on file. (A fetch
  // that failed at print, or a PDF pdf-lib could not parse, stays here; a
  // snapshot that records its left-out sheets only adds WHEN — VFY-19.)
  type WhenMissing = { leftOutAtPrint?: string; addedSincePrint?: true };
  const notPrintable: Array<{ label: string; reason: NotPrintableReason } & WhenMissing> = [];
  const notInPack: Array<{ label: string } & WhenMissing> = [];
  const offPaper = offPaperIds.map((id) => {
    const d = byId.get(id);
    const standing = documentStanding(d?.status);
    let reason: NotPrintableReason | null = null;
    if (!d) reason = "unavailable";
    else if (holdsUnreadable) reason = "hold_unknown";
    else if ((holdsByDoc.get(id)?.length ?? 0) > 0) reason = "on_hold";
    else if (standing === "not_issued" && !isRecognisedStatus(d.status)) reason = "status_unrecognised";
    else if (standing === "draft" || standing === "not_issued") reason = "not_issued";
    else if (standing !== "in_force") reason = "withdrawn";
    else if (!d.current_version_id) reason = "no_file";
    return { id, curId: d?.current_version_id ?? null, reason };
  });
  // The file of each remaining sheet's current revision — read once, only
  // when one is needed. file_type is in the base schema; a database without
  // it (42703) still reads the path alone. Any other error leaves the split
  // unknown — 503, never a guess at red or amber.
  const fileIds = [...new Set(offPaper.filter((o) => !o.reason && o.curId).map((o) => o.curId as string))];
  const fileByVersion = new Map<string, VersionFileRow>();
  if (fileIds.length) {
    const first = await sb.from("document_versions").select("id, file_url, file_type").in("id", fileIds);
    let fileErr = first.error;
    let fileRows = first.data as VersionFileRow[] | null;
    if (fileErr && isUndefinedColumnError(fileErr)) {
      const retry = await sb.from("document_versions").select("id, file_url").in("id", fileIds);
      fileErr = retry.error;
      fileRows = retry.data as VersionFileRow[] | null;
    }
    if (fileErr) return unavailable();
    for (const v of fileRows ?? []) fileByVersion.set(String(v.id), v);
  }
  for (const o of offPaper) {
    let reason: NotPrintableReason | null = o.reason;
    if (!reason && o.curId) {
      const f = fileByVersion.get(o.curId);
      // No version row, or one with no file, is the builder's "no current file".
      if (!f?.file_url) reason = "no_file";
      else if (!isPdfFile(f.file_url, f.file_type ?? null)) reason = "not_pdf";
    }
    const atPrint = leftOutAtPrint.get(o.id);
    const when: WhenMissing = !recordsLeftOut ? {} : atPrint ? { leftOutAtPrint: atPrint } : { addedSincePrint: true };
    const label = labelOf(o.id, null);
    if (reason) notPrintable.push({ label, reason, ...when });
    else notInPack.push({ label, ...when });
  }

  const staleCount = sheets.filter((s) => NOT_GOOD_STATES.has(s.state)).length;
  const notIssuedCount = sheets.filter((s) => NOT_ISSUED_STATES.has(s.state)).length;
  const heldCount = sheets.filter((s) => s.state === "held").length;

  let verdict: PackVerdict;
  if (snapshotMissing) verdict = "unverifiable";
  else if (closed) verdict = "closed";                         // VFY-8
  else if (sheets.length === 0) verdict = "empty";             // VFY-11
  else if (heldCount > 0) verdict = "held";                    // HLD-3 / PHYS-1
  else if (staleCount > 0 || notInPack.length > 0) verdict = "stale";
  else if (!printConfirmed) verdict = "unconfirmed_print";     // VFY-2 legacy QR
  else if (sheets.some((s) => s.state === "not_yet_effective")) verdict = "not_yet_effective";
  else if (notPrintable.length > 0) verdict = "incomplete";    // VFY-2: amber, not stale
  else verdict = "current";

  await scan(verdict);

  return verifyJson({
    name: pkg.name ?? "Work package",
    packageStatus: pkg.status ?? null,
    closed,
    printedAt,
    snapshotMissing,
    // The QR named a print record AND it was found.
    printConfirmed: printConfirmed && !snapshotMissing,
    sheetCount: sheets.length,
    staleCount,
    notIssuedCount,
    heldCount,
    notInPack,
    notPrintable,
    verdict,
    // Back-compat: true ONLY for the green verdict.
    allFresh: verdict === "current",
    sheets,
    checkedAt: new Date().toISOString(),
  });
}
