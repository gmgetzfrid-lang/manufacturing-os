// POST /api/notifications/send-queued
//
// Drains the email_notifications queue. Called fire-and-forget by client
// code after queueing an email (that kick drains only the caller's own
// workspaces), AND by a Vercel/Supabase cron schedule as a safety net.
// Each row goes only to a member of its workspace or to the recipient of
// that workspace's issued transmittal.
//
// Email delivery uses Resend (https://resend.com) — set RESEND_API_KEY +
// RESEND_FROM_EMAIL in your environment. If those aren't configured, rows
// stay queued (no errors logged at queue-write time; the sender just
// marks attempts as failed with a clear message).

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// A full batch is up to MAX_BATCH sequential-ish Resend round-trips — far
// beyond the platform's default ~10s function budget. Without this, the
// batch bump to 100 made every full drain time out at iteration 1.
export const maxDuration = 300;

// We use the service-role key here because this endpoint may be called
// without a user session (e.g. by a scheduled cron). RLS would block
// otherwise. Make sure SUPABASE_SERVICE_ROLE_KEY is set in env.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const cronSecret = process.env.CRON_SECRET || "";

// Per-request cap — bounds one invocation, not the day: the maintenance cron
// loops this route until the queue is empty.
const MAX_BATCH = 100;
const MAX_ATTEMPTS = 5;

interface EmailNotificationRow {
  id: string;
  org_id: string;
  to_email: string;
  subject: string;
  body_text: string;
  body_html?: string | null;
  attempt_count?: number | null;
  event_type?: string | null;
  resource_id?: string | null;
}

const norm = (e: string | null | undefined) => String(e ?? "").trim().toLowerCase();

export async function POST(req: Request) {
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Supabase credentials missing" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // Authorize: this route uses the service-role key, so it must not be
  // world-callable. Only the shared CRON_SECRET (the cron and the server
  // routes that queue mail) drains the WHOLE queue. A signed-in user's kick
  // (lib/notifications.ts kickEmailDrain, fired by the browser right after
  // it queues an email, and the admin settings probe) drains only rows of
  // workspaces that user is an active member of.
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const isCron = cronSecret !== "" && token === cronSecret;
  let scopeOrgIds: string[] | null = null;
  if (!isCron) {
    const user = token ? (await supabase.auth.getUser(token)).data.user : null;
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { data: mems } = await supabase
      .from("org_members").select("org_id")
      .eq("uid", user.id).eq("status", "active");
    scopeOrgIds = [...new Set(((mems ?? []) as Array<{ org_id: string | null }>)
      .map((m) => m.org_id).filter((id): id is string => !!id))];
    if (scopeOrgIds.length === 0) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || "notifications@manufacturing-os.app";

  // If email isn't configured, DEFER: leave rows queued untouched so the
  // entire backlog flows the moment the operator sets RESEND_API_KEY.
  // (An earlier version flipped them to a terminal 'suppressed' state,
  // which permanently destroyed every email queued before configuration —
  // deferral costs nothing since nothing retries without a drain call.)
  if (!resendKey) {
    let backlog = supabase
      .from("email_notifications")
      .select("id", { count: "exact", head: true })
      .in("status", ["queued", "failed"]);
    if (scopeOrgIds) backlog = backlog.in("org_id", scopeOrgIds);
    const { count } = await backlog;
    return NextResponse.json({
      processed: 0,
      sent: 0,
      failed: 0,
      deferred: count ?? 0,
      configured: false,
      note: "RESEND_API_KEY is not set - emails left queued (no delivery attempted). Set the env var and the backlog sends on the next drain.",
    });
  }

  // Recover rows the pre-deferral code destroyed: 'suppressed' was only ever
  // written by the old not-configured path, so with a key now present those
  // rows are the backlog the operator expected to send. Only the last 7 days —
  // older notifications are stale enough that a surprise blast hurts more
  // than the silence did.
  let recover = supabase
    .from("email_notifications")
    .update({ status: "queued", attempt_count: 0, error_message: null })
    .eq("status", "suppressed")
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  if (scopeOrgIds) recover = recover.in("org_id", scopeOrgIds);
  await recover;

  // Reclaim orphans: rows stranded in 'sending' by a previous run that crashed
  // between claiming and completing. 15 min is far longer than any real send,
  // so this never steals a row another run is actively processing.
  let reclaim = supabase
    .from("email_notifications")
    .update({ status: "queued" })
    .eq("status", "sending")
    .lt("last_attempted_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());
  if (scopeOrgIds) reclaim = reclaim.in("org_id", scopeOrgIds);
  await reclaim;

  // Find candidate work.
  let work = supabase
    .from("email_notifications")
    .select("*")
    .in("status", ["queued", "failed"])
    .lt("attempt_count", MAX_ATTEMPTS);
  if (scopeOrgIds) work = work.in("org_id", scopeOrgIds);
  const { data: candidates, error: claimErr } = await work
    .order("created_at", { ascending: true })
    .limit(MAX_BATCH);

  if (claimErr) return NextResponse.json({ error: claimErr.message }, { status: 500 });
  if (!candidates || candidates.length === 0) return NextResponse.json({ processed: 0 });

  // Atomically CLAIM: flip to 'sending' only for rows STILL queued/failed, and
  // .select() back exactly the rows THIS invocation won. A concurrent drain
  // that raced us to the same rows finds them already 'sending', so its guard
  // matches nothing and it returns an empty set — no email is ever sent twice.
  const candidateIds = candidates.map((r: EmailNotificationRow) => r.id);
  const { data: claimed } = await supabase
    .from("email_notifications")
    .update({ status: "sending", last_attempted_at: new Date().toISOString() })
    .in("id", candidateIds)
    .in("status", ["queued", "failed"])
    .select("*");

  const claimedRows = (claimed ?? []) as EmailNotificationRow[];
  if (claimedRows.length === 0) return NextResponse.json({ processed: 0 });

  // Recipient check: the queue takes inserts from the browser, so a row is
  // only sent to an active member of the row's own workspace, or, for the
  // one outside-the-org kind the app sends (an issued transmittal, queued by
  // lib/transmittals.ts), to that workspace's transmittal recipient.
  type TransmittalRow = { id: string; org_id: string; recipient_email: string | null; status: string | null };
  const orgIds = [...new Set(claimedRows.map((r) => r.org_id).filter(Boolean))];
  const emails = [...new Set(claimedRows.flatMap((r) => [String(r.to_email ?? "").trim(), norm(r.to_email)]).filter(Boolean))];
  const transmittalIds = [...new Set(claimedRows
    .filter((r) => r.event_type === "transmittal_issued" && r.resource_id)
    .map((r) => r.resource_id as string))];
  let memberRows: Array<{ org_id: string; email: string | null }> = [];
  let tRows: TransmittalRow[] = [];
  let checkErr: unknown = null;
  if (orgIds.length > 0 && emails.length > 0) {
    const { data, error } = await supabase.from("org_members").select("org_id, email")
      .in("org_id", orgIds).in("email", emails).eq("status", "active");
    if (error) checkErr = error;
    else memberRows = (data ?? []) as Array<{ org_id: string; email: string | null }>;
  }
  if (!checkErr && transmittalIds.length > 0) {
    const { data, error } = await supabase.from("transmittals")
      .select("id, org_id, recipient_email, status").in("id", transmittalIds);
    if (error) checkErr = error;
    else tRows = (data ?? []) as TransmittalRow[];
  }
  if (checkErr) {
    // Couldn't check: hand the rows back untouched for the next drain.
    await supabase.from("email_notifications").update({ status: "queued" })
      .in("id", claimedRows.map((r) => r.id)).eq("status", "sending");
    return NextResponse.json({ error: "Couldn't check the recipients. Try again." }, { status: 500 });
  }
  const memberKeys = new Set(memberRows.map((m) => `${m.org_id}|${norm(m.email)}`));
  const tById = new Map(tRows.map((t) => [t.id, t]));
  const allowed = (r: EmailNotificationRow): boolean => {
    if (memberKeys.has(`${r.org_id}|${norm(r.to_email)}`)) return true;
    if (r.event_type !== "transmittal_issued" || !r.resource_id) return false;
    const t = tById.get(r.resource_id);
    return !!t && t.org_id === r.org_id && (t.status === "issued" || t.status === "acknowledged")
      && !!norm(t.recipient_email) && norm(t.recipient_email) === norm(r.to_email);
  };
  const queued = claimedRows.filter(allowed);
  const refused = claimedRows.filter((r) => !allowed(r));
  if (refused.length > 0) {
    await supabase.from("email_notifications").update({
      status: "failed",
      attempt_count: MAX_ATTEMPTS,
      error_message: "Not sent: the recipient isn't a member of this workspace.",
    }).in("id", refused.map((r) => r.id));
  }

  let sent = 0;
  let failed = refused.length;

  // Small parallel chunks: 5-wide keeps a 100-row batch under ~30s without
  // slamming Resend's rate limit (a 429 lands in the failed/retry path, so
  // even a burst degrades to a later attempt, never a lost email).
  const sendOne = async (row: EmailNotificationRow) => {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: fromEmail,
          to: row.to_email,
          subject: row.subject,
          text: row.body_text,
          html: row.body_html || undefined,
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Resend ${resp.status}: ${errBody}`);
      }

      await supabase
        .from("email_notifications")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          attempt_count: (row.attempt_count || 0) + 1,
        })
        .eq("id", row.id);
      sent++;
    } catch (e) {
      failed++;
      const msg = (e as Error).message || String(e);
      await supabase
        .from("email_notifications")
        .update({
          status: (row.attempt_count || 0) + 1 >= MAX_ATTEMPTS ? "failed" : "queued",
          attempt_count: (row.attempt_count || 0) + 1,
          error_message: msg.slice(0, 500),
        })
        .eq("id", row.id);
    }
  };
  for (let i = 0; i < queued.length; i += 5) {
    await Promise.all(queued.slice(i, i + 5).map(sendOne));
  }

  return NextResponse.json({ processed: claimedRows.length, sent, failed });
}

export async function GET(req: Request) {
  // Allow GET so a cron service can ping us without changing method
  return POST(req);
}
