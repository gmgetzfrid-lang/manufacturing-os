// lib/storageUsage.ts — SERVER-ONLY. REAL platform storage measurement.
//
// The admin storage page previously showed an R2 figure summed from rows
// that happen to record a size — an estimate that misses knowledge PDFs,
// intake/transmittal uploads, and orphans. This module measures TRUTH:
//
//   - R2: walk the bucket with ListObjectsV2 and sum actual object sizes.
//     Listing is ~1 class-A op per 1000 objects. The walk runs in the daily
//     cron AND on every admin storage page load, so its op count follows how
//     often admins look, not the day — cheap against the free tier's 1M
//     ops/month, but bounded by a deadline either way (admin-and-org
//     BILL-13): a walk that runs out of time stops and says it is partial.
//   - DB: the existing mfg_table_stats() SECURITY DEFINER fn (exact on-disk
//     relation sizes from pg catalogs).
//
// Free-tier ceilings are constants (Cloudflare R2 free: 10 GB storage;
// Supabase free: 500 MB database). When the deployment upgrades plans,
// override via env: STORAGE_LIMIT_R2_BYTES / STORAGE_LIMIT_DB_BYTES.
//
// runPlatformStorageAlerts() is the daily watchdog: when DB or R2 crosses
// 70% (high) / 90% (critical) of its ceiling, the people who may see the
// deployment's figures get an in-app notification, deduped to one per week
// per person per resource — every Admin/DocCtrl of the workspace on a
// single-workspace deployment, the platform operators on a shared one.
//
// admin-and-org BILL-5 / BILL-12 (Round G, P6; DEC-44 (A&O P6)): the plan
// ceilings and the bucket walk are DEPLOYMENT facts — one bucket, one
// database, shared by every workspace on the server. Changing a ceiling is a
// platform operator's act (a uid in platform_settings 'platform_operators',
// which no org role can write); reading the deployment's figures is the
// operator's, or the sole workspace's on a single-workspace deployment. A
// workspace's own usage is measured under its own key prefix (orgs/<id>/).

import type { SupabaseClient } from "@supabase/supabase-js";
import { ListObjectsV2Command, type ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { alertBand, notifyAsServiceRole, type AlertBand } from "@/lib/storageAlerts";
import type { NotificationKind } from "@/lib/inAppNotifications";

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

/** platform_settings key listing the platform operators: `{"uids": [...]}`.
 *  The table is service-role only (20260920 revokes it from every client
 *  role; 20261177 re-asserts that and seeds the empty list) and no app route
 *  writes this row, so no org role — Admin included — can make anyone an
 *  operator. The deployment's owner adds a uid in the Supabase SQL editor. */
export const PLATFORM_OPERATORS_KEY = "platform_operators";
export const PLATFORM_OPERATORS_MIGRATION = "20261177_ao_roundG_platform_operators.sql";

/** The SQL a deployment owner runs to make `uid` a platform operator (shown
 *  to a refused member; also in 20261177's header). Idempotent. */
export function platformOperatorSql(uid: string): string {
  const id = /^[0-9a-fA-F-]{36}$/.test(uid) ? uid : "<your user id>";
  return `INSERT INTO platform_settings (key, value) VALUES ('${PLATFORM_OPERATORS_KEY}', '{"uids": []}'::jsonb) ON CONFLICT (key) DO NOTHING; ` +
    `UPDATE platform_settings SET value = jsonb_build_object('uids', COALESCE(value->'uids', '[]'::jsonb) || jsonb_build_array('${id}'::text)), updated_at = now() ` +
    `WHERE key = '${PLATFORM_OPERATORS_KEY}' AND NOT (COALESCE(value->'uids', '[]'::jsonb) ? '${id}');`;
}

/** The registered platform operators. `error` is set when the row could not
 *  be read — every caller then treats the caller as NOT an operator (fail
 *  closed). A missing row is no operators, not an error. */
export async function readPlatformOperators(sb: SupabaseClient): Promise<{ uids: string[]; error: string | null }> {
  try {
    const { data, error } = await sb
      .from("platform_settings").select("value").eq("key", PLATFORM_OPERATORS_KEY).maybeSingle();
    if (error) return { uids: [], error: error.message };
    const raw = (data?.value as { uids?: unknown } | null)?.uids;
    const uids = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string" && /^[0-9a-fA-F-]{36}$/.test(u)) : [];
    return { uids, error: null };
  } catch (e) {
    return { uids: [], error: (e as Error).message };
  }
}

/** True only when `orgId` is the ONE workspace on this deployment — then the
 *  deployment's figures are that workspace's own. Fails closed: an
 *  unreadable orgs table is "not sole". */
export async function isSoleTenant(sb: SupabaseClient, orgId: string): Promise<boolean> {
  try {
    const { data, error } = await sb.from("orgs").select("id").limit(2);
    if (error || !Array.isArray(data)) return false;
    return data.length === 1 && (data[0] as { id?: string }).id === orgId;
  } catch {
    return false;
  }
}

export type StorageScope = "deployment" | "workspace";

/** What a member of `orgId` may see of storage (BILL-5 Done-when 2):
 *  "deployment" — the whole bucket, the database's tables and the plan
 *  ceilings — for a platform operator, or for the sole workspace on a
 *  single-workspace deployment (its own figures); otherwise "workspace":
 *  only what is under the workspace's own prefix. `operator` alone may
 *  change the plan ceilings. */
export async function storageScopeFor(sb: SupabaseClient, orgId: string, uid: string): Promise<{
  scope: StorageScope; operator: boolean; soleTenant: boolean; operatorsError: string | null;
}> {
  const [ops, sole] = await Promise.all([readPlatformOperators(sb), isSoleTenant(sb, orgId)]);
  const operator = !ops.error && ops.uids.includes(uid);
  return { scope: operator || sole ? "deployment" : "workspace", operator, soleTenant: sole, operatorsError: ops.error };
}

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
  /** True when the walk stopped early — the safety page cap, or (BILL-13)
   *  its time budget — so real usage is higher. */
  truncated: boolean;
  /** Why a truncated walk stopped (null when it finished). */
  stoppedBy?: "pages" | "deadline" | null;
  /** Where the bytes actually are, biggest first. A single total invites
   *  "is that even right?"; the breakdown is the receipt. */
  segments: R2Segment[];
  /** Newest object anywhere in the bucket. If this predates an upload the
   *  user just made, the number on screen is stale — not wrong. */
  newest: string | null;
  /** The total under orgs/<orgTotalFor>/, when the walk was asked for one
   *  (a whole-bucket walk that also measures one workspace). */
  org?: { bytes: number; objects: number; newest: string | null };
}

export interface MeasureR2Options {
  maxPages?: number;
  /** Epoch ms: the walk stops by then and reports `truncated` (BILL-13). */
  deadlineMs?: number;
  /** Walk only the keys under this prefix — a workspace's `orgs/<id>/`. */
  prefix?: string;
  /** During a whole-bucket walk, also total this org's keys (orgs/<id>/). */
  orgTotalFor?: string;
}

/** A workspace's own key prefix. */
export const orgStoragePrefix = (orgId: string) => `orgs/${orgId}/`;

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

const isAbort = (e: unknown) => {
  const name = (e as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
};

/** Walk the bucket (or one prefix of it) and sum real object sizes, grouped
 *  by what the files are. One pass, no extra API cost over the plain total.
 *  Bounded by a page cap and, when given, a deadline (BILL-13): a walk that
 *  runs out of time — between pages, or mid-request — returns what it
 *  measured with `truncated: true` and `stoppedBy: "deadline"`, never a
 *  throw, so a slow bucket reads as "partial", distinct from a failure. A
 *  number argument is the page cap (the original signature). */
export async function measureR2Usage(opts: number | MeasureR2Options = {}): Promise<R2Usage> {
  const o: MeasureR2Options = typeof opts === "number" ? { maxPages: opts } : opts;
  const maxPages = o.maxPages ?? 500;
  const orgPrefix = o.orgTotalFor ? orgStoragePrefix(o.orgTotalFor) : null;
  let bytes = 0;
  let objects = 0;
  let token: string | undefined;
  let pages = 0;
  let newest: string | null = null;
  let stoppedBy: R2Usage["stoppedBy"] = null;
  const org = orgPrefix ? { bytes: 0, objects: 0, newest: null as string | null } : null;
  const groups = new Map<string, R2Segment>();
  do {
    let abortSignal: AbortSignal | undefined;
    if (o.deadlineMs !== undefined) {
      const remaining = o.deadlineMs - Date.now();
      if (remaining <= 0) { stoppedBy = "deadline"; break; }
      abortSignal = AbortSignal.timeout(remaining);
    }
    let res: ListObjectsV2CommandOutput;
    try {
      res = await r2.send(new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        ContinuationToken: token,
        MaxKeys: 1000,
        ...(o.prefix ? { Prefix: o.prefix } : {}),
      }), abortSignal ? { abortSignal } : undefined);
    } catch (e) {
      if (abortSignal && isAbort(e)) { stoppedBy = "deadline"; break; }
      throw e;
    }
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
      if (org && orgPrefix && (obj.Key ?? "").startsWith(orgPrefix)) {
        org.bytes += size;
        org.objects++;
        if (at && (!org.newest || at > org.newest)) org.newest = at;
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
    pages++;
  } while (token && pages < maxPages);
  if (!stoppedBy && token) stoppedBy = "pages";
  const segments = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
  return {
    bytes, objects, truncated: stoppedBy !== null, stoppedBy, segments, newest,
    ...(org ? { org } : {}),
  };
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

/** The cron watchdog's walk budget (BILL-13): the maintenance cron has 300 s
 *  for every step, and the meaning-index drain after this one takes 100 s. */
export const PLATFORM_WALK_BUDGET_MS = 60_000;

export async function measurePlatformStorage(sb: SupabaseClient, opts: { deadlineMs?: number } = {}): Promise<PlatformStorageStatus> {
  const [r2Usage, dbBytes, limits] = await Promise.all([
    measureR2Usage({ deadlineMs: opts.deadlineMs ?? Date.now() + PLATFORM_WALK_BUDGET_MS }),
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

/** Who hears about the deployment's plan ceilings (BILL-5 / BILL-12): the
 *  deployment's figures go only to people who may see them. On a
 *  single-workspace deployment that is the workspace's Admin / DocCtrl (its
 *  own figures, as before); on a shared one, the platform operators, in each
 *  workspace they are an active member of — never every tenant's admins.
 *  `route` says which, for the cron log: "none" means a shared deployment
 *  with no operator registered (or an unreadable list), so nobody was told. */
async function platformAlertRecipients(sb: SupabaseClient): Promise<{
  route: "sole-workspace" | "operators" | "none"; targets: Array<{ orgId: string; uid: string }>;
}> {
  const { data: orgs } = await sb.from("orgs").select("id");
  const orgIds = ((orgs as Array<{ id: string }> | null) ?? []).map((o) => o.id);
  if (orgIds.length === 0) return { route: "none", targets: [] };
  if (orgIds.length === 1) {
    const { data: admins } = await sb
      .from("org_members").select("uid")
      .eq("org_id", orgIds[0]).eq("status", "active").or("role.in.(Admin,DocCtrl),roles.ov.{Admin,DocCtrl}");
    return { route: "sole-workspace", targets: ((admins as Array<{ uid: string }> | null) ?? []).map((a) => ({ orgId: orgIds[0], uid: a.uid })) };
  }
  const ops = await readPlatformOperators(sb);
  if (ops.error || ops.uids.length === 0) return { route: "none", targets: [] };
  const { data: memberships } = await sb
    .from("org_members").select("org_id, uid")
    .in("uid", ops.uids).eq("status", "active");
  const targets = ((memberships as Array<{ org_id: string; uid: string }> | null) ?? [])
    .map((m) => ({ orgId: m.org_id, uid: m.uid }));
  return { route: targets.length > 0 ? "operators" : "none", targets };
}

/** Daily watchdog: notify the people who may see the deployment's figures
 *  (platformAlertRecipients) when a platform resource runs hot against its
 *  plan ceiling. Deduped per person per resource per week. Returns the
 *  measured status for the cron log. */
export async function runPlatformStorageAlerts(sb: SupabaseClient): Promise<{
  status: PlatformStorageStatus; alerts: number; route?: "sole-workspace" | "operators" | "none";
}> {
  const status = await measurePlatformStorage(sb);
  let alerts = 0;

  // Each alert's kind is a NotificationKind (PROD-10 / TAX-11): the finite
  // set storage_platform_r2 / storage_platform_db, never a template string.
  const hot: Array<{ kind: NotificationKind; title: string; body: string }> = [];
  if (status.r2.band !== "ok") {
    hot.push({
      kind: "storage_platform_r2",
      title: status.r2.band === "crit"
        ? `File storage critical — ${status.r2.pct}% of plan`
        : `File storage high — ${status.r2.pct}% of plan`,
      // BILL-11: the app never refuses an upload at this ceiling, so the copy
      // no longer says uploads "start failing"; it says what does happen.
      body:
        `Cloudflare R2 holds ${status.r2.truncated ? "at least " : ""}${fmtGb(status.r2.bytes)} GB of the ${fmtGb(status.r2.limitBytes)} GB plan ceiling ` +
        `(${status.r2.objects.toLocaleString()} files, the whole deployment). This app does not stop uploads at the ceiling: ` +
        "past it, Cloudflare bills the overage, or refuses writes on an account without billing. Upgrade the R2 plan " +
        "or archive old revisions from Admin → Storage.",
    });
  }
  if (status.db.band !== "ok" && status.db.bytes !== null) {
    hot.push({
      kind: "storage_platform_db",
      title: status.db.band === "crit"
        ? `Database critical — ${status.db.pct}% of plan`
        : `Database high — ${status.db.pct}% of plan`,
      body:
        `The Supabase database holds ${fmtMb(status.db.bytes)} MB of the ${fmtMb(status.db.limitBytes)} MB plan ceiling (the whole deployment). ` +
        "Approaching the plan ceiling — upgrade the Supabase plan or purge disposable rows from Admin → Storage.",
    });
  }
  if (hot.length === 0) return { status, alerts };

  const { route, targets } = await platformAlertRecipients(sb);
  if (route === "none") {
    console.warn("[platform-storage] a plan ceiling is running hot, but this shared deployment has no platform operator to tell — register one (" + PLATFORM_OPERATORS_MIGRATION + ")");
  }
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  for (const t of targets) {
    for (const alert of hot) {
      const { count } = await sb
        .from("notifications").select("id", { count: "exact", head: true })
        .eq("org_id", t.orgId).eq("user_id", t.uid)
        .eq("kind", alert.kind).gte("created_at", sevenDaysAgo);
      if ((count ?? 0) > 0) continue;
      const sent = await notifyAsServiceRole(sb, {
        orgId: t.orgId, userId: t.uid, kind: alert.kind,
        title: alert.title, body: alert.body, link: "/admin/storage",
      });
      if (sent) alerts++;
    }
  }
  return { status, alerts, route };
}
