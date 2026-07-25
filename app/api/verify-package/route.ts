// GET /api/verify-package?p=<uuid>
//
// The endpoint behind the QR on a printed work-package cover sheet.
// UNAUTHENTICATED by design — the crew member holding the pack in the field
// has no account, and "SCAN BEFORE STARTING WORK" must not land on a login
// wall. Same exposure contract as /api/verify: an unguessable UUID that only
// appears on paper the org itself printed, and a response of revision-status
// facts only (labels + fresh/stale) — no files, no URLs, no people.
//
// Answers: "is every sheet in this printed pack still the current revision?"

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Verification unavailable" }, { status: 503 });
  }
  const pkgId = req.nextUrl.searchParams.get("p") ?? "";
  if (!UUID_RE.test(pkgId)) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: pkg } = await sb
    .from("work_packages")
    .select("id, name, status, closed_at")
    .eq("id", pkgId)
    .maybeSingle();
  if (!pkg) return NextResponse.json({ error: "Unknown package" }, { status: 404 });

  const { data: members } = await sb
    .from("work_package_documents")
    .select("document_id, pinned_version_id, pinned_rev_label")
    .eq("package_id", pkgId);
  const rows = (members ?? []) as Array<{
    document_id: string; pinned_version_id: string | null; pinned_rev_label: string | null;
  }>;

  const docIds = rows.map((r) => r.document_id);
  const { data: docs } = docIds.length
    ? await sb.from("documents").select("id, document_number, title, name, rev, current_version_id, status").in("id", docIds)
    : { data: [] };
  const byId = new Map(
    ((docs ?? []) as Array<Record<string, unknown>>).map((d) => [String(d.id), d]),
  );

  const sheets = rows.map((r) => {
    const d = byId.get(r.document_id);
    const retired = d?.status === "Superseded" || d?.status === "Archived";
    return {
      label: String(d?.document_number || d?.title || d?.name || "Document"),
      printedRev: r.pinned_rev_label,
      currentRev: (d?.rev as string | null) ?? null,
      fresh: !retired && !!r.pinned_version_id && r.pinned_version_id === (d?.current_version_id ?? null),
      retired,
    };
  });
  const staleCount = sheets.filter((s) => !s.fresh).length;

  return NextResponse.json({
    name: (pkg.name as string) ?? "Work package",
    packageStatus: (pkg.status as string) ?? null,
    closed: !!pkg.closed_at,
    sheetCount: sheets.length,
    staleCount,
    allFresh: sheets.length > 0 && staleCount === 0,
    sheets,
    checkedAt: new Date().toISOString(),
  });
}
