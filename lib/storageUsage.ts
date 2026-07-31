// lib/storageUsage.ts — SERVER-ONLY. REAL platform storage measurement.
//
// The admin storage page previously showed an R2 figure summed from rows
// that happen to record a size — an estimate that misses knowledge PDFs,
// intake/transmittal uploads, and orphans. This module measures TRUTH:
//
//   - R2: walk the bucket with ListObjectsV2 and sum actual object sizes.
//     Listing is ~1 class-A op per 1000 objects — measuring daily costs
//     effectively nothing against the free tier's 1M ops/month.
//   - DB: the existing mfg_table_stats() SECURITY DEFINER fn (exact on-disk
//     relation sizes from pg catalogs).
//
// Free-tier ceilings are constants (Cloudflare R2 free: 10 GB storage;
// Supabase free: 500 MB database). When the deployment upgrades plans,
// override via env: STORAGE_LIMIT_R2_BYTES / STORAGE_LIMIT_DB_BYTES.
//
// runPlatformStorageAlerts() is the daily watchdog: when DB or R2 crosses
// 70% (high) / 90% (critical) of its ceiling, every Admin/DocCtrl gets an
// in-app notification, deduped to one per week per person per resource.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { alertBand, type AlertBand } from "@/lib/storageAlerts";

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

const envBytes = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Plan ceilings — free tiers by default, env-overridable after upgrades. */
export const PLATFORM_LIMITS = {
  r2Bytes: envBytes("STORAGE_LIMIT_R2_BYTES", 10 * GiB),        // Cloudflare R2 free
  dbBytes: envBytes("STORAGE_LIMIT_DB_BYTES", 500 * MiB),       // Supabase free
};

export interface R2Usage {
  bytes: number;
  objects: number;
  /** True when the walk hit the safety page cap — real usage is higher. */
  truncated: boolean;
}

/** Walk the whole bucket and sum real object sizes. */
export async function measureR2Usage(maxPages = 500): Promise<R2Usage> {
  let bytes = 0;
  let objects = 0;
  let token: string | undefined;
  let pages = 0;
  do {
    const res = await r2.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const obj of res.Contents ?? []) {
      bytes += obj.Size ?? 0;
      objects++;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
    pages++;
  } while (token && pages < maxPages);
  return { bytes, objects, truncated: !!token };
}

/** Exact DB bytes via the migrated stats function; null when unavailable. */
export async function measureDbBytes(sb: SupabaseClient): Promise<number | null> {
  const { data, error } = await sb.rpc("mfg_table_stats");
  if (error || !data) return null;
  let total = 0;
  for (const row of data as Array<{ total_bytes: number }>) {
    total += Number(row.total_bytes) || 0;
  }
  return total;
}

export interface PlatformStorageStatus {
  r2: { bytes: number; objects: number; truncated: boolean; limitBytes: number; pct: number; band: AlertBand };
  db: { bytes: number | null; limitBytes: number; pct: number; band: AlertBand };
}

export async function measurePlatformStorage(sb: SupabaseClient): Promise<PlatformStorageStatus> {
  const [r2Usage, dbBytes] = await Promise.all([
    measureR2Usage(),
    measureDbBytes(sb),
  ]);
  const r2Band = alertBand(r2Usage.bytes, PLATFORM_LIMITS.r2Bytes);
  const dbBand = alertBand(dbBytes ?? 0, PLATFORM_LIMITS.dbBytes);
  return {
    r2: { ...r2Usage, limitBytes: PLATFORM_LIMITS.r2Bytes, pct: r2Band.pct, band: r2Band.band },
    db: { bytes: dbBytes, limitBytes: PLATFORM_LIMITS.dbBytes, pct: dbBand.pct, band: dbBand.band },
  };
}

const fmtGb = (bytes: number) => (bytes / GiB).toFixed(bytes >= GiB ? 1 : 2);
const fmtMb = (bytes: number) => Math.round(bytes / MiB);

/** Daily watchdog: notify every org's Admin/DocCtrl when a platform
 *  resource runs hot against its plan ceiling. Deduped per person per
 *  resource per week. Returns the measured status for the cron log. */
export async function runPlatformStorageAlerts(sb: SupabaseClient): Promise<{
  status: PlatformStorageStatus; alerts: number;
}> {
  const status = await measurePlatformStorage(sb);
  let alerts = 0;

  const hot: Array<{ key: string; title: string; body: string }> = [];
  if (status.r2.band !== "ok") {
    hot.push({
      key: "platform_r2",
      title: status.r2.band === "crit"
        ? `File storage critical — ${status.r2.pct}% of plan`
        : `File storage high — ${status.r2.pct}% of plan`,
      body:
        `Cloudflare R2 holds ${fmtGb(status.r2.bytes)} GB of ${fmtGb(status.r2.limitBytes)} GB ` +
        `(${status.r2.objects.toLocaleString()} files). Approaching the plan ceiling — upgrade the R2 plan ` +
        "or archive old revisions from Admin → Storage before uploads start failing.",
    });
  }
  if (status.db.band !== "ok" && status.db.bytes !== null) {
    hot.push({
      key: "platform_db",
      title: status.db.band === "crit"
        ? `Database critical — ${status.db.pct}% of plan`
        : `Database high — ${status.db.pct}% of plan`,
      body:
        `The Supabase database holds ${fmtMb(status.db.bytes)} MB of ${fmtMb(status.db.limitBytes)} MB. ` +
        "Approaching the plan ceiling — upgrade the Supabase plan or purge disposable rows from Admin → Storage.",
    });
  }
  if (hot.length === 0) return { status, alerts };

  const { data: orgs } = await sb.from("orgs").select("id");
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  for (const org of (orgs as Array<{ id: string }> | null) ?? []) {
    const { data: admins } = await sb
      .from("org_members").select("uid")
      .eq("org_id", org.id).eq("status", "active").in("role", ["Admin", "DocCtrl"]);
    for (const a of (admins as Array<{ uid: string }> | null) ?? []) {
      for (const alert of hot) {
        const { count } = await sb
          .from("notifications").select("id", { count: "exact", head: true })
          .eq("org_id", org.id).eq("user_id", a.uid)
          .eq("kind", `storage_${alert.key}`).gte("created_at", sevenDaysAgo);
        if ((count ?? 0) > 0) continue;
        const { error } = await sb.from("notifications").insert({
          org_id: org.id, user_id: a.uid, kind: `storage_${alert.key}`,
          title: alert.title, body: alert.body, link: "/admin/storage",
        });
        if (!error) alerts++;
      }
    }
  }
  return { status, alerts };
}
