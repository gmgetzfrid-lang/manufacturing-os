// GET /api/verify?doc=<uuid>&v=<uuid>
// GET /api/verify?t=<sheet token>   (a printed pack's sheet — PS-P9)
//
// The endpoint behind the QR code stamped on every uncontrolled copy.
// UNAUTHENTICATED by design: a contractor in the field scans a paper print
// with a phone — no account, no login. Exposure is minimal and deliberate:
//   * Both IDs are unguessable UUIDs that only appear ON a printed copy the
//     org itself issued.
//   * The response contains ONLY revision-status facts (doc number, title,
//     printed rev vs current rev, dates, the document's status, and whether
//     it is held — the hold's public CATEGORY only, never operator text) —
//     no file access, no URLs, no content, no people. A private or hidden
//     document (or one whose visibility was not read) is answered without
//     its number or title: number null, title "Restricted document"
//     (public-surfaces VFY-16; intelligence DACL-8 / DACL-3, lib/verifyDisclosure).
//   * Every answered scan leaves a row in verify_scans (endpoint, target,
//     verdict, client IP / user agent — VFY-12) and counts toward a generous
//     per-IP hourly cap; every answer is Cache-Control: no-store (VFY-13).
//
// Answers exactly one question: "is the paper in my hand still current?" —
// and it says so only when it KNOWS: the document is Issued or Locked (an
// allow-list, VFY-1), not held, the QR names the version printed (a QR with
// no ?v= cannot say which revision the paper is — VFY-3), that version is
// the current one, and its effective date has arrived in the facility's
// calendar (effectiveStatusFor → effectiveTodayISO, VFY-4 / REV-9) — the
// document's workspace zone when its Admin set one, else the deployment's
// (VFY-15: workspaceEffectiveDateTimeZone).
//
// PS-P9 (intelligence DACL-8 criterion 2, rulings under DEC-90): a printed
// pack's sheet QR names its sheet by a per-print token the server minted at
// print time (print_sheet_tokens, 20261237 — only its SHA-256 is stored).
// ?t= resolves it to (document, version, print) and the verdict is answered
// for THAT print, through exactly the path a ?doc=&v= QR takes; a token
// whose print was voided (the pack never left, or the sheet was not in the
// PDF) reads `print_voided` — red, never green — unless a stop-work or a
// retirement says more. A token answer discloses nothing a ?doc=&v= answer
// would not (lib/verifyDisclosure: no number or title for a restricted
// document). Every QR printed before PS-P9 — doc-only and ?v= — is answered
// exactly as before.
//
// PS-P10 (public-surfaces PHYS-20 limb 2): the token read also names the
// void reason (a column since 20261237). A sheet whose print a controller
// RECALLED (void_reason 'recalled', 20261240) is still `print_voided` — red,
// never green, the same verdict and scan row — and its answer adds
// sheetPrint.recalled / recalledAt, so the page says Document Control
// recalled it, and when. 'not_printed' / 'print_aborted' answer exactly as
// before (no added key).

import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { documentStanding, isUndefinedColumnError } from "@/lib/verifyVerdict";
import { effectiveStatusFor, workspaceEffectiveDateTimeZone } from "@/lib/effectiveDate";
import { publicHoldReason } from "@/lib/holds";
import { checkVerifyRate, clientIp, verifyJson, verifyRateLimitedResponse } from "@/lib/verifyRateLimit";
import { recordVerifyScan } from "@/lib/verifyScanLog";
import type { DocVerdict } from "@/lib/verifyPresent";
import { RESTRICTED_DOCUMENT_LABEL, verifyMayNameDocument } from "@/lib/verifyDisclosure";
import { isSheetToken } from "@/lib/printSheetTokens";
import { hashSheetToken, isMissingSheetTokenTable } from "@/lib/printSheetTokensServer";

// A revision verdict is never prerendered or cached (VFY-13; OFF-1 dw3).
export const dynamic = "force-dynamic";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// VFY-14: the rows are typed to exactly the columns selected, and the select
// names only what the verdict or the response uses — a spread of one of
// these can never carry a column the public contract does not list.
interface DocRow {
  id: string;
  // VFY-15: read only to pick the calendar "in effect" is decided in (the
  // workspace's zone); never part of the response.
  org_id: string | null;
  document_number: string | null;
  title: string | null;
  name: string | null;
  rev: string | null;
  status: string | null;
  current_version_id: string | null;
  legal_hold: boolean | null;
  // VFY-16: read only to decide whether the answer may name the document
  // (lib/verifyDisclosure verifyMayNameDocument); never part of the response.
  visibility?: string | null;
}
interface PrintedVersionRow { revision_label: string | null; created_at: string | null; record_id: string | null }
interface CurrentVersionRow { created_at?: string | null; effective_date?: string | null }
interface HoldReasonRow { reason: string | null }
interface SheetTokenRow { print_id: string; document_id: string; version_id: string; minted_at: string | null; voided_at: string | null; void_reason: string | null }

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return verifyJson({ error: "Verification unavailable" }, 503);
  }
  let docId = req.nextUrl.searchParams.get("doc") ?? "";
  let versionId = req.nextUrl.searchParams.get("v") ?? "";
  const sheetToken = req.nextUrl.searchParams.get("t");
  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const ip = clientIp(req);
  const userAgent = req.headers.get("user-agent");
  // The scan row keeps WHICH revision's paper was scanned (the ?v= version
  // id), so two prints of the same document stay distinguishable (VFY-12).
  // A token scan keeps its print id — two prints of one version stay
  // distinguishable too (PS-P9).
  let printedRef: string | null = null;
  const scan = (verdict: string) =>
    recordVerifyScan(sb, { endpoint: "verify", targetId: docId || null, printedRef: printedRef ?? (versionId || null), verdict, ip, userAgent });

  const rate = await checkVerifyRate(sb, { ip });
  if (rate.limited) return verifyRateLimitedResponse(rate);

  // PS-P9: a sheet token names (document, version, print). A token QR
  // carries nothing else; one that also names a document or version must
  // name the token's own (a mixed code is unknown, never answered for the
  // other one).
  let sheet: SheetTokenRow | null = null;
  if (sheetToken !== null) {
    if (!isSheetToken(sheetToken)) {
      docId = "";
      await scan("invalid");
      return verifyJson({ error: "Invalid code" }, 400);
    }
    const { data: tokData, error: tokErr } = await sb
      .from("print_sheet_tokens")
      .select("print_id, document_id, version_id, minted_at, voided_at, void_reason")
      .eq("token_hash", hashSheetToken(sheetToken))
      .maybeSingle();
    if (tokErr && !isMissingSheetTokenTable(tokErr)) {
      // An unreadable token is never "unknown" and never green.
      await scan("error");
      return verifyJson({ error: "Verification unavailable — try again" }, 503);
    }
    // No row — or no table (20261237 not pasted: no token can exist yet).
    const row = tokErr ? null : (tokData as SheetTokenRow | null);
    if (!row || (docId && docId.toLowerCase() !== row.document_id) || (versionId && versionId.toLowerCase() !== row.version_id)) {
      if (!row) docId = "";
      await scan("unknown");
      return verifyJson({ error: "Unknown code" }, 404);
    }
    sheet = row;
    docId = row.document_id;
    versionId = row.version_id;
    printedRef = row.print_id;
  }

  if (!UUID_RE.test(docId) || (versionId && !UUID_RE.test(versionId))) {
    await scan("invalid");
    return verifyJson({ error: "Invalid code" }, 400);
  }

  const { data: doc, error: docErr } = await sb
    .from("documents")
    .select("id, org_id, document_number, title, name, rev, status, current_version_id, legal_hold, visibility")
    .eq("id", docId)
    .maybeSingle();
  if (docErr) {
    // An unreadable document is never "unknown" and never green.
    await scan("error");
    return verifyJson({ error: "Verification unavailable — try again" }, 503);
  }
  if (!doc) {
    await scan("unknown");
    return verifyJson({ error: "Unknown document" }, 404);
  }
  const d = doc as DocRow;

  // An unreleased hold is a STOP-WORK signal — the drawing must not read as
  // usable in the field even if it is the current revision (the cross-area
  // field-verdict cluster). Legal hold and an open document_holds row both
  // count. A lookup error must never flip a held document to green, so an
  // errored hold read is "held" (fail safe for a stop-work signal). The
  // holds' predefined categories are named (VFY-5); operator text is not.
  // The legal hold is counted in activeHolds — exactly as /api/verify-hold
  // counts it among a card's other holds, so both surfaces show the same
  // number for the same document (VFY-5 done-when 3) — and never named: it
  // adds to the count, not to holdReasons.
  let heldError = false;
  let activeHolds: number | null = 0;
  let holdReasons: string[] = [];
  const { data: holdRows, error: holdErr } = await sb
    .from("document_holds")
    .select("reason")
    .eq("document_id", docId)
    .is("released_at", null);
  if (holdErr) {
    heldError = true;
    activeHolds = null;
  } else {
    const rows = (holdRows as HoldReasonRow[] | null) ?? [];
    activeHolds = rows.length + (d.legal_hold === true ? 1 : 0);
    holdReasons = [...new Set(rows.map((h) => publicHoldReason(h.reason)))];
  }
  const onHold = d.legal_hold === true || heldError || (activeHolds ?? 0) > 0;

  let printed: PrintedVersionRow | null = null;
  if (versionId) {
    const { data: v, error: vErr } = await sb
      .from("document_versions")
      .select("revision_label, created_at, record_id")
      .eq("id", versionId)
      .maybeSingle();
    if (vErr) {
      await scan("error");
      return verifyJson({ error: "Verification unavailable — try again" }, 503);
    }
    const vr = v as PrintedVersionRow | null;
    // The version must belong to this document — mixed IDs get a clean 404.
    if (!vr || vr.record_id !== docId) {
      await scan("unknown");
      return verifyJson({ error: "Unknown document" }, 404);
    }
    printed = vr;
  }

  let currentIssuedAt: string | null = null;
  let effectiveDate: string | null = null;
  if (d.current_version_id) {
    const { data: curData, error: curErr } = await sb
      .from("document_versions")
      .select("created_at, effective_date")
      .eq("id", d.current_version_id)
      .maybeSingle();
    let cur: unknown = curData;
    if (curErr) {
      // Only a pre-effective-date database (no column: 42703) may retry
      // without it — it has no effective dates, so "no date" is true there.
      // Any other error leaves the date UNKNOWN, and an unknown date may be a
      // future one: never a verdict that could be green before the revision
      // is in force (VFY-4 — late, never early). The retry is checked too.
      if (!isUndefinedColumnError(curErr)) {
        await scan("error");
        return verifyJson({ error: "Verification unavailable — try again" }, 503);
      }
      const { data: retryData, error: retryErr } = await sb
        .from("document_versions")
        .select("created_at")
        .eq("id", d.current_version_id)
        .maybeSingle();
      if (retryErr) {
        await scan("error");
        return verifyJson({ error: "Verification unavailable — try again" }, 503);
      }
      cur = retryData;
    }
    const c = cur as CurrentVersionRow | null;
    currentIssuedAt = c?.created_at ?? null;
    effectiveDate = c?.effective_date ?? null;
  }

  // The field verdict, most-severe first. Retirement comes from the shared
  // not-current set and "in force" from an ALLOW-list (lib/verifyVerdict.ts):
  // only Issued / Locked can reach a green answer, so a status added later —
  // or none at all — defaults to not-green (VFY-1 / VFY-9). `isCurrent`
  // stays for back-compat (older clients read only that boolean) and is true
  // ONLY for the plain in-force case.
  const standing = documentStanding(d.status);
  let verdict: DocVerdict;
  if (onHold) verdict = "held";
  else if (standing === "void") verdict = "void";
  else if (standing === "archived") verdict = "archived";
  else if (standing === "superseded") verdict = "superseded";
  else if (standing === "retired") verdict = "retired";
  else if (standing === "draft") verdict = "draft";
  else if (standing === "not_issued") verdict = "not_issued";
  // PS-P9: this print's paper never left (the pack was not completed, or
  // this sheet was not in the PDF) — stale, never green.
  else if (sheet?.voided_at) verdict = "print_voided";
  // VFY-3: a QR with no ?v= cannot say WHICH revision the paper is —
  // "cannot confirm", never green.
  else if (!versionId) verdict = "unverifiable";
  // The QR names the printed version, but the document has no current
  // revision on record to compare it with — "cannot confirm" too, in its own
  // words: the code DID say which revision was printed.
  else if (!d.current_version_id) verdict = "no_current_revision";
  else if (versionId !== d.current_version_id) verdict = "superseded_version";
  // VFY-4 / REV-9: a published rev with a FUTURE effective date is the
  // latest issue but not yet in force — decided in the facility's calendar
  // (lib/effectiveDate.ts: effectiveStatusFor → effectiveTodayISO), the same
  // "today" as the in-app badge, the watermark and the daily scan; with no
  // zone configured it is UTC-12, which can only ever be late, never early.
  // VFY-15: the calendar is the document's workspace zone (an Admin's
  // setting, read with this service client); none set, or unreadable, it is
  // the deployment's — today's behaviour.
  else if (effectiveStatusFor(effectiveDate, new Date(), effectiveDate ? await workspaceEffectiveDateTimeZone(sb, d.org_id) : undefined) === "pending") verdict = "not_yet_effective";
  else verdict = "current";

  await scan(verdict);

  // VFY-16 (DEC-90 default; intelligence DACL-8 / DACL-3): the verdict,
  // revisions, dates and holds are answered for every document; its number
  // and title only when its row was read with visibility normal or unset.
  const mayName = verifyMayNameDocument(d);
  return verifyJson({
    docNumber: mayName ? d.document_number || d.name || null : null,
    title: mayName ? d.title || null : RESTRICTED_DOCUMENT_LABEL,
    printedRev: printed?.revision_label ?? null,
    printedAt: printed?.created_at ?? null,
    currentRev: d.rev ?? null,
    currentIssuedAt,
    effectiveDate,
    notYetEffective: verdict === "not_yet_effective",
    onHold,
    activeHolds,
    holdReasons,
    docStatus: d.status ?? null,
    verdict,
    isCurrent: verdict === "current",
    checkedAt: new Date().toISOString(),
    // PS-P9: only on a token answer — when THIS print was made (not its
    // revision's issue date, which printedAt keeps) and whether it was voided.
    ...(sheet
      ? {
        sheetPrint: {
          printedAt: sheet.minted_at ?? null,
          voided: !!sheet.voided_at,
          // PHYS-20 limb 2: only on a recalled sheet — every other answer
          // keeps exactly PS-P9's two keys.
          ...(sheet.voided_at && sheet.void_reason === "recalled" ? { recalled: true, recalledAt: sheet.voided_at } : {}),
        },
      }
      : {}),
  });
}
