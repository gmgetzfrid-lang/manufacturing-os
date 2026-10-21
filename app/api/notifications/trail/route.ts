// GET /api/notifications/trail?orgId=&resourceId=[&userId=]
//
// drafting-flow EVID-9 done-when 4 / EVID-13 done-when 4 (notifications Round
// G, N18 DELIVERY RECORD; DEC-90 ruling (4)): what reached a person about one
// item — every bell row, email row and request notice record, each with its
// own columns (created, delivered, seen, retired unopened, sent, the
// provider's outcome, not emailed by their choice) and the first act they
// recorded on it (lib/noticeTrail.ts). Read-only.
//
// Who may ask: the person themselves (userId omitted, or their own), or an
// Admin of the workspace (by the full held role collection — never the
// headline alone). Anyone else: 403, nothing read. Not an active member: the
// gate's 403.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { memberHoldsAny } from "@/lib/roleHeld";
import { noticeTrailFor } from "@/lib/noticeTrail";
import { ALL_ROLES } from "@/types/schema";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const resourceId = (req.nextUrl.searchParams.get("resourceId") || "").trim();
  const asked = (req.nextUrl.searchParams.get("userId") || "").trim();
  const actor = await authorizeOrgRole(req, orgId, ALL_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (!resourceId || resourceId.length > 200) return NextResponse.json({ error: "resourceId is required" }, { status: 400 });
  const userId = asked || actor.userId;
  if (!UUID_RE.test(userId)) return NextResponse.json({ error: "userId must be a member's id" }, { status: 400 });
  if (userId !== actor.userId && !memberHoldsAny({ role: actor.role, roles: actor.roles }, ["Admin"])) {
    return NextResponse.json({ error: "Only the person themselves or an Admin can see what reached them." }, { status: 403 });
  }
  const trail = await noticeTrailFor(actor.admin, { orgId, userId, resourceId });
  return NextResponse.json(trail);
}
