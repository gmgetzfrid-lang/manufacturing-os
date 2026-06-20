// GET /api/admin/storage-stats?orgId=...
//
// Read-only deployment-wide storage/usage snapshot for the admin "Storage &
// Usage" dashboard. Returns per-table sizes + row estimates and an R2 binary
// estimate. Admin-gated; computes nothing destructive. Backed by the
// SECURITY DEFINER functions in migration 20260805 (aggregates only).

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";

export const runtime = "nodejs";

const ADMIN_ROLES = ["Admin", "Manager"];

// Tables the audit flagged as unbounded / archival-critical — surfaced so the
// UI can highlight where attention is needed first.
const WATCH = new Set([
  "audit_logs", "download_audits", "checkout_messages",
  "notifications", "email_notifications", "ticket_comments",
]);

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
  const tables = ((statRows as TableStat[] | null) ?? []).map((t) => ({
    name: t.table_name,
    rows: Math.max(0, Number(t.row_estimate) || 0),
    bytes: Math.max(0, Number(t.total_bytes) || 0),
    watch: WATCH.has(t.table_name),
  }));
  const dbBytes = tables.reduce((a, t) => a + t.bytes, 0);

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

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    db: { totalBytes: dbBytes, tables },
    r2Estimate: r2,
    note:
      "Table sizes on disk are exact; row counts are Postgres planner estimates (refresh with ANALYZE). " +
      "The R2 figure is estimated from records that store a size (document_versions, asset_photos) and " +
      "excludes ticket attachments (no size recorded) and orphaned files — so true R2 usage is higher.",
  });
}
