// /api/admin/purge — selective, guarded purge of disposable rows to free space.
//
//   GET  ?orgId=&days=   → PREVIEW. Counts (and estimates bytes for) the rows a
//                          purge WOULD remove. Changes nothing.
//   POST { orgId, days, tables?, confirm } → DELETE those rows + write a
//                          DATA_PURGE audit row.
//
// Only "purge worry-free" byproducts are eligible — never records. Each target
// keeps a safety floor so a purge can't touch anything still in use:
//   notifications        — read_at IS NOT NULL        (already-read bell items),
//                          never a row that carries one of the server's dedupe
//                          watermarks (DELIV-8 dw3: deleting one re-armed the
//                          escalation it remembered)
//   email_notifications  — status = sent              (delivered queue rows)
//   email_notifications  — status = suppressed, listed as its OWN line
//     (abandoned)          (DELIV-8, notifications Round G N6): mail an earlier
//                          build parked and never sent. It was purged as
//                          "delivered"; now the plan shows what is abandoned —
//                          count, kinds, dates — before the confirm, and the
//                          DATA_PURGE row records it
//   ai_usage_events      — before the current UTC month only (the AI spend
//                          ledger: every monthly AI cap is enforced from the
//                          month's rows, so they are never purge-eligible —
//                          GOV-4 / GOV-10, intelligence Round G)
// Everything is scoped to the caller's org and older than `days`
// (min 7, default 90). Destructive, so it's gated tighter than the read-only
// stats endpoint: Admin / DocCtrl only.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { monthStartIso } from "@/lib/ai/usageServer";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const PURGE_ROLES = ["Admin", "DocCtrl"];
const MIN_DAYS = 7;
const DEFAULT_DAYS = 90;

interface PurgeTarget {
  /** The target's name in the plan, the `tables` subset and the audit row —
   *  the table's own name, except the abandoned-email line. */
  key: string;
  table: string;
  label: string;
  reason: string;
}

const TARGETS: PurgeTarget[] = [
  {
    key: "notifications",
    table: "notifications",
    label: "Read in-app notifications",
    reason: "Bell items the recipient has already read. Disposable once read and aged — the lasting record of any action lives in the audit log. Rows the daily scans use to remember an escalation they already sent are kept, so a purge never re-sends one.",
  },
  {
    key: "email_notifications",
    table: "email_notifications",
    label: "Delivered email queue rows",
    reason: "Outbound emails already sent. The delivery is done; the queue row is a disposable byproduct.",
  },
  {
    key: "email_notifications_suppressed",
    table: "email_notifications",
    label: "Abandoned email queue rows (never sent)",
    reason: "Emails an earlier version parked as 'suppressed' while email was not configured, older than the drain's 7-day recovery window. They were never delivered and will never be sent; purging drops the only copy. The purge's audit row records how many, of which kinds and from when.",
  },
  {
    key: "ai_usage_events",
    table: "ai_usage_events",
    label: "AI spend ledger (past months)",
    reason: "Per-call AI meter rows — the ledger every monthly AI cap is enforced from. Only rows from before this month are ever eligible, whatever the window: this month's rows are the spend the caps count.",
  },
];

/** The cutoff a target is purged to. For the AI spend ledger it is never
 *  later than the first instant of the current UTC month (the ledger
 *  boundary getMonthUsage reads from): deleting this month's rows would
 *  lower the month's recorded spend and reopen a cap someone reached — the
 *  purger's own included — with no second signature (GOV-4 / GOV-10). */
function cutoffFor(table: string, cutoffIso: string): string {
  if (table !== "ai_usage_events") return cutoffIso;
  const floor = monthStartIso();
  return cutoffIso < floor ? cutoffIso : floor;
}

/** DELIV-8 dw3: the server's dedupe watermarks — the metadata keys and kinds
 *  20261160's enforce_notification_insert() refuses from a browser, because
 *  the daily scans read them to remember an escalation they already sent
 *  (a stale checkout, an aging hold, a review-health nudge, an ack
 *  escalation, an unstampable transmittal). A read row carrying one is never
 *  purged. lib/__tests__/maintenanceDrain.test.ts pins both lists to the
 *  NEWEST definition of that function. */
const PURGE_KEEPS_WATERMARK_KEYS = ["staleSessionId", "staleHoldId", "reviewHealthDay", "ackEscalation"];
const PURGE_KEEPS_KINDS = ["transmittal_unstampable", "storage_alert", "storage_platform_r2", "storage_platform_db"];

/** A PostgREST filter builder (a count or a delete) — kept structural: the
 *  generated builder types are too deep to thread through one helper. */
type FilterBuilder = {
  not: (column: string, op: string, value: unknown) => FilterBuilder;
  is: (column: string, value: null) => FilterBuilder;
  eq: (column: string, value: unknown) => FilterBuilder;
} & PromiseLike<{ count?: number | null; error: { message: string } | null }>;

/** The rows a target may purge — its safety floor — on a count or a delete. */
function floorOf(key: string, q: FilterBuilder): FilterBuilder {
  if (key === "notifications") {
    let n = q.not("read_at", "is", null).not("kind", "in", `(${PURGE_KEEPS_KINDS.join(",")})`);
    for (const k of PURGE_KEEPS_WATERMARK_KEYS) n = n.is(`metadata->>${k}`, null);
    return n;
  }
  if (key === "email_notifications") return q.eq("status", "sent");
  if (key === "email_notifications_suppressed") return q.eq("status", "suppressed");
  return q;
}

/** What purging the abandoned-email line would drop, by kind and date — for
 *  the plan line's reason and the DATA_PURGE row. Best-effort: an unreadable
 *  breakdown leaves the count (exact) to speak. */
async function abandonedDetail(sb: SupabaseClient, orgId: string, cutoffIso: string): Promise<{ byEventType: Record<string, number>; oldest: string | null; newest: string | null } | null> {
  try {
    const { data, error } = await sb
      .from("email_notifications")
      .select("event_type, created_at")
      .eq("org_id", orgId)
      .lt("created_at", cutoffIso)
      .eq("status", "suppressed");
    if (error || !Array.isArray(data)) return null;
    const byEventType: Record<string, number> = {};
    let oldest: string | null = null;
    let newest: string | null = null;
    for (const r of data as Array<{ event_type: string | null; created_at: string | null }>) {
      const k = r.event_type || "unknown";
      byEventType[k] = (byEventType[k] ?? 0) + 1;
      if (r.created_at && (!oldest || r.created_at < oldest)) oldest = r.created_at;
      if (r.created_at && (!newest || r.created_at > newest)) newest = r.created_at;
    }
    return { byEventType, oldest, newest };
  } catch {
    return null;
  }
}

function describeAbandoned(d: { byEventType: Record<string, number>; oldest: string | null; newest: string | null }): string {
  const kinds = Object.entries(d.byEventType).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ");
  const span = d.oldest && d.newest ? ` queued ${d.oldest.slice(0, 10)} to ${d.newest.slice(0, 10)} (UTC)` : "";
  return kinds ? ` These are: ${kinds}${span}.` : "";
}

function clampDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.max(MIN_DAYS, Math.floor(n));
}

async function countTarget(
  sb: SupabaseClient,
  t: PurgeTarget,
  orgId: string,
  cutoffIso: string,
): Promise<number> {
  const base = sb
    .from(t.table)
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .lt("created_at", cutoffIso);
  const { count, error } = await floorOf(t.key, base as unknown as FilterBuilder);
  if (error) throw new Error(`${t.key}: ${error.message}`);
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

  // Each line's `table` is its key (the page keys and labels lines by it);
  // `sourceTable` is the table it purges.
  const targets: Array<Omit<PurgeTarget, "key"> & { sourceTable: string; rows: number; estBytes: number; cutoffIso: string }> = [];
  let totalRows = 0;
  let totalEstBytes = 0;
  for (const t of TARGETS) {
    const cut = cutoffFor(t.table, cutoffIso);
    let rows = 0;
    try {
      rows = await countTarget(sb, t, orgId, cut);
    } catch {
      // A target table that isn't migrated yet simply contributes nothing.
      rows = 0;
    }
    let reason = t.reason;
    if (t.key === "email_notifications_suppressed" && rows > 0) {
      const d = await abandonedDetail(sb, orgId, cut);
      if (d) reason += describeAbandoned(d);
    }
    const estBytes = Math.round((avgBytes.get(t.table) ?? 0) * rows);
    targets.push({ table: t.key, sourceTable: t.table, label: t.label, reason, rows, estBytes, cutoffIso: cut });
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

  // Optional subset; default to every eligible target. A table name selects
  // every line of that table ("email_notifications" = delivered + abandoned,
  // as before); a line's key selects that line alone.
  const requested = Array.isArray(body.tables) && body.tables.length > 0
    ? TARGETS.filter((t) => body.tables!.includes(t.key) || body.tables!.includes(t.table))
    : TARGETS;

  const deleted: Array<{ table: string; rows: number; cutoffIso: string; error?: string; abandoned?: unknown }> = [];
  let totalDeleted = 0;
  for (const t of requested) {
    const cut = cutoffFor(t.table, cutoffIso);
    try {
      // Count first so we can report an exact number, then delete the same set.
      const rows = await countTarget(sb, t, orgId, cut);
      // DELIV-8: what an abandoned-email purge drops is recorded before it goes.
      const abandoned = t.key === "email_notifications_suppressed" && rows > 0 ? await abandonedDetail(sb, orgId, cut) : null;
      if (rows > 0) {
        const base = sb
          .from(t.table)
          .delete()
          .eq("org_id", orgId)
          .lt("created_at", cut);
        const { error } = await floorOf(t.key, base as unknown as FilterBuilder);
        if (error) throw new Error(error.message);
      }
      deleted.push({ table: t.key, rows, cutoffIso: cut, ...(abandoned ? { abandoned } : {}) });
      totalDeleted += rows;
    } catch (e) {
      deleted.push({ table: t.key, rows: 0, cutoffIso: cut, error: (e as Error).message });
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
