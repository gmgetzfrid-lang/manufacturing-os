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
import { authorizeOrgRole } from "@/lib/serverAuth";
import { scanOrphans, deleteOrphans } from "@/lib/storageOrphans";

export const runtime = "nodejs";
export const maxDuration = 300;

const ROLES = ["Admin", "DocCtrl"];

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeOrgRole(req, orgId, ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  try {
    const scan = await scanOrphans(actor.admin);
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
  const actor = await authorizeOrgRole(req, orgId, ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (body.confirm !== true) {
    return NextResponse.json({ error: "confirm: true is required to delete orphans." }, { status: 400 });
  }
  try {
    const result = await deleteOrphans(actor.admin);
    await actor.admin.from("audit_logs").insert({
      action: "STORAGE_ORPHANS_PURGED",
      resource_type: "storage", resource_id: orgId,
      org_id: orgId, user_id: actor.userId,
      details: { deleted: result.deleted, freedBytes: result.freedBytes, errors: result.errors.length },
    }).then(() => undefined, () => undefined);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
