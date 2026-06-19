// GET/POST /api/reminders/run
//
// Scheduled reminder cron (every 6h via vercel.json). For each user with a
// push subscription, tallies their open scratchpad to-dos and, if anything is
// overdue / due today / aging — and they haven't been pinged in the last 6h —
// pushes one OS notification that lands even when the app is closed.
//
// Auth: server-to-server Bearer CRON_SECRET (when set), matching the other
// crons. Degrades gracefully: returns early if Web Push isn't configured.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isPushConfigured, sendToSubscription } from "@/lib/push";
import { computeUserReminder, reminderPayload } from "@/lib/reminders";

export const runtime = "nodejs";
export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const cronSecret = process.env.CRON_SECRET || "";

const MIN_GAP_MS = 6 * 60 * 60 * 1000; // never ping a user more than every 6h

interface SubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  last_reminded_at: string | null;
}

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
  if (!isPushConfigured()) {
    return NextResponse.json({ skipped: "push not configured (set VAPID keys)" });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data, error } = await admin
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth, last_reminded_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Group subscriptions by user so a user with two devices is throttled once.
  const byUser = new Map<string, SubRow[]>();
  for (const row of (data ?? []) as SubRow[]) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }

  const now = Date.now();
  let usersNotified = 0, sent = 0, pruned = 0, skipped = 0;

  for (const [userId, rows] of byUser) {
    const lastMax = Math.max(0, ...rows.map((r) => (r.last_reminded_at ? Date.parse(r.last_reminded_at) : 0)));
    if (now - lastMax < MIN_GAP_MS) { skipped += 1; continue; }

    const reminder = await computeUserReminder(admin, userId);
    const payload = reminderPayload(reminder);
    if (!payload) { skipped += 1; continue; }

    const liveEndpoints: string[] = [];
    for (const r of rows) {
      let alive = true;
      try { alive = await sendToSubscription(r, payload); }
      catch { alive = true; /* transient error — keep the subscription */ }
      if (alive) { sent += 1; liveEndpoints.push(r.endpoint); }
      else { await admin.from("push_subscriptions").delete().eq("id", r.id); pruned += 1; }
    }
    if (liveEndpoints.length > 0) {
      usersNotified += 1;
      await admin.from("push_subscriptions")
        .update({ last_reminded_at: new Date().toISOString() })
        .in("endpoint", liveEndpoints);
    }
  }

  return NextResponse.json({ usersNotified, sent, pruned, skipped });
}

export async function POST(req: NextRequest) { return handler(req); }
export async function GET(req: NextRequest) { return handler(req); }
