// /api/admin/orphans — find and reclaim R2 objects nothing references.
//
//   GET  ?orgId=…             → read-only scan: orphan list (largest first),
//                               reclaimable bytes, bucket totals.
//   POST { orgId, confirm }   → delete. Re-scans server-side and removes
//                               only keys that are STILL orphans — the UI's
//                               list is display, never authority.
//
// Admin/DocCtrl only. The scan fails CLOSED: if any reference query errors,
// nothing is reported (and nothing can be deleted) rather than risking a
// live file being misread as an orphan.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { scanOrphans, deleteOrphans, orphanPurgeAuditDetails } from "@/lib/storageOrphans";

export const runtime = "nodejs";
export const maxDuration = 300;

// SURF-19 (admin-and-org Round G, P6): held to the storage surface's writes
// set (lib/adminSurfaces.ts) through lib/adminGate.ts — the ["Admin","DocCtrl"]
// this route spelled as a constant before; who is admitted is unchanged.
//
// intelligence ILIFE-1 criterion 3 / admin-and-org ALOG-8 (A&O Round G, P14):
// the purge's STORAGE_ORPHANS_PURGED row names the keys it deleted (a bounded
// list plus the count, lib/storageOrphans.ts orphanPurgeAuditDetails), so a
// mistaken purge is diagnosable — the objects themselves are gone. The write
// is CHECKED: the deletes have happened either way, so a refused row is in
// the answer (`auditError`) and logged, never a silent success (the purge's
// and archive-cancel's rule). The answer keeps its shape: the key list is
// the audit row's, not the response's. ILIFE-8: the scan's `referencedKeys`
// is the caller's prefix only.

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeAdminSurface(req, orgId, "storage", "write");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  try {
    // RET-7: the walk, the totals and the listing are this org's prefix only.
    const scan = await scanOrphans(actor.admin, orgId);
    // Cap the listing payload; totals stay complete.
    return NextResponse.json({ ...scan, orphans: scan.orphans.slice(0, 500) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: { orgId?: string; confirm?: boolean };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const orgId = String(body.orgId ?? "").trim();
  const actor = await authorizeAdminSurface(req, orgId, "storage", "write");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (body.confirm !== true) {
    return NextResponse.json({ error: "confirm: true is required to delete orphans." }, { status: 400 });
  }
  try {
    // RET-7: the delete set is this org's prefix only (re-scanned server-side).
    const result = await deleteOrphans(actor.admin, orgId);
    let auditError: string | null = null;
    try {
      const { error } = await actor.admin.from("audit_logs").insert({
        action: "STORAGE_ORPHANS_PURGED",
        resource_type: "storage", resource_id: orgId,
        org_id: orgId, user_id: actor.userId, user_email: actor.email, user_role: actor.admittedRole,
        details: orphanPurgeAuditDetails(result),
      });
      if (error) auditError = error.message;
    } catch (e) {
      auditError = (e as Error).message || String(e);
    }
    if (auditError) console.error("[admin/orphans] the STORAGE_ORPHANS_PURGED audit row was not written", auditError);
    const { deletedKeys: _keys, ...answer } = result;
    void _keys;
    return NextResponse.json({
      ...answer,
      ...(auditError ? { auditError: `the purge deleted ${result.deleted} file(s) but its STORAGE_ORPHANS_PURGED audit row was not written: ${auditError}` } : {}),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
