// GET /api/data-export/structured?orgId=...
//
// Streams the full export envelope as a downloadable JSON file (and is the
// first step of the browser-built Full ZIP, lib/clientBackup.ts).
// Admin-only (admin-and-org BKP-8): the export runs as the service role, so
// the caller is held to the data-export admin surface by the one gate
// (lib/adminGate.ts — the surface's role set lives in lib/adminSurfaces.ts,
// never in this file). An export that cannot be recorded in the audit trail
// is refused (BKP-13), with nothing sent. A recorded export rings every other
// controller's bell (lib/exportAlerts.ts), as the manual run does: this is the
// export page's most-used way out (the JSON download, and the envelope of the
// browser-built Full ZIP). A refused alert is logged and named in the
// X-Export-Alert response header; the download proceeds either way.

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { runOrgExport } from "@/lib/dataExport";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { alertAdminsOfExport } from "@/lib/exportAlerts";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export async function GET(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Server is missing Supabase credentials" }, { status: 500 });
  }

  const orgId = new URL(req.url).searchParams.get("orgId") || "";
  if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });
  const actor = await authorizeAdminSurface(req, orgId, "data-export");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  // Run the export
  let envelope: Awaited<ReturnType<typeof runOrgExport>>;
  try {
    envelope = await runOrgExport({
      supabaseUrl,
      serviceRoleKey,
      orgId,
      exporterUserId: actor.userId,
      exporterEmail: actor.email,
      exporterRole: actor.role,
      auditDetails: { channel: "json", exporterRoles: actor.roles },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || String(e) }, { status: 500 });
  }

  // BKP-13 / DEC-44 (A&O P3) §5: the controllers' bell — every OTHER Admin
  // and DocCtrl — the moment the workspace has been packaged for download.
  const alert = await alertAdminsOfExport(actor.admin, {
    orgId, actorUserId: actor.userId, actorEmail: actor.email,
    destination: "JSON export: a download or the browser-built Full ZIP",
  }).catch((e) => ({ ok: false, notified: 0, error: (e as Error).message }));
  if (!alert.ok) console.error(`[data-export/structured] org ${orgId}: the export alert was not sent: ${alert.error}`);

  // Stream as a downloadable JSON file
  const body = JSON.stringify(envelope, null, 2);
  const filename = `manufacturing-os-export-${(envelope.manifest.orgName || orgId).replace(/[^\w.\-]+/g, "_")}-${envelope.manifest.exportedAt.slice(0, 10)}.json`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Export-Alert": alert.ok
        ? `sent to ${alert.notified}`
        : `unsent: ${String(alert.error ?? "unknown error").replace(/[^\x20-\x7e]/g, "?").slice(0, 200)}`,
    },
  });
}
