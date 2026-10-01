// lib/storageAlerts.ts
//
// Real watermark alerting: compare actual storage usage against the org's set
// quota and notify admins when it crosses a threshold. The band math is pure
// and unit-tested; runStorageAlerts wires it to the DB from the daily cron.

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

/**
 * Check every org that has set a quota and drop an in-app notification to its
 * admins when usage is high. Deduped: an admin won't be re-alerted within 7
 * days. Usage is deployment-wide (DB + R2 estimate) — exact for the common
 * single-workspace deployment.
 */
export async function runStorageAlerts(sb: SupabaseClient): Promise<{ alerts: number; orgsChecked: number; usedBytes: number }> {
  let dbBytes = 0, r2Bytes = 0;
  try {
    const { data } = await sb.rpc("mfg_table_stats");
    for (const r of (data as Array<{ total_bytes: number }> | null) ?? []) dbBytes += Number(r.total_bytes) || 0;
  } catch { /* stats fn may not be migrated */ }
  try {
    const { data } = await sb.rpc("mfg_storage_estimate");
    const e = ((data as Array<{ versions_bytes: number; photos_bytes: number }> | null) ?? [])[0];
    if (e) r2Bytes = (Number(e.versions_bytes) || 0) + (Number(e.photos_bytes) || 0);
  } catch { /* best-effort */ }
  const usedBytes = dbBytes + r2Bytes;

  const { data: settings } = await sb
    .from("archive_settings")
    .select("org_id, quota_bytes")
    .not("quota_bytes", "is", null);

  let alerts = 0, orgsChecked = 0;
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  for (const s of (settings as Array<{ org_id: string; quota_bytes: number | null }> | null) ?? []) {
    const quota = Number(s.quota_bytes) || 0;
    if (!(quota > 0)) continue;
    orgsChecked++;
    const { pct, band } = alertBand(usedBytes, quota);
    if (band === "ok") continue;

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
        title: band === "crit" ? `Storage critical — ${pct}% full` : `Storage high — ${pct}% full`,
        body: `This workspace is at ${pct}% of its storage limit. Take a full backup and free up space (archive superseded revisions, purge disposable rows).`,
        link: "/admin/storage",
      });
      // Counted only when the row landed (notify() logs a refusal) — the
      // cron's storageAlerts figure used to count attempts.
      if (sent) alerts++;
    }
  }
  return { alerts, orgsChecked, usedBytes };
}
