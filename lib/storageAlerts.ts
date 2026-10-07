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

const fmtSize = (bytes: number) => {
  const GiB = 1024 ** 3;
  return bytes >= GiB ? `${(bytes / GiB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
};

/**
 * Check every org that has set a quota and drop an in-app notification to its
 * admins when usage is high. Deduped: an admin won't be re-alerted within 7
 * days.
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
  const { measureR2Usage, orgStoragePrefix } = await import("@/lib/storageUsage");
  const deadlineMs = Date.now() + (opts.budgetMs ?? QUOTA_WALK_BUDGET_MS);

  const { data: settings } = await sb
    .from("archive_settings")
    .select("org_id, quota_bytes")
    .not("quota_bytes", "is", null);

  let alerts = 0, orgsChecked = 0, unmeasured = 0;
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  for (const s of (settings as Array<{ org_id: string; quota_bytes: number | null }> | null) ?? []) {
    const quota = Number(s.quota_bytes) || 0;
    if (!(quota > 0)) continue;
    let usage: Awaited<ReturnType<typeof measureR2Usage>>;
    try {
      usage = await measureR2Usage({ prefix: orgStoragePrefix(s.org_id), deadlineMs });
    } catch {
      unmeasured++;
      continue;
    }
    if (usage.truncated && usage.objects === 0) { unmeasured++; continue; }
    orgsChecked++;
    const { pct, band } = alertBand(usage.bytes, quota);
    if (band === "ok") {
      // A partial walk below 70% says nothing about the real total.
      if (usage.truncated) unmeasured++;
      continue;
    }
    const atLeast = usage.truncated ? "at least " : "";

    const { data: admins } = await sb
      .from("org_members").select("uid")
      .eq("org_id", s.org_id).eq("status", "active").or("role.in.(Admin,DocCtrl),roles.ov.{Admin,DocCtrl}");
    for (const a of (admins as Array<{ uid: string }> | null) ?? []) {
      const { count } = await sb
        .from("notifications").select("id", { count: "exact", head: true })
        .eq("org_id", s.org_id).eq("user_id", a.uid).eq("kind", "storage_alert").gte("created_at", sevenDaysAgo);
      if ((count ?? 0) > 0) continue;
      const sent = await notifyAsServiceRole(sb, {
        orgId: s.org_id, userId: a.uid, kind: "storage_alert",
        title: band === "crit" ? `Storage critical — ${atLeast}${pct}% full` : `Storage high — ${atLeast}${pct}% full`,
        body:
          `This workspace's files are at ${atLeast}${pct}% of the storage limit an admin set ` +
          `(${atLeast}${fmtSize(usage.bytes)} of ${fmtSize(quota)}, measured under this workspace only). ` +
          "The limit is advisory: uploads are not blocked when it is reached. " +
          "Take a full backup and free up space (archive superseded revisions, purge disposable rows).",
        link: "/admin/storage",
      });
      // Counted only when the row landed (notify() logs a refusal) — the
      // cron's storageAlerts figure used to count attempts.
      if (sent) alerts++;
    }
  }
  return { alerts, orgsChecked, unmeasured };
}
