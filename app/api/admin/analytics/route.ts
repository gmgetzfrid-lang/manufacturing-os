// /api/admin/analytics — WF-20: the analytics page's data, behind the gate.
//
//   GET ?orgId=  → 200 { tickets: row[], documents: row[] }
//
// The page used to read `tickets` and `documents` through the caller's own
// PostgREST session, so narrowing `admin.analytics_view` hid a dashboard
// while leaving its data one request away. The read now happens here, under
// the same server decision the layout uses (role tokens, then a per-person
// grant, fail closed on a policy-load error), with the service client. The
// row shapes are exactly what the page mapped before.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeAdminSurface(req, orgId, "analytics");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const [{ data: tickets, error: tErr }, { data: documents, error: dErr }] = await Promise.all([
    actor.admin.from("tickets").select("*").eq("org_id", orgId),
    actor.admin.from("documents").select("id, org_id, status, document_number, title").eq("org_id", orgId),
  ]);
  if (tErr || dErr) {
    return NextResponse.json({ error: tErr?.message || dErr?.message || "Analytics read failed" }, { status: 500 });
  }
  return NextResponse.json({ tickets: tickets ?? [], documents: documents ?? [] });
}
