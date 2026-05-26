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

// We use the service-role key here because this endpoint may be called
// without a user session (e.g. by a scheduled cron). RLS would block
// otherwise. Make sure SUPABASE_SERVICE_ROLE_KEY is set in env.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const MAX_BATCH = 25;
const MAX_ATTEMPTS = 5;

export async function POST() {
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Supabase credentials missing" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // Claim a batch of work atomically by flipping queued -> sending
  const { data: queued, error: claimErr } = await supabase
    .from("email_notifications")
    .select("*")
    .in("status", ["queued", "failed"])
    .lt("attempt_count", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(MAX_BATCH);

  if (claimErr) return NextResponse.json({ error: claimErr.message }, { status: 500 });
  if (!queued || queued.length === 0) return NextResponse.json({ processed: 0 });

  const ids = queued.map((r: any) => r.id);
  await supabase
    .from("email_notifications")
    .update({ status: "sending", last_attempted_at: new Date().toISOString() })
    .in("id", ids);

  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || "notifications@manufacturing-os.app";

  let sent = 0;
  let failed = 0;

  for (const row of queued as any[]) {
    try {
      if (!resendKey) {
        throw new Error("RESEND_API_KEY not configured");
      }

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
  }

  return NextResponse.json({ processed: queued.length, sent, failed });
}

export async function GET() {
  // Allow GET so a cron service can ping us without changing method
  return POST();
}
