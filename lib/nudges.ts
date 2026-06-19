// lib/nudges.ts
//
// Proactive nudges — turn the cockpit from a passive list into a
// system-of-ACTION. We already know when a checkout is stale, a hold has sat
// for weeks, milestones are overdue, or markups are waiting. Surface those as
// short, explainable "do this" prompts instead of making the user infer it.
//
// Pure + testable: derived entirely from the already-loaded inbox snapshot.

import type { InboxSnapshot } from "@/lib/inbox";

export interface Nudge {
  id: string;
  severity: "high" | "medium";
  message: string;
  /** Label for the jump button (empty = handled inline on the page). */
  actionLabel: string;
  href?: string;
}

const HOLD_STALE_DAYS = 14;
const day = 86_400_000;

export function computeNudges(snap: InboxSnapshot): Nudge[] {
  const nudges: Nudge[] = [];

  if (snap.myStaleCheckouts.length > 0) {
    const n = snap.myStaleCheckouts.length;
    nudges.push({
      id: "stale-checkouts",
      severity: "high",
      message: `${n} of your checkouts ${n === 1 ? "has" : "have"} been out a while — check in or extend so others aren't blocked.`,
      actionLabel: "Review checkouts",
      href: "/checkouts",
    });
  }

  const staleHolds = snap.myOpenHolds.filter((h) => {
    const opened = typeof h.openedAt === "string" ? Date.parse(h.openedAt) : NaN;
    return Number.isFinite(opened) && Date.now() - opened > HOLD_STALE_DAYS * day;
  });
  if (staleHolds.length > 0) {
    const oldest = staleHolds[0];
    nudges.push({
      id: "stale-holds",
      severity: "medium",
      message: `A hold you opened${oldest?.reason ? ` ("${oldest.reason}")` : ""} has been open over ${HOLD_STALE_DAYS} days${staleHolds.length > 1 ? ` (and ${staleHolds.length - 1} more)` : ""} — release it or escalate.`,
      actionLabel: "Open hold queue",
      href: "/admin/holds",
    });
  }

  const overdue = snap.milestonesOverdue ?? [];
  if (overdue.length > 0) {
    const oldest = overdue[0];
    nudges.push({
      id: "overdue-milestones",
      severity: "high",
      message: `${overdue.length} milestone${overdue.length === 1 ? " is" : "s are"} overdue${oldest?.__overdueDays ? ` (oldest ${oldest.__overdueDays}d late)` : ""} — update status or reschedule.`,
      actionLabel: "Go to projects",
      href: "/projects",
    });
  }

  // Transmittals issued a while ago that the recipient still hasn't
  // acknowledged — chase the receipt so there's a clean paper trail.
  const TRANSMITTAL_CHASE_DAYS = 7;
  const awaiting = snap.transmittalsAwaitingAck ?? [];
  const aging = awaiting.filter((t) => (t.__ageDays ?? 0) >= TRANSMITTAL_CHASE_DAYS);
  if (aging.length > 0) {
    const oldest = aging[0];
    nudges.push({
      id: "transmittals-unacknowledged",
      severity: "medium",
      message: `${aging.length} transmittal${aging.length === 1 ? "" : "s"} you issued ${aging.length === 1 ? "is" : "are"} still unacknowledged${oldest?.number ? ` (oldest ${oldest.number}, ${oldest.__ageDays}d)` : ""} — chase the recipient for a receipt.`,
      actionLabel: "Open transmittals",
      href: "/transmittals",
    });
  }

  if (snap.markupRequestsToMe.length > 0) {
    const n = snap.markupRequestsToMe.length;
    nudges.push({
      id: "markup-requests",
      severity: "medium",
      message: `${n} markup request${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} waiting on you — share or decline below.`,
      actionLabel: "",
    });
  }

  // Drafting work assigned to me that's gone quiet. Scoped to the statuses
  // where the assignee is the one expected to act (DRAFTING / REVISION_REQ),
  // so we never nag about tickets that are actually waiting on someone else.
  const TICKET_STALE_DAYS = 5;
  const ACTIONABLE_STATUSES = new Set(["DRAFTING", "REVISION_REQ"]);
  const stalledAssigned = (snap.ticketsAssigned ?? []).filter((t) => {
    if (!ACTIONABLE_STATUSES.has(t.status)) return false;
    const lm = t.lastModified != null ? new Date(t.lastModified).getTime() : NaN;
    return Number.isFinite(lm) && Date.now() - lm > TICKET_STALE_DAYS * day;
  });
  if (stalledAssigned.length > 0) {
    const n = stalledAssigned.length;
    nudges.push({
      id: "stalled-assigned-tickets",
      severity: "medium",
      message: `${n} drafting request${n === 1 ? "" : "s"} assigned to you ${n === 1 ? "hasn't" : "haven't"} moved in over ${TICKET_STALE_DAYS} days — pick ${n === 1 ? "it" : "one"} back up or update status.`,
      actionLabel: "Open requests",
      href: "/requests",
    });
  }

  // High severity first, stable otherwise.
  return nudges.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
}
