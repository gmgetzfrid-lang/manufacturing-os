// GET/POST /api/cron/maintenance
//
// Hourly housekeeping cron. Runs the time-based enforcement that the rest
// of the app assumes happens on a clock rather than opportunistically on a
// page visit:
//
//   1. Auto-release ad-hoc checkouts past their 24h cap, ACROSS ALL ORGS.
//      (The /checkouts page does this for one org on load, but a lock must
//      not depend on someone happening to open that page.)
//   2. Drain the queued email_notifications queue as a safety net, in case
//      the fire-and-forget client kick failed.
//
// Auth: server-to-server. If CRON_SECRET is set, require it as a Bearer
// token. Degrades gracefully if optional env vars are missing.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autoReleaseExpiredAdHoc } from "@/lib/projects";
import { runStorageAlerts } from "@/lib/storageAlerts";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const cronSecret = process.env.CRON_SECRET || "";

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

  const result: { releasedCheckouts: number; notificationsDrained: number | null; storageAlerts: number; errors: string[] } = {
    releasedCheckouts: 0,
    notificationsDrained: null,
    storageAlerts: 0,
    errors: [],
  };

  // 1. Sweep expired ad-hoc checkouts across every org (no orgId filter).
  try {
    result.releasedCheckouts = await autoReleaseExpiredAdHoc(null, { client: sb });
  } catch (e) {
    result.errors.push(`checkout-sweep: ${(e as Error).message}`);
  }

  // 2. Drain the notification queue (best-effort; the route handles its own
  //    Resend wiring + suppression). We call it in-process via fetch to the
  //    sibling route so the email-sending logic lives in one place.
  try {
    const origin = req.nextUrl.origin;
    const res = await fetch(`${origin}/api/notifications/send-queued`, { method: "POST" });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { sent?: number; processed?: number } | null;
      result.notificationsDrained = body?.sent ?? body?.processed ?? 0;
    } else {
      result.errors.push(`notifications: HTTP ${res.status}`);
    }
  } catch (e) {
    result.errors.push(`notifications: ${(e as Error).message}`);
  }

  // 3. Storage watermark alerts: notify admins of orgs over their set quota.
  try {
    const { alerts } = await runStorageAlerts(sb);
    result.storageAlerts = alerts;
  } catch (e) {
    result.errors.push(`storage-alerts: ${(e as Error).message}`);
  }

  return NextResponse.json(result);
}

export async function POST(req: NextRequest) { return handler(req); }
export async function GET(req: NextRequest) { return handler(req); }
