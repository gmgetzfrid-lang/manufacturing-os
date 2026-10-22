// lib/examinationScopeGate.ts
//
// drafting-flow Round G, DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE —
// second fix pass. The workflow route's examination-scope issue gate in ONE
// call (GAP-102 acceptance 4; DEC-90 rulings (2) and (6) for DF-P24), so
// the route holds a single line that a test can switch off whole (the A/B
// regression sweep compares the route with this call against the route
// without it), and the preview "would this sign-off complete the review"
// shared with /api/tickets/examination-scope's waiver authority.
//
// Server-only: it reads lib/ticketRoster.ts (node:crypto). The rules
// themselves stay in lib/examinationScope.ts (pure, browser-safe).

import type { Ticket } from "@/types/schema";
import { ISSUING_APPROVALS, currentRoster, slotSignPlan } from "@/lib/workflow";
import { applySignPlan, rosterCompletion } from "@/lib/ticketRoster";
import { parseExaminationScopeConfig, applicableRequirements, scopeGateOutcome, type ScopeGateOutcome } from "@/lib/examinationScope";

/** Would this caller's roster sign-off, made now, COMPLETE the review (the
 *  sign-off block's own computation: slotSignPlan → applySignPlan →
 *  rosterCompletion with the producer floor)? Pure over the ticket. */
export function signOffWouldComplete(ticket: Ticket, uid: string, sodActive: boolean, now: number = Date.now()): boolean {
  const r = currentRoster(ticket);
  const p = r ? slotSignPlan(r, ticket, uid, sodActive, now) : null;
  return !!r && !!p && p.fillable.length > 0
    && rosterCompletion(applySignPlan(r, p, { uid, name: null }, "examination-scope-preview", new Date(now).toISOString()), { sodActive, drafterId: ticket.assignedDrafterId }).complete;
}

/** What the gate decided for one workflow action:
 *   * `none` — not an issue, or no requirement applies: nothing was read and
 *     nothing is recorded (today's route);
 *   * `config_unchecked` — an issue whose 'drafting' row could not be read:
 *     it goes ahead (DEC-90 ruling (6)) and its audit row says so;
 *   * otherwise lib/examinationScope.ts scopeGateOutcome over the request's
 *     ticket_examination_scopes row (read only here, only then). */
export type IssueScopeDecision = { kind: "none" } | { kind: "config_unchecked" } | ScopeGateOutcome;

export async function issueScopeGate(input: {
  action: string;
  ticket: Ticket;
  draftingCfg: Record<string, unknown> | null;
  draftingCfgRead: boolean;
  callerId: string;
  sodActive: boolean;
  readRow: () => PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>;
}): Promise<IssueScopeDecision> {
  const { action, ticket, draftingCfg, draftingCfgRead, callerId, sodActive } = input;
  const approval = ISSUING_APPROVALS.has(action);
  if (!approval && action !== "sign_slot") return { kind: "none" };
  const config = draftingCfgRead ? parseExaminationScopeConfig(draftingCfg) : null;
  const entries = config ? applicableRequirements(config, ticket) : [];
  // A sign-off is an issue only when it completes the review — computed only
  // where it could matter (a requirement applies, or the configuration is
  // unknown).
  const issues = approval || ((entries.length > 0 || !config) && signOffWouldComplete(ticket, callerId, sodActive));
  if (!issues) return { kind: "none" };
  if (!config) return { kind: "config_unchecked" };
  if (entries.length === 0) return { kind: "none" };
  const read = await input.readRow();
  // The caller reached the gate past the route's own authority checks (the
  // action offered and enabled, TIER-5, the member count, the declaration,
  // a sign-off that completes the review) — the same acts
  // lib/workflowAuthority.ts issueAuthorityNow accepts a waiver from — so the
  // refusal tells them they may record one (merge-time fix pass 2).
  return scopeGateOutcome(config, ticket, { data: read.data, error: read.error }, draftingCfg, { callerMayWaive: true });
}
