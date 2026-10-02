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
// X-Export-Alert response header; the download proceeds either way. The
// DATA_EXPORT row's user_role is the role the surface admitted the exporter
// by (the gate's admittedRole: an Admin whose headline is Viewer is recorded
// as Admin), the full collection in details.exporterRoles.
//
// Fourth review fix (BKP-8 / DEC-44 (A&O P3) Risk): it is held to the hourly
// cap the manual run is (lib/exportRunner.ts exportRateLimitRefusal, counted
// on the export_runs people started — fifth review fix: never the scheduled
// pushes or their gate skips): it opens a run row of its own — read and
// written CHECKED, a refused one refuses the export (503) — and closes it
// with the outcome; a refused closing write is named in X-Export-Unrecorded.
// Its files are named against the workspace's ledger (lib/dataExport.ts
// recordExport — fifth review fix: was its whole list on every call). An
// export whose DATA_EXPORT row was written but which then failed (its file
// list refused) is recorded as not delivered (DATA_EXPORT_UNDELIVERED).

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { runOrgExport, recordExportUndelivered } from "@/lib/dataExport";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { alertAdminsOfExport } from "@/lib/exportAlerts";
import { exportRateLimitRefusal } from "@/lib/exportRunner";

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

  // The hourly cap, and a run row so this export counts toward it.
  const limited = await exportRateLimitRefusal(actor.admin, orgId);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
  const startedAt = new Date().toISOString();
  const { data: runRow, error: runRowErr } = await actor.admin.from("export_runs").insert({
    org_id: orgId,
    destination_id: null,
    trigger_type: "manual",
    triggered_by: actor.userId,
    triggered_by_email: actor.email,
    status: "running",
    destination_type: "json",
    started_at: startedAt,
  }).select("id").single();
  const runId = (runRow as { id: string } | null)?.id;
  if (runRowErr || !runId) {
    return NextResponse.json(
      { error: `Could not open this export's run record (${runRowErr?.message ?? "no run id returned"}) — nothing was exported.` },
      { status: 503 },
    );
  }

  // Run the export
  let envelope: Awaited<ReturnType<typeof runOrgExport>>;
  const recorded: { id: string | null } = { id: null };
  try {
    envelope = await runOrgExport({
      supabaseUrl,
      serviceRoleKey,
      orgId,
      exporterUserId: actor.userId,
      exporterEmail: actor.email,
      exporterRole: actor.admittedRole,
      auditDetails: { channel: "json", exporterRoles: actor.roles },
      onRecorded: (id) => { recorded.id = id; },
    });
  } catch (e) {
    let msg = (e as Error).message || String(e);
    if (recorded.id) {
      const unwritten = await recordExportUndelivered(actor.admin, {
        orgId, recordId: recorded.id, exporterUserId: actor.userId, exporterEmail: actor.email, error: msg,
      }).catch((x) => (x as Error).message || String(x));
      if (unwritten) msg = `${msg} — and the record that this export did not leave could not be written (${unwritten})`;
    }
    const completedAt = new Date().toISOString();
    const { error: runUpdErr } = await actor.admin.from("export_runs").update({
      status: "failed",
      error_message: msg.slice(0, 1000),
      completed_at: completedAt,
      duration_ms: Date.parse(completedAt) - Date.parse(startedAt),
    }).eq("id", runId);
    if (runUpdErr) console.error(`[data-export/structured] org ${orgId}, run ${runId}: run row not updated: ${runUpdErr.message}`);
    return NextResponse.json({ error: msg, ...(runUpdErr ? { warnings: [`run row not updated: ${runUpdErr.message}`] } : {}) }, { status: 500 });
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
  // The run row's outcome, CHECKED: a refused write is named, the download proceeds.
  const completedAt = new Date().toISOString();
  const { error: runUpdErr } = await actor.admin.from("export_runs").update({
    status: "succeeded",
    table_count: envelope.manifest.tables.length,
    total_rows: envelope.manifest.tables.reduce((n, t) => n + t.rowCount, 0),
    file_count: envelope.files.length,
    total_bytes: Buffer.byteLength(body, "utf8"),
    destination_type: "json",
    diagnostics: alert.ok ? [] : [{ ts: completedAt, step: "alert:unsent", detail: alert.error }],
    completed_at: completedAt,
    duration_ms: Date.parse(completedAt) - Date.parse(startedAt),
  }).eq("id", runId);
  if (runUpdErr) console.error(`[data-export/structured] org ${orgId}, run ${runId}: run row not updated: ${runUpdErr.message}`);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Export-Run-Id": runId,
      ...(runUpdErr ? { "X-Export-Unrecorded": `run row not updated: ${runUpdErr.message}`.replace(/[^\x20-\x7e]/g, "?").slice(0, 300) } : {}),
      "X-Export-Alert": alert.ok
        ? `sent to ${alert.notified}`
        : `unsent: ${String(alert.error ?? "unknown error").replace(/[^\x20-\x7e]/g, "?").slice(0, 200)}`,
    },
  });
}
