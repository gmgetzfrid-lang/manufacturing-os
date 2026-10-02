// GET/POST /api/data-export/run-scheduled
//
// Vercel cron hits this ONCE DAILY (05:00 UTC — hourly crons require a paid
// Vercel plan and an hourly schedule in vercel.json makes the whole
// deployment fail validation on Hobby; that exact failure once silently
// blocked every deploy, so don't "fix" this back to hourly). We claim every
// destination whose next_run_at <= now() and is enabled, run them
// sequentially, and advance their schedule clocks. A destination's
// schedule_hour_utc orders WHEN it becomes due; delivery happens at the next
// daily sweep after that. Errors don't abort the batch.
//
// Auth: this is a server-to-server endpoint. Require the
// CRON_SECRET env var as a Bearer token to prevent random callers
// from triggering exports on demand.
//
// admin-and-org BKP-13: a scheduled push is recorded like a person's export
// — its DATA_EXPORT audit row is written (a machine row: user_id NULL, the
// machine named in user_email, DEC-44 (A&O P3)) and CHECKED, so a run whose
// record is refused fails instead of shipping unrecorded — and it rings the
// controllers' bell (lib/exportAlerts.ts), as the manual run always did.
// BILL-3 (Done-when 3): a bucket destination whose plan no longer includes
// cloud backups is skipped AND disabled under SUBSCRIPTION_ENFORCE (DEC-18),
// never deleted; an Admin re-enables it once the plan allows (PATCH applies
// the same entitlement gate to enabling).
// The run row is opened CHECKED: a run whose row is refused does not export
// (it would leave no run history). The success path's run-row and
// destination writes are checked too, and a refused one is logged and named
// on the sweep result (`warnings`), never swallowed.

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildAndDeliverExport, computeNextRunAt, exportEmbedDeadline, retentionProblem, type ExportDestination } from "@/lib/exportRunner";
import { scheduledRunGate, cloudBucketAllowed, CLOUD_BUCKET_REFUSAL, SUBSCRIPTION_INACTIVE_REFUSAL } from "@/lib/exportEntitlement";
import { alertAdminsOfExport } from "@/lib/exportAlerts";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const cronSecret = process.env.CRON_SECRET || "";

/** DEC-44 (A&O P3): the actor of a row no person wrote — user_id NULL (never a
 *  string or an invented uuid in the uuid column), the machine named in
 *  user_email, user_role "system". */
const SCHEDULED_EXPORT_ACTOR = { email: "system:scheduled-export", role: "system" } as const;

type ScheduleParams = Parameters<typeof computeNextRunAt>[0];

// A due destination row carries both the delivery config (ExportDestination)
// and the schedule columns consumed by computeNextRunAt.
type ScheduledDestination = ExportDestination & {
  schedule_kind: ScheduleParams["schedule_kind"];
  schedule_hour_utc?: ScheduleParams["schedule_hour_utc"];
  schedule_day_of_week?: ScheduleParams["schedule_day_of_week"];
  schedule_day_of_month?: ScheduleParams["schedule_day_of_month"];
  next_run_at?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  name?: string | null;
};

type ScheduledRunResult = {
  destinationId: string;
  ok: boolean;
  bytes?: number;
  error?: string;
  /** XEDGE-7: what the gate WOULD have refused with SUBSCRIPTION_ENFORCE on. */
  warnings?: string[];
};

async function handler(req: NextRequest) {
  // The ZIP's embed loop (and the export's storage checks) stop at this route's own deadline, so the archive is delivered.
  const routeStart = Date.now();
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Supabase credentials missing" }, { status: 500 });
  }
  // Fail closed: reject unless the caller presents CRON_SECRET. Vercel
  // attaches it automatically to the scheduled invocation; if the secret is
  // somehow unset, deny rather than fire every org's export world-open.
  const auth = req.headers.get("authorization") || "";
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const nowIso = new Date().toISOString();
  // DEC-18: billing-derived refusals are inert until the flag is on.
  const enforceBilling = process.env.SUBSCRIPTION_ENFORCE === "true";

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
    // Atomically CLAIM this destination so an overlapping cron run (or a
    // second scheduler) can't also pick it and double-export. Advance
    // next_run_at to the next scheduled time, guarded by the exact value we
    // selected (compare-and-set). If the update matches no row, another run
    // already claimed it — skip. On failure below, next_run_at stays advanced,
    // so a failed export waits for its next cycle rather than re-firing.
    const tentativeNext = computeNextRunAt({
      schedule_kind: dest.schedule_kind,
      schedule_hour_utc: dest.schedule_hour_utc,
      schedule_day_of_week: dest.schedule_day_of_week,
      schedule_day_of_month: dest.schedule_day_of_month,
      from: new Date(),
    });
    const { data: claimed } = await sb
      .from("export_destinations")
      .update({ next_run_at: tentativeNext })
      .eq("id", dest.id)
      .eq("next_run_at", dest.next_run_at ?? nowIso)
      .select("id");
    if (!claimed || claimed.length === 0) {
      results.push({ destinationId: dest.id, ok: false, error: "skipped: already claimed by another run" });
      continue;
    }

    // XEDGE-7 / XEDGE-8: an unattended push must not outlive the person who
    // configured it, the workspace's subscription, or the plan the bucket
    // feature is sold on (lib/exportEntitlement.ts). A skip is RECORDED — a
    // cancelled run plus the destination's last-run status — never a silent
    // continue; the clock was already advanced by the claim above. Both
    // record writes are CHECKED: a failure is logged and named on the sweep
    // result, so a night with no run row is never a silent gap.
    const gate = await scheduledRunGate(sb, dest, enforceBilling);
    for (const n of gate.notices) console.warn(`[run-scheduled] destination ${dest.id}: ${n}`);
    if (!gate.ok) {
      const at = new Date().toISOString();
      // BILL-3 Done-when 3: a lapsed plan DISABLES a bucket destination (the
      // skip alone would re-fire the refusal every night) — never deletes it.
      // Only when the gate refused on a BILLING limb (the plan, or the
      // subscription — under the flag, the only time it refuses on billing
      // grounds) and the plan, read again, no longer includes buckets. A skip
      // for a departed configurer, or for an unreadable workspace row, never
      // disables, whatever the plan.
      const planLapsed = enforceBilling && !!dest.bucket && refusedOnBillingLimb(gate.reason)
        && await planNoLongerIncludesBuckets(sb, dest.org_id);
      const skipMsg = `skipped: ${gate.reason}${planLapsed ? " — the destination was disabled; an Admin re-enables it once the plan includes cloud backups" : ""}`;
      const unrecorded: string[] = [];
      const { error: runErr } = await sb.from("export_runs").insert({
        org_id: dest.org_id,
        destination_id: dest.id,
        trigger_type: "scheduled",
        status: "cancelled",
        error_message: skipMsg.slice(0, 1000),
        destination_type: dest.destination_type,
        diagnostics: [{ ts: at, step: "gate:skipped", detail: gate.reason }],
        started_at: at,
        completed_at: at,
        duration_ms: 0,
      });
      if (runErr) unrecorded.push(`run row not recorded: ${runErr.message}`);
      const { error: destErr } = await sb.from("export_destinations").update({
        last_run_at: at,
        last_run_status: "failed",
        last_run_error: skipMsg.slice(0, 500),
        ...(planLapsed ? { enabled: false } : {}),
      }).eq("id", dest.id);
      if (destErr) unrecorded.push(`last-run status not recorded: ${destErr.message}`);
      for (const u of unrecorded) console.error(`[run-scheduled] destination ${dest.id}: ${u}`);
      results.push({ destinationId: dest.id, ok: false, error: [skipMsg, ...unrecorded].join("; ") });
      continue;
    }

    const startedAt = new Date().toISOString();
    const { data: runRow, error: runRowErr } = await sb.from("export_runs").insert({
      org_id: dest.org_id,
      destination_id: dest.id,
      trigger_type: "scheduled",
      status: "running",
      started_at: startedAt,
    }).select("id").single();
    const runId = (runRow as { id: string } | null)?.id;
    if (runRowErr || !runId) {
      // Nothing is exported without its run record; the claim already moved
      // the clock, so this costs one cycle and is said on the card.
      const msg = `not run: the run record could not be opened (${runRowErr?.message ?? "no run id returned"}); retried next cycle`;
      console.error(`[run-scheduled] destination ${dest.id}: ${msg}`);
      const { error: destErr } = await sb.from("export_destinations").update({
        last_run_at: startedAt, last_run_status: "failed", last_run_error: msg.slice(0, 500),
      }).eq("id", dest.id);
      if (destErr) console.error(`[run-scheduled] destination ${dest.id}: last-run status not recorded: ${destErr.message}`);
      results.push({ destinationId: dest.id, ok: false, error: destErr ? `${msg}; last-run status not recorded: ${destErr.message}` : msg });
      continue;
    }

    try {
      const result = await buildAndDeliverExport({
        supabaseUrl,
        serviceRoleKey,
        orgId: dest.org_id,
        exporterUserId: null,
        exporterEmail: SCHEDULED_EXPORT_ACTOR.email,
        exporterRole: SCHEDULED_EXPORT_ACTOR.role,
        auditDetails: {
          channel: "scheduled", destinationId: dest.id, destinationType: dest.destination_type,
          configuredBy: dest.updated_by || dest.created_by || null,
        },
        includeFiles: dest.include_files ?? true,
        delivery: { kind: "destination", destination: dest },
        deadlineAt: exportEmbedDeadline(routeStart, maxDuration),
      });

      // BKP-13: the controllers' bell, as for a manual run — every controller
      // (no person ran this), naming the destination and its configurer. A
      // refused alert is recorded on the run, never swallowed.
      const alert = await alertAdminsOfExport(sb, {
        orgId: dest.org_id, actorUserId: null, actorEmail: SCHEDULED_EXPORT_ACTOR.email,
        destination: dest.destination_type,
        scheduled: { destinationName: dest.name || dest.id, configuredBy: dest.updated_by || dest.created_by || null },
      }).catch((e) => ({ ok: false, notified: 0, error: (e as Error).message }));
      if (!alert.ok) console.error(`[run-scheduled] destination ${dest.id}: the export alert was not sent: ${alert.error}`);
      // BKP-6: a retention purge that did not finish is said on the run row and the card.
      const retentionNote = retentionProblem(result.retention);
      const completedAt = new Date().toISOString();
      const unrecorded: string[] = [];
      {
        const { error: runUpdErr } = await sb.from("export_runs").update({
          status: "succeeded",
          table_count: result.tableCount,
          total_rows: result.totalRows,
          file_count: result.fileCount,
          total_bytes: result.bytes,
          destination_path: result.destinationPath ?? null,
          destination_type: dest.destination_type,
          diagnostics: [
            ...gate.notices.map((n) => ({ ts: startedAt, step: "gate:notice", detail: n })),
            ...result.diagnostics,
            ...(alert.ok ? [] : [{ ts: completedAt, step: "alert:unsent", detail: alert.error }]),
          ],
          ...(retentionNote ? { error_message: retentionNote.slice(0, 1000) } : {}),
          completed_at: completedAt,
          duration_ms: Date.parse(completedAt) - Date.parse(startedAt),
        }).eq("id", runId);
        if (runUpdErr) unrecorded.push(`run row not updated: ${runUpdErr.message}`);
      }
      const { error: destUpdErr } = await sb.from("export_destinations").update({
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
      if (destUpdErr) unrecorded.push(`last-run status not recorded: ${destUpdErr.message}`);
      for (const u of unrecorded) console.error(`[run-scheduled] destination ${dest.id}: ${u}`);
      const warnings = [...gate.notices, ...unrecorded];

      results.push({
        destinationId: dest.id, ok: true, bytes: result.bytes,
        ...(warnings.length ? { warnings } : {}),
      });
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

/** BILL-3: did the scheduled gate refuse on its subscription or plan limb?
 *  Those limbs' reasons carry lib/exportEntitlement.ts's own refusal
 *  sentences (CLOUD_BUCKET_REFUSAL, SUBSCRIPTION_INACTIVE_REFUSAL); the
 *  membership limb's and the unreadable-row reason carry neither. */
function refusedOnBillingLimb(reason: string): boolean {
  return reason.includes(CLOUD_BUCKET_REFUSAL) || reason.includes(SUBSCRIPTION_INACTIVE_REFUSAL);
}

/** BILL-3: does this workspace's plan no longer include bucket destinations?
 *  Read on its own — the gate already refused, so this only decides whether
 *  to DISABLE as well. An unreadable row does not disable (fail safe: the
 *  skip already happened; a disable needs a definite answer). */
async function planNoLongerIncludesBuckets(sb: SupabaseClient, orgId: string): Promise<boolean> {
  const { data, error } = await sb.from("orgs").select("subscription_status, subscribed_plan").eq("id", orgId).maybeSingle();
  if (error || !data) return false;
  const row = data as { subscription_status?: string | null; subscribed_plan?: string | null };
  return !cloudBucketAllowed(row.subscribed_plan, row.subscription_status);
}

export async function POST(req: NextRequest) { return handler(req); }
export async function GET(req: NextRequest) { return handler(req); }
