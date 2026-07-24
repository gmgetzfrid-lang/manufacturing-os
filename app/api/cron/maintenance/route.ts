// GET/POST /api/cron/maintenance
//
// Housekeeping cron — scheduled DAILY at 03:00 UTC (vercel.json). The
// /checkouts page also runs the checkout sweep opportunistically on load,
// so in practice expiry enforcement is "daily at worst, page-visit at best".
// Runs the time-based enforcement that the rest of the app assumes happens
// on a clock rather than only on a page visit:
//
//   1. Auto-release ad-hoc checkouts past their cap, ACROSS ALL ORGS.
//      (A lock must not depend on someone happening to open /checkouts.)
//   2. Drain the queued email_notifications queue as a safety net, in case
//      the fire-and-forget client kick failed.
//   3. Storage watermark alerts.
//   4. Prune expired document_intents rows (the ambient work-in-progress
//      layer decays by design — expired rows are noise).
//   5. Stale-checkout escalation: checkouts held past 14 days notify the
//      org's DocCtrl/Admin pool (a stale lock stops being the holder's
//      private secret).
//
// Auth: server-to-server. If CRON_SECRET is set, require it as a Bearer
// token. Degrades gracefully if optional env vars are missing.

import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { autoReleaseExpiredAdHoc } from "@/lib/projects";
import { runStorageAlerts } from "@/lib/storageAlerts";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const cronSecret = process.env.CRON_SECRET || "";

async function handler(req: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: "Supabase credentials missing" }, { status: 500 });
  }
  // Fail closed: reject unless the caller presents CRON_SECRET. Vercel
  // attaches it automatically to the scheduled invocation; if the secret is
  // somehow unset, deny rather than run world-open.
  const auth = req.headers.get("authorization") || "";
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const result: {
    releasedCheckouts: number;
    notificationsDrained: number | null;
    storageAlerts: number;
    prunedIntents: number;
    staleEscalations: number;
    errors: string[];
  } = {
    releasedCheckouts: 0,
    notificationsDrained: null,
    storageAlerts: 0,
    prunedIntents: 0,
    staleEscalations: 0,
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
    const res = await fetch(`${origin}/api/notifications/send-queued`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
    });
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

  // 4. Prune expired intents (decayed ambient signal). No-op pre-migration.
  try {
    const { data, error } = await sb
      .from("document_intents")
      .delete()
      .lt("expires_at", new Date().toISOString())
      .select("id");
    if (!error) result.prunedIntents = ((data as unknown[]) ?? []).length;
  } catch (e) {
    result.errors.push(`intent-prune: ${(e as Error).message}`);
  }

  // 5. Stale-checkout escalation. Sessions active for 14+ days notify the
  //    org's DocCtrl/Admin pool — once per session (metadata-deduped by the
  //    session id in the notification row we insert).
  try {
    result.staleEscalations = await escalateStaleCheckouts(sb);
  } catch (e) {
    result.errors.push(`stale-escalation: ${(e as Error).message}`);
  }

  return NextResponse.json(result);
}

const STALE_ESCALATION_DAYS = 14;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function escalateStaleCheckouts(sb: SupabaseClient<any>): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_ESCALATION_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: staleRows, error } = await sb
    .from("checkout_sessions")
    .select("id, org_id, document_id, library_id, user_id, user_name, started_at, purpose")
    .eq("status", "active")
    .lt("started_at", cutoff);
  if (error || !staleRows?.length) return 0;

  let escalated = 0;
  for (const row of staleRows as Array<{
    id: string; org_id: string; document_id: string; library_id: string | null;
    user_id: string; user_name: string | null; started_at: string; purpose: string | null;
  }>) {
    // Dedupe: skip if we've already escalated this session.
    const { data: existing } = await sb
      .from("notifications")
      .select("id")
      .eq("kind", "checkout_released")
      .contains("metadata", { staleSessionId: row.id })
      .limit(1);
    if ((existing as unknown[] | null)?.length) continue;

    const { data: controllers } = await sb
      .from("org_members")
      .select("uid")
      .eq("org_id", row.org_id)
      .eq("status", "active")
      .in("role", ["Admin", "DocCtrl"]);
    const recipients = ((controllers as Array<{ uid: string }> | null) ?? [])
      .map((c) => c.uid)
      .filter((uid) => uid !== row.user_id);
    if (recipients.length === 0) continue;

    const days = Math.floor((Date.now() - Date.parse(row.started_at)) / (24 * 3600 * 1000));
    const inserts = recipients.map((uid) => ({
      org_id: row.org_id,
      user_id: uid,
      kind: "checkout_released",
      title: `Checkout held ${days} days — review needed`,
      body: `${row.user_name || "A user"} has had a document checked out since ${new Date(row.started_at).toLocaleDateString()}${row.purpose ? ` (${row.purpose})` : ""}. Nudge them or force-release if the work is done.`,
      link: row.library_id ? `/documents/${row.library_id}?doc=${row.document_id}` : "/checkouts",
      resource_type: "document",
      resource_id: row.document_id,
      actor_name: "System",
      metadata: { staleSessionId: row.id, escalation: true },
    }));
    const { error: insErr } = await sb.from("notifications").insert(inserts);
    if (!insErr) escalated += 1;
  }
  return escalated;
}

export async function POST(req: NextRequest) { return handler(req); }
export async function GET(req: NextRequest) { return handler(req); }
