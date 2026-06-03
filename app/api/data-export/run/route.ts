// POST /api/data-export/run
// Body: { orgId, destinationId? }
//
// If destinationId is provided, runs against that destination (S3 push
// or webhook). If omitted, builds an inline ZIP and streams it to the
// caller as a download response.
//
// Always writes an export_runs row with the result.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { buildAndDeliverExport, computeNextRunAt } from "@/lib/exportRunner";

const ADMIN_ROLES = ["Admin", "Manager", "DocCtrl"];
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = body?.orgId;
  const auth = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
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

  let dest: any = null;
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
      includeFiles: dest?.include_files ?? body.includeFiles ?? true,
      delivery: dest
        ? { kind: "destination", destination: dest }
        : { kind: "inline" },
    });

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
        diagnostics: result.diagnostics,
        completed_at: completedAt,
        duration_ms: duration,
      }).eq("id", runId);
    }

    if (dest) {
      // Update destination summary + advance the schedule clock
      await auth.admin.from("export_destinations").update({
        last_run_at: completedAt,
        last_run_status: "succeeded",
        last_run_error: null,
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

    // Inline delivery: stream the ZIP bytes back
    const zipBytes = result.zipBytes!;
    return new NextResponse(zipBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="manufacturing-os-export-${orgId}-${startedAt.slice(0, 10)}.zip"`,
        "Cache-Control": "no-store",
        "X-Export-Run-Id": runId || "",
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
