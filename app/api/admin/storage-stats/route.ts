// GET /api/admin/storage-stats?orgId=...
//
// Read-only deployment-wide storage/usage snapshot for the admin "Storage &
// Usage" dashboard. Returns per-table sizes + row estimates and an R2 binary
// estimate. Admin-gated; computes nothing destructive. Backed by the
// SECURITY DEFINER functions in migration 20260805 (aggregates only).

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { classifyTable, type DataClass } from "@/lib/storageClassify";

export const runtime = "nodejs";

const ADMIN_ROLES = ["Admin", "Manager", "DocCtrl"];

interface TableStat { table_name: string; row_estimate: number; total_bytes: number }
interface StorageEst { versions_bytes: number; photos_bytes: number; version_count: number; photo_count: number }

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

  let r2 = { totalBytes: 0, versionsBytes: 0, photosBytes: 0, versionCount: 0, photoCount: 0 };
  const { data: estRows } = await sb.rpc("mfg_storage_estimate");
  const est = ((estRows as StorageEst[] | null) ?? [])[0];
  if (est) {
    const versionsBytes = Number(est.versions_bytes) || 0;
    const photosBytes = Number(est.photos_bytes) || 0;
    r2 = {
      totalBytes: versionsBytes + photosBytes,
      versionsBytes,
      photosBytes,
      versionCount: Number(est.version_count) || 0,
      photoCount: Number(est.photo_count) || 0,
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

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    db: { totalBytes: dbBytes, tables, byCategory },
    r2Estimate: r2,
    dedup,
    ai,
    note:
      "Table sizes on disk are exact; row counts are Postgres planner estimates (refresh with ANALYZE). " +
      "The R2 figure is estimated from records that store a size (document_versions, asset_photos) and " +
      "excludes ticket attachments (no size recorded) and orphaned files — so true R2 usage is higher.",
  });
}
