// POST /api/data-export/run
// Body: { orgId, destinationId? }
//
// If destinationId is provided, runs against that destination (S3 push
// or webhook). If omitted, builds an inline ZIP and streams it to the
// caller as a download response.
//
// Always writes an export_runs row with the result.
//
// Admin-only (admin-and-org BKP-8): held to the data-export admin surface by
// the one gate (lib/adminGate.ts; the role set lives in lib/adminSurfaces.ts).

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { authorizeAdminSurface } from "@/lib/adminGate";
import { buildAndDeliverExport, computeNextRunAt, exportEmbedDeadline, retentionProblem, type ExportDestination } from "@/lib/exportRunner";
import { makeArchiveId } from "@/lib/archive";
import { alertAdminsOfExport } from "@/lib/exportAlerts";

type ScheduleParams = Parameters<typeof computeNextRunAt>[0];

// A destination row carries both the delivery config (ExportDestination) and
// the schedule columns consumed by computeNextRunAt.
type ScheduledDestination = ExportDestination & {
  schedule_kind: ScheduleParams["schedule_kind"];
  schedule_hour_utc?: ScheduleParams["schedule_hour_utc"];
  schedule_day_of_week?: ScheduleParams["schedule_day_of_week"];
  schedule_day_of_month?: ScheduleParams["schedule_day_of_month"];
};

interface RunBody {
  orgId: string;
  destinationId?: string;
  includeFiles?: boolean;
}
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export async function POST(req: NextRequest) {
  // The ZIP's embed loop (and the export's storage checks) stop at this route's own deadline, so the archive is delivered.
  const routeStart = Date.now();
  let body: RunBody;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = String(body?.orgId ?? "");
  const auth = await authorizeAdminSurface(req, orgId, "data-export");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Rate limit: cap export runs per org per hour so a tight loop can't hammer
  // the (expensive) ZIP builder or exfiltrate at speed.
  const MAX_RUNS_PER_HOUR = 12;
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count: recentRuns } = await auth.admin
    .from("export_runs")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .gte("started_at", oneHourAgo);
  if ((recentRuns ?? 0) >= MAX_RUNS_PER_HOUR) {
    return NextResponse.json(
      { error: `Export rate limit reached (${MAX_RUNS_PER_HOUR}/hour for this workspace). Try again shortly.` },
      { status: 429 },
    );
  }

  // Open a runs row up front so the UI can poll it
  const startedAt = new Date().toISOString();
  const { data: runRow } = await auth.admin.from("export_runs").insert({
    org_id: orgId,
    destination_id: body.destinationId ?? null,
    trigger_type: "manual",
    triggered_by: auth.userId,
    triggered_by_email: auth.email,
    status: "running",
    started_at: startedAt,
  }).select("id").single();
  const runId = (runRow as { id: string } | null)?.id;

  let dest: ScheduledDestination | null = null;
  if (body.destinationId) {
    const { data } = await auth.admin
      .from("export_destinations")
      .select("*")
      .eq("id", body.destinationId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!data) return NextResponse.json({ error: "Destination not found" }, { status: 404 });
    dest = data;
  }

  try {
    const result = await buildAndDeliverExport({
      supabaseUrl,
      serviceRoleKey,
      orgId,
      exporterUserId: auth.userId,
      exporterEmail: auth.email,
      exporterRole: auth.role,
      auditDetails: { channel: dest ? `destination:${dest.destination_type}` : "zip", exporterRoles: auth.roles, ...(dest ? { destinationId: dest.id } : {}) },
      includeFiles: dest?.include_files ?? body.includeFiles ?? true,
      delivery: dest
        ? { kind: "destination", destination: dest }
        : { kind: "inline" },
      deadlineAt: exportEmbedDeadline(routeStart, maxDuration),
    });

    // OUT-OF-BAND ALERT (finding: compromised-admin exfiltration). A full-org
    // export is the single highest-impact action in the app — it packages
    // every table + file into one downloadable ZIP. A silent success is
    // exactly what a phished-credential attacker wants; a stolen admin login
    // shouldn't be able to drain the workspace without the real admins
    // seeing it. Notify every OTHER Admin/DocCtrl the moment a run completes,
    // so an unexpected export surfaces on their bell within seconds. This is
    // detection, not prevention (the actor is already authorized), but it
    // collapses the window between exfiltration and discovery.
    // A refused alert is recorded on the run (BKP-13), never swallowed.
    const alert = await alertAdminsOfExport(auth.admin, {
      orgId, actorUserId: auth.userId, actorEmail: auth.email,
      destination: dest ? (dest.destination_type as string) : "inline download",
    }).catch((e) => ({ ok: false, notified: 0, error: (e as Error).message }));
    if (!alert.ok) console.error(`[data-export/run] org ${orgId}: the export alert was not sent: ${alert.error}`);
    // BKP-6: a retention purge that did not finish is said on the run row and
    // the destination card; the backup itself was delivered and verified.
    const retentionNote = retentionProblem(result.retention);

    const completedAt = new Date().toISOString();
    const duration = Date.parse(completedAt) - Date.parse(startedAt);
    if (runId) {
      await auth.admin.from("export_runs").update({
        status: "succeeded",
        table_count: result.tableCount,
        total_rows: result.totalRows,
        file_count: result.fileCount,
        total_bytes: result.bytes,
        destination_path: result.destinationPath ?? null,
        destination_type: dest?.destination_type ?? "inline",
        diagnostics: alert.ok ? result.diagnostics : [...result.diagnostics, { ts: completedAt, step: "alert:unsent", detail: alert.error }],
        ...(retentionNote ? { error_message: retentionNote.slice(0, 1000) } : {}),
        completed_at: completedAt,
        duration_ms: duration,
      }).eq("id", runId);
    }

    if (dest) {
      // Update destination summary + advance the schedule clock
      await auth.admin.from("export_destinations").update({
        last_run_at: completedAt,
        last_run_status: "succeeded",
        last_run_error: retentionNote ? retentionNote.slice(0, 500) : null,
        last_run_bytes: result.bytes,
        next_run_at: computeNextRunAt({
          schedule_kind: dest.schedule_kind,
          schedule_hour_utc: dest.schedule_hour_utc,
          schedule_day_of_week: dest.schedule_day_of_week,
          schedule_day_of_month: dest.schedule_day_of_month,
          from: new Date(completedAt),
        }),
      }).eq("id", dest.id);

      return NextResponse.json({
        ok: true,
        runId,
        bytes: result.bytes,
        fileCount: result.fileCount,
        destinationPath: result.destinationPath,
      });
    }

    // Inline delivery: stamp a stable archive identity, catalog it, then stream.
    // The saved file is literally named after its archive id, so the admin can
    // record (and later quote) it without any extra step.
    const zipBytes = result.zipBytes!;
    const archiveId = makeArchiveId({
      at: new Date(startedAt),
      token: (runId || "").replace(/-/g, "").slice(-4) || "0000",
    });
    try {
      await auth.admin.from("archives").insert({
        org_id: orgId,
        archive_id: archiveId,
        kind: "full",
        file_count: result.fileCount,
        total_bytes: result.bytes,
        created_by: auth.userId,
        created_by_email: auth.email,
      });
    } catch { /* catalog is best-effort; the download still proceeds */ }
    return new NextResponse(zipBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="manufacturing-os-backup-${archiveId}.zip"`,
        "Cache-Control": "no-store",
        "X-Export-Run-Id": runId || "",
        "X-Archive-Id": archiveId,
      },
    });
  } catch (e) {
    const completedAt = new Date().toISOString();
    const duration = Date.parse(completedAt) - Date.parse(startedAt);
    const msg = (e as Error).message || String(e);
    if (runId) {
      await auth.admin.from("export_runs").update({
        status: "failed",
        error_message: msg.slice(0, 1000),
        completed_at: completedAt,
        duration_ms: duration,
      }).eq("id", runId);
    }
    if (dest) {
      await auth.admin.from("export_destinations").update({
        last_run_at: completedAt,
        last_run_status: "failed",
        last_run_error: msg.slice(0, 500),
      }).eq("id", dest.id);
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
