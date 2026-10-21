// drafting-flow Round G, DF-P6 REVIEW-MODEL fix pass (review, minor 9) — the
// engine matrix the REGRESSION snapshot is taken over.
//
// The same file generated `lib/__tests__/dfP6EngineBase7893129.golden.json`
// once, against the BASE engine (commit 7893129, before DF-P6), and the
// current engine is compared with it by `lib/__tests__/reviewModel.test.ts`.
// It imports only what existed at the base (`@/lib/workflow` WorkflowEngine,
// `@/types/schema`), so it runs unchanged on either side. Every ticket here
// is one the review-model columns cannot speak for (`engineeringRequired`
// absent) — the requests DEC-90 ruling (2) says keep today's path exactly.
// DF-P6 fix pass 2 (review, issue 1): `over` lays extra ticket fields on
// every entry (the snapshot itself was taken with none) — so the same matrix
// pins a pre-paste row the backfill set true (engineeringRequired true,
// reviewModelFiled false) against the base too.

import { WorkflowEngine } from "@/lib/workflow";
import { ALL_ROLES, type Role, type Ticket, type TicketAttachment, type TicketStatus } from "@/types/schema";

const NOW = "2026-10-21T12:00:00.000Z";
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "submitted", rev: "1A" } as TicketAttachment;

export const MATRIX_STATUSES: TicketStatus[] = [
  "PENDING_ENG_TEAM", "PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT", "CLOSED",
];
export const MATRIX_REQUESTER_ROLES: Role[] = ["Viewer", "Manager", "Engineer-2", "DocCtrl"];
export const MATRIX_UIDS = ["req", "drf", "eng", "x"];
export const MATRIX_MEMBER_COUNTS = [0, 5];

function ticketFor(status: TicketStatus, requesterRole: Role, engineerAssigned: boolean, over: Record<string, unknown> = {}): Ticket {
  return {
    id: "t1", orgId: "o1", ticketId: "REQ-1", title: "Pump iso", unit: "U-100", requestType: "ISO",
    status, requesterId: "req", requesterRole, assignedDrafterId: status === "PENDING_ASSIGNMENT" ? null : "drf",
    assignedEngineerId: engineerAssigned ? "eng" : null,
    attachments: [DRAFT], comments: [], history: [], unreadBy: [], watchers: [], revisionCount: 0, deliverableRev: "1A", createdAt: NOW,
    ...over,
  } as unknown as Ticket;
}

/** One line per (requester role, status, engineer assigned, member count,
 *  actor role, uid): the actions offered, each `action|disabled|optional`. */
export function engineMatrix(over: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const req of MATRIX_REQUESTER_ROLES) {
    for (const status of MATRIX_STATUSES) {
      for (const engineerAssigned of [false, true]) {
        for (const members of MATRIX_MEMBER_COUNTS) {
          for (const actorRole of ALL_ROLES) {
            for (const uid of MATRIX_UIDS) {
              const acts = WorkflowEngine.getActions(ticketFor(status, req, engineerAssigned, over), actorRole, uid, undefined, {
                userRoles: [actorRole], requesterRoles: [req], activeMemberCount: members,
              });
              out[`${req}|${status}|${engineerAssigned ? "E" : "-"}|${members}|${actorRole}|${uid}`] = acts
                .map((a) => `${a.action}|${a.disabledReason ? "D" : ""}|${a.optional ? "O" : ""}`)
                .join(",");
            }
          }
        }
      }
    }
  }
  return out;
}
