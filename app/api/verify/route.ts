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
    .select("id, document_number, title, name, rev, status, current_version_id, superseded_at")
    .eq("id", docId)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "Unknown document" }, { status: 404 });

  const d = doc as {
    id: string; document_number: string | null; title: string | null; name: string | null;
    rev: string | null; status: string | null; current_version_id: string | null; superseded_at: string | null;
  };

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
    let { data: cur, error: curErr } = await sb
      .from("document_versions")
      .select("created_at, effective_date")
      .eq("id", d.current_version_id)
      .maybeSingle();
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

  const docRetired = d.status === "Superseded" || d.status === "Archived";
  const isCurrent = !docRetired && (!versionId || versionId === d.current_version_id);
  // A published rev with a FUTURE effective date is the latest issue but is
  // not yet in force — the field page must not flash an unqualified green.
  const notYetEffective =
    isCurrent && !!effectiveDate && effectiveDate.slice(0, 10) > new Date().toISOString().slice(0, 10);

  return NextResponse.json({
    docNumber: d.document_number || d.name || null,
    title: d.title || null,
    printedRev: printed?.revision_label ?? null,
    printedAt: printed?.created_at ?? null,
    currentRev: d.rev ?? null,
    currentIssuedAt,
    effectiveDate,
    notYetEffective,
    docStatus: d.status ?? null,
    isCurrent,
    checkedAt: new Date().toISOString(),
  });
}
