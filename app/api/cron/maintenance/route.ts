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
import { __setServerSupabaseClient, __resetServerSupabaseClient } from "@/lib/supabase";
import { scanAndNotifyReviews } from "@/lib/reviewCycles";
import { scanAndNotifyAcks } from "@/lib/acknowledgments";
import { scanReviews } from "@/lib/reviewControl";
import { scanEffectiveDates } from "@/lib/effectiveDate";
import { scanRetention } from "@/lib/retention";
import { scanAccessRecerts } from "@/lib/accessRecert";
import { scanDistributionAcks } from "@/lib/distributionAcks";
import { syncAllKnowledgeSources } from "@/lib/knowledgeSourceSync";
import { drainKnowledgeIngestQueue } from "@/lib/knowledgeIngest";
import { runPlatformStorageAlerts } from "@/lib/storageUsage";

export const runtime = "nodejs";
export const maxDuration = 300;

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
    complianceNotices: number;
    complianceOrgs: number;
    complianceEmails: number;
    remindersSent: number | null;
    knowledgeSync?: { libraries: number; added: number; refreshed: number; removed: number };
    knowledgeIngest?: { docs: number; pages: number; completed: number };
    platformStorage?: { r2Pct: number; dbPct: number; alerts: number };
    errors: string[];
  } = {
    releasedCheckouts: 0,
    notificationsDrained: null,
    storageAlerts: 0,
    prunedIntents: 0,
    staleEscalations: 0,
    complianceNotices: 0,
    complianceOrgs: 0,
    complianceEmails: 0,
    remindersSent: null,
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
  //    LOOP until the queue is empty (bounded): the batch cap exists to bound
  //    one request, not the day — a 400-email fan-out must not take 16 days.
  try {
    const origin = req.nextUrl.origin;
    let drained = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${origin}/api/notifications/send-queued`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cronSecret}` },
      });
      if (!res.ok) { result.errors.push(`notifications: HTTP ${res.status}`); break; }
      const body = (await res.json().catch(() => null)) as { sent?: number; processed?: number } | null;
      const batch = body?.sent ?? body?.processed ?? 0;
      drained += batch;
      if (batch === 0) break; // queue empty
    }
    result.notificationsDrained = drained;
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

  // 6. COMPLIANCE CLOCKS — review cycles, read-&-understood nags, pre-publish
  //    review nudges + alternate activation, effective-date arrivals,
  //    retention flags, access recerts, distribution-ack nags. These scans
  //    are written against the shared lib client; swap it to the service
  //    role for this lambda so they run with full visibility (not one
  //    controller's RLS slice) and run on a real clock instead of whenever
  //    a controller happens to open a browser tab.
  try {
    __setServerSupabaseClient(sb);
    const { data: orgRows, error: orgErr } = await sb.from("orgs").select("id");
    if (orgErr) throw new Error(orgErr.message);
    const scans: Array<[string, (orgId: string) => Promise<number>]> = [
      ["review-cycles", scanAndNotifyReviews],
      ["read-understood", scanAndNotifyAcks],
      ["pre-publish-review", scanReviews],
      ["effective-dates", scanEffectiveDates],
      ["retention", scanRetention],
      ["access-recert", scanAccessRecerts],
      ["distribution-acks", scanDistributionAcks],
    ];
    for (const org of (orgRows as Array<{ id: string }>) ?? []) {
      result.complianceOrgs += 1;
      for (const [name, fn] of scans) {
        try {
          result.complianceNotices += await fn(org.id);
        } catch (e) {
          // Loud, per-scan, per-org — a permanently failing scan must be
          // distinguishable from a clean one.
          result.errors.push(`${name}@${org.id}: ${(e as Error).message}`);
        }
      }
    }
  } catch (e) {
    result.errors.push(`compliance: ${(e as Error).message}`);
  } finally {
    // Never leave the shared client bound to the service role — on a
    // long-lived self-hosted process the swap would otherwise outlive this
    // request and leak into anything else importing @/lib/supabase.
    __resetServerSupabaseClient();
  }

  // 6b. COMPLIANCE EMAIL DIGEST — the bell alone is not an escalation
  //     channel: an obligation that never leaves the app dies with an unread
  //     badge. One email per user per day summarizing their NEW compliance
  //     notices (reviews due, acks outstanding, retention flags, recerts,
  //     effective dates, reviewer nudges). Queued into email_notifications;
  //     the drain below sends it.
  try {
    result.complianceEmails = await queueComplianceDigests(sb);
  } catch (e) {
    result.errors.push(`compliance-digest: ${(e as Error).message}`);
  }

  // 6c. Drain anything the compliance steps just queued (step 2 ran before
  //     they existed in this request).
  try {
    const origin = req.nextUrl.origin;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${origin}/api/notifications/send-queued`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cronSecret}` },
      });
      if (!res.ok) break;
      const body = (await res.json().catch(() => null)) as { sent?: number; processed?: number } | null;
      if ((body?.sent ?? body?.processed ?? 0) === 0) break;
    }
  } catch { /* the daily drain will catch up */ }

  // 7. Push reminders — the reminders route was documented as scheduled but
  //    never was; drive it from here so it actually runs (its own route
  //    handles VAPID config detection and per-user throttling).
  try {
    const origin = req.nextUrl.origin;
    const res = await fetch(`${origin}/api/reminders/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
    });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { sent?: number } | null;
      result.remindersSent = body?.sent ?? 0;
    } else {
      result.errors.push(`reminders: HTTP ${res.status}`);
    }
  } catch (e) {
    result.errors.push(`reminders: ${(e as Error).message}`);
  }

  // 8. KNOWLEDGE SOURCES — the live-subscription heartbeat. Reconcile every
  //    knowledge library against its document-control sources (newly filed
  //    docs appear, rev-ups go stale, removed/archived docs drop out), then
  //    drain the ingest queue so linked documents index in the background
  //    without anyone babysitting a browser tab. Bounded by pages + a
  //    deadline so this step can't eat the whole invocation. No-op on a
  //    pre-20260917 DB.
  try {
    const sync = await syncAllKnowledgeSources();
    result.knowledgeSync = {
      libraries: sync.libraries, added: sync.added,
      refreshed: sync.refreshed, removed: sync.removed,
    };
    if (sync.errors.length) {
      result.errors.push(...sync.errors.slice(0, 5).map((m) => `knowledge-sync: ${m}`));
    }
  } catch (e) {
    result.errors.push(`knowledge-sync: ${(e as Error).message}`);
  }
  try {
    const drained = await drainKnowledgeIngestQueue({
      maxPages: 400,
      deadlineMs: Date.now() + 120_000,
    });
    result.knowledgeIngest = {
      docs: drained.docsTouched, pages: drained.pagesIndexed, completed: drained.completed,
    };
    if (drained.errors.length) {
      result.errors.push(...drained.errors.slice(0, 5).map((m) => `knowledge-ingest: ${m}`));
    }
  } catch (e) {
    result.errors.push(`knowledge-ingest: ${(e as Error).message}`);
  }

  // 9. PLATFORM STORAGE WATCHDOG — real measurements (walk the R2 bucket,
  //    exact DB relation sizes) against the plan ceilings (free tiers by
  //    default). Admins get an in-app notification at 70%/90%, deduped to
  //    one per person per resource per week — "upgrade before it breaks",
  //    not "why did uploads stop".
  try {
    const { status, alerts } = await runPlatformStorageAlerts(sb);
    result.platformStorage = { r2Pct: status.r2.pct, dbPct: status.db.pct, alerts };
  } catch (e) {
    result.errors.push(`platform-storage: ${(e as Error).message}`);
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

const COMPLIANCE_KINDS = [
  "review_due", "owner_behind",
  "ack_requested", "ack_overdue", "ack_unsatisfiable",
  "retention_eligible", "access_recert_due", "effective_now",
  "review_requested", "review_overdue", "review_complete",
  "review_alternate_activated", "deletion_requested",
  // Manual distribution-ack requests/re-nudges ride on doc_superseded (the
  // daily scan's nags use ack_requested/ack_overdue); voided sign-offs are
  // obligations too.
  "doc_superseded", "review_invalidated",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function queueComplianceDigests(sb: SupabaseClient<any>): Promise<number> {
  const since = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const { data: rows, error } = await sb
    .from("notifications")
    .select("org_id, user_id, kind, title, link")
    .in("kind", COMPLIANCE_KINDS)
    .gt("created_at", since)
    .limit(2000);
  if (error || !rows?.length) return 0;

  // One digest per (org, user).
  const byUser = new Map<string, { orgId: string; userId: string; titles: string[] }>();
  for (const r of rows as Array<{ org_id: string; user_id: string; title: string }>) {
    const key = `${r.org_id}:${r.user_id}`;
    const e = byUser.get(key) ?? { orgId: r.org_id, userId: r.user_id, titles: [] };
    e.titles.push(r.title);
    byUser.set(key, e);
  }

  const userIds = [...new Set([...byUser.values()].map((e) => e.userId))];
  const { data: members } = await sb
    .from("org_members").select("uid, org_id, email").in("uid", userIds).eq("status", "active");
  const emailOf = new Map(((members as Array<{ uid: string; org_id: string; email: string | null }>) ?? [])
    .map((m) => [`${m.org_id}:${m.uid}`, m.email]));

  // Respect the user's email opt-out.
  const { data: prefs } = await sb
    .from("notification_preferences").select("user_id, email_enabled").in("user_id", userIds);
  const emailEnabled = new Map(((prefs as Array<{ user_id: string; email_enabled: boolean | null }>) ?? [])
    .map((p) => [p.user_id, p.email_enabled !== false]));

  let queued = 0;
  for (const e of byUser.values()) {
    const to = emailOf.get(`${e.orgId}:${e.userId}`);
    if (!to) continue;
    if (emailEnabled.get(e.userId) === false) continue;
    // Dedupe: one digest per (org, user) per day (metadata-marked).
    const dayKey = new Date().toISOString().slice(0, 10);
    const { data: existing } = await sb
      .from("email_notifications").select("id")
      .eq("org_id", e.orgId)
      .eq("to_user_id", e.userId)
      .eq("event_type", "compliance_digest")
      .contains("metadata", { day: dayKey })
      .limit(1);
    if ((existing as unknown[] | null)?.length) continue;

    const unique = [...new Set(e.titles)].slice(0, 12);
    const more = e.titles.length - unique.length;
    await sb.from("email_notifications").insert({
      org_id: e.orgId,
      to_user_id: e.userId,
      to_email: to,
      subject: `Compliance items need you (${e.titles.length})`,
      body_text:
        "These document-control items are waiting on you:\n\n" +
        unique.map((t) => `  • ${t}`).join("\n") +
        (more > 0 ? `\n  …and ${more} more` : "") +
        "\n\nOpen your Inbox to act on them.",
      event_type: "compliance_digest",
      metadata: { day: dayKey, count: e.titles.length },
      status: "queued",
    });
    queued += 1;
  }
  return queued;
}

export async function POST(req: NextRequest) { return handler(req); }
export async function GET(req: NextRequest) { return handler(req); }
