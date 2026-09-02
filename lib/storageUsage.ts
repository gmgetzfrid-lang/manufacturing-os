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

export interface PlatformLimits {
  r2Bytes: number;
  dbBytes: number;
  /** Where the numbers came from — shown in the UI so nobody trusts a
   *  default as if it were their real plan. */
  source: "settings" | "env" | "default";
}

/** Built-in fallbacks = the current FREE tiers (Cloudflare R2 10 GB,
 *  Supabase 500 MB). Neither provider exposes plan limits to the
 *  credentials this app holds (S3 keys / service role), so the ceiling is
 *  a SETTING: admins edit it on the storage page (stored in
 *  platform_settings — survives deploys, changes instantly) and it defaults
 *  to free tier until they do. Usage, by contrast, is always MEASURED. */
export const DEFAULT_LIMITS = {
  r2Bytes: 10 * GiB,
  dbBytes: 500 * MiB,
};

export const STORAGE_LIMITS_KEY = "storage_limits";

/** Resolve the plan ceilings: admin-set value → env override → free tier. */
export async function loadPlatformLimits(sb: SupabaseClient): Promise<PlatformLimits> {
  try {
    const { data } = await sb
      .from("platform_settings").select("value").eq("key", STORAGE_LIMITS_KEY).maybeSingle();
    const v = data?.value as { r2Bytes?: number; dbBytes?: number } | null;
    const r2 = Number(v?.r2Bytes);
    const db = Number(v?.dbBytes);
    if (Number.isFinite(r2) && r2 > 0 && Number.isFinite(db) && db > 0) {
      return { r2Bytes: r2, dbBytes: db, source: "settings" };
    }
  } catch { /* pre-migration DB — fall through */ }
  const envR2 = envBytes("STORAGE_LIMIT_R2_BYTES", 0);
  const envDb = envBytes("STORAGE_LIMIT_DB_BYTES", 0);
  if (envR2 > 0 || envDb > 0) {
    return {
      r2Bytes: envR2 > 0 ? envR2 : DEFAULT_LIMITS.r2Bytes,
      dbBytes: envDb > 0 ? envDb : DEFAULT_LIMITS.dbBytes,
      source: "env",
    };
  }
  return { ...DEFAULT_LIMITS, source: "default" };
}

export interface R2Segment {
  /** Human label for the kind of file ("Knowledge library PDFs"). */
  label: string;
  bytes: number;
  objects: number;
  /** Newest object in this segment — proves a recent upload actually landed. */
  newest: string | null;
}

export interface R2Usage {
  bytes: number;
  objects: number;
  /** True when the walk hit the safety page cap — real usage is higher. */
  truncated: boolean;
  /** Where the bytes actually are, biggest first. A single total invites
   *  "is that even right?"; the breakdown is the receipt. */
  segments: R2Segment[];
  /** Newest object anywhere in the bucket. If this predates an upload the
   *  user just made, the number on screen is stale — not wrong. */
  newest: string | null;
}

/** Which kind of file a storage key holds. Keys are laid out by feature
 *  (`orgs/<id>/knowledge/...`), so the path segment after the org id is the
 *  discriminator; anything unrecognized is reported as-is rather than
 *  silently folded into "other", because an unexplained bucket of bytes is
 *  exactly what makes a storage number untrustworthy. */
export function segmentForKey(key: string): string {
  const parts = key.split("/").filter(Boolean);
  const feature = parts[0] === "orgs" && parts.length > 2 ? parts[2] : parts[0] ?? "";
  switch (feature) {
    // orgs/<org>/libraries/<libraryId>/... — every controlled revision and
    // the source CAD attached to it.
    case "libraries": return "Controlled document revisions";
    case "knowledge": return "Knowledge library files";
    case "assets": return "Asset photos";
    case "plot-plans": return "Plot plans";
    case "project-intake": return "Project intake uploads";
    case "output-templates":
    case "output-examples":
    case "output-data": return "Output templates";
    case "branding": return "Branding & logos";
    case "diagnostics": return "Diagnostics";
    case "avatars": return "Avatars";
    case "data": return "Offline archives";
    case "exports": return "Export artifacts";
    default: return feature ? `Other — ${feature}/` : "Other — bucket root";
  }
}

/** Walk the whole bucket and sum real object sizes, grouped by what the
 *  files are. One pass, no extra API cost over the plain total. */
export async function measureR2Usage(maxPages = 500): Promise<R2Usage> {
  let bytes = 0;
  let objects = 0;
  let token: string | undefined;
  let pages = 0;
  let newest: string | null = null;
  const groups = new Map<string, R2Segment>();
  do {
    const res = await r2.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const obj of res.Contents ?? []) {
      const size = obj.Size ?? 0;
      bytes += size;
      objects++;
      const at = obj.LastModified?.toISOString() ?? null;
      if (at && (!newest || at > newest)) newest = at;
      const label = segmentForKey(obj.Key ?? "");
      const seg = groups.get(label) ?? { label, bytes: 0, objects: 0, newest: null };
      seg.bytes += size;
      seg.objects++;
      if (at && (!seg.newest || at > seg.newest)) seg.newest = at;
      groups.set(label, seg);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
    pages++;
  } while (token && pages < maxPages);
  const segments = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
  return { bytes, objects, truncated: !!token, segments, newest };
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
  r2: {
    bytes: number; objects: number; truncated: boolean; segments: R2Segment[]; newest: string | null;
    limitBytes: number; pct: number; band: AlertBand;
  };
  db: { bytes: number | null; limitBytes: number; pct: number; band: AlertBand };
  limitsSource: PlatformLimits["source"];
}

export async function measurePlatformStorage(sb: SupabaseClient): Promise<PlatformStorageStatus> {
  const [r2Usage, dbBytes, limits] = await Promise.all([
    measureR2Usage(),
    measureDbBytes(sb),
    loadPlatformLimits(sb),
  ]);
  const r2Band = alertBand(r2Usage.bytes, limits.r2Bytes);
  // A truncated walk measured a FLOOR, not the total. Reporting "ok" from a
  // number we know is incomplete is the failure mode that lets a bucket sail
  // past its ceiling while the dashboard stays green — never band a
  // truncated measurement below "warn".
  if (r2Usage.truncated && r2Band.band === "ok") r2Band.band = "warn";
  const dbBand = alertBand(dbBytes ?? 0, limits.dbBytes);
  return {
    r2: { ...r2Usage, limitBytes: limits.r2Bytes, pct: r2Band.pct, band: r2Band.band },
    db: { bytes: dbBytes, limitBytes: limits.dbBytes, pct: dbBand.pct, band: dbBand.band },
    limitsSource: limits.source,
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
      .eq("org_id", org.id).eq("status", "active").or("role.in.(Admin,DocCtrl),roles.ov.{Admin,DocCtrl}");
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
