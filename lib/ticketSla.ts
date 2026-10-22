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
// would otherwise breach on the first run after the deploy. A stored window
// outside the create route's bound (lib/notifications.ts boundedSlaDays —
// whole days, 1 to SLA_DEFAULT_DAYS_MAX) is never used: the pass treats its
// type as one with no row and says so (drafting-flow EDGE-17, DF-P13).

import type { TicketStatus } from "@/types/schema";
import {
  loadRoutingContext, routedPool, queuePool, type RoutingClient, type RoutingContext,
} from "@/lib/ticketRouting";
import { formatRecordDate } from "@/lib/recordTime";
import { ticketStatusLabel } from "@/lib/ticketStatusLabels";
import { SLA_DEFAULT_DAYS_MAX, boundedSlaDays } from "@/lib/notifications";
// DF-P22 fix pass (AUTHZ-13 / DEC-89): an escalation names a request only to
// the contact's people who may read it.
import { isContractorOnly, ticketReadScope, type ScopedTicket } from "@/lib/ticketReadScope";

/** GAP-106: the fraction of the SLA window at which the owner is warned. */
export const SLA_WARN_FRACTION = 0.75;

/** The migration that starts the clock (GAP-106 fix pass 2): it records the
 *  backlog already past its target as overdue without a notice each, in the
 *  same transaction that adds SLA_CLOCK_COLUMN — so the column being there
 *  means the backlog was recorded, and the scan may send. */
export const SLA_CLOCK_MIGRATION = "20261195";
export const SLA_CLOCK_COLUMN = "outcome";

/** The `metadata.action` the clock's notices carry ("Due soon" / "Overdue").
 *  They say the request is LATE, not "act on state X": the workflow route's
 *  supersede step retires them only when the request exits (CLOSED /
 *  CANCELED) — an open-to-open transition leaves it as late as it was. */
export const SLA_ACTION = { warn: "sla_warning", breach: "sla_breach", escalation: "sla_escalation" } as const;
// DF-P22: the escalation tier's notice says the request is late too, so it is
// retired only when the request exits, exactly as the other two.
export const SLA_NOTICE_ACTIONS: ReadonlySet<string> = new Set<string>([SLA_ACTION.warn, SLA_ACTION.breach, SLA_ACTION.escalation]);

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
  // drafting-flow UI-7 (DF-P14): the stage a person reads, in the shared
  // words (lib/ticketStatusLabels.ts) — never the stored identifier.
  const stageName = `the “${ticketStatusLabel(String(t.status))}” stage`;
  if (stage === "warn") {
    const pct = usedPercent(t, target, now);
    const used = pct === null ? "" : ` and has used ${Math.min(pct, 99)}% of its time`;
    const where = onRequester ? `It is waiting at ${stageName}, on ${onRequester}.` : `It is waiting at ${stageName}.`;
    return { title: `Due soon · ${label}`, body: `This request is due ${due}${used}. ${where}` };
  }
  return onRequester
    ? { title: `Overdue · ${label}`, body: `This request was due ${due} and is waiting at ${stageName}, on ${onRequester}. Nothing needs reassigning: ${onRequester} moves it on.` }
    : { title: `Overdue · ${label}`, body: `This request was due ${due} and is still waiting at ${stageName}. Reassign it, or tell the requester when it will be done.` };
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
  /** DF-P22 escalation pass only: the most breach rows one run reads (the
   *  ones already told included); default maxTickets × SLA_ESCALATION_SCAN_FACTOR. */
  maxScanned?: number;
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
          metadata: { action: stage === "breach" ? SLA_ACTION.breach : SLA_ACTION.warn, status: t.status, sla: stage, target: new Date(target).toISOString() },
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
  // EDGE-17 (DF-P13): a stored window outside the create route's bound
  // (boundedSlaDays — whole days, 1 to SLA_DEFAULT_DAYS_MAX; 20261218's CHECK)
  // is never used. Its type is passed over exactly as a type with no row is,
  // so one workspace's row (a value of ~100,000,000 days made the date below
  // throw) never stops this pass for the workspaces after it. Each workspace
  // holding such rows is one line: its id and a count, nothing more.
  const unusable = new Map<string, number>();
  for (const d of ((defs as Array<{ org_id: string; request_type: string; default_days: number }> | null) ?? [])) {
    if (!d.org_id || !d.request_type) continue;
    const days = boundedSlaDays(d.default_days);
    if (days === null) { unusable.set(d.org_id, (unusable.get(d.org_id) ?? 0) + 1); continue; }
    const m = byOrg.get(d.org_id) ?? new Map<string, number>();
    m.set(d.request_type, days);
    byOrg.set(d.org_id, m);
  }
  for (const [orgId, n] of unusable) {
    report.errors.push(`ticket-sla@${orgId}: ${n} sla_defaults window(s) outside 1–${SLA_DEFAULT_DAYS_MAX} whole days were not used — the open requests of those types with no due date of their own are not timed, as for a type with no window, until the window is corrected (Admin → Request forms)`);
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

// ─── DF-P22: the escalation tier above the queue owners (FRIC-1 dw2, GAP-106) ─
//
// DEC-90 ruling (1) for DF-P22 (fail-safe, no regression):
//   * A workspace MAY configure an escalation contact — a named member or a
//     role — and a period (whole days, 1 to SLA_ESCALATION_MAX_DAYS; default
//     SLA_ESCALATION_DEFAULT_DAYS). It lives in its own configuration key
//     (org_configurations key SLA_ESCALATION_KEY), written ONLY by
//     /api/admin/sla-escalation for an Admin (by the held collection), with
//     an audit row for every change; 20261264 refuses every client write of
//     that key. The queue owners it sits above (the DraftingSupervisor
//     holders who edit the request forms) cannot switch it off or point it
//     at themselves (DF-P22 fix pass — the escalated party never controls
//     the escalation).
//   * A breach (sla_breached_at) the queue owners have not cleared — the
//     request is still open, not archived, and still past its target — for a
//     whole period tells the contact ONCE per breach per period: at breach +
//     1 period, again at breach + 2 periods while it stays uncleared, and so
//     on. A run that missed some periods sends one notice for the period it
//     is in, never one per missed period.
//   * Only to the contact's people who may READ the request (AUTHZ-13 /
//     DEC-89): a Contractor-only member is told only of a request in their
//     narrowed read (lib/ticketReadScope.ts); a read that cannot be checked
//     sends and claims nothing for that request this run (retried next run).
//   * Through an existing notification kind (`ticket_status`, category
//     `sla` — the "SLA warnings" preference, bell + email through emit()):
//     ONE notice per person per workspace per run — the request itself when
//     it is the only one due for them, else a digest naming them (which no
//     transition of the request it is filed under retires —
//     slaNoticeSurvivesTransition) — each
//     request still claimed on ticket_sla_escalations (20261264 — one row per
//     breach per period; the unique key is the claim, so two runs never send
//     twice) and recorded on its own audit row (TICKET_SLA_ESCALATED, the
//     system actor).
//   * Every due breach is reached: a run reads, per workspace, past the
//     breaches already told for their current period (keyset pages on
//     (sla_breached_at, id)) until it has its share of breaches to tell; the
//     budget is shared fairly among the configured workspaces, and the
//     workspace that goes first rotates daily.
//   * Escalation only TELLS: it never reassigns, never changes a status,
//     never blocks anyone, and writes nothing on the ticket.
//   * No contact configured (no key, or a value this parser cannot use) =
//     exactly today's behaviour: runTicketSlaScan is unchanged and this pass
//     reads one configuration list and stops. Before 20261264 is pasted the
//     pass sends nothing and says so.

/** The machine actor the escalation's audit row names (DEC-87 §2). */
export const SLA_ESCALATION_ACTOR = "system:sla-clock";
export const SLA_ESCALATION_AUDIT_ACTION = "TICKET_SLA_ESCALATED";
/** The audit row an Admin's change of the tier writes (/api/admin/sla-escalation;
 *  the TICKET_ family, with its _NOT_APPLIED follow-up). */
export const SLA_ESCALATION_SET_AUDIT = "TICKET_SLA_ESCALATION_SET";
/** The org_configurations key that holds the tier (Admin-only, server-written). */
export const SLA_ESCALATION_KEY = "sla_escalation";
export const SLA_ESCALATION_DEFAULT_DAYS = 2;
export const SLA_ESCALATION_MAX_DAYS = 30;
/** The migration that carries the claim table and the key's write rule. */
export const SLA_ESCALATION_MIGRATION = "20261264";
/** A role that can never be the contact: its holders read only their own
 *  requests (20261166), so a role-wide escalation would name requests they
 *  may not see. */
export const SLA_ESCALATION_REFUSED_ROLES: readonly string[] = ["Contractor"];
/** The digest's metadata action. NOT one of SLA_NOTICE_ACTIONS (those are
 *  retired when THEIR request exits): a digest names several requests, so no
 *  one request's transition — an exit included — retires it. The workflow
 *  route's supersede step asks slaNoticeSurvivesTransition, which keeps it. */
export const SLA_ESCALATION_DIGEST_ACTION = "sla_escalation_digest";
/**
 * Whether the workflow route's supersede step (app/api/tickets/workflow-action
 * — it reads every unread notice whose resource_id is the ticket) KEEPS an
 * unread notice with this metadata.action. An SLA notice ("Due soon" /
 * "Overdue" / the single-request escalation) says "this request is late",
 * which only an exit (CLOSED / CANCELED) changes. The escalation digest is
 * filed under the first request it names but speaks for all of them, so no
 * transition of that one request retires it — its reader does. Pure.
 */
export function slaNoticeSurvivesTransition(action: string, exits: boolean): boolean {
  if (action === SLA_ESCALATION_DIGEST_ACTION) return true;
  return !exits && SLA_NOTICE_ACTIONS.has(action);
}
/** How many requests a digest names one by one (the rest are counted). */
export const SLA_ESCALATION_DIGEST_NAMED = 10;
/** Rows a run may read past the breaches already told, per breach it may
 *  tell (a bound when no deadline is given; the cron passes its deadline). */
export const SLA_ESCALATION_SCAN_FACTOR = 50;

export type SlaEscalationContact = { kind: "member"; uid: string } | { kind: "role"; role: string };
export interface SlaEscalationConfig { contact: SlaEscalationContact; periodDays: number }

const ESC_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The workspace's escalation tier, or why it cannot be used. Absent (no key,
 * null) is `{ ok: true, config: null }` — nothing configured, today's
 * behaviour. A stored value this parser cannot use is never guessed at: it is
 * `{ ok: false }` with the reason (the pass then escalates nothing for that
 * workspace and says why). Pure.
 */
export function parseSlaEscalation(raw: unknown): { ok: true; config: SlaEscalationConfig | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, config: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "the escalation setting is not an object" };
  const o = raw as Record<string, unknown>;
  const c = o.contact as Record<string, unknown> | null | undefined;
  if (c === null || c === undefined) return { ok: true, config: null };
  if (typeof c !== "object" || Array.isArray(c)) return { ok: false, error: "the escalation contact is not an object" };
  let contact: SlaEscalationContact;
  if (c.kind === "member") {
    const uid = typeof c.uid === "string" ? c.uid.trim() : "";
    if (!ESC_UUID_RE.test(uid)) return { ok: false, error: "the escalation contact names no member" };
    contact = { kind: "member", uid };
  } else if (c.kind === "role") {
    const role = typeof c.role === "string" ? c.role.trim() : "";
    if (!role) return { ok: false, error: "the escalation contact names no role" };
    if (SLA_ESCALATION_REFUSED_ROLES.includes(role)) return { ok: false, error: `the role ${role} cannot be the escalation contact (its holders read only their own requests)` };
    contact = { kind: "role", role };
  } else {
    return { ok: false, error: "the escalation contact is neither a member nor a role" };
  }
  const d = o.periodDays;
  let periodDays = SLA_ESCALATION_DEFAULT_DAYS;
  if (d !== undefined && d !== null) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > SLA_ESCALATION_MAX_DAYS) {
      return { ok: false, error: `the escalation period is a whole number of days from 1 to ${SLA_ESCALATION_MAX_DAYS}` };
    }
    periodDays = d;
  }
  return { ok: true, config: { contact, periodDays } };
}

/** Which period after the breach `now` falls in (1 = the first whole period
 *  has passed), or 0 before the first period ends / with no breach. Pure. */
export function escalationPeriodIndex(breachedAt: string | null | undefined, now: number, periodDays: number): number {
  const b = ms(breachedAt);
  if (b === null || periodDays <= 0 || now < b) return 0;
  return Math.floor((now - b) / (periodDays * DAY_MS));
}

/** Is the breach still uncleared — the request open, not archived, its
 *  breach on record and its target (when it has one) still passed? Pure. */
export function breachUncleared(t: Pick<SlaTicket, "status" | "slaBreachedAt" | "targetCompletionAt"> & { archivedAt?: string | null }, now: number): boolean {
  if (TERMINAL.includes(String(t.status)) || t.archivedAt || !t.slaBreachedAt) return false;
  const target = ms(t.targetCompletionAt);
  return target === null || now >= target;
}

/** The members the contact names now: the named member while they are an
 *  active member, or every active member HOLDING the role (the additive
 *  collection — ADD-1, never the headline alone). Sorted. Pure. Who of them
 *  may read a given request is decided per request (escalationAudienceFor). */
export function escalationRecipients(contact: SlaEscalationContact, members: ReadonlyArray<{ uid: string; roles: readonly string[] }>): string[] {
  if (contact.kind === "member") return members.some((m) => m.uid === contact.uid) ? [contact.uid] : [];
  return [...new Set(members.filter((m) => m.roles.includes(contact.role)).map((m) => m.uid))].sort();
}

/**
 * Of the contact's people, those who may READ this request (AUTHZ-13 /
 * DEC-89): everyone whose read is the workspace's, and a Contractor-only
 * member only when lib/ticketReadScope.ts places the request in their
 * narrowed read. `unknown` counts the people whose read could not be checked
 * (the mention lookup failed) — runSlaEscalationScan then sends and claims
 * nothing for that request this run (retried), so nobody is told on a guess
 * and nobody misses a period because of a failed lookup.
 */
export async function escalationAudienceFor(
  client: RoutingClient,
  members: ReadonlyArray<{ uid: string; role?: unknown; roles?: unknown }>,
  recipients: readonly string[],
  ticket: ScopedTicket,
): Promise<{ uids: string[]; out: number; unknown: number }> {
  const uids: string[] = [];
  let out = 0;
  let unknown = 0;
  for (const uid of recipients) {
    const member = members.find((m) => m.uid === uid);
    if (!member) { out += 1; continue; }
    if (!isContractorOnly(member)) { uids.push(uid); continue; }
    const scope = await ticketReadScope(client as never, member, uid, ticket);
    if (scope === "in") uids.push(uid);
    else if (scope === "unknown") unknown += 1;
    else out += 1;
  }
  return { uids, out, unknown };
}

/** The escalation notice's words. It tells; it asks nobody to do anything
 *  the queue owners were not already asked to do. */
export function slaEscalationNotice(
  t: SlaTicket, input: { breachedAt: string; periodDays: number; periodIndex: number }, timeZone?: string | null,
): { title: string; body: string } {
  const label = `${t.ticketId ?? ""} ${t.title ?? ""}`.trim() || "A drafting request";
  const since = formatRecordDate(input.breachedAt, timeZone ?? null);
  const waited = input.periodIndex * input.periodDays;
  const stageName = `the “${ticketStatusLabel(String(t.status))}” stage`;
  return {
    title: `Escalated: still overdue · ${label}`,
    body: `This request has been overdue since ${since} and is still waiting at ${stageName} — ${waited} day${waited === 1 ? "" : "s"} after its queue was told. You are this workspace's escalation contact; nothing was reassigned or changed.`,
  };
}

/** The digest's words: one notice naming every request due for one person
 *  in one run (the first SLA_ESCALATION_DIGEST_NAMED by name). Pure. */
export function slaEscalationDigest(
  items: ReadonlyArray<{ t: SlaTicket; breachedAt: string }>, periodDays: number, timeZone?: string | null,
): { title: string; body: string } {
  const named = items.slice(0, SLA_ESCALATION_DIGEST_NAMED).map(({ t, breachedAt }) => {
    const label = `${t.ticketId ?? ""} ${t.title ?? ""}`.trim() || "a drafting request";
    return `${label} (overdue since ${formatRecordDate(breachedAt, timeZone ?? null)}, at the “${ticketStatusLabel(String(t.status))}” stage)`;
  });
  const rest = items.length - named.length;
  return {
    title: `Escalated: ${items.length} requests still overdue`,
    body: `${items.length} requests are still overdue ${periodDays} day${periodDays === 1 ? "" : "s"} or more after their queues were told: ${named.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}. You are this workspace's escalation contact; nothing was reassigned or changed.`,
  };
}

export interface SlaEscalationReport {
  /** False until 20261264 is pasted (nothing is sent; said). */
  ready: boolean;
  /** Workspaces with a usable escalation contact. */
  configured: number;
  /** Breaches read (including those already told for their period). */
  scanned: number;
  escalated: number;
  /** Escalations due whose notice reached nobody (claim released; retried). */
  unreached: number;
  /** Escalations due that none of the contact's people may read, or whose
   *  readers could not all be checked (nothing claimed or sent; said — the
   *  latter retried next run). */
  outOfScope: number;
  truncated: boolean;
  errors: string[];
}

interface EscRow {
  id: string; org_id: string; ticket_id: string | null; title: string | null; status: string; request_type: string | null;
  requester_id: string | null; assigned_drafter_id: string | null; assigned_engineer_id: string | null;
  created_at: string | null; target_completion_at: string | null; sla_breach_warned_at: string | null; sla_breached_at: string | null; archived_at: string | null;
  watchers?: string[] | null;
}

/** True when the error says 20261264's claim table is not there yet. */
export function isMissingEscalationTable(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  return (code === "42P01" || code === "PGRST205" || code === "PGRST204" || code === "42703") && /ticket_sla_escalations/.test(String(err.message ?? ""));
}

/** The configured workspaces in run order: by id, rotated by the day, so no
 *  workspace is always the last to share the run's budget. Pure. */
export function escalationOrgOrder<T extends { orgId: string }>(configs: readonly T[], now: number): T[] {
  const sorted = [...configs].sort((a, b) => (a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0));
  if (sorted.length === 0) return sorted;
  const start = Math.floor(now / DAY_MS) % sorted.length;
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

/**
 * The escalation pass (one more pass of step 5b — no new cron entry). Never
 * throws; every failure is a line, and a breach whose claim, notice or org
 * could not be handled is left for the next run. Runs AFTER
 * runTicketSlaScan, which it never changes.
 */
export async function runSlaEscalationScan(deps: SlaScanDeps): Promise<SlaEscalationReport> {
  const sb = deps.client;
  const now = deps.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const maxTickets = Math.max(1, deps.maxTickets ?? 500);
  const pageSize = Math.max(1, deps.pageSize ?? 200);
  const maxScanned = Math.max(1, deps.maxScanned ?? maxTickets * SLA_ESCALATION_SCAN_FACTOR);
  const report: SlaEscalationReport = { ready: false, configured: 0, scanned: 0, escalated: 0, unreached: 0, outOfScope: 0, truncated: false, errors: [] };
  const say = (line: string) => report.errors.push(`ticket-sla-escalation: ${line}`);
  const pastDeadline = () => deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt;

  // (0) Who configured a contact? No row → today's behaviour, nothing else read.
  const { data: cfgRows, error: cfgErr } = await sb.from("org_configurations")
    .select("org_id, data").eq("key", SLA_ESCALATION_KEY);
  if (cfgErr) { say(`the escalation settings could not be read — nobody was escalated to: ${cfgErr.message}`); return report; }
  const configs: Array<{ orgId: string; config: SlaEscalationConfig }> = [];
  for (const r of ((cfgRows as Array<{ org_id: string; data: unknown }> | null) ?? [])) {
    const parsed = parseSlaEscalation(r.data);
    if (!parsed.ok) { say(`org ${r.org_id}: ${parsed.error} — nobody is escalated to until an Admin corrects it (Admin → Request forms)`); continue; }
    if (parsed.config) configs.push({ orgId: r.org_id, config: parsed.config });
  }
  report.configured = configs.length;
  if (configs.length === 0) return report;

  // (1) Is the claim table there? Before 20261264: nothing sent, said.
  const { error: probeErr } = await sb.from("ticket_sla_escalations").select("id").limit(1);
  if (probeErr) {
    if (isMissingEscalationTable(probeErr)) say(`the escalation tier starts when ${SLA_ESCALATION_MIGRATION} is pasted — nothing was sent`);
    else say(`whether the escalation record is in the database could not be read — nothing was sent: ${probeErr.message}`);
    return report;
  }
  report.ready = true;

  const ordered = escalationOrgOrder(configs, now);
  let sendLeft = maxTickets;
  let readLeft = maxScanned;
  for (let i = 0; i < ordered.length; i++) {
    const { orgId, config } = ordered[i];
    if (pastDeadline()) { report.truncated = true; break; }
    // A fair share of what is left, for this workspace and each after it.
    const orgsLeft = ordered.length - i;
    const share = Math.ceil(sendLeft / orgsLeft);
    const readShare = Math.ceil(readLeft / orgsLeft);
    if (share <= 0 || readShare <= 0) { report.truncated = true; break; }
    let ctx: Awaited<ReturnType<typeof loadRoutingContext>>;
    try { ctx = await loadRoutingContext(orgId, sb); } catch (e) { ctx = { ok: false, error: (e as Error)?.message ?? String(e) }; }
    if (!ctx.ok) { say(`org ${orgId}: its members could not be read — nobody was escalated to: ${ctx.error}`); continue; }
    const members = ctx.members;
    const recipients = escalationRecipients(config.contact, members);
    if (recipients.length === 0) {
      say(`org ${orgId}: its escalation contact (${config.contact.kind === "member" ? "a member who is no longer active" : `the role ${config.contact.role}, which no active member holds`}) names nobody — nobody was escalated to`);
      continue;
    }

    // (2) The breaches due now and not yet told for the period they are in:
    // at least one whole period old, oldest first, keyset-paged on
    // (sla_breached_at, id) PAST the ones already told — so a backlog told
    // for this period never stands in front of a breach that is due.
    const due = new Date(now - config.periodDays * DAY_MS).toISOString();
    const candidates: Array<{ t: SlaTicket; r: EscRow; periodIndex: number }> = [];
    let cursor: { at: string; id: string } | null = null;
    let orgRead = 0;
    for (;;) {
      if (candidates.length >= share) break;
      if (pastDeadline() || orgRead >= readShare) { report.truncated = true; break; }
      const want = Math.min(pageSize, readShare - orgRead);
      let q = sb.from("tickets")
        .select(`${SLA_COLUMNS}, archived_at, watchers`)
        .eq("org_id", orgId)
        .not("status", "in", "(CLOSED,CANCELED)")
        .is("archived_at", null)
        .not("sla_breached_at", "is", null)
        .lte("sla_breached_at", due);
      if (cursor) q = q.or(`sla_breached_at.gt.${pgq(cursor.at)},and(sla_breached_at.eq.${pgq(cursor.at)},id.gt.${cursor.id})`);
      const { data, error } = await q.order("sla_breached_at", { ascending: true }).order("id", { ascending: true }).limit(want);
      if (error) { say(`org ${orgId}: its overdue requests could not be read${candidates.length ? " past the first ones found" : ""} — the rest wait for the next run: ${error.message}`); break; }
      const rows = (data as EscRow[] | null) ?? [];
      orgRead += rows.length;
      report.scanned += rows.length;
      if (rows.length === 0) break;
      const last = rows[rows.length - 1];
      cursor = { at: String(last.sla_breached_at), id: last.id };
      // What was already sent for these breaches.
      const { data: sent, error: sentErr } = await sb.from("ticket_sla_escalations")
        .select("ticket_id, breached_at, period_index").in("ticket_id", rows.map((r) => r.id));
      if (sentErr) { say(`org ${orgId}: the escalations already sent could not be read — none of these was told (retried next run): ${sentErr.message}`); break; }
      const done = new Set(((sent as Array<{ ticket_id: string; breached_at: string; period_index: number }> | null) ?? [])
        .map((x) => `${x.ticket_id}|${ms(x.breached_at)}|${x.period_index}`));
      for (const r of rows) {
        const t = toTicket(r);
        if (!breachUncleared({ ...t, archivedAt: r.archived_at }, now)) continue;
        const periodIndex = escalationPeriodIndex(t.slaBreachedAt, now, config.periodDays);
        if (periodIndex < 1 || done.has(`${t.id}|${ms(t.slaBreachedAt)}|${periodIndex}`)) continue;
        if (candidates.length >= share) { report.truncated = true; break; }
        candidates.push({ t, r, periodIndex });
      }
      if (rows.length < want) break;
    }
    readLeft -= orgRead;
    sendLeft -= candidates.length;
    if (candidates.length === 0) continue;
    const zone = deps.zoneOf ? await deps.zoneOf(orgId).catch(() => null) : null;

    // (3) Per request: the contact's people who may read it, then the claim.
    const claimed: Array<{ t: SlaTicket; periodIndex: number; claimId: string; auditId: string; to: string[] }> = [];
    for (const c of candidates) {
      if (pastDeadline()) { report.truncated = true; break; }
      const t = c.t;
      const aud = await escalationAudienceFor(sb, members, recipients, {
        id: t.id, requesterId: t.requesterId ?? null, assignedDrafterId: t.assignedDrafterId ?? null,
        assignedEngineerId: t.assignedEngineerId ?? null, watchers: Array.isArray(c.r.watchers) ? c.r.watchers : null,
      });
      // Fix pass 2: a person whose read could not be checked is never told
      // on a guess — and the period is never marked told over their head
      // either: nothing is claimed or sent for this request this run, so the
      // next run (the lookup answering) tells everyone it should, once.
      if (aud.unknown > 0) {
        report.outOfScope += 1;
        say(`ticket ${t.id}: whether ${aud.unknown} of the escalation contact's people may read it could not be checked — nobody was told of it and nothing was claimed; it is retried on the next run`);
        continue;
      }
      if (aud.uids.length === 0) {
        report.outOfScope += 1;
        say(`ticket ${t.id}: none of the escalation contact's people may read this request (a Contractor-only member reads only their own requests) — nobody was told of it`);
        continue;
      }
      // Claim first: the unique (ticket, breach, period) key means one run
      // sends it. 23505 = another run got there first.
      const claimId = crypto.randomUUID();
      const auditId = crypto.randomUUID();
      const { error: claimErr } = await sb.from("ticket_sla_escalations").insert({
        id: claimId, org_id: orgId, ticket_id: t.id, breached_at: t.slaBreachedAt, period_index: c.periodIndex, period_days: config.periodDays,
        contact: config.contact, recipients: aud.uids, audit_id: auditId, status_at: String(t.status), escalated_at: nowIso,
      });
      if (claimErr) {
        if ((claimErr as { code?: string }).code !== "23505") say(`ticket ${t.id}: the escalation could not be claimed — nothing was sent (retried next run): ${claimErr.message}`);
        continue;
      }
      claimed.push({ t, periodIndex: c.periodIndex, claimId, auditId, to: aud.uids });
    }

    // (4) ONE notice per person: the request itself when it is the only one
    // due for them, else a digest naming them all.
    const byUid = new Map<string, typeof claimed>();
    for (const k of claimed) for (const u of k.to) byUid.set(u, [...(byUid.get(u) ?? []), k]);
    const reachedBy = new Map<string, string[]>();
    for (const [uid, items] of byUid) {
      const one = items.length === 1;
      const first = items[0];
      const notice = one
        ? slaEscalationNotice(first.t, { breachedAt: first.t.slaBreachedAt!, periodDays: config.periodDays, periodIndex: first.periodIndex }, zone)
        : slaEscalationDigest(items.map((k) => ({ t: k.t, breachedAt: k.t.slaBreachedAt! })), config.periodDays, zone);
      try {
        const res = await deps.emit({
          orgId, category: "sla", kind: "ticket_status", title: notice.title, body: notice.body,
          link: one ? `/requests/${first.t.id}` : "/requests",
          resource: { type: "ticket", id: first.t.id }, actorName: "System", audience: { involved: [uid] },
          metadata: one
            ? { action: SLA_ACTION.escalation, status: first.t.status, sla: "escalation", breachedAt: first.t.slaBreachedAt, periodIndex: first.periodIndex, periodDays: config.periodDays }
            : { action: SLA_ESCALATION_DIGEST_ACTION, sla: "escalation", digest: true, periodDays: config.periodDays,
                tickets: items.map((k) => ({ id: k.t.id, breachedAt: k.t.slaBreachedAt, periodIndex: k.periodIndex })) },
        });
        if (res.recipients > 0) for (const k of items) reachedBy.set(k.claimId, [...(reachedBy.get(k.claimId) ?? []), uid]);
      } catch (e) {
        say(`org ${orgId}: an escalation notice failed: ${(e as Error)?.message ?? String(e)}`);
      }
    }

    // (5) Per request: nobody reached → the claim is released (retried next
    // run); else its own audit row, after the notice — it never names a
    // notice that did not go out (DEC-90). A refused row is said; the claim
    // row stays the record of the escalation.
    for (const k of claimed) {
      const told = (reachedBy.get(k.claimId) ?? []).sort();
      if (told.length === 0) {
        report.unreached += 1;
        const { error: relErr } = await sb.from("ticket_sla_escalations").delete().eq("id", k.claimId);
        say(`ticket ${k.t.id}: the escalation reached nobody (${k.to.length} contact(s) resolved) — ${relErr ? `its claim could not be released (${relErr.message}), so it is not retried` : "it is retried on the next run"}`);
        continue;
      }
      report.escalated += 1;
      const digest = told.some((u) => (byUid.get(u)?.length ?? 0) > 1);
      const { error: aErr } = await sb.from("audit_logs").insert({
        id: k.auditId, action: SLA_ESCALATION_AUDIT_ACTION, resource_type: "ticket", resource_id: k.t.id, org_id: orgId,
        user_id: null, user_email: SLA_ESCALATION_ACTOR, user_role: "system",
        details: { status: k.t.status, breachedAt: k.t.slaBreachedAt, target: k.t.targetCompletionAt ?? null, periodIndex: k.periodIndex, periodDays: config.periodDays, contact: config.contact, recipients: told, escalation: k.claimId, ...(digest ? { digest: true } : {}) },
      });
      if (aErr) say(`ticket ${k.t.id}: the escalation went out, but its audit row was not written (ticket_sla_escalations row ${k.claimId} records it): ${aErr.message}`);
    }
  }
  return report;
}
