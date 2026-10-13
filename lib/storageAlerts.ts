// lib/storageAlerts.ts
//
// Real watermark alerting: compare a workspace's measured storage against the
// quota its admins set and notify them when it crosses a threshold. The band
// math is pure and unit-tested; runStorageAlerts wires it to the bucket and
// the DB from the daily cron. The quota is ADVISORY (admin-and-org BILL-11):
// nothing refuses an upload at it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyChecked, type NotificationInput } from "@/lib/inAppNotifications";

export type AlertBand = "ok" | "warn" | "crit";

/**
 * Write one bell row through notify()'s typed insert (notifyChecked), so the
 * kind is a NotificationKind the registry classifies (PROD-10 / TAX-11: the
 * two storage watchdogs inserted raw rows whose kinds no union declared),
 * under the watchdog's own service-role client for this call only
 * (lib/serverClientScope, the intake door's pattern). The cron runs these
 * steps outside its module-wide client swap, so without the binding the
 * insert would go out as the anonymous client and be refused. Resolves true
 * when the row was written. Imported lazily: alertBand's importers (the
 * storage-stats route) do not need node:async_hooks.
 */
export async function notifyAsServiceRole(sb: SupabaseClient, input: NotificationInput): Promise<boolean> {
  const { runWithServerClient } = await import("@/lib/serverClientScope");
  return runWithServerClient(sb, () => notifyChecked(input));
}

/** Usage→band against a real quota. warn at 70%, crit at 90%. */
export function alertBand(usedBytes: number, quotaBytes: number): { pct: number; band: AlertBand } {
  if (!(quotaBytes > 0)) return { pct: 0, band: "ok" };
  const pct = Math.round((usedBytes / quotaBytes) * 100);
  const band: AlertBand = pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok";
  return { pct, band };
}

/** The cron's time budget for measuring every quota'd workspace (BILL-13). */
export const QUOTA_WALK_BUDGET_MS = 45_000;

/** The order the quota'd workspaces are walked in on `dayIndex` (days since
 *  the epoch): by org id, rotated one place a day, so the workspace walked
 *  first — the one with the most of the shared budget — changes daily and a
 *  large workspace cannot stand in front of the same others every night. */
export function quotaWalkOrder<T extends { org_id: string }>(rows: readonly T[], dayIndex: number): T[] {
  const sorted = [...rows].sort((a, b) => (a.org_id < b.org_id ? -1 : a.org_id > b.org_id ? 1 : 0));
  if (sorted.length === 0) return sorted;
  const start = ((Math.floor(dayIndex) % sorted.length) + sorted.length) % sorted.length;
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

/** One workspace's walk deadline: an equal share of the time left among the
 *  workspaces still to walk (`remainingWalks`, this one included), never past
 *  the shared deadline. Time a small workspace does not use rolls forward. */
export function fairShareDeadline(now: number, sharedDeadlineMs: number, remainingWalks: number): number {
  const left = sharedDeadlineMs - now;
  if (left <= 0 || remainingWalks <= 1) return sharedDeadlineMs;
  return now + Math.floor(left / remainingWalks);
}

const fmtSize = (bytes: number) => {
  const GiB = 1024 ** 3;
  return bytes >= GiB ? `${(bytes / GiB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
};

/**
 * Check every org that has set a quota and drop an in-app notification to its
 * admins when usage is high. Deduped: an admin won't be re-alerted within 7
 * days.
 *
 * Fix pass (BILL-12 / BILL-13): the walks share one budget, but no workspace
 * can take it all. Each walk gets an equal share of the time left
 * (fairShareDeadline), and the order rotates daily (quotaWalkOrder), so a
 * large workspace early in the list no longer leaves every later one
 * unmeasured night after night. The `unmeasured` count is logged here and
 * the maintenance cron adds it to its errors, so it reaches an operator.
 *
 * admin-and-org BILL-12 (Round G, P6): each workspace is measured under its
 * OWN key prefix (orgs/<id>/ — a real bucket walk, lib/storageUsage.ts
 * measureR2Usage) and compared to its own quota. It used to compare one
 * deployment-wide figure (every tenant's database tables plus every tenant's
 * revisions and photos) to each org's quota, so another tenant's upload put
 * your workspace into "critical". The quota is for the workspace's FILES: the
 * database is one shared Postgres, watched against its plan ceiling by the
 * platform watchdog. BILL-11: the quota is advisory — nothing refuses an
 * upload at it — and the copy says so. The walks share one time budget; a
 * workspace measured only partly is alerted only when its floor already
 * crosses a band ("at least N%"), and one not measured in time is counted
 * in `unmeasured`, never reported as fine.
 */
export async function runStorageAlerts(sb: SupabaseClient, opts: { budgetMs?: number } = {}): Promise<{
  alerts: number; orgsChecked: number; unmeasured: number;
}> {
  // Lazy: storageUsage imports this module (alertBand), and the bucket client
  // it carries is needed only here.
  const { measureR2Usage, orgStoragePrefix, soleTenantId, loadPlatformLimits, r2PlanBand } = await import("@/lib/storageUsage");
  const deadlineMs = Date.now() + (opts.budgetMs ?? QUOTA_WALK_BUDGET_MS);

  const { data: settings } = await sb
    .from("archive_settings")
    .select("org_id, quota_bytes")
    .not("quota_bytes", "is", null);

  let alerts = 0, orgsChecked = 0, unmeasured = 0;
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const utcDayStart = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString();
  const quotaRows = ((settings as Array<{ org_id: string; quota_bytes: number | null }> | null) ?? [])
    .filter((r) => (Number(r.quota_bytes) || 0) > 0);
  const order = quotaWalkOrder(quotaRows, Math.floor(Date.now() / 86_400_000));
  // BILL-15 (DEC-99 §3): on a single-workspace server this workspace's files
  // are nearly the whole bucket, and the platform R2 alert (the cron's later
  // step, lib/storageUsage.ts runPlatformStorageAlerts) goes to the same
  // Admin / DocCtrl. There the walk covers the whole bucket once (the
  // workspace's own total measured in the same pass), and the bell states
  // both figures, each with what it measured and against which limit; the
  // R2 step counts it as its own bell. A shared server walks the prefix and
  // keeps the two alerts apart (they reach different people). Unreadable
  // orgs: not sole, as before.
  const soleOrg = order.length > 0 ? await soleTenantId(sb) : null;
  for (let i = 0; i < order.length; i++) {
    const s = order[i];
    const quota = Number(s.quota_bytes) || 0;
    const sole = soleOrg !== null && s.org_id === soleOrg;
    let usage: Awaited<ReturnType<typeof measureR2Usage>>;
    try {
      const deadline = fairShareDeadline(Date.now(), deadlineMs, order.length - i);
      usage = await measureR2Usage(sole
        ? { orgTotalFor: s.org_id, deadlineMs: deadline }
        : { prefix: orgStoragePrefix(s.org_id), deadlineMs: deadline });
    } catch {
      unmeasured++;
      continue;
    }
    // The workspace's own files: the prefix walk's total, or (sole) its
    // total within the whole-bucket walk.
    const files = sole ? (usage.org ?? { bytes: 0, objects: 0 }) : usage;
    if (usage.truncated && files.objects === 0) { unmeasured++; continue; }
    orgsChecked++;
    const { pct, band } = alertBand(files.bytes, quota);
    if (band === "ok") {
      // A partial walk below 70% says nothing about the real total.
      if (usage.truncated) unmeasured++;
      continue;
    }
    const atLeast = usage.truncated ? "at least " : "";
    // Sole: the whole bucket against the R2 plan ceiling, banded exactly as
    // the platform watchdog bands it (a partial walk is never below warn).
    let plan: { pct: number; band: AlertBand; bytes: number; limitBytes: number } | null = null;
    if (sole) {
      const limits = await loadPlatformLimits(sb);
      plan = { ...r2PlanBand(usage.bytes, usage.truncated, limits.r2Bytes), bytes: usage.bytes, limitBytes: limits.r2Bytes };
    }
    const crit = band === "crit" || plan?.band === "crit";

    const { data: admins } = await sb
      .from("org_members").select("uid")
      .eq("org_id", s.org_id).eq("status", "active").or("role.in.(Admin,DocCtrl),roles.ov.{Admin,DocCtrl}");
    for (const a of (admins as Array<{ uid: string }> | null) ?? []) {
      const { count } = await sb
        .from("notifications").select("id", { count: "exact", head: true })
        .eq("org_id", s.org_id).eq("user_id", a.uid).eq("kind", "storage_alert").gte("created_at", sevenDaysAgo);
      if ((count ?? 0) > 0) continue;
      if (plan) {
        // BILL-15, the shared per-day key: a person the R2 step already
        // belled with the plan's figure TODAY (UTC; a second cron run the
        // same day) is not sent a second percentage for the same files now.
        // The next day's run sends this bell, stating both figures.
        const { count: planToday } = await sb
          .from("notifications").select("id", { count: "exact", head: true })
          .eq("org_id", s.org_id).eq("user_id", a.uid).eq("kind", "storage_platform_r2").gte("created_at", utcDayStart);
        if ((planToday ?? 0) > 0) continue;
      }
      // BILL-15: on a sole server one bell, both figures, each named by what
      // it measured and against which limit. metadata.r2PlanBand is what the
      // R2 step reads to count this as its bell (a server-only kind: no
      // browser can write a row of it).
      const copy: { title: string; body: string; metadata?: Record<string, unknown> } = plan
        ? {
          title: `Storage ${crit ? "critical" : "high"} — ${atLeast}${pct}% of the set limit, ${atLeast}${plan.pct}% of plan`,
          body:
            `This workspace's files are at ${atLeast}${pct}% of the storage limit an admin set ` +
            `(${atLeast}${fmtSize(files.bytes)} of ${fmtSize(quota)}, measured under this workspace only), ` +
            `and the server's file storage is at ${atLeast}${plan.pct}% of its Cloudflare R2 plan ceiling ` +
            `(${atLeast}${fmtSize(plan.bytes)} of ${fmtSize(plan.limitBytes)}, every file on the server; this is its only workspace). ` +
            "The limit is advisory: uploads are not blocked when it is reached. This app does not stop uploads at the plan ceiling " +
            "either: past it, Cloudflare bills the overage, or refuses writes on an account without billing. " +
            (plan.band !== "ok" ? "Upgrade the R2 plan, or take" : "Take") +
            " a full backup and free up space from Admin → Storage (archive superseded revisions or closed tickets, delete orphaned files).",
          metadata: { r2PlanBand: plan.band, r2PlanPct: plan.pct },
        }
        : {
          title: band === "crit" ? `Storage critical — ${atLeast}${pct}% full` : `Storage high — ${atLeast}${pct}% full`,
          body:
            `This workspace's files are at ${atLeast}${pct}% of the storage limit an admin set ` +
            `(${atLeast}${fmtSize(files.bytes)} of ${fmtSize(quota)}, measured under this workspace only). ` +
            "The limit is advisory: uploads are not blocked when it is reached. " +
            // Only what lowers THIS figure (the workspace's files): purging
            // database rows frees database space, which the quota does not count.
            "Take a full backup and free up space from Admin → Storage (archive superseded revisions or closed tickets, delete orphaned files).",
        };
      const sent = await notifyAsServiceRole(sb, {
        orgId: s.org_id, userId: a.uid, kind: "storage_alert",
        title: copy.title, body: copy.body, metadata: copy.metadata,
        link: "/admin/storage",
      });
      // Counted only when the row landed (notify() logs a refusal) — the
      // cron's storageAlerts figure used to count attempts.
      if (sent) alerts++;
    }
  }
  if (unmeasured > 0) {
    console.warn(
      `[storage-alerts] ${unmeasured} of ${order.length} workspace(s) with a storage limit were not measured in time ` +
      "(or only partly, below 70%); none was reported fine. The walk order rotates daily.",
    );
  }
  return { alerts, orgsChecked, unmeasured };
}
