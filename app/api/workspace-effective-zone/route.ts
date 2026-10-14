// app/api/workspace-effective-zone/route.ts
//
// public-surfaces VFY-15 (admin-and-org Round G, P12 re-review fix): the
// browser's answer to "which calendar decides this workspace's effective
// dates?". The decision needs the workspace's audit trail (who last set the
// 'timezone' row — lib/workspaceTimeZone.ts readWorkspaceTimeZoneWriter),
// which a browser session without admin.audit_view may not read, so the
// server decides with the service client — the same decision /api/verify,
// /api/verify-package, the transmittal portal and the daily scan make — and
// the badge, the register and the suppression watermark follow it.
//
// GET ?orgId=… with the caller's bearer token. Any ACTIVE member of that
// workspace may ask (authorizeOrgRole over every role); the answer is the
// calendar name and whether the workspace's own zone is it. `reconfirm`
// (the stored zone's writer is not shown to be an Admin — the
// /admin/settings card's notice) is said only to an Admin.
// Before the operator records 20261203 live nothing is read and the
// deployment's calendar is answered, exactly as before VFY-15.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { ALL_ROLES } from "@/types/schema";
import { decideWorkspaceEffectiveZone, effectiveDateTimeZone, workspaceEffectiveZoneHonoured } from "@/lib/effectiveDate";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  if (!workspaceEffectiveZoneHonoured()) {
    return NextResponse.json({ zone: effectiveDateTimeZone(), honoured: false, reconfirm: false, stored: null }, { headers: noStore });
  }
  const actor = await authorizeOrgRole(req, orgId, [...ALL_ROLES]);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status, headers: noStore });
  const d = await decideWorkspaceEffectiveZone(actor.admin, orgId);
  const isAdmin = actor.roles.includes("Admin");
  return NextResponse.json({
    zone: d.zone,
    honoured: d.honoured,
    reconfirm: isAdmin ? d.reconfirm : false,
    stored: isAdmin ? d.stored : null,
  }, { headers: noStore });
}
