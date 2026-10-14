// lib/ticketStatusLabels.ts
//
// drafting-flow Round G, DF-P9 TICKET-PAGE — UI-7: what a person READS for a
// request's status. `PENDING_ENG_TEAM`, `REVISION_REQ`, `PENDING_IFC` and
// `FINAL_DRAFT` are database identifiers; they were the primary label on the
// ticket, in the queue, on the supervisor board and in the status filter.
// "Final Draft" reads as *not finished* to a requester when it means the
// package was issued and waits for their acknowledgement.
//
// DISPLAY LAYER ONLY. The enum values are untouched (99-fix-sequencing,
// "Do not do these": renaming them ripples into the state machine, the
// archive and the shed). The request surfaces read their words from here —
// the ticket header pill and its printed traveler, the queue's table, cards,
// status filter, the board's per-request chips and its single-status lane
// chips, the workflow map (components/requests/WorkflowDiagramModal.tsx), the
// archived-ticket viewer and a document's impact panel — so the map and the
// chip never disagree. A surface that still shows the stored value is a
// drafting-flow UI-7 remainder, listed there with its owner; it is fixed with
// `ticketStatusLabel`, never a new list.
//
// Pure — types and one label constant only — so pages, components and tests
// share it.

import type { TicketStatus } from "@/types/schema";
import { UNIT_UNKNOWN_LABEL } from "@/lib/ticketCreate";

/** One display label per status. The workflow map's stage names. */
export const TICKET_STATUS_LABELS: Readonly<Record<TicketStatus, string>> = Object.freeze({
  PENDING_ASSIGNMENT: "Awaiting drafter",
  PENDING_ENG_TEAM: "Engineering review",
  DRAFTING: "Drafting",
  REVISION_REQ: "Revision requested",
  PENDING_REVIEW: "In review",
  PENDING_FINAL_APPROVAL: "Engineer sign-off",
  PENDING_IFC: "Ready to issue (IFC)",
  FINAL_DRAFT: "Issued — awaiting acknowledgement",
  CLOSED: "Closed",
  CANCELED: "Canceled",
});

/** The label a person reads for `status`. A value this build does not know
 *  (a row written by a newer build, a legacy status) is shown in words, never
 *  as SHOUTED_SNAKE_CASE: "Some_status" → "Some status". */
export function ticketStatusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown status";
  const known = (TICKET_STATUS_LABELS as Record<string, string>)[status];
  if (known) return known;
  const words = status.replace(/_/g, " ").toLowerCase().trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown status";
}

/** The status filter's choices, in workflow order (the queue's select). */
export const TICKET_STATUS_FILTER_ORDER: readonly TicketStatus[] = [
  "PENDING_ASSIGNMENT",
  "PENDING_ENG_TEAM",
  "DRAFTING",
  "REVISION_REQ",
  "PENDING_REVIEW",
  "PENDING_FINAL_APPROVAL",
  "PENDING_IFC",
  "FINAL_DRAFT",
  "CLOSED",
  "CANCELED",
];

// ─────────────────────────────────────────────────────────────────────────────
// FRIC-3 / FRIC-8 readers (DF-P2's hand-off): the unit as a person reads it.
// /api/tickets/create records an unknown unit explicitly (`unit` NULL +
// metadata.unit_unknown, DEC-101 item 1), keeps a derived unit that is not on
// the workspace's list and marks it (metadata.unit_unlisted), and keeps a
// unit it could not check because the list could not be read
// (metadata.unit_unchecked = the unit given, with `unit` NULL). The queue's
// unit chip and the ticket page used to render all three as an empty chip.
// Read-only: triage sets the unit (the assign modal, DCW-7).
// ─────────────────────────────────────────────────────────────────────────────

export interface TicketUnitDisplay {
  /** The words in the chip. */
  text: string;
  /** A qualifier shown beside it ("not on the unit list"), or null. */
  note: string | null;
  /** No unit is on the record (the chip is a statement, not a unit code). */
  unknown: boolean;
}

/** "No unit recorded" — a NULL unit on a row that predates the explicit
 *  unknown (DF-P2): nothing says why, so nothing is claimed. */
export const NO_UNIT_RECORDED_LABEL = "No unit recorded";

export function ticketUnitDisplay(
  unit: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): TicketUnitDisplay {
  const m = metadata ?? {};
  const u = typeof unit === "string" ? unit.trim() : "";
  if (u) return { text: u, note: m.unit_unlisted === true ? "not on the unit list" : null, unknown: false };
  const unchecked = typeof m.unit_unchecked === "string" ? m.unit_unchecked.trim() : "";
  if (unchecked) return { text: unchecked, note: "given, not checked — the unit list could not be read; triage assigns", unknown: true };
  if (m.unit_unknown === true) return { text: UNIT_UNKNOWN_LABEL, note: null, unknown: true };
  return { text: NO_UNIT_RECORDED_LABEL, note: null, unknown: true };
}
