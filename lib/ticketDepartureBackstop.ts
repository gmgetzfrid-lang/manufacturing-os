// lib/ticketDepartureBackstop.ts
//
// drafting-flow EDGE-4 (Round G, DF-P3 fix pass 3): the recurring backstop
// for what a member departure leaves behind.
//
// The departure itself (20261195's org_members triggers →
// return_departed_member_tickets) runs inside the removing Admin's request,
// so it never waits and never refuses the removal (DEC-20): a ticket another
// write holds row-locked is skipped (SKIP LOCKED), a hand-back the database
// refuses is a WARNING, and one call hands back at most 200. Without a
// backstop those tickets would stay on a uid that cannot sign in, which the
// ratified EDGE-4 default forbids.
//
// Step 5b of the maintenance cron (no new cron entry) runs this as the
// service role: it lists the (org, uid) pairs that still hold open work while
// not an active member of that org (departed_member_ticket_holders — the
// same predicate as 20261195's backlog move), and hands each back through
// the SAME function, repeating a pair while a call hits its bound. Bounded
// (a holder-list cap, a per-holder pass cap, the step's deadline),
// idempotent (a ticket handed back leaves the list), never throws: every
// failure is a line. As the service role, auth.uid() is NULL, so neither
// ticket_update_guard nor the notification rail's per-actor caps apply.

/** 20261195: lists the departed holders (service role only). */
export const DEPARTURE_HOLDERS_RPC = "departed_member_ticket_holders";
/** 20261195: hands one departed member's tickets in one org back. */
export const DEPARTURE_RETURN_RPC = "return_departed_member_tickets";
/** return_departed_member_tickets' per-call bound (its v_max). */
export const DEPARTURE_CALL_BOUND = 200;

export interface DepartureRpcClient {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
}

export interface DepartureBackstopDeps {
  client: DepartureRpcClient;
  /** Stop starting calls at this time (ms epoch). */
  deadlineAt: number;
  /** Holders read per run (default 50). */
  maxHolders?: number;
  /** Calls per holder per run (default 10 — 2,000 tickets). */
  maxPassesPerHolder?: number;
  now?: () => number;
}

export interface DepartureBackstopReport {
  /** False before 20261195 is pasted (no departure triggers either): nothing to do. */
  installed: boolean;
  /** (org, uid) pairs listed this run. */
  holders: number;
  /** Tickets handed back this run. */
  handedBack: number;
  /** Tickets the listed holders still hold after this run (locked, refused,
   *  or past the per-holder pass cap); the next run tries again. */
  left: number;
  /** The run stopped before serving every holder there may be (deadline, or
   *  the holder list hit its cap). */
  truncated: boolean;
  errors: string[];
}

const missingFunction = (e: { code?: string; message: string }): boolean =>
  e.code === "PGRST202" || e.code === "42883" || /could not find the function/i.test(e.message ?? "");

interface HolderRow { org_id: string; uid: string; label: string | null; held: number | string | null }

export async function runDepartureBackstop(deps: DepartureBackstopDeps): Promise<DepartureBackstopReport> {
  const now = deps.now ?? Date.now;
  const maxHolders = deps.maxHolders ?? 50;
  const maxPasses = deps.maxPassesPerHolder ?? 10;
  const report: DepartureBackstopReport = { installed: true, holders: 0, handedBack: 0, left: 0, truncated: false, errors: [] };

  let listed: HolderRow[];
  try {
    const { data, error } = await deps.client.rpc(DEPARTURE_HOLDERS_RPC, { p_limit: maxHolders });
    if (error) {
      if (missingFunction(error)) { report.installed = false; return report; }
      report.errors.push(`ticket-departure: the departed members still holding open tickets could not be listed — nothing was handed back: ${error.message}`);
      return report;
    }
    listed = ((data as HolderRow[] | null) ?? []).filter((h) => h && h.org_id && h.uid);
  } catch (e) {
    report.errors.push(`ticket-departure: the departed members still holding open tickets could not be listed — nothing was handed back: ${(e as Error)?.message ?? String(e)}`);
    return report;
  }
  report.holders = listed.length;
  if (listed.length >= maxHolders) report.truncated = true;

  let outOfTime = false;
  for (const h of listed) {
    const held = Math.max(0, Number(h.held) || 0);
    let moved = 0;
    let failed = false;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      if (now() >= deps.deadlineAt) { report.truncated = true; outOfTime = true; break; }
      let n = 0;
      try {
        const { data, error } = await deps.client.rpc(DEPARTURE_RETURN_RPC, { p_org: h.org_id, p_uid: h.uid, p_label: h.label ?? null });
        if (error) {
          report.errors.push(`ticket-departure: the open tickets of the departed member ${h.uid} in org ${h.org_id} could not be handed back: ${error.message} — the next run tries again`);
          failed = true;
          break;
        }
        n = Math.max(0, Number(data) || 0);
      } catch (e) {
        report.errors.push(`ticket-departure: the open tickets of the departed member ${h.uid} in org ${h.org_id} could not be handed back: ${(e as Error)?.message ?? String(e)} — the next run tries again`);
        failed = true;
        break;
      }
      moved += n;
      // Below the bound, the call reached every ticket it could: what is left
      // is row-locked or refused, and calling again now would not move it.
      if (n < DEPARTURE_CALL_BOUND) break;
    }
    report.handedBack += moved;
    const left = Math.max(0, held - moved);
    report.left += left;
    if (left > 0 && !failed && !outOfTime) {
      report.errors.push(`ticket-departure: ${left} of ${held} open ticket(s) of the departed member ${h.uid} in org ${h.org_id} were not handed back this run (held by another write, or refused — the database log names each) — the next run tries again`);
    }
    if (outOfTime) break;
  }
  return report;
}
