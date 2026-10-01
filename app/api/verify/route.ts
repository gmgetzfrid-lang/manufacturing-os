// GET /api/verify?doc=<uuid>&v=<uuid>
//
// The endpoint behind the QR code stamped on every uncontrolled copy.
// UNAUTHENTICATED by design: a contractor in the field scans a paper print
// with a phone — no account, no login. Exposure is minimal and deliberate:
//   * Both IDs are unguessable UUIDs that only appear ON a printed copy the
//     org itself issued.
//   * The response contains ONLY revision-status facts (doc number, title,
//     printed rev vs current rev, dates, the document's status, and whether
//     it is held — the hold's public CATEGORY only, never operator text) —
//     no file access, no URLs, no content, no people.
//   * Every answered scan leaves a row in verify_scans (endpoint, target,
//     verdict, client IP / user agent — VFY-12) and counts toward a generous
//     per-IP hourly cap; every answer is Cache-Control: no-store (VFY-13).
//
// Answers exactly one question: "is the paper in my hand still current?" —
// and it says so only when it KNOWS: the document is Issued or Locked (an
// allow-list, VFY-1), not held, the QR names the version printed (a QR with
// no ?v= cannot say which revision the paper is — VFY-3), that version is
// the current one, and its effective date has arrived in the facility's
// calendar (effectiveStatusFor → effectiveTodayISO, VFY-4 / REV-9).

import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { documentStanding, isUndefinedColumnError } from "@/lib/verifyVerdict";
import { effectiveStatusFor } from "@/lib/effectiveDate";
import { publicHoldReason } from "@/lib/holds";
import { checkVerifyRate, clientIp, verifyJson, verifyRateLimitedResponse } from "@/lib/verifyRateLimit";
import { recordVerifyScan } from "@/lib/verifyScanLog";
import type { DocVerdict } from "@/lib/verifyPresent";

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
  document_number: string | null;
  title: string | null;
  name: string | null;
  rev: string | null;
  status: string | null;
  current_version_id: string | null;
  legal_hold: boolean | null;
}
interface PrintedVersionRow { revision_label: string | null; created_at: string | null; record_id: string | null }
interface CurrentVersionRow { created_at?: string | null; effective_date?: string | null }
interface HoldReasonRow { reason: string | null }

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return verifyJson({ error: "Verification unavailable" }, 503);
  }
  const docId = req.nextUrl.searchParams.get("doc") ?? "";
  const versionId = req.nextUrl.searchParams.get("v") ?? "";
  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const ip = clientIp(req);
  const userAgent = req.headers.get("user-agent");
  // The scan row keeps WHICH revision's paper was scanned (the ?v= version
  // id), so two prints of the same document stay distinguishable (VFY-12).
  const scan = (verdict: string) =>
    recordVerifyScan(sb, { endpoint: "verify", targetId: docId, printedRef: versionId || null, verdict, ip, userAgent });

  const rate = await checkVerifyRate(sb, { ip });
  if (rate.limited) return verifyRateLimitedResponse(rate);

  if (!UUID_RE.test(docId) || (versionId && !UUID_RE.test(versionId))) {
    await scan("invalid");
    return verifyJson({ error: "Invalid code" }, 400);
  }

  const { data: doc, error: docErr } = await sb
    .from("documents")
    .select("id, document_number, title, name, rev, status, current_version_id, legal_hold")
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
  else if (effectiveStatusFor(effectiveDate) === "pending") verdict = "not_yet_effective";
  else verdict = "current";

  await scan(verdict);

  return verifyJson({
    docNumber: d.document_number || d.name || null,
    title: d.title || null,
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
  });
}
