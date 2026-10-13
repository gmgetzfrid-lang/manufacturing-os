// /api/admin/archive-settings — the org's designated archive location + naming.
//
//   GET  ?orgId=   → current setting (where backups are kept, naming convention)
//   PUT  { orgId, locationHint, naming } → upsert it
//
// This is what makes "provide archive MOS-2026Q2-A1B2 (kept at <location>)"
// possible: the admin records ONCE where the org's offline archives live, and
// every archived-file prompt can point the user straight to it.
//
// SURF-19 (admin-and-org Round G, P6): both handlers are held to the storage
// surface's writes set through lib/adminGate.ts — the set ["Admin","DocCtrl"]
// they spelled as a constant before (the GET included: it feeds the quota and
// location editors, which only that set may use). Who is admitted is
// unchanged. BILL-7: a PUT writes an audit row with the old and new values.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeAdminSurface(req, orgId, "storage", "write");
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
  const actor = await authorizeAdminSurface(req, orgId, "storage", "write");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  // BILL-7: what the row held before, for the audit row's old values.
  // Checked: a change that cannot say what it replaced is not made.
  const { data: prior, error: priorErr } = await actor.admin
    .from("archive_settings")
    .select("location_hint, naming, quota_bytes")
    .eq("org_id", orgId)
    .maybeSingle();
  if (priorErr) return NextResponse.json({ error: `Couldn't read the current settings: ${priorErr.message}` }, { status: 500 });

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

  // BILL-7: the quota (and the location) drive every storage alert and every
  // archived-file prompt — a change is recorded with who made it, the old
  // value and the new. Only fields that changed are named; a save that
  // changed nothing writes no row.
  const was = (prior ?? {}) as { location_hint?: string | null; naming?: string | null; quota_bytes?: number | null };
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const col of ["location_hint", "naming", "quota_bytes"] as const) {
    if (!(col in patch)) continue;
    const before = was[col] ?? null;
    const after = (patch[col] as string | number | null) ?? null;
    if ((col === "quota_bytes" ? (Number(before) || null) : before) !== after) changes[col] = { before, after };
  }
  if (Object.keys(changes).length > 0) {
    const { error: auditErr } = await actor.admin.from("audit_logs").insert({
      action: "quota_bytes" in changes ? "STORAGE_QUOTA_CHANGED" : "ARCHIVE_SETTINGS_CHANGED",
      resource_id: orgId,
      resource_type: "archive_settings",
      org_id: orgId,
      user_id: actor.userId,
      user_email: actor.email || null,
      user_role: actor.admittedRole,
      details: { changes },
    });
    if (auditErr) {
      return NextResponse.json({ ok: true, warning: `Saved, but the audit record of the change was refused (${auditErr.message}).` });
    }
  }
  return NextResponse.json({ ok: true });
}
