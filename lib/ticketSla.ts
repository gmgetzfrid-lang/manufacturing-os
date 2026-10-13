// lib/ticketSla.ts
//
// drafting-flow GAP-106 / EDGE-7 / ROUTE-9 (Round G, DF-P3): the drafting
// request SLA clock finally has a reader. Every request is born with a
// `target_completion_at`; before this file nothing on the server ever looked
// at it, `sla_breach_warned_at` / `sla_breached_at` were never written, and
// the "SLA warnings" preference gated nothing.
//
// The model (the plan's default, ratified by the integrator under the user's
// delegation, 2026-10-07):
//   * WARN at SLA_WARN_FRACTION (75 %) of the window — created_at to the
//     target — to the party the ticket is waiting on in its CURRENT status,
//     with the status's routed pool (lib/ticketRouting.ts — LEAK-1's
//     resolver), falling back to the assignment queue's owners when the
//     status names nobody.
//   * BREACH at the target: the same people, the assignment queue's owners
//     (the people who can reassign — "escalate above them") and the
//     requester.
//   * Escalation is a clock, never a decision: nothing here advances, closes
//     or reassigns a ticket (the gap register's "Do not").
//   * Each stage fires ONCE per ticket: the stamp is claimed compare-and-set
//     (`… IS NULL` and the status the scan read) before anything is sent, so
//     two runs, or a run racing a transition, never send twice; a send that
//     reached nobody releases its claim and is reported, so the next run
//     tries again.
//   * No new cron entry: one step in app/api/cron/maintenance/route.ts.
//
// The warn fraction is a named constant; making it org-configurable is a
// later change (recorded on GAP-106). The window comes from the ticket's own
// `target_completion_at` (stamped at creation from the request type); a
// ticket with none gets one only when its org configured `sla_defaults` for
// its type (default_days from created_at) — DEFAULT_SLA_DAYS is never
// applied retroactively, because a ticket filed months ago with no target
// would otherwise breach on the first run after the deploy.

import type { TicketStatus } from "@/types/schema";
import {
  loadRoutingContext, routedPool, queuePool, type RoutingClient, type RoutingContext,
} from "@/lib/ticketRouting";
import { formatRecordDate } from "@/lib/recordTime";

/** GAP-106: the fraction of the SLA window at which the owner is warned. */
export const SLA_WARN_FRACTION = 0.75;

const DAY_MS = 24 * 3600 * 1000;
const TERMINAL: readonly string[] = ["CLOSED", "CANCELED"];

/** The ticket fields the SLA clock reads. */
export interface SlaTicket {
  id: string;
  orgId: string;
  ticketId?: string | null;
  title?: string | null;
  status: TicketStatus | string;
  requestType?: string | null;
  requesterId?: string | null;
  assignedDrafterId?: string | null;
  assignedEngineerId?: string | null;
  createdAt?: string | null;
  targetCompletionAt?: string | null;
  slaBreachWarnedAt?: string | null;
  slaBreachedAt?: string | null;
}

export type SlaStage = "none" | "warn" | "breach";

const ms = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** The ticket's due time in ms: its own target, else (only) the org's
 *  configured `sla_defaults` days for its type, counted from creation. */
export function effectiveTarget(t: SlaTicket, orgDefaults?: ReadonlyMap<string, number> | null): number | null {
  const own = ms(t.targetCompletionAt);
  if (own !== null) return own;
  const days = t.requestType ? orgDefaults?.get(t.requestType) : undefined;
  const created = ms(t.createdAt);
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0 || created === null) return null;
  return created + days * DAY_MS;
}

/** The moment the warning is due: SLA_WARN_FRACTION of the way from creation
 *  to the target (the target itself when the window is unknown or empty). */
export function warnAt(t: SlaTicket, target: number): number {
  const created = ms(t.createdAt);
  if (created === null || target <= created) return target;
  return created + (target - created) * SLA_WARN_FRACTION;
}

/** Which stage is due NOW and not yet sent. Pure. */
export function slaStage(t: SlaTicket, now: number, target: number | null): SlaStage {
  if (TERMINAL.includes(String(t.status)) || target === null) return "none";
  if (t.slaBreachedAt) return "none";
  if (now >= target) return "breach";
  if (!t.slaBreachWarnedAt && now >= warnAt(t, target)) return "warn";
  return "none";
}

/** The person (if any) the ticket waits on in its current status. */
export function waitingParty(t: SlaTicket): string[] {
  switch (t.status) {
    case "PENDING_ENG_TEAM":
    case "PENDING_FINAL_APPROVAL":
      return t.assignedEngineerId ? [t.assignedEngineerId] : [];
    case "DRAFTING":
    case "REVISION_REQ":
    case "PENDING_IFC":
      return t.assignedDrafterId ? [t.assignedDrafterId] : [];
    case "PENDING_REVIEW":
    case "FINAL_DRAFT":
      return t.requesterId ? [t.requesterId] : [];
    default:
      return [];
  }
}

const uniq = (xs: Array<string | null | undefined>): string[] => Array.from(new Set(xs.filter((x): x is string => !!x)));

/**
 * Who hears about a stage (ROUTE-9 done-when 2: the party responsible for the
 * CURRENT status, never only requester + drafter — an overdue
 * PENDING_ASSIGNMENT ticket has no drafter to nag).
 *  - warn:   the waiting party ∪ the status's routed pool; nobody → the queue.
 *  - breach: that ∪ the assignment queue's owners ∪ the requester.
 */
export function slaRecipients(
  t: SlaTicket, stage: Exclude<SlaStage, "none">, pools: { routed: readonly string[]; queue: readonly string[] },
): string[] {
  let base = uniq([...waitingParty(t), ...pools.routed]);
  if (base.length === 0) base = uniq([...pools.queue]);
  if (stage === "warn") return base;
  return uniq([...base, ...pools.queue, t.requesterId]);
}

export function slaNotice(t: SlaTicket, stage: Exclude<SlaStage, "none">, target: number, timeZone?: string | null): { title: string; body: string } {
  const label = `${t.ticketId ?? ""} ${t.title ?? ""}`.trim() || "A drafting request";
  const due = formatRecordDate(new Date(target).toISOString(), timeZone ?? null);
  return stage === "warn"
    ? { title: `Due soon · ${label}`, body: `This request is due ${due} and has used ${Math.round(SLA_WARN_FRACTION * 100)}% of its time. It is waiting at ${t.status}.` }
    : { title: `Overdue · ${label}`, body: `This request was due ${due} and is still waiting at ${t.status}. Reassign it, or tell the requester when it will be done.` };
}

// ─── the scan (IO; one step of the maintenance cron) ────────────────────────

/** What one emit reached (lib/notify/dispatch.ts EmitResult's shape). */
export interface SlaEmitResult { recipients: number; inapp?: { sent: number; failed: number } }

export interface SlaEmitInput {
  orgId: string;
  category: "sla";
  kind: "ticket_status";
  title: string;
  body: string;
  link: string;
  resource: { type: "ticket"; id: string };
  actorName: string;
  audience: { involved: string[] };
  metadata: Record<string, unknown>;
}

export interface SlaScanDeps {
  /** The service-role client (the cron's). */
  client: RoutingClient;
  /** emit() under the service role (the cron wraps runWithServerClient). */
  emit: (input: SlaEmitInput) => Promise<SlaEmitResult>;
  /** The org's record time zone, for the date in the notice (NEDGE-12). */
  zoneOf?: (orgId: string) => Promise<string | null>;
  now?: number;
  /** Tickets read per page, and the most one run reads. */
  pageSize?: number;
  maxTickets?: number;
  /** Stop starting new tickets past this time (ms epoch). */
  deadlineAt?: number;
}

export interface SlaScanReport {
  scanned: number;
  warned: number;
  breached: number;
  /** Open tickets with no target and no org default for their type. */
  noTarget: number;
  /** Stages due whose notice reached nobody (claim released; retried). */
  unreached: number;
  /** The run stopped before reading every open ticket (page cap / time). */
  truncated: boolean;
  errors: string[];
}

interface Row {
  id: string; org_id: string; ticket_id: string | null; title: string | null; status: string; request_type: string | null;
  requester_id: string | null; assigned_drafter_id: string | null; assigned_engineer_id: string | null;
  created_at: string | null; target_completion_at: string | null; sla_breach_warned_at: string | null; sla_breached_at: string | null;
}

const toTicket = (r: Row): SlaTicket => ({
  id: r.id, orgId: r.org_id, ticketId: r.ticket_id, title: r.title, status: r.status, requestType: r.request_type,
  requesterId: r.requester_id, assignedDrafterId: r.assigned_drafter_id, assignedEngineerId: r.assigned_engineer_id,
  createdAt: r.created_at, targetCompletionAt: r.target_completion_at,
  slaBreachWarnedAt: r.sla_breach_warned_at, slaBreachedAt: r.sla_breached_at,
});

/**
 * Scan every open ticket whose breach has not been sent, and send the stage
 * that is due. Never throws: every failure is a line in `errors`, and a
 * ticket whose org could not be read is left for the next run (no stamp).
 */
export async function runTicketSlaScan(deps: SlaScanDeps): Promise<SlaScanReport> {
  const sb = deps.client;
  const now = deps.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const pageSize = deps.pageSize ?? 500;
  const maxTickets = deps.maxTickets ?? 2000;
  const report: SlaScanReport = { scanned: 0, warned: 0, breached: 0, noTarget: 0, unreached: 0, truncated: false, errors: [] };

  const orgCtx = new Map<string, RoutingContext | null>();
  const orgDefaults = new Map<string, Map<string, number>>();
  const zones = new Map<string, string | null>();
  const contextOf = async (orgId: string): Promise<RoutingContext | null> => {
    if (!orgCtx.has(orgId)) {
      const ctx = await loadRoutingContext(orgId, sb);
      if (!ctx.ok) report.errors.push(`ticket-sla@${orgId}: the members could not be read — no SLA notice was sent for this org: ${ctx.error}`);
      orgCtx.set(orgId, ctx.ok ? ctx : null);
    }
    return orgCtx.get(orgId) ?? null;
  };
  const defaultsOf = async (orgId: string): Promise<Map<string, number>> => {
    if (!orgDefaults.has(orgId)) {
      const m = new Map<string, number>();
      const { data, error } = await sb.from("sla_defaults").select("request_type, default_days").eq("org_id", orgId);
      if (error) report.errors.push(`ticket-sla@${orgId}: sla_defaults could not be read — tickets with no target were skipped: ${error.message}`);
      for (const r of ((data as Array<{ request_type: string; default_days: number }> | null) ?? [])) {
        if (r.request_type && Number(r.default_days) > 0) m.set(r.request_type, Number(r.default_days));
      }
      orgDefaults.set(orgId, m);
    }
    return orgDefaults.get(orgId)!;
  };
  const zoneOf = async (orgId: string): Promise<string | null> => {
    if (!deps.zoneOf) return null;
    if (!zones.has(orgId)) zones.set(orgId, await deps.zoneOf(orgId).catch(() => null));
    return zones.get(orgId) ?? null;
  };

  // Keyset pages on id: a breach stamped on this page drops its row out of
  // the filter, so an offset would skip rows on the next page.
  let after: string | null = null;
  for (let read = 0; read < maxTickets; read += pageSize) {
    let q = sb.from("tickets")
      .select("id, org_id, ticket_id, title, status, request_type, requester_id, assigned_drafter_id, assigned_engineer_id, created_at, target_completion_at, sla_breach_warned_at, sla_breached_at")
      .not("status", "in", "(CLOSED,CANCELED)")
      .is("archived_at", null)
      .is("sla_breached_at", null);
    if (after) q = q.gt("id", after);
    const { data, error } = await q.order("id", { ascending: true }).limit(pageSize);
    if (error) {
      report.errors.push(`ticket-sla: the open tickets could not be read — no SLA notice was sent: ${error.message}`);
      return report;
    }
    const rows = (data as Row[] | null) ?? [];
    if (rows.length > 0) after = rows[rows.length - 1].id;
    for (const row of rows) {
      if (deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt) { report.truncated = true; return report; }
      report.scanned += 1;
      const t = toTicket(row);
      const target = effectiveTarget(t, t.targetCompletionAt ? null : await defaultsOf(t.orgId));
      if (target === null) { report.noTarget += 1; continue; }
      const stage = slaStage(t, now, target);
      if (stage === "none") continue;
      const ctx = await contextOf(t.orgId);
      if (!ctx) continue;
      const pools = {
        routed: routedPool(ctx, t.status as TicketStatus, undefined, { assignedDrafterId: t.assignedDrafterId, assignedEngineerId: t.assignedEngineerId }),
        queue: queuePool(ctx),
      };
      const active = new Set(ctx.members.map((m) => m.uid));
      const recipients = slaRecipients(t, stage, pools).filter((u) => active.has(u));

      // Claim the stage first (compare-and-set on the stamp AND the status we
      // read): one run sends it, a transition in between wins.
      const stamp: Record<string, string> = stage === "breach"
        ? { sla_breached_at: nowIso, ...(t.slaBreachWarnedAt ? {} : { sla_breach_warned_at: nowIso }) }
        : { sla_breach_warned_at: nowIso };
      const column = stage === "breach" ? "sla_breached_at" : "sla_breach_warned_at";
      const { data: claimed, error: claimErr } = await sb.from("tickets").update(stamp)
        .eq("id", t.id).eq("status", t.status).is(column, null).select("id");
      if (claimErr) { report.errors.push(`ticket-sla: ticket ${t.id} — the ${stage} could not be recorded, nothing was sent (retried on the next run): ${claimErr.message}`); continue; }
      if (!claimed || (claimed as unknown[]).length === 0) continue; // another run, or a transition, got there first

      const notice = slaNotice(t, stage, target, await zoneOf(t.orgId));
      let reached = 0;
      if (recipients.length > 0) {
        try {
          const r = await deps.emit({
            orgId: t.orgId, category: "sla", kind: "ticket_status",
            title: notice.title, body: notice.body, link: `/requests/${t.id}`,
            resource: { type: "ticket", id: t.id }, actorName: "System",
            audience: { involved: recipients },
            metadata: { action: stage === "breach" ? "sla_breach" : "sla_warning", status: t.status, sla: stage, target: new Date(target).toISOString() },
          });
          reached = r.inapp ? r.inapp.sent : r.recipients;
        } catch (e) {
          report.errors.push(`ticket-sla: ticket ${t.id} — the ${stage} notice failed: ${(e as Error)?.message ?? String(e)}`);
        }
      }
      if (reached === 0) {
        // Nobody was told: release the claim so the next run tries again, and
        // say so (LEAK-1 done-when 3 — never silently dropped).
        report.unreached += 1;
        report.errors.push(`ticket-sla: ticket ${t.id} (${t.status}) — the ${stage} reached nobody (${recipients.length} recipient(s) resolved); it is retried on the next run`);
        const release: Record<string, null> = stage === "breach"
          ? { sla_breached_at: null, ...(t.slaBreachWarnedAt ? {} : { sla_breach_warned_at: null }) }
          : { sla_breach_warned_at: null };
        const { data: released, error: relErr } = await sb.from("tickets").update(release).eq("id", t.id).eq(column, nowIso).select("id");
        if (relErr || !released || (released as unknown[]).length === 0) {
          report.errors.push(`ticket-sla: ticket ${t.id} — the unsent ${stage} could not be released (${relErr?.message ?? "no row"}); it will not be retried`);
        }
        continue;
      }
      if (stage === "breach") report.breached += 1; else report.warned += 1;
    }
    if (rows.length < pageSize) return report;
  }
  report.truncated = true;
  return report;
}
