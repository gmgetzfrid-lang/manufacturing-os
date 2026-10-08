// GET /api/admin/storage-stats?orgId=...
//
// The admin "Storage & Usage" dashboard's snapshot. Computes nothing
// destructive. Backed by the SECURITY DEFINER functions in migration 20260805
// (aggregates only).
//
// admin-and-org Round G, P6 (BILL-5 / BILL-12 / BILL-13; DEC-44 (A&O P6)):
//   * The WORKSPACE's own files are always measured, under its own key
//     prefix (orgs/<id>/) — that is the figure its quota is compared to.
//   * The DEPLOYMENT's figures (every table's size and row estimate, the
//     whole bucket, the plan ceilings, dedup, shared AI usage) are returned
//     only to a member who may see them: a platform operator, or a member of
//     the ONE workspace on a single-workspace deployment (its own figures).
//     On a shared server anyone else gets `scope: "workspace"` and those
//     fields are null — another tenant's totals are not theirs to read.
//   * The bucket walk has a deadline (BILL-13): it stops in time and says it
//     is partial; `maxDuration` covers it and the RPCs.
// SURF-19: the gate is lib/adminGate.ts — GET under the storage surface's
// entry rule, POST under its writes set (the sets these handlers spelled as
// constants before; who is admitted is unchanged).

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { classifyTable, type DataClass } from "@/lib/storageClassify";
import {
  measureR2Usage, loadPlatformLimits, resolvePlatformLimits, storageScopeFor, readPlatformOperators, orgStoragePrefix,
  platformOperatorSql, STORAGE_LIMITS_KEY, PLATFORM_OPERATORS_MIGRATION,
} from "@/lib/storageUsage";
import { alertBand } from "@/lib/storageAlerts";

export const runtime = "nodejs";
// BILL-13: the walk below stops by WALK_BUDGET_MS; the RPCs before it are
// sub-second aggregates. 60 s holds both with room.
export const maxDuration = 60;
const WALK_BUDGET_MS = 40_000;

interface TableStat { table_name: string; row_estimate: number; total_bytes: number }
interface StorageEst {
  versions_bytes: number; photos_bytes: number; knowledge_bytes?: number;
  version_count: number; photo_count: number; knowledge_count?: number;
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeAdminSurface(req, orgId, "storage");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  const sb = actor.admin;
  const { scope, operator, soleTenant } = await storageScopeFor(sb, orgId, actor.userId);
  const deadlineMs = Date.now() + WALK_BUDGET_MS;

  if (scope === "workspace") {
    // A shared server, and not an operator: only this workspace's own files.
    let files: Awaited<ReturnType<typeof measureR2Usage>> | null = null;
    let filesError: string | null = null;
    try {
      files = await measureR2Usage({ prefix: orgStoragePrefix(orgId), deadlineMs });
    } catch (e) {
      filesError = (e as Error).message;
    }
    // AI usage for THIS workspace (the deployment-wide count is not theirs).
    let ai: { last24h: number; last30d: number } | null = null;
    try {
      const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const since30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
      const [a, b] = await Promise.all([
        sb.from("ai_usage_events").select("*", { count: "exact", head: true }).eq("org_id", orgId).gte("created_at", since24),
        sb.from("ai_usage_events").select("*", { count: "exact", head: true }).eq("org_id", orgId).gte("created_at", since30),
      ]);
      if (!a.error && !b.error) ai = { last24h: a.count ?? 0, last30d: b.count ?? 0 };
    } catch { ai = null; }
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      scope,
      platformOperator: operator,
      soleTenant,
      operatorSql: operator ? null : platformOperatorSql(actor.userId),
      workspace: { files, filesError },
      db: null, r2Estimate: null, r2Real: null, r2Error: null, freeTier: null, dedup: null,
      ai,
      note:
        "This workspace shares its server with other workspaces, so only its own files are shown, measured " +
        "from the bucket under this workspace's own storage prefix. The database's tables, the whole bucket and " +
        "the hosting-plan ceilings are deployment-wide: a platform operator sees them.",
    });
  }

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
  // The workspace's own total comes from the same walk (no second pass).
  let workspaceFiles: { bytes: number; objects: number; newest: string | null; truncated: boolean; stoppedBy: string | null } | null = null;
  try {
    const { org, ...measured } = await measureR2Usage({ deadlineMs, orgTotalFor: orgId });
    const band = alertBand(measured.bytes, limits.r2Bytes);
    // A truncated walk is a floor, not a total — never band it "ok".
    r2Real = { ...measured, pct: band.pct, band: measured.truncated && band.band === "ok" ? "warn" : band.band };
    if (org) workspaceFiles = { ...org, truncated: measured.truncated, stoppedBy: measured.stoppedBy ?? null };
  } catch (e) {
    r2Real = null;
    r2Error = (e as Error).message;
  }
  const dbBand = alertBand(dbBytes, limits.dbBytes);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    scope,
    platformOperator: operator,
    // Who the platform watchdog tells (lib/storageUsage.ts
    // platformAlertRecipients): the sole workspace's Admin / DocCtrl, or the
    // platform operators — the page names the right one.
    soleTenant,
    operatorSql: operator ? null : platformOperatorSql(actor.userId),
    workspace: { files: workspaceFiles, filesError: r2Error },
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
      "Deployment-wide figures (every workspace on this server): table sizes on disk are exact; row counts are " +
      "Postgres planner estimates (refresh with ANALYZE). The measured R2 figure walks the actual bucket; the " +
      "estimate breaks it down by what records sizes (revisions, photos) — the gap is ticket attachments, " +
      "knowledge PDFs, and orphans. The storage limit is compared to this workspace's own files only.",
  });
}

/** POST { orgId, r2LimitBytes, dbLimitBytes } — set the hosting-plan storage
 *  ceilings. Stored in platform_settings: survives deploys, applies
 *  instantly to every bar and the cron watchdog. Providers don't expose plan
 *  limits to the credentials this app holds, so the ceiling is an explicit
 *  setting; usage is always measured.
 *
 *  BILL-5 (DEC-44 (A&O P6)): the ceilings are ONE deployment-wide row that
 *  bands every workspace on the server, so no org role may set them — not
 *  Admin, not DocCtrl, of any org. Only a platform operator may (a uid in
 *  platform_settings 'platform_operators', which only the service role can
 *  write). The storage surface's writes set still gates the route first
 *  (SURF-19: who reaches it is unchanged); the operator rule is the second
 *  rail. BILL-7: the change writes an audit row with the old and new values,
 *  checked. The old values are read from the row itself, checked: a failed
 *  read refuses the change (nothing saved) rather than recording the
 *  free-tier fallback as what the ceilings were. */
export async function POST(req: NextRequest) {
  let body: { orgId?: string; r2LimitBytes?: number; dbLimitBytes?: number };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const orgId = String(body.orgId ?? "").trim();
  const actor = await authorizeAdminSurface(req, orgId, "storage", "write");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const ops = await readPlatformOperators(actor.admin);
  if (ops.error) {
    return NextResponse.json({ error: `Couldn't check who may change the plan ceilings — nothing was saved. (${ops.error})` }, { status: 503 });
  }
  if (!ops.uids.includes(actor.userId)) {
    return NextResponse.json({
      error:
        "The hosting-plan ceilings are one setting for this whole server, shared by every workspace on it, so only a " +
        "platform operator can change them. The deployment's owner registers operators in the Supabase SQL editor " +
        `(see ${PLATFORM_OPERATORS_MIGRATION}).`,
      operatorRequired: true,
    }, { status: 403 });
  }

  const r2LimitBytes = Number(body.r2LimitBytes);
  const dbLimitBytes = Number(body.dbLimitBytes);
  if (!Number.isFinite(r2LimitBytes) || r2LimitBytes <= 0 ||
      !Number.isFinite(dbLimitBytes) || dbLimitBytes <= 0) {
    return NextResponse.json({ error: "r2LimitBytes and dbLimitBytes must be positive numbers." }, { status: 400 });
  }

  // BILL-7: what the ceilings were, for the audit row — read and CHECKED, as
  // archive-settings reads its prior row. loadPlatformLimits would fall back
  // to env / free-tier figures on a failed read and record them as the old
  // value; here a failed read saves nothing. No row is not a failure: the
  // ceilings then were the env override or the free tier, and `source` says so.
  const { data: priorRow, error: priorErr } = await actor.admin
    .from("platform_settings").select("value").eq("key", STORAGE_LIMITS_KEY).maybeSingle();
  if (priorErr) {
    const missing = priorErr.code === "42P01" || /does not exist/i.test(priorErr.message);
    return NextResponse.json({
      error: missing
        ? "The platform_settings table doesn't exist yet — run migration 20260920 in Supabase first."
        : `Couldn't read the current ceilings, so the change could not be recorded against them — nothing was saved. (${priorErr.message})`,
    }, { status: missing ? 424 : 503 });
  }
  const before = resolvePlatformLimits((priorRow as { value?: unknown } | null)?.value ?? null);
  const after = { r2Bytes: Math.round(r2LimitBytes), dbBytes: Math.round(dbLimitBytes) };
  const { error } = await actor.admin.from("platform_settings").upsert({
    key: STORAGE_LIMITS_KEY,
    value: after,
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

  // BILL-7: the row names the actor (a real uid) and both values. Checked —
  // a refused row is said on the answer; the change itself has landed.
  const { error: auditErr } = await actor.admin.from("audit_logs").insert({
    action: "PLATFORM_STORAGE_LIMITS_CHANGED",
    resource_id: STORAGE_LIMITS_KEY,
    resource_type: "platform_settings",
    org_id: orgId,
    user_id: actor.userId,
    user_email: actor.email || null,
    user_role: actor.admittedRole,
    details: {
      scope: "deployment",
      before: { r2Bytes: before.r2Bytes, dbBytes: before.dbBytes, source: before.source },
      after,
    },
  });
  if (auditErr) {
    return NextResponse.json({
      ok: true,
      warning: `The ceilings were saved, but the audit record of the change was refused (${auditErr.message}).`,
    });
  }
  return NextResponse.json({ ok: true });
}
