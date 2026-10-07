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
//   email_notifications  — status = sent              (delivered queue rows;
//                          line key email_notifications_sent)
//   email_notifications  — status = suppressed, listed as its OWN line
//     (abandoned)          (DELIV-8, notifications Round G N6): mail an earlier
//                          build parked and never sent. It was purged as
//                          "delivered"; now the plan shows what is abandoned —
//                          count, kinds, dates — before the confirm, and an
//                          audit row records it BEFORE the delete (no record,
//                          no delete)
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
   *  the table's own name, except the two email lines, which each have their
   *  own (N6 fix pass 2: a table name never stands for both). */
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
    key: "email_notifications_sent",
    table: "email_notifications",
    label: "Delivered email queue rows",
    reason: "Outbound emails already sent. The delivery is done; the queue row is a disposable byproduct.",
  },
  {
    key: "email_notifications_suppressed",
    table: "email_notifications",
    label: "Abandoned email queue rows (never sent)",
    reason: "Emails an earlier version parked as 'suppressed' while email was not configured, older than the drain's 7-day recovery window. They were never delivered and will never be sent; purging drops the only copy. Before they are deleted an audit row records how many, of which kinds and from when — if that record cannot be written, they are not deleted.",
  },
  {
    key: "ai_usage_events",
    table: "ai_usage_events",
    label: "AI spend ledger (past months)",
    reason: "Per-call AI meter rows — the ledger every monthly AI cap is enforced from. Only rows from before this month are ever eligible, whatever the window: this month's rows are the spend the caps count.",
  },
];

/** A name an earlier client sent in `tables`, and the ONE line it selects now
 *  (DELIV-8, N6 fix pass 2). Bare "email_notifications" once meant "sent or
 *  suppressed"; it selects the delivered line alone — the abandoned line, the
 *  only copy of mail never sent, is purged only when named by its own key (or
 *  when no subset is given). The GET plan lists these aliases. */
const LEGACY_TARGET_NAMES: Record<string, string> = { email_notifications: "email_notifications_sent" };

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

/** A read of the abandoned line (abandonedDetail) — structural, like
 *  FilterBuilder. */
type ScanBuilder = {
  eq: (column: string, value: unknown) => ScanBuilder;
  lt: (column: string, value: unknown) => ScanBuilder;
  gt: (column: string, value: unknown) => ScanBuilder;
  not: (column: string, op: string, value: unknown) => ScanBuilder;
  is: (column: string, value: null) => ScanBuilder;
  order: (column: string, options: { ascending: boolean }) => ScanBuilder;
  limit: (n: number) => ScanBuilder;
} & PromiseLike<{ data?: unknown; count?: number | null; error: { message: string } | null }>;

/** The rows a target may purge — its safety floor — on a count or a delete. */
function floorOf(key: string, q: FilterBuilder): FilterBuilder {
  if (key === "notifications") {
    let n = q.not("read_at", "is", null).not("kind", "in", `(${PURGE_KEEPS_KINDS.join(",")})`);
    for (const k of PURGE_KEEPS_WATERMARK_KEYS) n = n.is(`metadata->>${k}`, null);
    return n;
  }
  if (key === "email_notifications_sent") return q.eq("status", "sent");
  if (key === "email_notifications_suppressed") return q.eq("status", "suppressed");
  return q;
}

/** What purging the abandoned-email line drops. */
interface AbandonedDetail {
  byEventType: Record<string, number>;
  oldest: string | null;
  newest: string | null;
  /** More kinds than ABANDONED_KINDS_MAX: byEventType names the first ones. */
  moreKinds?: true;
}
/** How many distinct kinds the breakdown names (the app has fewer than 30). */
const ABANDONED_KINDS_MAX = 50;

/** What purging the abandoned-email line would drop, by kind and date — for
 *  the plan line's reason and the audit row written before the delete.
 *  Exact, whatever the volume (DELIV-8, N6 fix pass): never a bulk read the
 *  API's row cap truncates. The kinds are walked one at a time (the next
 *  kind above the last, one row each) and each is a head count; the dates
 *  are two ordered one-row reads. Null when any read fails — the line's own
 *  count (exact) then speaks alone. */
async function abandonedDetail(sb: SupabaseClient, orgId: string, cutoffIso: string): Promise<AbandonedDetail | null> {
  // The abandoned line's rows, on a read of `columns` (a head count when
  // `count`) — kept structural, as FilterBuilder is.
  const scoped = (columns: string, count = false): ScanBuilder =>
    (sb.from("email_notifications").select(columns, count ? { count: "exact", head: true } : undefined) as unknown as ScanBuilder)
      .eq("org_id", orgId).lt("created_at", cutoffIso).eq("status", "suppressed");
  try {
    const byEventType: Record<string, number> = {};
    let moreKinds = false;
    let last: string | null = null;
    for (let i = 0; ; i++) {
      let q = scoped("event_type").not("event_type", "is", null);
      if (last !== null) q = q.gt("event_type", last);
      const { data, error } = await q.order("event_type", { ascending: true }).limit(1);
      if (error) return null;
      const next = (data as Array<{ event_type: string | null }> | null)?.[0]?.event_type ?? null;
      if (next === null) break;
      if (i >= ABANDONED_KINDS_MAX) { moreKinds = true; break; }
      const { count, error: countErr } = await scoped("id", true).eq("event_type", next);
      if (countErr || typeof count !== "number") return null;
      if (count > 0) byEventType[next] = count;
      last = next;
    }
    const { count: untyped, error: untypedErr } = await scoped("id", true).is("event_type", null);
    if (untypedErr || typeof untyped !== "number") return null;
    if (untyped > 0) byEventType.unknown = untyped;
    const edge = async (ascending: boolean): Promise<string | null | undefined> => {
      const { data, error } = await scoped("created_at").order("created_at", { ascending }).limit(1);
      if (error) return undefined;
      return ((data as Array<{ created_at: string | null }> | null)?.[0]?.created_at ?? null);
    };
    const [oldest, newest] = await Promise.all([edge(true), edge(false)]);
    if (oldest === undefined || newest === undefined) return null;
    return { byEventType, oldest, newest, ...(moreKinds ? { moreKinds: true as const } : {}) };
  } catch {
    return null;
  }
}

function describeAbandoned(d: AbandonedDetail): string {
  const kinds = Object.entries(d.byEventType).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, n]) => `${n} ${k}`).join(", ") +
    (d.moreKinds ? ", and further kinds" : "");
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
    // A purge's `tables` names lines by their `table` key above; these older
    // names are still accepted, each for the one line given.
    legacyTableNames: LEGACY_TARGET_NAMES,
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

  // Optional subset; default to every eligible target. Each name selects the
  // one line whose key it is (N6 fix pass 2: never every line of a table — a
  // client keying lines by table name would otherwise purge the abandoned
  // mail it never selected); an older name selects the line
  // LEGACY_TARGET_NAMES gives it.
  const named = new Set((Array.isArray(body.tables) ? body.tables : []).map((n) => (Object.hasOwn(LEGACY_TARGET_NAMES, n) ? LEGACY_TARGET_NAMES[n] : n)));
  const requested = named.size > 0 ? TARGETS.filter((t) => named.has(t.key)) : TARGETS;

  const deleted: Array<{ table: string; rows: number; cutoffIso: string; error?: string; abandoned?: unknown }> = [];
  let totalDeleted = 0;
  for (const t of requested) {
    const cut = cutoffFor(t.table, cutoffIso);
    try {
      // Count first so we can report an exact number, then delete the same set.
      const rows = await countTarget(sb, t, orgId, cut);
      // DELIV-8 (N6 fix pass): what an abandoned-email purge drops — the only
      // copy of mail never sent — is recorded BEFORE it goes, in an audit row
      // of its own; a record that cannot be written means no delete.
      const abandoned = t.key === "email_notifications_suppressed" && rows > 0 ? await abandonedDetail(sb, orgId, cut) : null;
      if (t.key === "email_notifications_suppressed" && rows > 0) {
        const { error: recErr } = await sb.from("audit_logs").insert({
          action: "DATA_PURGE_ABANDONED_EMAIL",
          resource_id: orgId,
          resource_type: "org",
          org_id: orgId,
          user_id: actor.userId,
          user_email: actor.email,
          details: { cutoffDays: days, cutoffIso: cut, rows, abandoned: abandoned ?? "the breakdown could not be read; the count is exact" },
        });
        if (recErr) throw new Error(`not purged — the record of what it holds could not be written first: ${recErr.message}`);
      }
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

  // Purging is itself an audited action — chain of custody for what was
  // removed. The deletes have happened either way; a refused or failed audit
  // row is reported in the answer, never a silent success (N6 fix pass).
  let auditError: string | null = null;
  try {
    const { error } = await sb.from("audit_logs").insert({
      action: "DATA_PURGE",
      resource_id: orgId,
      resource_type: "org",
      org_id: orgId,
      user_id: actor.userId,
      user_email: actor.email,
      details: { cutoffDays: days, cutoffIso, deleted, totalDeleted },
    });
    if (error) auditError = error.message;
  } catch (e) {
    auditError = (e as Error).message || String(e);
  }
  if (auditError) console.error("[admin/purge] the DATA_PURGE audit row was not written", auditError);

  return NextResponse.json({
    ok: true, cutoffDays: days, deleted, totalDeleted,
    ...(auditError ? { auditError: `the purge ran but its DATA_PURGE audit row was not written: ${auditError}` } : {}),
  });
}
