// /api/admin/purge — selective, guarded purge of disposable rows to free space.
//
//   GET  ?orgId=&days=   → PREVIEW. Counts (and estimates bytes for) the rows a
//                          purge WOULD remove. Changes nothing.
//   POST { orgId, days, tables?, confirm } → DELETE those rows + write a
//                          DATA_PURGE audit row.
//
// Only "purge worry-free" byproducts are eligible — never records. Each target
// keeps a safety floor so a purge can't touch anything still in use:
//   notifications        — read_at IS NOT NULL        (already-read bell items)
//   email_notifications  — status IN (sent,suppressed) (delivered queue rows)
//   ai_usage_events      — (pure telemetry)
// Everything is scoped to the caller's org and older than `days`
// (min 7, default 90). Destructive, so it's gated tighter than the read-only
// stats endpoint: Admin / DocCtrl only.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const PURGE_ROLES = ["Admin", "DocCtrl"];
const MIN_DAYS = 7;
const DEFAULT_DAYS = 90;

interface PurgeTarget {
  table: string;
  label: string;
  reason: string;
}

const TARGETS: PurgeTarget[] = [
  {
    table: "notifications",
    label: "Read in-app notifications",
    reason: "Bell items the recipient has already read. Disposable once read and aged — the lasting record of any action lives in the audit log.",
  },
  {
    table: "email_notifications",
    label: "Delivered email queue rows",
    reason: "Outbound emails already sent or suppressed. The delivery is done; the queue row is a disposable byproduct.",
  },
  {
    table: "ai_usage_events",
    label: "AI usage telemetry",
    reason: "Per-call AI meter rows. Valuable while recent (rate visibility); pure telemetry once aged.",
  },
];

function clampDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.max(MIN_DAYS, Math.floor(n));
}

async function countTarget(
  sb: SupabaseClient,
  table: string,
  orgId: string,
  cutoffIso: string,
): Promise<number> {
  const base = sb
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .lt("created_at", cutoffIso);
  const q =
    table === "notifications" ? base.not("read_at", "is", null) :
    table === "email_notifications" ? base.in("status", ["sent", "suppressed"]) :
    base;
  const { count, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

// ─── PREVIEW ────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const days = clampDays(req.nextUrl.searchParams.get("days"));
  const actor = await authorizeOrgRole(req, orgId, PURGE_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  const sb = actor.admin;

  const cutoffIso = new Date(Date.now() - days * 86400 * 1000).toISOString();

  // Per-table average row size (whole-table) to estimate reclaimable bytes.
  const avgBytes = new Map<string, number>();
  try {
    const { data: statRows } = await sb.rpc("mfg_table_stats");
    for (const r of (statRows as Array<{ table_name: string; row_estimate: number; total_bytes: number }> | null) ?? []) {
      const rows = Math.max(1, Number(r.row_estimate) || 0);
      avgBytes.set(r.table_name, (Number(r.total_bytes) || 0) / rows);
    }
  } catch { /* estimate is best-effort */ }

  const targets: Array<PurgeTarget & { rows: number; estBytes: number }> = [];
  let totalRows = 0;
  let totalEstBytes = 0;
  for (const t of TARGETS) {
    let rows = 0;
    try {
      rows = await countTarget(sb, t.table, orgId, cutoffIso);
    } catch {
      // A target table that isn't migrated yet simply contributes nothing.
      rows = 0;
    }
    const estBytes = Math.round((avgBytes.get(t.table) ?? 0) * rows);
    targets.push({ ...t, rows, estBytes });
    totalRows += rows;
    totalEstBytes += estBytes;
  }

  return NextResponse.json({
    orgScoped: true,
    cutoffDays: days,
    cutoffIso,
    targets,
    totalRows,
    totalEstBytes,
    note:
      "Counts are exact for your workspace; byte figures are estimates from average row size " +
      "(actual reclaim depends on Postgres VACUUM). Only disposable byproducts are listed — records are never eligible.",
  });
}

// ─── PURGE ──────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: { orgId?: string; days?: number; tables?: string[]; confirm?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const orgId = body.orgId || "";
  const actor = await authorizeOrgRole(req, orgId, PURGE_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (body.confirm !== true) {
    return NextResponse.json({ error: "Confirmation required: pass confirm:true to purge." }, { status: 400 });
  }
  const sb = actor.admin;
  const days = clampDays(body.days);
  const cutoffIso = new Date(Date.now() - days * 86400 * 1000).toISOString();

  // Optional subset; default to every eligible target.
  const requested = Array.isArray(body.tables) && body.tables.length > 0
    ? TARGETS.filter((t) => body.tables!.includes(t.table))
    : TARGETS;

  const deleted: Array<{ table: string; rows: number; error?: string }> = [];
  let totalDeleted = 0;
  for (const t of requested) {
    try {
      // Count first so we can report an exact number, then delete the same set.
      const rows = await countTarget(sb, t.table, orgId, cutoffIso);
      if (rows > 0) {
        const base = sb
          .from(t.table)
          .delete()
          .eq("org_id", orgId)
          .lt("created_at", cutoffIso);
        const dq =
          t.table === "notifications" ? base.not("read_at", "is", null) :
          t.table === "email_notifications" ? base.in("status", ["sent", "suppressed"]) :
          base;
        const { error } = await dq;
        if (error) throw new Error(error.message);
      }
      deleted.push({ table: t.table, rows });
      totalDeleted += rows;
    } catch (e) {
      deleted.push({ table: t.table, rows: 0, error: (e as Error).message });
    }
  }

  // Purging is itself an audited action — chain of custody for what was removed.
  try {
    await sb.from("audit_logs").insert({
      action: "DATA_PURGE",
      resource_id: orgId,
      resource_type: "org",
      org_id: orgId,
      user_id: actor.userId,
      user_email: actor.email,
      details: { cutoffDays: days, cutoffIso, deleted, totalDeleted },
    });
  } catch { /* never block the purge result on the audit insert */ }

  return NextResponse.json({ ok: true, cutoffDays: days, deleted, totalDeleted });
}
