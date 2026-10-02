// POST /api/data-export/destinations/[id]/test
//
// Verifies the credentials for a destination by doing a real write +
// delete (S3/R2) or a HEAD probe (webhook). Returns ok/error. We do this
// server-side so the access keys never leave the server.
// Admin-only, like every data-export route (admin-and-org BKP-8), through
// the one gate (lib/adminGate.ts). The destination read is CHECKED (a failed
// read is a 500 naming it, never "Destination not found"), and so is the
// EXPORT_DESTINATION_TEST audit row: a refused one is said in the answer as
// a `warning` (the probe itself ran), as the create, edit and delete rows
// are — never dropped in silence.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { testDestinationConnection, type ExportDestination } from "@/lib/exportRunner";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const orgId = new URL(req.url).searchParams.get("orgId") || "";
  const auth = await authorizeAdminSurface(req, orgId, "data-export");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data: dest, error: destErr } = await auth.admin
    .from("export_destinations")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (destErr) return NextResponse.json({ error: `Could not read the destination (${destErr.message}) — nothing was tested.` }, { status: 500 });
  if (!dest) return NextResponse.json({ error: "Destination not found" }, { status: 404 });

  const result = await testDestinationConnection(dest as ExportDestination);

  const { error: auditErr } = await auth.admin.from("audit_logs").insert({
    action: "EXPORT_DESTINATION_TEST",
    resource_id: id,
    resource_type: "export_destination",
    org_id: orgId,
    user_id: auth.userId,
    user_email: auth.email,
    user_role: auth.admittedRole,
    details: { ok: result.ok, error: result.error ?? null },
  });
  if (auditErr) {
    console.error(`[data-export/destinations/test] org ${orgId}: the EXPORT_DESTINATION_TEST audit row was not written: ${auditErr.message}`);
    return NextResponse.json({ ...result, warning: `Tested, but the test could not be recorded in the audit log: ${auditErr.message}` });
  }

  return NextResponse.json(result);
}
