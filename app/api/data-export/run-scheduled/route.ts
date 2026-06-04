// GET/POST /api/data-export/run-scheduled
//
// Vercel cron hits this hourly. We claim every destination whose
// next_run_at <= now() and is enabled, run them sequentially, and
// advance their schedule clocks. Errors don't abort the batch.
//
// Auth: this is a server-to-server endpoint. Require the
// CRON_SECRET env var as a Bearer token to prevent random callers
// from triggering exports on demand.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildAndDeliverExport, computeNextRunAt, type ExportDestination } from "@/lib/exportRunner";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const cronSecret = process.env.CRON_SECRET || "";

type ScheduleParams = Parameters<typeof computeNextRunAt>[0];

// A due destination row carries both the delivery config (ExportDestination)
// and the schedule columns consumed by computeNextRunAt.
type ScheduledDestination = ExportDestination & {
  schedule_kind: ScheduleParams["schedule_kind"];
  schedule_hour_utc?: ScheduleParams["schedule_hour_utc"];
  schedule_day_of_week?: ScheduleParams["schedule_day_of_week"];
  schedule_day_of_month?: ScheduleParams["schedule_day_of_month"];
};

type ScheduledRunResult = {
  destinationId: string;
  ok: boolean;
  bytes?: number;
  error?: string;
};

async function handler(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Supabase credentials missing" }, { status: 500 });
  }
  if (cronSecret) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const nowIso = new Date().toISOString();

  const { data: due } = await sb
    .from("export_destinations")
    .select("*")
    .eq("enabled", true)
    .not("next_run_at", "is", null)
    .lte("next_run_at", nowIso)
    .limit(50);

  const list = (due ?? []) as ScheduledDestination[];
  const results: ScheduledRunResult[] = [];

  for (const dest of list) {
    const startedAt = new Date().toISOString();
    const { data: runRow } = await sb.from("export_runs").insert({
      org_id: dest.org_id,
      destination_id: dest.id,
      trigger_type: "scheduled",
      status: "running",
      started_at: startedAt,
    }).select("id").single();
    const runId = (runRow as { id: string } | null)?.id;

    try {
      const result = await buildAndDeliverExport({
        supabaseUrl,
        serviceRoleKey,
        orgId: dest.org_id,
        exporterUserId: "cron",
        exporterEmail: "cron@manufacturing-os",
        includeFiles: dest.include_files ?? true,
        delivery: { kind: "destination", destination: dest },
      });

      const completedAt = new Date().toISOString();
      if (runId) {
        await sb.from("export_runs").update({
          status: "succeeded",
          table_count: result.tableCount,
          total_rows: result.totalRows,
          file_count: result.fileCount,
          total_bytes: result.bytes,
          destination_path: result.destinationPath ?? null,
          destination_type: dest.destination_type,
          diagnostics: result.diagnostics,
          completed_at: completedAt,
          duration_ms: Date.parse(completedAt) - Date.parse(startedAt),
        }).eq("id", runId);
      }
      await sb.from("export_destinations").update({
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

      results.push({ destinationId: dest.id, ok: true, bytes: result.bytes });
    } catch (e) {
      const completedAt = new Date().toISOString();
      const msg = (e as Error).message || String(e);
      if (runId) {
        await sb.from("export_runs").update({
          status: "failed",
          error_message: msg.slice(0, 1000),
          completed_at: completedAt,
          duration_ms: Date.parse(completedAt) - Date.parse(startedAt),
        }).eq("id", runId);
      }
      await sb.from("export_destinations").update({
        last_run_at: completedAt,
        last_run_status: "failed",
        last_run_error: msg.slice(0, 500),
        // Still advance the clock so a chronically-broken destination doesn't
        // run every hour. They'll get the email + UI surface to investigate.
        next_run_at: computeNextRunAt({
          schedule_kind: dest.schedule_kind,
          schedule_hour_utc: dest.schedule_hour_utc,
          schedule_day_of_week: dest.schedule_day_of_week,
          schedule_day_of_month: dest.schedule_day_of_month,
          from: new Date(completedAt),
        }),
      }).eq("id", dest.id);
      results.push({ destinationId: dest.id, ok: false, error: msg });
    }
  }

  return NextResponse.json({ processed: results.length, results });
}

export async function POST(req: NextRequest) { return handler(req); }
export async function GET(req: NextRequest) { return handler(req); }
