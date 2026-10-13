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
// single-workspace deployment, the platform operators on a shared one. A
// shared deployment with no operator to tell is never silent: each
// workspace's Admins get a notice that carries no figures, and the cron
// reports it in its errors (BILL-5 fix pass). On a single-workspace
// deployment the quota alert states the R2 figure too and, when that figure
// was measured in full, stands in for the R2 bell (BILL-15); any quota bell
// sent today holds the R2 bell to the next day, so its Admin / DocCtrl never
// get two different percentages for the same files on the same day.
//
// admin-and-org BILL-5 / BILL-12 (Round G, P6; DEC-99): the plan
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
import { memberHoldsAny, roleFilter } from "@/lib/roleHeld";

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

/** The id of the ONE workspace on this deployment, or null when there are
 *  none or several. Fails closed: an unreadable orgs table is null ("not
 *  sole"). */
export async function soleTenantId(sb: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await sb.from("orgs").select("id").limit(2);
    if (error || !Array.isArray(data) || data.length !== 1) return null;
    const id = (data[0] as { id?: unknown }).id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** True only when `orgId` is the ONE workspace on this deployment — then the
 *  deployment's figures are that workspace's own. Fails closed: an
 *  unreadable orgs table is "not sole". */
export async function isSoleTenant(sb: SupabaseClient, orgId: string): Promise<boolean> {
  return (await soleTenantId(sb)) === orgId;
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

/** The plan ceilings a `storage_limits` row's value (null: no row) resolves
 *  to: the operator-set value → env override → free tier. Pure — the
 *  ceiling POST resolves the row it read (checked) for its audit row's old
 *  values with this, never with a fallback that hides a failed read (BILL-7). */
export function resolvePlatformLimits(value: unknown): PlatformLimits {
  const v = value as { r2Bytes?: number; dbBytes?: number } | null | undefined;
  const r2 = Number(v?.r2Bytes);
  const db = Number(v?.dbBytes);
  if (Number.isFinite(r2) && r2 > 0 && Number.isFinite(db) && db > 0) {
    return { r2Bytes: r2, dbBytes: db, source: "settings" };
  }
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

/** Resolve the plan ceilings for display and banding: admin-set value → env
 *  override → free tier. A failed read falls back (the page and the cron
 *  still band against something); a writer that must know the stored value
 *  reads the row itself and checks the error. */
export async function loadPlatformLimits(sb: SupabaseClient): Promise<PlatformLimits> {
  try {
    const { data, error } = await sb
      .from("platform_settings").select("value").eq("key", STORAGE_LIMITS_KEY).maybeSingle();
    if (!error) return resolvePlatformLimits(data?.value ?? null);
  } catch { /* pre-migration DB — fall through */ }
  return resolvePlatformLimits(null);
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

/** The whole bucket's band against the R2 plan ceiling. A truncated walk
 *  measured a FLOOR, not the total. Reporting "ok" from a number we know is
 *  incomplete is the failure mode that lets a bucket sail past its ceiling
 *  while the dashboard stays green — never band a truncated measurement
 *  below "warn". Shared by the platform watchdog and, on a single-workspace
 *  server, the quota alert that states this figure too (BILL-15). */
export function r2PlanBand(bytes: number, truncated: boolean, limitBytes: number): { pct: number; band: AlertBand } {
  const r = alertBand(bytes, limitBytes);
  return truncated && r.band === "ok" ? { pct: r.pct, band: "warn" } : r;
}

export async function measurePlatformStorage(sb: SupabaseClient, opts: { deadlineMs?: number } = {}): Promise<PlatformStorageStatus> {
  const [r2Usage, dbBytes, limits] = await Promise.all([
    measureR2Usage({ deadlineMs: opts.deadlineMs ?? Date.now() + PLATFORM_WALK_BUDGET_MS }),
    measureDbBytes(sb),
    loadPlatformLimits(sb),
  ]);
  const r2Band = r2PlanBand(r2Usage.bytes, r2Usage.truncated, limits.r2Bytes);
  const dbBand = alertBand(dbBytes ?? 0, limits.dbBytes);
  return {
    r2: { ...r2Usage, limitBytes: limits.r2Bytes, pct: r2Band.pct, band: r2Band.band },
    db: { bytes: dbBytes, limitBytes: limits.dbBytes, pct: dbBand.pct, band: dbBand.band },
    limitsSource: limits.source,
  };
}

const fmtGb = (bytes: number) => (bytes / GiB).toFixed(bytes >= GiB ? 1 : 2);
const fmtMb = (bytes: number) => Math.round(bytes / MiB);

/** Where the platform watchdog's alert went (BILL-5 / BILL-12):
 *  "sole-workspace" — the only workspace's Admin / DocCtrl, with the figures
 *  (they are its own); "operators" — the platform operators, with the
 *  figures; "no-operator" — a shared deployment with no operator to tell (none
 *  registered, an unreadable list, or none an active member of a workspace):
 *  each workspace's Admins get a notice WITHOUT figures, and the cron reports
 *  it; "none" — a deployment with no workspace at all. */
export type PlatformAlertRoute = "sole-workspace" | "operators" | "no-operator" | "none";

/** Who hears about the deployment's plan ceilings (BILL-5 / BILL-12): the
 *  deployment's figures go only to people who may see them. On a
 *  single-workspace deployment that is the workspace's Admin / DocCtrl (its
 *  own figures, as before); on a shared one, the platform operators, each
 *  ONCE, in the first workspace (by id) they are an active member of —
 *  never every tenant's admins. With no operator to tell, every workspace's
 *  Admins (by the full role collection) are the "no-operator" fallback:
 *  told that the server runs hot, never by how much. */
async function platformAlertRecipients(sb: SupabaseClient): Promise<{
  route: PlatformAlertRoute; targets: Array<{ orgId: string; uid: string }>; operatorsError: string | null;
}> {
  const { data: orgs } = await sb.from("orgs").select("id");
  const orgIds = ((orgs as Array<{ id: string }> | null) ?? []).map((o) => o.id);
  if (orgIds.length === 0) return { route: "none", targets: [], operatorsError: null };
  if (orgIds.length === 1) {
    const { data: admins } = await sb
      .from("org_members").select("uid")
      .eq("org_id", orgIds[0]).eq("status", "active").or("role.in.(Admin,DocCtrl),roles.ov.{Admin,DocCtrl}");
    return {
      route: "sole-workspace", operatorsError: null,
      targets: ((admins as Array<{ uid: string }> | null) ?? []).map((a) => ({ orgId: orgIds[0], uid: a.uid })),
    };
  }
  const ops = await readPlatformOperators(sb);
  if (!ops.error && ops.uids.length > 0) {
    const { data: memberships } = await sb
      .from("org_members").select("org_id, uid")
      .in("uid", ops.uids).eq("status", "active");
    // One bell per operator, not one per workspace they belong to.
    const byUid = new Map<string, string>();
    for (const m of (memberships as Array<{ org_id: string; uid: string }> | null) ?? []) {
      const prev = byUid.get(m.uid);
      if (prev === undefined || m.org_id < prev) byUid.set(m.uid, m.org_id);
    }
    if (byUid.size > 0) {
      return { route: "operators", operatorsError: null, targets: [...byUid].map(([uid, orgId]) => ({ orgId, uid })) };
    }
  }
  // Nobody may see the figures — tell each workspace's Admins that the server
  // runs hot, without them.
  const { data: admins } = await sb
    .from("org_members").select("org_id, uid, role, roles")
    .in("org_id", orgIds).eq("status", "active").or(roleFilter(["Admin"]));
  const targets = ((admins as Array<{ org_id: string; uid: string; role?: unknown; roles?: unknown }> | null) ?? [])
    .filter((m) => memberHoldsAny(m, ["Admin"]))
    .map((m) => ({ orgId: m.org_id, uid: m.uid }));
  return { route: "no-operator", targets, operatorsError: ops.error };
}

/** The cron's error line when the watchdog found a hot ceiling but no
 *  platform operator to give the figures to (null otherwise). It is said in
 *  the cron's result, where whoever runs the server reads it, not only in a
 *  log line (BILL-5 fix pass). */
export function platformAlertUnroutedError(run: {
  status: PlatformStorageStatus; route?: PlatformAlertRoute; operatorsError?: string | null;
}): string | null {
  if (run.route !== "no-operator") return null;
  const hot: string[] = [];
  if (run.status.r2.band !== "ok") hot.push(`file storage at ${run.status.r2.truncated ? "at least " : ""}${run.status.r2.pct}%`);
  if (run.status.db.band !== "ok" && run.status.db.bytes !== null) hot.push(`the database at ${run.status.db.pct}%`);
  const why = run.operatorsError
    ? `the operator list could not be read (${run.operatorsError})`
    : "no platform operator is registered, or none is an active member of a workspace";
  return `platform-storage: ${hot.join(" and ")} of the plan ceiling, but ${why} — register one (${PLATFORM_OPERATORS_MIGRATION}); ` +
    "each workspace's Admins were told without figures";
}

/** A quota bell row the R2 step reads (BILL-15): its metadata and when it
 *  went out. */
export type QuotaBellRow = { metadata?: Record<string, unknown> | null; created_at?: string | null };

const BAND_RANK: Record<AlertBand, number> = { ok: 0, warn: 1, crit: 2 };

/** A timestamp as epoch ms, or NaN. PostgREST returns timestamptz as ISO
 *  8601 with an offset ("…+00:00", or the session's own offset when the
 *  database's time zone is not UTC), sometimes without fractional seconds;
 *  a bare "YYYY-MM-DD HH:MM:SS+00" (psql's shape) is read too. Instants are
 *  compared, never strings: "…T00:00:00+00:00" sorts before
 *  "…T00:00:00.000Z" as text, and "…T19:30:00-05:00" is the next UTC day. */
export function timestampMs(value: unknown): number {
  if (typeof value !== "string" || !value) return NaN;
  const iso = value.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T").replace(/(T[\d:.]+[+-]\d{2})$/, "$1:00");
  return Date.parse(iso);
}

/** BILL-15 (DEC-99 §3), single-workspace server: does a this-week quota
 *  bell (`storage_alert`) stand in for, or hold back, the R2 bell the
 *  platform step would send now at `measured`?
 *  - Any quota bell that went out TODAY (UTC, at or after `dayStartIso`)
 *    holds the R2 bell to the next day, whatever it stated — a complete
 *    plan figure, a floor ("at least N%"), or none (its plan walk failed):
 *    the person has had a storage percentage today, and a second, different
 *    one for the same files is what the finding rules out. The next day the
 *    R2 bell goes unless the rule below covers it.
 *  - A bell whose plan figure was COMPLETE (metadata.r2PlanTruncated ===
 *    false) covers the R2 bell's week when the band it stated ranks at or
 *    above `measured` (ok < warn < crit). A floor (banded warn because the
 *    walk stopped early) or a quota-only bell never covers the week, so it
 *    delays a measured plan figure by at most a day and never hides it. */
export function quotaBellCoversR2Bell(rows: readonly QuotaBellRow[] | null | undefined, measured: AlertBand, dayStartIso: string): boolean {
  const dayStart = timestampMs(dayStartIso);
  for (const r of rows ?? []) {
    const at = timestampMs(r.created_at);
    if (Number.isFinite(at) && Number.isFinite(dayStart) && at >= dayStart) return true;
    const m = r.metadata;
    if (!m || m.r2PlanTruncated !== false) continue;
    const stated = m.r2PlanBand;
    if (stated !== "ok" && stated !== "warn" && stated !== "crit") continue;
    if (BAND_RANK[stated] >= BAND_RANK[measured]) return true;
  }
  return false;
}

/** Daily watchdog: notify the people who may see the deployment's figures
 *  (platformAlertRecipients) when a platform resource runs hot against its
 *  plan ceiling. Deduped per person per resource per week. Returns the
 *  measured status, and (when something ran hot) where the alert went. */
export async function runPlatformStorageAlerts(sb: SupabaseClient): Promise<{
  status: PlatformStorageStatus; alerts: number; route?: PlatformAlertRoute; operatorsError?: string | null;
}> {
  const status = await measurePlatformStorage(sb);
  let alerts = 0;

  // Each alert's kind is a NotificationKind (PROD-10 / TAX-11): the finite
  // set storage_platform_r2 / storage_platform_db, never a template string.
  // `title` / `body` carry the figures; `blindTitle` / `blindBody` are the
  // no-operator fallback, which carries none (BILL-5: a tenant's admin may
  // not read the deployment's totals).
  const hot: Array<{ kind: NotificationKind; band: AlertBand; title: string; body: string; blindTitle: string; blindBody: string }> = [];
  const blindTail =
    "These figures cover every workspace on the server, so they go to a platform operator, and this server has none " +
    "to tell. Let whoever runs the server know. If that is you, register as its platform operator from Admin → Storage " +
    "to see the figures and set the plan ceilings.";
  if (status.r2.band !== "ok") {
    hot.push({
      kind: "storage_platform_r2",
      band: status.r2.band,
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
      blindTitle: "This server's file storage is running hot",
      blindBody:
        "The file storage plan this server runs on is nearing its ceiling. This app does not stop uploads at the ceiling: " +
        "past it, Cloudflare bills the overage, or refuses writes on an account without billing. " + blindTail,
    });
  }
  if (status.db.band !== "ok" && status.db.bytes !== null) {
    hot.push({
      kind: "storage_platform_db",
      band: status.db.band,
      title: status.db.band === "crit"
        ? `Database critical — ${status.db.pct}% of plan`
        : `Database high — ${status.db.pct}% of plan`,
      body:
        `The Supabase database holds ${fmtMb(status.db.bytes)} MB of the ${fmtMb(status.db.limitBytes)} MB plan ceiling (the whole deployment). ` +
        "Approaching the plan ceiling — upgrade the Supabase plan or purge disposable rows from Admin → Storage.",
      blindTitle: "This server's database is running hot",
      blindBody:
        "The database plan this server runs on is nearing its size ceiling. On Supabase's free plan, past it the database " +
        "goes read-only and every save fails. " + blindTail,
    });
  }
  if (hot.length === 0) return { status, alerts };

  const { route, targets, operatorsError } = await platformAlertRecipients(sb);
  if (route === "no-operator") {
    console.warn("[platform-storage] a plan ceiling is running hot, but this shared deployment has no platform operator to tell — " +
      "each workspace's Admins get a notice without figures; register one (" + PLATFORM_OPERATORS_MIGRATION + ")");
  }
  const blind = route === "no-operator";
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const utcDayStart = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString();
  for (const t of targets) {
    for (const alert of hot) {
      // BILL-15 (DEC-99 §3): on a single-workspace server the workspace's
      // files ARE nearly the whole bucket, and the quota alert (the cron's
      // earlier step, lib/storageAlerts.ts runStorageAlerts) goes to these
      // same people. When it fires there it states BOTH figures — the files
      // against the limit an admin set, and the whole bucket against this R2
      // plan ceiling — so it can be this bell too (quotaBellCoversR2Bell:
      // only a COMPLETE plan figure, stated at or above the band measured
      // now, covers this bell's week; any quota bell sent earlier today — a
      // floor or a quota-only one included — holds it to the next day). A
      // shared server keeps both (different people). A read
      // that fails skips nothing: the R2 bell goes. storage_alert is a
      // server-only kind once 20261160 is live (rule 2); before that paste
      // a forged row could feed this read, as each kind's own weekly dedupe
      // already could at base.
      if (route === "sole-workspace" && alert.kind === "storage_platform_r2") {
        const { data: filesBells } = await sb
          .from("notifications").select("metadata, created_at")
          .eq("org_id", t.orgId).eq("user_id", t.uid)
          .eq("kind", "storage_alert").gte("created_at", sevenDaysAgo);
        if (quotaBellCoversR2Bell(filesBells as QuotaBellRow[] | null, alert.band, utcDayStart)) continue;
      }
      // Deduped per person per resource per week — but a blind (no-figures)
      // bell never stands in for the figures: an Admin belled blind on day 1
      // and registered as operator on day 2 gets the percentage on day 2,
      // not on day 8. The blind row is told apart by its title (NOT NULL, a
      // constant here) and tagged in metadata for the record; a figures row
      // still dedups a later blind one (they already know more).
      let dedup = sb
        .from("notifications").select("id", { count: "exact", head: true })
        .eq("org_id", t.orgId).eq("user_id", t.uid)
        .eq("kind", alert.kind).gte("created_at", sevenDaysAgo);
      if (!blind) dedup = dedup.neq("title", alert.blindTitle);
      const { count } = await dedup;
      if ((count ?? 0) > 0) continue;
      const sent = await notifyAsServiceRole(sb, {
        orgId: t.orgId, userId: t.uid, kind: alert.kind,
        title: blind ? alert.blindTitle : alert.title,
        body: blind ? alert.blindBody : alert.body,
        link: "/admin/storage",
        ...(blind ? { metadata: { withoutFigures: true } } : {}),
      });
      if (sent) alerts++;
    }
  }
  return { status, alerts, route, operatorsError };
}
