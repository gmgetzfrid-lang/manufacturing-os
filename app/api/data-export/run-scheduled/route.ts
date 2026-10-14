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
// machine named in user_email, DEC-87) and CHECKED, so a run whose
// record is refused fails instead of shipping unrecorded — and it rings the
// controllers' bell (lib/exportAlerts.ts), as the manual run always did.
// BILL-3 (Done-when 3): a bucket destination whose plan no longer includes
// cloud backups is skipped AND disabled under SUBSCRIPTION_ENFORCE (DEC-18),
// never deleted; an Admin re-enables it once the plan allows (PATCH applies
// the same entitlement gate to enabling).
// The run row is opened CHECKED: a run whose row is refused does not export
// (it would leave no run history). The success path's run-row and
// destination writes are checked too, and a refused one is logged and named
// on the sweep result (`warnings`), never swallowed. So are the failure
// path's, the claim (a refused claim runs nothing; the destination stays due
// for the next sweep) and the read of what is due: a sweep that cannot read
// it answers 500, so the cron run shows as failed instead of "processed: 0".
//
// BKP-13 / DEC-87 §1: the data-export surface is Admin-only. A
// destination whose last configurer does not hold the surface's entry role
// (Admin) — one a Manager or DocCtrl set up before the surface narrowed —
// still RUNS: a nightly backup must not stop the night this deploys
// (regression first; the third review fix pass skipped it, with no bell).
// That night's bell to every Admin names who last confirmed it and asks them
// to open it and save it to confirm it (that stamps updated_by), or disable
// it; the run row, the destination card and the sweep result say the same.
// It rings every night until an Admin saves it (P14 bounds this at 7 nights,
// below). A failed bell is recorded on the run (alert:unsent) and named on
// the sweep result. A push that FAILS carries the same sentence on its run
// row, its card (after the failure) and the sweep result (fifth review fix:
// it was dropped there). A CONFIRMED destination's failed push rings no bell;
// an unconfirmed destination's failed night in the bounded grace (below)
// rings every Admin's bell (P14): it says nothing left only when the push
// failed before the archive was sent, and otherwise that the destination may
// hold it (P14 fix pass: a webhook that answers 500 has already received the
// whole ZIP — lib/exportRunner.ts pushTransmissionBegan).
//
// DEC-87 §1 as amended 2026-10-13 under DEC-90 (admin-and-org Round G, P14;
// intelligence IEDGE-10 / DACL-7): that grace is BOUNDED. Each unconfirmed
// push is a counted night (lib/exportAlerts.ts unconfirmedGraceTonight, read
// from the destination's own scheduled run rows — the night this deploys is
// night 1); nights 1 to 7 run and every Admin's bell names the night (a
// night whose push failed rings it too, saying whether the archive was
// sent); night 7's push is followed by a pause, said in its bell; from night
// 8 the sweep skips it with a cancelled run row and the card saying it is
// paused (no bell — P14 fix pass: unless night 7's bell was refused, when the
// first paused night that can rings it, checked, once), until an Admin opens
// it and saves it (confirmed: it runs as any other destination) or disables
// it. A count that cannot be read never stops a backup: it runs, and says so
// — P14 fix pass: unless the destination row in hand says its last scheduled
// run left it paused (lib/exportAlerts.ts pausedAtLastRun), when it stays
// paused. P14 review fix: a night whose confirmation cannot be VERIFIED (the
// configurer's role read failed) never ends the pause — the count is still
// read, and a paused destination is skipped as on any paused night; otherwise
// it runs, its run row marked grace:unverified, which neither counts nor
// breaks the count. Only an Admin's save ends a pause (P14 fix pass: on an
// unverified night a destination saved since its pause — only an Admin can
// save one — runs uncounted rather than staying paused on that guess).
//
// admin-and-org BKP-6: a succeeded bucket push whose retention purge ran puts
// the purge's deleted and failed counts on its run row's own columns
// (migration 20261172; until that is pasted the row is written without them,
// the counts in its diagnostics as before — lib/exportRunner.ts
// closeSucceededRun).

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildAndDeliverExport, closeSucceededRun, computeNextRunAt, exportEmbedDeadline, pushesToBucket, pushTransmissionBegan, retentionProblem, type ExportDestination } from "@/lib/exportRunner";
import { scheduledRunGate, cloudBucketAllowed, CLOUD_BUCKET_REFUSAL, SUBSCRIPTION_INACTIVE_REFUSAL } from "@/lib/exportEntitlement";
import {
  alertAdminsOfExport, destinationConfirmation, unconfirmedNote as unconfirmedNoteFor,
  unconfirmedGraceTonight, graceSentence, graceNightStep, graceUnverifiedStep, pausedNote, pausedUnverifiedNote,
  pausedCountUnreadSentence, pausedAtLastRun, savedSince, SAVED_SINCE_PAUSE_NOTE, PAUSE_ANNOUNCED_EARLIER,
  GRACE_PAUSED_STEP, GRACE_PAUSE_ANNOUNCED_STEP, ALERT_UNSENT_STEP, UNCONFIRMED_GRACE_NIGHTS, type UnconfirmedGrace,
} from "@/lib/exportAlerts";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const cronSecret = process.env.CRON_SECRET || "";

/** DEC-87: the actor of a row no person wrote — user_id NULL (never a
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
  /** Stamped only by an Admin's save (PATCH); read by the grace (savedSince). */
  updated_at?: string | null;
  /** The card's last run, read by the grace's fallback (pausedAtLastRun). */
  last_run_at?: string | null;
  last_run_error?: string | null;
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

  const { data: due, error: dueErr } = await sb
    .from("export_destinations")
    .select("*")
    .eq("enabled", true)
    .not("next_run_at", "is", null)
    .lte("next_run_at", nowIso)
    .limit(50);
  if (dueErr) {
    // Read as "nothing due", a failed read would skip every scheduled backup
    // with no run row and a 200: the silent gap BKP-13 closes.
    console.error(`[run-scheduled] the destinations due for export could not be read: ${dueErr.message}`);
    return NextResponse.json(
      { error: `Could not read the destinations due for export (${dueErr.message}) — nothing was run; they stay due for the next sweep.` },
      { status: 500 },
    );
  }

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
    const { data: claimed, error: claimErr } = await sb
      .from("export_destinations")
      .update({ next_run_at: tentativeNext })
      .eq("id", dest.id)
      .eq("next_run_at", dest.next_run_at ?? nowIso)
      .select("id");
    if (claimErr) {
      // Not claimed, so not run: its clock did not move, and the next sweep
      // picks it up again.
      const msg = `not run: the destination could not be claimed (${claimErr.message}); it stays due for the next sweep`;
      console.error(`[run-scheduled] destination ${dest.id}: ${msg}`);
      results.push({ destinationId: dest.id, ok: false, error: msg });
      continue;
    }
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
    // BILL-3 Done-when 3 (A&O P3 fix pass 8): the gate's plan limb tests
    // `bucket`; it is handed one only for a row that pushes to a bucket — s3 /
    // r2 with a bucket (pushesToBucket, Run Now's rule) — so a webhook still
    // carrying the bucket name it had before it was converted is neither
    // refused (under the flag) nor noticed as "plan gate would skip" (without
    // it). lib/exportEntitlement.ts itself is not edited.
    const gate = await scheduledRunGate(sb, { ...dest, bucket: pushesToBucket(dest) ? dest.bucket : null }, enforceBilling);
    for (const n of gate.notices) console.warn(`[run-scheduled] destination ${dest.id}: ${n}`);
    const refusal = gate.ok ? null : gate.reason;
    if (refusal) {
      const at = new Date().toISOString();
      // BILL-3 Done-when 3: a lapsed plan DISABLES a bucket destination (the
      // skip alone would re-fire the refusal every night) — never deletes it.
      // Only when the gate refused on a BILLING limb (the plan, or the
      // subscription — under the flag, the only time it refuses on billing
      // grounds) and the plan, read again, no longer includes buckets. A skip
      // for a departed configurer, or for an unreadable workspace row, never
      // disables, whatever the plan. Only a row that pushes to a bucket (s3 /
      // r2 with a bucket — A&O P3 fix pass 8: was any row with a bucket name,
      // so a converted webhook was disabled for a feature it does not use).
      const planLapsed = !gate.ok && enforceBilling && pushesToBucket(dest) && refusedOnBillingLimb(gate.reason)
        && await planNoLongerIncludesBuckets(sb, dest.org_id);
      const skipMsg = `skipped: ${refusal}${planLapsed ? " — the destination was disabled; an Admin re-enables it once the plan includes cloud backups" : ""}`;
      const unrecorded: string[] = [];
      const { error: runErr } = await sb.from("export_runs").insert({
        org_id: dest.org_id,
        destination_id: dest.id,
        trigger_type: "scheduled",
        status: "cancelled",
        error_message: skipMsg.slice(0, 1000),
        destination_type: dest.destination_type,
        diagnostics: [{ ts: at, step: "gate:skipped", detail: refusal }],
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

    // DEC-87 §1: does its last configurer hold the data-export
    // surface's entry role? Either way it runs; an unconfirmed one turns the
    // night's bell into a request to confirm it (below).
    const confirmation = await destinationConfirmation(sb, dest);
    // DEC-87 §1 (amended, P14): an unconfirmed destination's night in the
    // bounded grace — or, past its last night, a pause.
    let grace: UnconfirmedGrace | null = null;
    const graceNotes: string[] = [];
    // P14 review fix: a confirmation that could not be VERIFIED (the role read
    // failed) still reads the grace — a paused destination stays paused, and
    // tonight's run row is marked neutral in the count (grace:unverified), so
    // an unreadable night neither pushes from a paused destination nor
    // restarts the count at night 1.
    const unverified = !confirmation.unconfirmed && confirmation.notice ? (confirmation.unverified ?? "the role read failed") : null;
    if (confirmation.unconfirmed || unverified !== null) {
      const tonight = await unconfirmedGraceTonight(sb, dest.id);
      const countError = !tonight.paused && "error" in tonight ? tonight.error : null;
      // P14 fix pass (major): a count that cannot be read falls back on the
      // row in hand — a destination whose last scheduled run left it paused
      // stays paused (never a whole-workspace push on a failed read).
      let paused = tonight.paused || (countError !== null && pausedAtLastRun(dest));
      // P14 fix pass (minor): on an unverified night, a destination saved
      // since its pause (only an Admin can save one) is not held paused on
      // that guess — it runs, uncounted (grace:unverified).
      if (paused && unverified !== null && savedSince(dest.updated_at, tonight.paused ? tonight.since : dest.last_run_at)) {
        paused = false;
        graceNotes.push(SAVED_SINCE_PAUSE_NOTE);
        console.warn(`[run-scheduled] destination ${dest.id}: ${SAVED_SINCE_PAUSE_NOTE}`);
      }
      if (paused) {
        const at = new Date().toISOString();
        const base = confirmation.unconfirmed ? pausedNote(confirmation.unconfirmed) : pausedUnverifiedNote(unverified ?? "");
        const note = countError !== null ? `${base} ${pausedCountUnreadSentence(countError)}` : base;
        if (unverified !== null) console.warn(`[run-scheduled] destination ${dest.id}: ${confirmation.notice}; it stays paused`);
        if (countError !== null) console.warn(`[run-scheduled] destination ${dest.id}: the unconfirmed-night count could not be read (${countError}); its last scheduled run left it paused, so it stays paused`);
        const msg = `skipped: ${note}`;
        // P14 fix pass (minor): a pause whose announcing bell was refused is
        // announced by the first paused night that can (checked), once; a
        // pause already announced is carried forward on the row, so the next
        // count stops here.
        const announced: Array<{ ts: string; step: string; detail: string }> = [];
        const warnings: string[] = [];
        if (tonight.paused && tonight.announced) {
          announced.push({ ts: at, step: GRACE_PAUSE_ANNOUNCED_STEP, detail: PAUSE_ANNOUNCED_EARLIER });
        } else if (tonight.paused && confirmation.unconfirmed) {
          const bell = await alertAdminsOfExport(sb, {
            orgId: dest.org_id, actorUserId: null, actorEmail: SCHEDULED_EXPORT_ACTOR.email,
            destination: dest.destination_type,
            scheduled: {
              destinationName: dest.name || dest.id, configuredBy: dest.updated_by || dest.created_by || null,
              unconfirmed: confirmation.unconfirmed, pausedNotice: { of: UNCONFIRMED_GRACE_NIGHTS },
            },
          }).catch((err) => ({ ok: false, notified: 0, error: (err as Error).message }));
          if (bell.ok) {
            announced.push({ ts: at, step: GRACE_PAUSE_ANNOUNCED_STEP, detail: `announced tonight to ${bell.notified} controller(s): the bell at its last push could not be sent` });
          } else {
            announced.push({ ts: at, step: ALERT_UNSENT_STEP, detail: bell.error ?? "the alert could not be sent" });
            warnings.push(`the pausing alert was not sent: ${bell.error}`);
            console.error(`[run-scheduled] destination ${dest.id}: the pausing alert was not sent: ${bell.error}`);
          }
        }
        const unrecorded: string[] = [];
        const { error: runErr } = await sb.from("export_runs").insert({
          org_id: dest.org_id,
          destination_id: dest.id,
          trigger_type: "scheduled",
          status: "cancelled",
          error_message: msg.slice(0, 1000),
          destination_type: dest.destination_type,
          diagnostics: [{ ts: at, step: GRACE_PAUSED_STEP, detail: note }, ...announced],
          started_at: at,
          completed_at: at,
          duration_ms: 0,
        });
        if (runErr) unrecorded.push(`run row not recorded: ${runErr.message}`);
        const { error: destErr } = await sb.from("export_destinations").update({
          last_run_at: at,
          last_run_status: "failed",
          last_run_error: msg.slice(0, 500),
        }).eq("id", dest.id);
        if (destErr) unrecorded.push(`last-run status not recorded: ${destErr.message}`);
        for (const u of unrecorded) console.error(`[run-scheduled] destination ${dest.id}: ${u}`);
        results.push({
          destinationId: dest.id, ok: false, error: [msg, ...unrecorded].join("; "),
          ...(warnings.length ? { warnings } : {}),
        });
        continue;
      }
      if (confirmation.unconfirmed && !tonight.paused) grace = { night: tonight.night, of: tonight.of, pausing: tonight.pausing };
      if (countError !== null) {
        const graceReadNote = `the unconfirmed-night count could not be read (${countError}); the push ran`;
        graceNotes.push(graceReadNote);
        console.warn(`[run-scheduled] destination ${dest.id}: ${graceReadNote}`);
      }
    }
    const unconfirmedNote = confirmation.unconfirmed
      ? `${unconfirmedNoteFor(confirmation.unconfirmed)}${grace ? ` ${graceSentence(grace)}` : ""}`
      : null;
    const notices = [
      ...gate.notices, ...(confirmation.notice ? [confirmation.notice] : []), ...(unconfirmedNote ? [unconfirmedNote] : []),
      ...graceNotes,
    ];
    if (confirmation.notice) console.warn(`[run-scheduled] destination ${dest.id}: ${confirmation.notice}`);

    const startedAt = new Date().toISOString();
    // The night is counted on the run row from the moment it opens, so a push
    // killed mid-flight (its row left "running") still counts.
    // P14 review fix: an unverified night is marked neutral from the moment its row opens.
    const graceStep = grace ? graceNightStep(grace, startedAt) : unverified !== null ? graceUnverifiedStep(startedAt) : null;
    const { data: runRow, error: runRowErr } = await sb.from("export_runs").insert({
      org_id: dest.org_id,
      destination_id: dest.id,
      trigger_type: "scheduled",
      status: "running",
      started_at: startedAt,
      ...(graceStep ? { diagnostics: [graceStep] } : {}),
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

    // P14 fix pass: once the builder has returned, the archive was delivered.
    let delivered = false;
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
      delivered = true;

      // BKP-13: the controllers' bell, as for a manual run — every controller
      // (no person ran this), naming the destination and its configurer; for
      // an unconfirmed destination, asking every Admin to confirm it or
      // disable it (DEC-87 §1). A refused alert is recorded on the
      // run and named on the sweep result, never swallowed.
      const alert = await alertAdminsOfExport(sb, {
        orgId: dest.org_id, actorUserId: null, actorEmail: SCHEDULED_EXPORT_ACTOR.email,
        destination: dest.destination_type,
        scheduled: {
          destinationName: dest.name || dest.id, configuredBy: dest.updated_by || dest.created_by || null,
          ...(confirmation.unconfirmed ? { unconfirmed: confirmation.unconfirmed } : {}),
          ...(grace ? { grace } : {}),
        },
      }).catch((e) => ({ ok: false, notified: 0, error: (e as Error).message }));
      if (!alert.ok) console.error(`[run-scheduled] destination ${dest.id}: the export alert was not sent: ${alert.error}`);
      // BKP-6: a retention purge that did not finish is said on the run row and the card.
      const retentionNote = retentionProblem(result.retention);
      // P14 fix pass: cut so the unconfirmed note (the night that pauses it
      // says so, which pausedAtLastRun reads) survives, as on the failure path.
      const cardNote = retentionNote && unconfirmedNote
        ? `${retentionNote.slice(0, Math.max(0, 500 - unconfirmedNote.length - 1))} ${unconfirmedNote}`
        : (retentionNote || unconfirmedNote || null);
      const completedAt = new Date().toISOString();
      const unrecorded: string[] = [];
      {
        // BKP-6 Done-when 3: the purge's deleted and failed counts on the run
        // row's own columns (20261172); before that paste the row closes as
        // it always did, the counts in its diagnostics (closeSucceededRun).
        const { error: runUpdErr } = await closeSucceededRun(sb, runId, {
          status: "succeeded",
          table_count: result.tableCount,
          total_rows: result.totalRows,
          file_count: result.fileCount,
          total_bytes: result.bytes,
          destination_path: result.destinationPath ?? null,
          destination_type: dest.destination_type,
          diagnostics: [
            ...gate.notices.map((n) => ({ ts: startedAt, step: "gate:notice", detail: n })),
            ...(confirmation.notice ? [{ ts: startedAt, step: "gate:notice", detail: confirmation.notice }] : []),
            ...(unconfirmedNote ? [{ ts: startedAt, step: "gate:unconfirmed", detail: unconfirmedNote }] : []),
            ...(graceStep ? [graceStep] : []),
            ...graceNotes.map((n) => ({ ts: startedAt, step: "gate:notice", detail: n })),
            ...result.diagnostics,
            ...(alert.ok ? [] : [{ ts: completedAt, step: "alert:unsent", detail: alert.error }]),
          ],
          ...(retentionNote ? { error_message: retentionNote.slice(0, 1000) } : {}),
          completed_at: completedAt,
          duration_ms: Date.parse(completedAt) - Date.parse(startedAt),
        }, result.retention);
        if (runUpdErr) unrecorded.push(`run row not updated: ${runUpdErr.message}`);
      }
      const { error: destUpdErr } = await sb.from("export_destinations").update({
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
      for (const u of unrecorded) console.error(`[run-scheduled] destination ${dest.id}: ${u}`);
      const warnings = [...notices, ...(alert.ok ? [] : [`the export alert was not sent: ${alert.error}`]), ...unrecorded];

      results.push({
        destinationId: dest.id, ok: true, bytes: result.bytes,
        ...(warnings.length ? { warnings } : {}),
      });
    } catch (e) {
      const completedAt = new Date().toISOString();
      const msg = (e as Error).message || String(e);
      // DEC-87 §1: a failed push of an unconfirmed destination still
      // asks for confirmation — on the run row, after the failure on the card
      // (cut so the sentence survives), and on the sweep result.
      const cardError = unconfirmedNote
        ? `${msg.slice(0, Math.max(0, 500 - unconfirmedNote.length - 1))} ${unconfirmedNote}`.slice(0, 500)
        : msg.slice(0, 500);
      // DEC-87 §1 as amended (P14): a night of the bounded grace is a bell
      // even when its push failed — every night before the pause, and the
      // pause itself, reach every Admin. It says nothing left only when the
      // push failed before the archive was sent; once its transmission began
      // (a webhook's 500 comes after the whole ZIP reached it) it says the
      // destination may hold it (P14 fix pass). A confirmed destination's
      // failed push rings no bell, as before.
      const sent = delivered || pushTransmissionBegan(e);
      const graceAlert = grace && confirmation.unconfirmed
        ? await alertAdminsOfExport(sb, {
          orgId: dest.org_id, actorUserId: null, actorEmail: SCHEDULED_EXPORT_ACTOR.email,
          destination: dest.destination_type,
          scheduled: {
            destinationName: dest.name || dest.id, configuredBy: dest.updated_by || dest.created_by || null,
            unconfirmed: confirmation.unconfirmed, grace, failed: msg, ...(sent ? { failedAfterSend: true } : {}),
          },
        }).catch((err) => ({ ok: false, notified: 0, error: (err as Error).message }))
        : null;
      if (graceAlert && !graceAlert.ok) console.error(`[run-scheduled] destination ${dest.id}: the unconfirmed-night alert was not sent: ${graceAlert.error}`);
      // Checked like the success path: a refused write is logged and named on
      // the result, never swallowed (a run row left "running" stays stuck).
      const unrecorded: string[] = [];
      {
        const { error: runUpdErr } = await sb.from("export_runs").update({
          status: "failed",
          error_message: msg.slice(0, 1000),
          ...(notices.length ? {
            diagnostics: [
              ...gate.notices.map((n) => ({ ts: startedAt, step: "gate:notice", detail: n })),
              ...(confirmation.notice ? [{ ts: startedAt, step: "gate:notice", detail: confirmation.notice }] : []),
              ...(unconfirmedNote ? [{ ts: startedAt, step: "gate:unconfirmed", detail: unconfirmedNote }] : []),
              ...(graceStep ? [graceStep] : []),
              ...graceNotes.map((n) => ({ ts: startedAt, step: "gate:notice", detail: n })),
              ...(graceAlert && !graceAlert.ok ? [{ ts: completedAt, step: "alert:unsent", detail: graceAlert.error }] : []),
            ],
          } : {}),
          completed_at: completedAt,
          duration_ms: Date.parse(completedAt) - Date.parse(startedAt),
        }).eq("id", runId);
        if (runUpdErr) unrecorded.push(`run row not updated: ${runUpdErr.message}`);
      }
      const { error: destUpdErr } = await sb.from("export_destinations").update({
        last_run_at: completedAt,
        last_run_status: "failed",
        last_run_error: cardError,
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
      if (destUpdErr) unrecorded.push(`last-run status not recorded: ${destUpdErr.message}`);
      for (const u of unrecorded) console.error(`[run-scheduled] destination ${dest.id}: ${u}`);
      const failWarnings = [...notices, ...(graceAlert && !graceAlert.ok ? [`the unconfirmed-night alert was not sent: ${graceAlert.error}`] : [])];
      results.push({
        destinationId: dest.id, ok: false, error: [msg, ...(unconfirmedNote ? [unconfirmedNote] : []), ...unrecorded].join("; "),
        ...(failWarnings.length ? { warnings: failWarnings } : {}),
      });
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
