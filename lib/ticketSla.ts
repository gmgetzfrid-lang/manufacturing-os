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
//   * Every run reads the most urgent first (soonest target), so a cap on
//     what one run reads never starves a breach (runTicketSlaScan).
//   * The clock STARTS at the paste of 20261195 (SLA_CLOCK_MIGRATION): until
//     its column is there the scan sends nothing and only counts the open
//     requests already past their target; the paste records that backlog as
//     overdue without a notice each and tells each workspace's assignment
//     queue once. So the first run after the deploy never mails the whole
//     backlog, and a breach after the paste never waits behind it.
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

/** The migration that starts the clock (GAP-106 fix pass 2): it records the
 *  backlog already past its target as overdue without a notice each, in the
 *  same transaction that adds SLA_CLOCK_COLUMN — so the column being there
 *  means the backlog was recorded, and the scan may send. */
export const SLA_CLOCK_MIGRATION = "20261195";
export const SLA_CLOCK_COLUMN = "outcome";

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

/** The statuses at which the request waits on its REQUESTER (their review,
 *  their acknowledgement) — nobody on the drafting side can move it. */
const REQUESTER_STEP: Readonly<Record<string, string>> = {
  PENDING_REVIEW: "the requester's review",
  FINAL_DRAFT: "the requester's acknowledgement",
};
export function waitsOnRequester(status: TicketStatus | string): boolean {
  return Object.prototype.hasOwnProperty.call(REQUESTER_STEP, String(status));
}

/** How much of its window the request has used at `now`, in whole percent
 *  (floored), or null when the window is unknown or empty. */
export function usedPercent(t: SlaTicket, target: number, now: number): number | null {
  const created = ms(t.createdAt);
  if (created === null || target <= created) return null;
  return Math.max(0, Math.floor(((now - created) / (target - created)) * 100));
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

/**
 * The notice's words (fix pass 2): the share of the window used is the one at
 * `now` (a ticket found late — filed before the clock started, or reached
 * after earlier-due ones — says how late, never a fixed 75 %), and a request
 * that waits on its requester says so instead of asking anyone to reassign it.
 */
export function slaNotice(
  t: SlaTicket, stage: Exclude<SlaStage, "none">, target: number, timeZone?: string | null, now: number = Date.now(),
): { title: string; body: string } {
  const label = `${t.ticketId ?? ""} ${t.title ?? ""}`.trim() || "A drafting request";
  const due = formatRecordDate(new Date(target).toISOString(), timeZone ?? null);
  const onRequester = waitsOnRequester(t.status) ? REQUESTER_STEP[String(t.status)] : null;
  if (stage === "warn") {
    const pct = usedPercent(t, target, now);
    const used = pct === null ? "" : ` and has used ${Math.min(pct, 99)}% of its time`;
    const where = onRequester ? `It is waiting at ${t.status}, on ${onRequester}.` : `It is waiting at ${t.status}.`;
    return { title: `Due soon · ${label}`, body: `This request is due ${due}${used}. ${where}` };
  }
  return onRequester
    ? { title: `Overdue · ${label}`, body: `This request was due ${due} and is waiting at ${t.status}, on ${onRequester}. Nothing needs reassigning: ${onRequester} moves it on.` }
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
  /** False until 20261195 is pasted (SLA_CLOCK_MIGRATION): nothing is sent,
   *  and `overdueBeforeClock` counts the backlog the paste will record. */
  clockStarted: boolean;
  /** Before the paste only: open requests already past their target with no
   *  breach recorded (counts only). */
  overdueBeforeClock?: number;
  scanned: number;
  warned: number;
  breached: number;
  /** Open tickets with no target of their own (those whose org set
   *  sla_defaults for their type are on the clock through it; the rest are
   *  not). */
  noTarget: number;
  /** Stages due whose notice reached nobody (claim released; retried). */
  unreached: number;
  /** The run stopped before reading every ticket it would have (page cap /
   *  time); the next run starts again with the soonest-due. */
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

/** A value inside a PostgREST logic tree (`or=(…)`): quoted, because a
 *  timestamp carries the reserved `.` and `:`. */
const pgq = (v: string): string => `"${v.replace(/"/g, "")}"`;

const SLA_COLUMNS = "id, org_id, ticket_id, title, status, request_type, requester_id, assigned_drafter_id, assigned_engineer_id, created_at, target_completion_at, sla_breach_warned_at, sla_breached_at";

/**
 * Scan the open tickets whose breach has not been sent, and send the stage
 * that is due. Never throws: every failure is a line in `errors`, and a
 * ticket whose org could not be read is left for the next run (no stamp).
 *
 * Every run makes progress on the tickets that are due (ROUTE-9 done-when 1
 * / EDGE-7 done-when 1), whatever the number of open tickets:
 *  (1) tickets WITH a target are read soonest-due first — ordered by
 *      (target_completion_at, id), keyset-paged — so the at-most-maxTickets
 *      a run reads are the most urgent. A ticket is passed over only while
 *      maxTickets tickets due no later than it are all still short of their
 *      own target (so it is short of its own too), and each of those leaves
 *      the scan the run it breaches; a breach is never starved. (A warning
 *      can wait behind earlier-due tickets with shorter windows; it is sent
 *      by its target at the latest, with the breach.)
 *  (2) tickets with NO target, only in an org that configured sla_defaults
 *      for their type, are read per (org, type) by a filter that matches
 *      exactly the tickets whose stage is due (created_at against the
 *      window) — each one read is stamped and leaves the filter, so the next
 *      run starts with the rest. Each pass reads at most maxTickets.
 */
export async function runTicketSlaScan(deps: SlaScanDeps): Promise<SlaScanReport> {
  const sb = deps.client;
  const now = deps.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const pageSize = deps.pageSize ?? 500;
  const maxTickets = deps.maxTickets ?? 2000;
  const report: SlaScanReport = { clockStarted: false, scanned: 0, warned: 0, breached: 0, noTarget: 0, unreached: 0, truncated: false, errors: [] };

  // ── (0) has the clock started? (GAP-106 fix pass 2) ──────────────────────
  // Before 20261195 every open request past its target would get a breach
  // notice on the first run, oldest first. Until the paste records that
  // backlog, send nothing; count it (counts only) so the operator sees it.
  const { error: clockErr } = await sb.from("tickets").select(SLA_CLOCK_COLUMN).limit(1);
  if (clockErr) {
    const code = (clockErr as { code?: string }).code;
    const missing = (code === "42703" || code === "PGRST204") && (clockErr.message ?? "").includes(SLA_CLOCK_COLUMN);
    if (!missing) {
      report.errors.push(`ticket-sla: whether the SLA clock has started could not be read — no SLA notice was sent: ${clockErr.message}`);
      return report;
    }
    const { count, error: countErr } = await sb.from("tickets")
      .select("id", { count: "exact", head: true })
      .not("status", "in", "(CLOSED,CANCELED)")
      .is("archived_at", null)
      .is("sla_breached_at", null)
      .lt("target_completion_at", nowIso);
    if (!countErr) report.overdueBeforeClock = count ?? 0;
    report.errors.push(`ticket-sla: the SLA clock starts when ${SLA_CLOCK_MIGRATION} is pasted — nothing was sent. ${countErr ? `The open requests already past their target could not be counted (${countErr.message})` : `${count ?? 0} open request(s) are already past their target`}; the paste records them as overdue without a notice each and tells each workspace's assignment queue once.`);
    return report;
  }
  report.clockStarted = true;

  const orgCtx = new Map<string, RoutingContext | null>();
  const zones = new Map<string, string | null>();
  const contextOf = async (orgId: string): Promise<RoutingContext | null> => {
    if (!orgCtx.has(orgId)) {
      const ctx = await loadRoutingContext(orgId, sb);
      if (!ctx.ok) report.errors.push(`ticket-sla@${orgId}: the members could not be read — no SLA notice was sent for this org: ${ctx.error}`);
      orgCtx.set(orgId, ctx.ok ? ctx : null);
    }
    return orgCtx.get(orgId) ?? null;
  };
  const zoneOf = async (orgId: string): Promise<string | null> => {
    if (!deps.zoneOf) return null;
    if (!zones.has(orgId)) zones.set(orgId, await deps.zoneOf(orgId).catch(() => null));
    return zones.get(orgId) ?? null;
  };
  const openTickets = () => sb.from("tickets")
    .select(SLA_COLUMNS)
    .not("status", "in", "(CLOSED,CANCELED)")
    .is("archived_at", null)
    .is("sla_breached_at", null);
  const pastDeadline = () => deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt;

  /** Evaluate one ticket and send its due stage. */
  const handle = async (row: Row, orgDefaults: ReadonlyMap<string, number> | null): Promise<void> => {
    report.scanned += 1;
    const t = toTicket(row);
    const target = effectiveTarget(t, t.targetCompletionAt ? null : orgDefaults);
    if (target === null) return;
    const stage = slaStage(t, now, target);
    if (stage === "none") return;
    const ctx = await contextOf(t.orgId);
    if (!ctx) return;
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
    if (claimErr) { report.errors.push(`ticket-sla: ticket ${t.id} — the ${stage} could not be recorded, nothing was sent (retried on the next run): ${claimErr.message}`); return; }
    if (!claimed || (claimed as unknown[]).length === 0) return; // another run, or a transition, got there first

    const notice = slaNotice(t, stage, target, await zoneOf(t.orgId), now);
    // emit() addresses every resolved recipient on BOTH channels: the bell
    // row and the email (queued whatever the bell did). A stage counts as
    // delivered when emit resolved anyone; a bell that landed for nobody
    // while the email was queued keeps the claim (released, the next run
    // would mail everyone again, every day) and is reported.
    let resolved = 0;
    if (recipients.length > 0) {
      try {
        const r = await deps.emit({
          orgId: t.orgId, category: "sla", kind: "ticket_status",
          title: notice.title, body: notice.body, link: `/requests/${t.id}`,
          resource: { type: "ticket", id: t.id }, actorName: "System",
          audience: { involved: recipients },
          metadata: { action: stage === "breach" ? "sla_breach" : "sla_warning", status: t.status, sla: stage, target: new Date(target).toISOString() },
        });
        resolved = r.recipients;
        if (resolved > 0 && r.inapp && r.inapp.sent === 0) {
          report.errors.push(`ticket-sla: ticket ${t.id} (${t.status}) — the ${stage} bell rows were not written for any of ${resolved} recipient(s); the email was queued, so it is not sent again`);
        }
      } catch (e) {
        report.errors.push(`ticket-sla: ticket ${t.id} — the ${stage} notice failed: ${(e as Error)?.message ?? String(e)}`);
      }
    }
    if (resolved === 0) {
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
      return;
    }
    if (stage === "breach") report.breached += 1; else report.warned += 1;
  };

  // ── (1) tickets with a target, soonest-due first ──────────────────────────
  // Keyset pages on (target, id): a breach stamped on this page drops its
  // row out of the filter, so an offset would skip rows on the next page.
  let cursor: { target: string; id: string } | null = null;
  for (let read = 0; ;) {
    if (read >= maxTickets) { report.truncated = true; break; }
    const want = Math.min(pageSize, maxTickets - read);
    let q = openTickets().not("target_completion_at", "is", null);
    if (cursor) q = q.or(`target_completion_at.gt.${pgq(cursor.target)},and(target_completion_at.eq.${pgq(cursor.target)},id.gt.${cursor.id})`);
    const { data, error } = await q.order("target_completion_at", { ascending: true }).order("id", { ascending: true }).limit(want);
    if (error) {
      report.errors.push(`ticket-sla: the open tickets could not be read — no SLA notice was sent: ${error.message}`);
      return report;
    }
    const rows = (data as Row[] | null) ?? [];
    read += rows.length;
    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      cursor = { target: String(last.target_completion_at), id: last.id };
    }
    for (const row of rows) {
      if (pastDeadline()) { report.truncated = true; return report; }
      await handle(row, null);
    }
    if (rows.length < want) break;
  }

  // ── (2) no target of their own: only where the org set sla_defaults ──────
  if (pastDeadline()) { report.truncated = true; return report; }
  const { count: untargeted, error: countErr } = await sb.from("tickets")
    .select("id", { count: "exact", head: true })
    .not("status", "in", "(CLOSED,CANCELED)")
    .is("archived_at", null)
    .is("sla_breached_at", null)
    .is("target_completion_at", null);
  if (countErr) report.errors.push(`ticket-sla: the open tickets with no target could not be counted: ${countErr.message}`);
  else report.noTarget = untargeted ?? 0;
  if (!countErr && (untargeted ?? 0) === 0) return report;

  const { data: defs, error: defErr } = await sb.from("sla_defaults").select("org_id, request_type, default_days");
  if (defErr) {
    report.errors.push(`ticket-sla: sla_defaults could not be read — tickets with no target were skipped: ${defErr.message}`);
    return report;
  }
  const byOrg = new Map<string, Map<string, number>>();
  for (const d of ((defs as Array<{ org_id: string; request_type: string; default_days: number }> | null) ?? [])) {
    if (!d.org_id || !d.request_type || !(Number(d.default_days) > 0)) continue;
    const m = byOrg.get(d.org_id) ?? new Map<string, number>();
    m.set(d.request_type, Number(d.default_days));
    byOrg.set(d.org_id, m);
  }
  let read2 = 0;
  for (const [orgId, types] of byOrg) {
    for (const [requestType, days] of types) {
      // Due exactly when created_at is past the warn point (75 % of the
      // window) and not yet warned, or past the whole window (the breach).
      const warnFrom = new Date(now - days * DAY_MS * SLA_WARN_FRACTION).toISOString();
      const breachFrom = new Date(now - days * DAY_MS).toISOString();
      let after: string | null = null;
      for (;;) {
        if (read2 >= maxTickets) { report.truncated = true; return report; }
        const want = Math.min(pageSize, maxTickets - read2);
        let q = openTickets().is("target_completion_at", null).eq("org_id", orgId).eq("request_type", requestType)
          .lte("created_at", warnFrom)
          .or(`sla_breach_warned_at.is.null,created_at.lte.${pgq(breachFrom)}`);
        if (after) q = q.gt("id", after);
        const { data, error } = await q.order("id", { ascending: true }).limit(want);
        if (error) {
          report.errors.push(`ticket-sla@${orgId}: the ${requestType} tickets with no target could not be read — none was evaluated: ${error.message}`);
          break;
        }
        const rows = (data as Row[] | null) ?? [];
        read2 += rows.length;
        if (rows.length > 0) after = rows[rows.length - 1].id;
        for (const row of rows) {
          if (pastDeadline()) { report.truncated = true; return report; }
          await handle(row, types);
        }
        if (rows.length < want) break;
      }
    }
  }
  return report;
}
