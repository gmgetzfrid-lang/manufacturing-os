// lib/ticketOutcome.ts
//
// drafting-flow GAP-107 / LEAK-9 (Round G, DF-P3): how a request ENDED, as a
// typed fact. Before this, a request that was withdrawn, filed twice, or
// handled outside the app ended exactly like one that was delivered — a
// CLOSED status (or a CANCELED one with a free-text reason in the comment
// thread) — so the bypass this whole area is about could not be counted.
//
// One terminal status per exit (CLOSED / CANCELED, DEC-14) and a REASON
// FIELD, never a status per reason (the gap register's "Do not"). The free
// text stays in the comment the action already requires; the category is
// this vocabulary, ratified by the integrator under the user's delegation
// (2026-10-07): completed, withdrawn, duplicate, handled_out_of_band,
// rejected. Org-configurable later (record); the database CHECK in
// 20261195 holds the same five.
//
// Pure: no IO. The workflow route validates and stamps `tickets.outcome`
// (lib/ticketTransitions.ts writes it); /admin/analytics reads it back
// (summarizeOutcomes).

import type { TicketOutcome } from "@/types/schema";

export type { TicketOutcome };

/** The vocabulary, in the order a picker lists it. */
export const TICKET_OUTCOMES: readonly TicketOutcome[] = [
  "completed",
  "withdrawn",
  "duplicate",
  "handled_out_of_band",
  "rejected",
] as const;

/** What a reader is shown for each outcome. */
export const OUTCOME_LABEL: Record<TicketOutcome, string> = {
  completed: "Completed",
  withdrawn: "Withdrawn",
  duplicate: "Duplicate",
  handled_out_of_band: "Handled outside the app",
  rejected: "Rejected",
};

/** The outcomes that mean the work did NOT come back through the app — the
 *  leak the area is measured by (`duplicate` is a filing error, not a leak;
 *  `rejected` is a decision the flow made). */
export const LEAK_OUTCOMES: readonly TicketOutcome[] = ["withdrawn", "handled_out_of_band"];

/** A cancel is never "completed": a canceled request delivered nothing. */
export const CANCEL_OUTCOMES: readonly TicketOutcome[] = ["withdrawn", "duplicate", "handled_out_of_band", "rejected"];

export function isTicketOutcome(v: unknown): v is TicketOutcome {
  return typeof v === "string" && (TICKET_OUTCOMES as readonly string[]).includes(v);
}

/** The actions that end a request, and the outcomes each may record. */
export function outcomesFor(actionType: string): readonly TicketOutcome[] | null {
  switch (actionType) {
    case "cancel_request": return CANCEL_OUTCOMES;
    case "close_ticket":
    case "close_rfi": return TICKET_OUTCOMES;
    default: return null;
  }
}

/**
 * The outcome a terminal action records when the caller named none.
 *  - `close_ticket` from FINAL_DRAFT (the requester's acknowledgement, or a
 *    co-reviewer's on their behalf) and `close_rfi` (answered) → completed:
 *    the flow ran to its end.
 *  - `cancel_request` → withdrawn: DEC-14's cancel IS a withdrawal (the
 *    requester's own, or management's on the queue's behalf). The engine marks
 *    the action `requiresOutcome`; until the request page sends the category
 *    (DF-P9 owns the page), a cancel without one is recorded as withdrawn and
 *    the audit row says the category was defaulted — so a cancel that works
 *    today keeps working (REGRESSION FIRST).
 *  - `close_ticket` from any other status (the Admin force close) → null:
 *    nothing says how that request ended, and "completed" would be a lie.
 */
export function defaultOutcome(actionType: string, fromStatus: string): TicketOutcome | null {
  if (actionType === "close_rfi") return "completed";
  if (actionType === "close_ticket") return fromStatus === "FINAL_DRAFT" ? "completed" : null;
  if (actionType === "cancel_request") return "withdrawn";
  return null;
}

export interface OutcomeRow {
  status?: string | null;
  outcome?: string | null;
  requestType?: string | null;
}

export interface OutcomeSummary {
  /** Requests that ended (CLOSED or CANCELED). */
  ended: number;
  /** Count per outcome, plus `unrecorded` (ended before 20261195, or a force
   *  close that named none). */
  byOutcome: Record<TicketOutcome | "unrecorded", number>;
  /** (withdrawn + handled_out_of_band) / ended with a recorded outcome — the
   *  leak rate; null when nothing ended with an outcome yet. */
  leakRate: number | null;
  /** The same, per request type (the queue a request entered by). */
  byType: Array<{ requestType: string; ended: number; leaked: number; leakRate: number | null }>;
}

/** GAP-107 acceptance 2: a queue's leak rate is a number someone can look at. */
export function summarizeOutcomes(rows: readonly OutcomeRow[]): OutcomeSummary {
  const byOutcome: OutcomeSummary["byOutcome"] = {
    completed: 0, withdrawn: 0, duplicate: 0, handled_out_of_band: 0, rejected: 0, unrecorded: 0,
  };
  const types = new Map<string, { ended: number; recorded: number; leaked: number }>();
  let ended = 0;
  let recorded = 0;
  let leaked = 0;
  for (const r of rows) {
    if (r.status !== "CLOSED" && r.status !== "CANCELED") continue;
    ended += 1;
    const type = (r.requestType ?? "").trim() || "(none)";
    const t = types.get(type) ?? { ended: 0, recorded: 0, leaked: 0 };
    t.ended += 1;
    if (isTicketOutcome(r.outcome)) {
      byOutcome[r.outcome] += 1;
      recorded += 1;
      t.recorded += 1;
      if (LEAK_OUTCOMES.includes(r.outcome)) { leaked += 1; t.leaked += 1; }
    } else {
      byOutcome.unrecorded += 1;
    }
    types.set(type, t);
  }
  return {
    ended,
    byOutcome,
    leakRate: recorded > 0 ? leaked / recorded : null,
    byType: Array.from(types.entries())
      .map(([requestType, t]) => ({ requestType, ended: t.ended, leaked: t.leaked, leakRate: t.recorded > 0 ? t.leaked / t.recorded : null }))
      .sort((a, b) => b.ended - a.ended || a.requestType.localeCompare(b.requestType)),
  };
}
