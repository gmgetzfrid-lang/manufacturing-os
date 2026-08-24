// GET /api/verify?doc=<uuid>&v=<uuid>
//
// The endpoint behind the QR code stamped on every uncontrolled copy.
// UNAUTHENTICATED by design: a contractor in the field scans a paper print
// with a phone — no account, no login. Exposure is minimal and deliberate:
//   * Both IDs are unguessable UUIDs that only appear ON a printed copy the
//     org itself issued.
//   * The response contains ONLY revision-status facts (doc number, title,
//     printed rev vs current rev, dates) — no file access, no URLs, no
//     content, no people.
//
// Answers exactly one question: "is the paper in my hand still current?"

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Verification unavailable" }, { status: 503 });
  }
  const docId = req.nextUrl.searchParams.get("doc") ?? "";
  const versionId = req.nextUrl.searchParams.get("v") ?? "";
  if (!UUID_RE.test(docId) || (versionId && !UUID_RE.test(versionId))) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: doc } = await sb
    .from("documents")
    .select("id, document_number, title, name, rev, status, current_version_id, superseded_at, legal_hold")
    .eq("id", docId)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "Unknown document" }, { status: 404 });

  const d = doc as {
    id: string; document_number: string | null; title: string | null; name: string | null;
    rev: string | null; status: string | null; current_version_id: string | null;
    superseded_at: string | null; legal_hold: boolean | null;
  };

  // An unreleased hold is a STOP-WORK signal — the drawing must not read as
  // usable in the field even if it is the current revision (the cross-area
  // field-verdict cluster). Legal hold and an open document_holds row both
  // count. A lookup error must never flip a held document to green, so treat
  // an errored hold read as "held" (fail safe for a stop-work signal).
  let heldError = false;
  let onHold = d.legal_hold === true;
  if (!onHold) {
    const { data: holdRows, error: holdErr } = await sb
      .from("document_holds")
      .select("id")
      .eq("document_id", docId)
      .is("released_at", null)
      .limit(1);
    if (holdErr) heldError = true;
    else onHold = ((holdRows as unknown[]) ?? []).length > 0;
  }

  interface PrintedVersion {
    revision_label: string | null;
    created_at: string | null;
    superseded_at: string | null;
    record_id?: string;
  }
  let printed: PrintedVersion | null = null;
  if (versionId) {
    const { data: v } = await sb
      .from("document_versions")
      .select("revision_label, created_at, superseded_at, record_id")
      .eq("id", versionId)
      .maybeSingle();
    const vr = v as PrintedVersion | null;
    // The version must belong to this document — mixed IDs get a clean 404.
    if (!vr || vr.record_id !== docId) {
      return NextResponse.json({ error: "Unknown document" }, { status: 404 });
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
      // Pre-effective-date-migration DB: retry without the column.
      ({ data: cur } = await sb
        .from("document_versions")
        .select("created_at")
        .eq("id", d.current_version_id)
        .maybeSingle());
    }
    const c = cur as { created_at?: string; effective_date?: string | null } | null;
    currentIssuedAt = c?.created_at ?? null;
    effectiveDate = c?.effective_date ?? null;
  }

  // Retirement is the SHARED not-current set (Superseded, Void, Archived) —
  // an inline literal here is exactly how "Void" slipped through and verified
  // green (DIST-2). "Draft" is not retired but is also not in force: a print
  // from a Draft-status document must not read as current either.
  const status = d.status ?? "";
  const docRetired = NOT_CURRENT_STATUSES.has(status);
  const isDraft = status === "Draft";
  const isThisTheCurrentVersion = !versionId || versionId === d.current_version_id;

  // The field verdict, most-severe first. `isCurrent` stays for back-compat
  // (older clients read only that boolean) but is true ONLY for the plain
  // in-force case.
  let verdict:
    | "current" | "not_yet_effective" | "held"
    | "superseded" | "void" | "archived" | "draft" | "superseded_version";
  if (onHold || heldError) verdict = "held";
  else if (status === "Void") verdict = "void";
  else if (status === "Archived") verdict = "archived";
  else if (status === "Superseded") verdict = "superseded";
  else if (isDraft) verdict = "draft";
  // Any other member of the shared not-current set (future-proofing: a new
  // retired status can never silently default to green) → generic not-current.
  else if (docRetired) verdict = "superseded_version";
  else if (!isThisTheCurrentVersion) verdict = "superseded_version";
  else verdict = "current";

  const inForceNow = verdict === "current";
  // A published rev with a FUTURE effective date is the latest issue but is
  // not yet in force — the field page must not flash an unqualified green.
  const notYetEffective =
    inForceNow && !!effectiveDate && effectiveDate.slice(0, 10) > new Date().toISOString().slice(0, 10);
  if (notYetEffective) verdict = "not_yet_effective";

  const isCurrent = verdict === "current";

  return NextResponse.json({
    docNumber: d.document_number || d.name || null,
    title: d.title || null,
    printedRev: printed?.revision_label ?? null,
    printedAt: printed?.created_at ?? null,
    currentRev: d.rev ?? null,
    currentIssuedAt,
    effectiveDate,
    notYetEffective,
    onHold: onHold || heldError,
    docStatus: d.status ?? null,
    verdict,
    isCurrent,
    checkedAt: new Date().toISOString(),
  });
}
