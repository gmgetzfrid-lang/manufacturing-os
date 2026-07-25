// POST /api/notifications/send-queued
//
// Drains the email_notifications queue. Called fire-and-forget by client
// code after queueing an email, AND by a Vercel/Supabase cron schedule
// as a safety net.
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
  to_email: string;
  subject: string;
  body_text: string;
  body_html?: string | null;
  attempt_count?: number | null;
}

export async function POST(req: Request) {
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Supabase credentials missing" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // Authorize: this route uses the service-role key and drains the whole
  // queue, so it must not be world-callable. Accept either the shared
  // CRON_SECRET (internal cron + server-to-server callers) or a valid user
  // session (the in-app browser kick fired right after queueing an email).
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  let authorized = cronSecret !== "" && token === cronSecret;
  if (!authorized && token) {
    const { data: { user } } = await supabase.auth.getUser(token);
    authorized = !!user;
  }
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || "notifications@manufacturing-os.app";

  // Hard kill switch: if email isn't configured at all, mark every queued
  // row as 'suppressed' immediately. This keeps the queue clean (no failed
  // rows piling up, no retry storms, no log spam) while preserving the
  // audit record of what WOULD have been sent. When the operator later
  // sets RESEND_API_KEY, newly-queued rows flow normally; previously-
  // suppressed rows stay suppressed (terminal state — deliberately not sent).
  if (!resendKey) {
    const { count } = await supabase
      .from("email_notifications")
      .update({
        status: "suppressed",
        error_message: "Email sending not configured (RESEND_API_KEY not set)",
        last_attempted_at: new Date().toISOString(),
      }, { count: "exact" })
      .in("status", ["queued", "failed"]);
    return NextResponse.json({
      processed: 0,
      sent: 0,
      failed: 0,
      suppressed: count ?? 0,
      note: "RESEND_API_KEY is not set — emails suppressed (no delivery attempted). Set the env var to enable sending.",
    });
  }

  // Reclaim orphans: rows stranded in 'sending' by a previous run that crashed
  // between claiming and completing. 15 min is far longer than any real send,
  // so this never steals a row another run is actively processing.
  await supabase
    .from("email_notifications")
    .update({ status: "queued" })
    .eq("status", "sending")
    .lt("last_attempted_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());

  // Find candidate work.
  const { data: candidates, error: claimErr } = await supabase
    .from("email_notifications")
    .select("*")
    .in("status", ["queued", "failed"])
    .lt("attempt_count", MAX_ATTEMPTS)
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

  const queued = (claimed ?? []) as EmailNotificationRow[];
  if (queued.length === 0) return NextResponse.json({ processed: 0 });

  let sent = 0;
  let failed = 0;

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

  return NextResponse.json({ processed: queued.length, sent, failed });
}

export async function GET(req: Request) {
  // Allow GET so a cron service can ping us without changing method
  return POST(req);
}
