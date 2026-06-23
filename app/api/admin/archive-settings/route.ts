// /api/admin/archive-settings — the org's designated archive location + naming.
//
//   GET  ?orgId=   → current setting (where backups are kept, naming convention)
//   PUT  { orgId, locationHint, naming } → upsert it
//
// This is what makes "provide archive MOS-2026Q2-A1B2 (kept at <location>)"
// possible: the admin records ONCE where the org's offline archives live, and
// every archived-file prompt can point the user straight to it.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";

export const runtime = "nodejs";

const ADMIN_ROLES = ["Admin", "DocCtrl"];

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const { data } = await actor.admin
    .from("archive_settings")
    .select("location_hint, naming, quota_bytes, updated_at, updated_by")
    .eq("org_id", orgId)
    .maybeSingle();

  return NextResponse.json({
    settings: data ?? { location_hint: null, naming: null, quota_bytes: null, updated_at: null, updated_by: null },
  });
}

export async function PUT(req: NextRequest) {
  let body: { orgId?: string; locationHint?: string; naming?: string; quotaBytes?: number | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = body.orgId || "";
  const actor = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  // Build a partial update so callers can change just the location or just the
  // quota without clobbering the other.
  const patch: Record<string, unknown> = { org_id: orgId, updated_at: new Date().toISOString(), updated_by: actor.userId };
  if (body.locationHint !== undefined) patch.location_hint = (body.locationHint ?? "").trim() || null;
  if (body.naming !== undefined) patch.naming = (body.naming ?? "").trim() || null;
  if (body.quotaBytes !== undefined) {
    const q = Number(body.quotaBytes);
    patch.quota_bytes = Number.isFinite(q) && q > 0 ? Math.floor(q) : null;
  }

  const { error } = await actor.admin
    .from("archive_settings")
    .upsert(patch, { onConflict: "org_id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
