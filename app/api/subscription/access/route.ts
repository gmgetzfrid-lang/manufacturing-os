// GET /api/subscription/access?orgId=<uuid>
//
// admin-and-org BILL-10 / ORG-9 (Round G P5): the server's answer for the
// app's subscription curtain (components/subscription/SubscriptionGate.tsx).
// The switch is a SERVER environment variable (SUBSCRIPTION_ENFORCE, DEC-18),
// which a browser bundle cannot read, so the curtain asks here instead of
// carrying a constant of its own. Any active member of the workspace may ask.
//
//   { enforced: false, access: true,  reason: null }  — the switch is off
//   { enforced: true,  access: true,  reason: null }  — on, workspace in good standing
//   { enforced: true,  access: false, reason: "…" }   — on, workspace lapsed
//
// The decision is lib/serverAuth.ts orgAccessVerdict — the same check the
// billable routes make (enforceOrgAccess), so the curtain and the server's
// refusals cannot disagree.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole, orgAccessVerdict } from "@/lib/serverAuth";
import { ALL_ROLES } from "@/types/schema";

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeOrgRole(req, orgId, ALL_ROLES as string[]);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  const verdict = await orgAccessVerdict(actor.admin, orgId);
  return NextResponse.json(verdict, { headers: { "Cache-Control": "no-store" } });
}
