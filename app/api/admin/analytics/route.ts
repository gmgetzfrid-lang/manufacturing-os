// /api/admin/analytics — WF-20: the analytics page's data, behind the gate.
//
//   GET ?orgId=  → 200 { tickets: row[], documents: row[] }
//
// The page used to read `tickets` and `documents` through the caller's own
// PostgREST session, so narrowing `admin.analytics_view` hid a dashboard
// while leaving its data one request away. The DECISION now happens here,
// on the server (role tokens, then a per-person grant, fail closed on a
// policy-load error). The READ still runs as the caller: a client carrying
// their own bearer, so RLS applies exactly as it did when the page read the
// tables itself. This route must never return more than the caller's own
// session could see — `documents_acl_select` hides the private / hidden
// documents the ACL does not admit them to, and a service-role read would
// have handed those titles and numbers to every member the gate admits.
// The service client is used for the gate only. The row shapes are exactly
// what the page mapped before.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { callerScopedClient } from "@/lib/serverAuth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeAdminSurface(req, orgId, "analytics");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const asCaller = callerScopedClient(req);
  if ("error" in asCaller) return NextResponse.json({ error: asCaller.error }, { status: asCaller.status });

  const [{ data: tickets, error: tErr }, { data: documents, error: dErr }] = await Promise.all([
    asCaller.from("tickets").select("*").eq("org_id", orgId),
    asCaller.from("documents").select("id, org_id, status, document_number, title").eq("org_id", orgId),
  ]);
  if (tErr || dErr) {
    return NextResponse.json({ error: tErr?.message || dErr?.message || "Analytics read failed" }, { status: 500 });
  }
  return NextResponse.json({ tickets: tickets ?? [], documents: documents ?? [] });
}
