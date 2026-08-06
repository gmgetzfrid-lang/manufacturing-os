// GET /api/admin/storage-stats?orgId=...
//
// Read-only deployment-wide storage/usage snapshot for the admin "Storage &
// Usage" dashboard. Returns per-table sizes + row estimates and an R2 binary
// estimate. Admin-gated; computes nothing destructive. Backed by the
// SECURITY DEFINER functions in migration 20260805 (aggregates only).

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { classifyTable, type DataClass } from "@/lib/storageClassify";
import { measureR2Usage, loadPlatformLimits, STORAGE_LIMITS_KEY } from "@/lib/storageUsage";
import { alertBand } from "@/lib/storageAlerts";

export const runtime = "nodejs";

const ADMIN_ROLES = ["Admin", "Manager", "DocCtrl"];

interface TableStat { table_name: string; row_estimate: number; total_bytes: number }
interface StorageEst {
  versions_bytes: number; photos_bytes: number; knowledge_bytes?: number;
  version_count: number; photo_count: number; knowledge_count?: number;
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  const sb = actor.admin;

  const { data: statRows, error: statErr } = await sb.rpc("mfg_table_stats");
  if (statErr) {
    return NextResponse.json(
      { error: `Storage stats unavailable — apply migration 20260805. (${statErr.message})` },
      { status: 503 },
    );
  }
  const tables = ((statRows as TableStat[] | null) ?? []).map((t) => {
    const cls = classifyTable(t.table_name);
    return {
      name: t.table_name,
      rows: Math.max(0, Number(t.row_estimate) || 0),
      bytes: Math.max(0, Number(t.total_bytes) || 0),
      category: cls.category,
      reason: cls.reason,
      grower: !!cls.grower,
    };
  });
  const dbBytes = tables.reduce((a, t) => a + t.bytes, 0);
  // Bytes by bucket — the "what's safe to purge vs must keep" headline.
  const byCategory: Record<DataClass, number> = { purge: 0, archive: 0, reference: 0 };
  for (const t of tables) byCategory[t.category] += t.bytes;

  let r2 = {
    totalBytes: 0, versionsBytes: 0, photosBytes: 0, knowledgeBytes: 0,
    versionCount: 0, photoCount: 0, knowledgeCount: 0,
  };
  const { data: estRows } = await sb.rpc("mfg_storage_estimate");
  const est = ((estRows as StorageEst[] | null) ?? [])[0];
  if (est) {
    const versionsBytes = Number(est.versions_bytes) || 0;
    const photosBytes = Number(est.photos_bytes) || 0;
    // Present until migration 20261008 lands; absent means the deployment's
    // estimate genuinely cannot see knowledge files, so it stays 0 rather
    // than quietly inheriting a wrong number.
    const knowledgeBytes = Number(est.knowledge_bytes) || 0;
    r2 = {
      totalBytes: versionsBytes + photosBytes + knowledgeBytes,
      versionsBytes,
      photosBytes,
      knowledgeBytes,
      versionCount: Number(est.version_count) || 0,
      photoCount: Number(est.photo_count) || 0,
      knowledgeCount: Number(est.knowledge_count) || 0,
    };
  }

  // Dedup opportunity — identical files stored more than once (best-effort).
  let dedup: {
    totalVersions: number; totalBytes: number; distinctHashes: number;
    dupGroups: number; reclaimableBytes: number;
  } | null = null;
  {
    const { data: dedupRows, error: dedupErr } = await sb.rpc("mfg_dedup_stats");
    const d = ((dedupRows as Array<{
      total_versions: number; total_bytes: number; distinct_hashes: number;
      dup_groups: number; reclaimable_bytes: number;
    }> | null) ?? [])[0];
    if (!dedupErr && d) {
      dedup = {
        totalVersions: Number(d.total_versions) || 0,
        totalBytes: Number(d.total_bytes) || 0,
        distinctHashes: Number(d.distinct_hashes) || 0,
        dupGroups: Number(d.dup_groups) || 0,
        reclaimableBytes: Number(d.reclaimable_bytes) || 0,
      };
    }
  }

  // AI usage (shared-key load) — best-effort; null if metering isn't migrated.
  let ai: { last24h: number; last30d: number } | null = null;
  try {
    const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const since30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const [a, b] = await Promise.all([
      sb.from("ai_usage_events").select("*", { count: "exact", head: true }).gte("created_at", since24),
      sb.from("ai_usage_events").select("*", { count: "exact", head: true }).gte("created_at", since30),
    ]);
    if (!a.error && !b.error) ai = { last24h: a.count ?? 0, last30d: b.count ?? 0 };
  } catch { ai = null; }

  // REAL R2 usage: walk the bucket and sum actual object sizes — the truth
  // the estimate above approximates. Best-effort: a bucket/creds hiccup
  // degrades to null rather than failing the whole dashboard.
  const limits = await loadPlatformLimits(sb);
  let r2Real: Awaited<ReturnType<typeof measureR2Usage>> & { pct: number; band: string } | null = null;
  // WHY the walk failed, kept for the UI. Falling back to the row-sum
  // silently is how a number that structurally cannot see knowledge PDFs
  // ends up presented as the storage total.
  let r2Error: string | null = null;
  try {
    const measured = await measureR2Usage();
    const band = alertBand(measured.bytes, limits.r2Bytes);
    // A truncated walk is a floor, not a total — never band it "ok".
    r2Real = { ...measured, pct: band.pct, band: measured.truncated && band.band === "ok" ? "warn" : band.band };
  } catch (e) {
    r2Real = null;
    r2Error = (e as Error).message;
  }
  const dbBand = alertBand(dbBytes, limits.dbBytes);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    db: { totalBytes: dbBytes, tables, byCategory },
    r2Estimate: r2,
    r2Real,
    r2Error,
    freeTier: {
      r2LimitBytes: limits.r2Bytes,
      dbLimitBytes: limits.dbBytes,
      dbPct: dbBand.pct,
      dbBand: dbBand.band,
      source: limits.source,
    },
    dedup,
    ai,
    note:
      "Table sizes on disk are exact; row counts are Postgres planner estimates (refresh with ANALYZE). " +
      "The measured R2 figure walks the actual bucket; the estimate breaks it down by what records sizes " +
      "(revisions, photos) — the gap is ticket attachments, knowledge PDFs, and orphans.",
  });
}

/** POST { orgId, r2LimitBytes, dbLimitBytes } — set the hosting-plan storage
 *  ceilings (Admin). Stored in platform_settings: survives deploys, applies
 *  instantly to every bar and the cron watchdog. Providers don't expose plan
 *  limits to the credentials this app holds, so the ceiling is an explicit
 *  admin setting; usage is always measured. */
export async function POST(req: NextRequest) {
  let body: { orgId?: string; r2LimitBytes?: number; dbLimitBytes?: number };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const orgId = String(body.orgId ?? "").trim();
  const actor = await authorizeOrgRole(req, orgId, ["Admin", "DocCtrl"]);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const r2LimitBytes = Number(body.r2LimitBytes);
  const dbLimitBytes = Number(body.dbLimitBytes);
  if (!Number.isFinite(r2LimitBytes) || r2LimitBytes <= 0 ||
      !Number.isFinite(dbLimitBytes) || dbLimitBytes <= 0) {
    return NextResponse.json({ error: "r2LimitBytes and dbLimitBytes must be positive numbers." }, { status: 400 });
  }

  const { error } = await actor.admin.from("platform_settings").upsert({
    key: STORAGE_LIMITS_KEY,
    value: { r2Bytes: Math.round(r2LimitBytes), dbBytes: Math.round(dbLimitBytes) },
    updated_by: actor.userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });
  if (error) {
    const missing = error.code === "42P01" || /does not exist/i.test(error.message);
    return NextResponse.json({
      error: missing
        ? "The platform_settings table doesn't exist yet — run migration 20260920 in Supabase first."
        : `Couldn't save the limits: ${error.message}`,
    }, { status: missing ? 424 : 500 });
  }
  return NextResponse.json({ ok: true });
}
