// POST /api/data-export/run
// Body: { orgId, destinationId? }
//
// If destinationId is provided, runs against that destination (S3 push
// or webhook). If omitted, builds an inline ZIP and streams it to the
// caller as a download response.
//
// Always writes an export_runs row with the result — for a bucket push whose
// retention purge ran, its deleted and failed counts in the row's own
// columns (admin-and-org BKP-6, migration 20261172; until that is pasted the
// row is written without them, the counts in its diagnostics as before).
//
// Admin-only (admin-and-org BKP-8): held to the data-export admin surface by
// the one gate (lib/adminGate.ts; the role set lives in lib/adminSurfaces.ts).
//
// BKP-11 Done-when 3: "Run Now" fires a destination as surely as the
// scheduler does, so it is held to the rule enabling one is: a bucket
// destination needs both access keys, and a DISABLED webhook its signing
// secret (lib/exportRunner.ts destinationCredentialGap). A restored row
// arrives disabled with none of them, still naming the backup owner's URL;
// it answers 409 here, with nothing sent and no run row opened.
//
// BILL-3 Done-when 3: a bucket destination is the Growth feature. Under
// SUBSCRIPTION_ENFORCE (the rule the scheduled sweep follows, DEC-18) Run Now
// passes the plan gate creating or enabling one does (402), so a destination
// the sweep disabled for a lapsed plan cannot be pushed by hand instead.
//
// The rate-limit count and the run row are read and written CHECKED: a run
// that cannot be counted, or whose run row is refused, is refused (503)
// before anything is exported — it would otherwise run uncounted, past the
// cap, with no run history. The closing writes (the run row, the
// destination's last-run summary, the archive catalog entry) are checked
// too: a refused one is logged and named — `warnings` on a JSON answer, the
// X-Export-Unrecorded header on a download — never a silent success.
//
// The DATA_EXPORT row's user_role is the role the data-export surface
// admitted the exporter by (an Admin whose headline is Viewer is recorded as
// Admin); the full collection is in details.exporterRoles.
//
// DEC-44 (A&O P3) §1: Run Now does not confirm a destination (it does not
// stamp updated_by; saving it does), so a destination a Manager or DocCtrl
// last saved keeps the request to confirm it on its card after a Run Now,
// succeeded or failed (lib/exportAlerts.ts destinationConfirmation — the read
// the nightly sweep makes; fifth review fix: Run Now wiped it, and the card
// read as a clean success until the next night).

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { authorizeAdminSurface } from "@/lib/adminGate";
import { buildAndDeliverExport, closeSucceededRun, computeNextRunAt, destinationCredentialGap, exportEmbedDeadline, exportRateLimitRefusal, retentionProblem, type ExportDestination } from "@/lib/exportRunner";
import { makeArchiveId } from "@/lib/archive";
import { alertAdminsOfExport, destinationConfirmation, unconfirmedNote } from "@/lib/exportAlerts";
import { assertCloudBucketEntitlement } from "@/lib/exportEntitlement";

type ScheduleParams = Parameters<typeof computeNextRunAt>[0];

// A destination row carries both the delivery config (ExportDestination) and
// the schedule columns consumed by computeNextRunAt.
type ScheduledDestination = ExportDestination & {
  schedule_kind: ScheduleParams["schedule_kind"];
  schedule_hour_utc?: ScheduleParams["schedule_hour_utc"];
  schedule_day_of_week?: ScheduleParams["schedule_day_of_week"];
  schedule_day_of_month?: ScheduleParams["schedule_day_of_month"];
  created_by?: string | null;
  updated_by?: string | null;
};

/** DEC-44 (A&O P3) §1: the card's request to confirm a destination its last
 *  configurer could not set up today, or null (also when that could not be
 *  read: the sweep says so the next night). */
async function confirmationNoteFor(admin: Parameters<typeof destinationConfirmation>[0], dest: ScheduledDestination): Promise<string | null> {
  const c = await destinationConfirmation(admin, dest);
  return c.unconfirmed ? unconfirmedNote(c.unconfirmed) : null;
}

interface RunBody {
  orgId: string;
  destinationId?: string;
  includeFiles?: boolean;
}
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

/** A header-safe line naming what was not recorded. */
function headerLine(parts: string[]): string {
  return parts.join("; ").replace(/[^\x20-\x7e]/g, "?").slice(0, 300);
}

export async function POST(req: NextRequest) {
  // The ZIP's embed loop (and the export's storage checks) stop at this route's own deadline, so the archive is delivered.
  const routeStart = Date.now();
  let body: RunBody;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = String(body?.orgId ?? "");
  const auth = await authorizeAdminSurface(req, orgId, "data-export");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Rate limit: cap export runs per org per hour so a tight loop can't hammer
  // the (expensive) ZIP builder or exfiltrate at speed — the cap the JSON
  // export (`structured`) is held to as well (lib/exportRunner.ts).
  const limited = await exportRateLimitRefusal(auth.admin, orgId);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });

  // The destination, read CHECKED before anything is opened or sent.
  let dest: ScheduledDestination | null = null;
  if (body.destinationId) {
    const { data, error: destErr } = await auth.admin
      .from("export_destinations")
      .select("*")
      .eq("id", body.destinationId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (destErr) return NextResponse.json({ error: `Could not read the destination (${destErr.message}) — nothing was run.` }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Destination not found" }, { status: 404 });
    dest = data as ScheduledDestination;
    const row = data as ScheduledDestination & { enabled?: boolean | null };
    const gap = destinationCredentialGap(
      row.destination_type,
      { accessKey: !!row.access_key_id_encrypted, secretKey: !!row.secret_access_key_encrypted, webhookSecret: !!row.webhook_secret_encrypted },
      { requireWebhookSecret: row.enabled !== true, then: "run it again" },
    );
    if (gap) return NextResponse.json({ error: gap }, { status: 409 });
    // BILL-3 Done-when 3: the plan gate, behind the sweep's flag (DEC-18).
    const bucket = row.destination_type === "s3" || row.destination_type === "r2" || !!String(row.bucket ?? "").trim();
    if (bucket && process.env.SUBSCRIPTION_ENFORCE === "true") {
      const plan = await assertCloudBucketEntitlement(auth.admin, orgId);
      if (plan) return NextResponse.json({ error: plan.error }, { status: plan.status });
    }
  }

  // Open a runs row up front so the UI can poll it
  const startedAt = new Date().toISOString();
  const { data: runRow, error: runRowErr } = await auth.admin.from("export_runs").insert({
    org_id: orgId,
    destination_id: body.destinationId ?? null,
    trigger_type: "manual",
    triggered_by: auth.userId,
    triggered_by_email: auth.email,
    status: "running",
    started_at: startedAt,
  }).select("id").single();
  const runId = (runRow as { id: string } | null)?.id;
  if (runRowErr || !runId) {
    return NextResponse.json(
      { error: `Could not open this export's run record (${runRowErr?.message ?? "no run id returned"}) — nothing was exported.` },
      { status: 503 },
    );
  }

  try {
    const result = await buildAndDeliverExport({
      supabaseUrl,
      serviceRoleKey,
      orgId,
      exporterUserId: auth.userId,
      exporterEmail: auth.email,
      exporterRole: auth.admittedRole,
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
    // The closing writes are CHECKED: a refused one is logged and named in the
    // answer. The export itself left and is recorded, so the run succeeded.
    // BKP-6 Done-when 3: the purge's deleted and failed counts go on the run
    // row's own columns (20261172); before that paste the row closes as it
    // always did, the counts in its diagnostics (closeSucceededRun).
    const unrecorded: string[] = [];
    {
      const { error: runUpdErr } = await closeSucceededRun(auth.admin, runId, {
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
      }, result.retention);
      if (runUpdErr) unrecorded.push(`run row not updated: ${runUpdErr.message}`);
    }

    if (dest) {
      // Update destination summary + advance the schedule clock; the card
      // keeps an unconfirmed destination's request to confirm it.
      const confirmNote = await confirmationNoteFor(auth.admin, dest);
      const cardNote = [retentionNote, confirmNote].filter(Boolean).join(" ") || null;
      const { error: destUpdErr } = await auth.admin.from("export_destinations").update({
        last_run_at: completedAt,
        last_run_status: "succeeded",
        last_run_error: cardNote ? cardNote.slice(0, 500) : null,
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
      for (const u of unrecorded) console.error(`[data-export/run] org ${orgId}, run ${runId}: ${u}`);

      return NextResponse.json({
        ok: true,
        runId,
        bytes: result.bytes,
        fileCount: result.fileCount,
        destinationPath: result.destinationPath,
        ...(unrecorded.length || confirmNote ? { warnings: [...(confirmNote ? [confirmNote] : []), ...unrecorded] } : {}),
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
    // The catalog entry is not a condition of the download, but a refused one
    // is named, never swallowed.
    try {
      const { error: catalogErr } = await auth.admin.from("archives").insert({
        org_id: orgId,
        archive_id: archiveId,
        kind: "full",
        file_count: result.fileCount,
        total_bytes: result.bytes,
        created_by: auth.userId,
        created_by_email: auth.email,
      });
      if (catalogErr) unrecorded.push(`archive catalog entry not recorded: ${catalogErr.message}`);
    } catch (e) {
      unrecorded.push(`archive catalog entry not recorded: ${(e as Error).message}`);
    }
    for (const u of unrecorded) console.error(`[data-export/run] org ${orgId}, run ${runId}: ${u}`);
    return new NextResponse(zipBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="manufacturing-os-backup-${archiveId}.zip"`,
        "Cache-Control": "no-store",
        "X-Export-Run-Id": runId || "",
        "X-Archive-Id": archiveId,
        ...(unrecorded.length ? { "X-Export-Unrecorded": headerLine(unrecorded) } : {}),
      },
    });
  } catch (e) {
    const completedAt = new Date().toISOString();
    const duration = Date.parse(completedAt) - Date.parse(startedAt);
    const msg = (e as Error).message || String(e);
    // Checked like the success path: a run row left "running" would stay
    // stuck on the page and keep counting toward the hourly cap.
    const unrecorded: string[] = [];
    {
      const { error: runUpdErr } = await auth.admin.from("export_runs").update({
        status: "failed",
        error_message: msg.slice(0, 1000),
        completed_at: completedAt,
        duration_ms: duration,
      }).eq("id", runId);
      if (runUpdErr) unrecorded.push(`run row not updated: ${runUpdErr.message}`);
    }
    if (dest) {
      const confirmNote = await confirmationNoteFor(auth.admin, dest);
      const { error: destUpdErr } = await auth.admin.from("export_destinations").update({
        last_run_at: completedAt,
        last_run_status: "failed",
        last_run_error: confirmNote
          ? `${msg.slice(0, Math.max(0, 500 - confirmNote.length - 1))} ${confirmNote}`.slice(0, 500)
          : msg.slice(0, 500),
      }).eq("id", dest.id);
      if (destUpdErr) unrecorded.push(`last-run status not recorded: ${destUpdErr.message}`);
    }
    for (const u of unrecorded) console.error(`[data-export/run] org ${orgId}, run ${runId}: ${u}`);
    return NextResponse.json({ error: msg, ...(unrecorded.length ? { warnings: unrecorded } : {}) }, { status: 500 });
  }
}
