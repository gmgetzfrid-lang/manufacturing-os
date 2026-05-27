// POST /api/data-export/destinations/[id]/test
//
// Verifies the credentials for a destination by doing a real write +
// delete (S3/R2) or a HEAD probe (webhook). Returns ok/error. We do this
// server-side so the access keys never leave the server.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { testDestinationConnection } from "@/lib/exportRunner";

const ADMIN_ROLES = ["Admin", "Manager", "DocCtrl"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const orgId = new URL(req.url).searchParams.get("orgId") || "";
  const auth = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data: dest } = await auth.admin
    .from("export_destinations")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!dest) return NextResponse.json({ error: "Destination not found" }, { status: 404 });

  const result = await testDestinationConnection(dest as any);

  await auth.admin.from("audit_logs").insert({
    action: "EXPORT_DESTINATION_TEST",
    resource_id: id,
    resource_type: "export_destination",
    org_id: orgId,
    user_id: auth.userId,
    user_email: auth.email,
    user_role: auth.role,
    details: { ok: result.ok, error: result.error ?? null },
  });

  return NextResponse.json(result);
}
