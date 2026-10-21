// drafting-flow Round G, DF-P8 fix pass — DEC-90 ruling (1): a request with
// no project behaves exactly as it did before DF-P8, in every status and on
// every transition the engine offers.
//
// This helper walks every TicketStatus × role × identity × offered action for
// a ticket ROW that names no project (project_id null) and carries no
// archive claim (archive_id null), runs computeTransition on rowToTicket(row)
// with the clock and the id generator pinned, and returns one digest per
// (status, role, identity, action) of { newStatus, updates }. The SAME file
// was run against the base commit db3a1f3 to write
// lib/__tests__/fixtures/dfP8NoProjectBaseline.json; the test compares the
// two maps, so any drift in what a no-project request writes fails.
// (The workflow route's SM-7 `attempt` stamp is added by the route after
// computeTransition — it is not part of these updates.)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { WorkflowEngine } from "@/lib/workflow";
import { computeTransition, rowToTicket, type TransitionInput } from "@/lib/ticketTransitions";
import { ALL_ROLES, type Role, type TicketAttachment, type TicketStatus } from "@/types/schema";

export const MATRIX_NOW = "2026-10-02T12:00:00.000Z";
const LM = "2026-10-02T00:00:00.000Z";
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "submitted" } as TicketAttachment;
const FINAL = { id: "a-f", name: "iso_IFC.pdf", url: "orgs/o1/tickets/REQ-1/iso_IFC.pdf", type: "Final", status: "submitted" } as TicketAttachment;

export const MATRIX_STATUSES: TicketStatus[] = (() => {
  const s = readFileSync(join(process.cwd(), "types/schema.ts"), "utf8");
  const at = s.indexOf("export type TicketStatus =");
  return Array.from(s.slice(at, s.indexOf(";", at)).matchAll(/"([A-Z_]+)"/g)).map((m) => m[1] as TicketStatus);
})();

/** The DB row of a request with no project and no archive claim. */
export function noProjectRow(status: TicketStatus): Record<string, unknown> {
  return {
    id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "Pump iso", unit: "U-100", request_type: "ISO", status,
    requester_id: "req", requester_role: "Viewer",
    assigned_drafter_id: status === "PENDING_ASSIGNMENT" ? null : "drf",
    assigned_engineer_id: status === "PENDING_ENG_TEAM" || status === "PENDING_FINAL_APPROVAL" ? "eng" : null,
    attachments: [DRAFT], comments: [], history: [], unread_by: [], watchers: [], revision_count: 0,
    created_at: LM, last_modified: LM, archived_at: null, archive_id: null,
    project_id: null,
  };
}

function inputFor(a: { action: string; label: string; variant?: unknown; engineeringOverride?: boolean }, uid: string, role: string): TransitionInput {
  return {
    engineeringOverride: a.engineeringOverride === true,
    actionType: a.action,
    actionLabel: a.label,
    variant: a.variant,
    comment: "note for the record",
    engineer: { id: "eng-new", name: "New Engineer", email: "eng-new@x.io" },
    assignment: { id: "drf-new", name: "New Drafter" },
    finalAttachment: FINAL,
    attachment: { ...DRAFT, id: "a-extra", type: "Reference" } as TicketAttachment,
    actor: { uid, email: `${uid}@x.io`, role },
    now: MATRIX_NOW,
  } as unknown as TransitionInput;
}

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
};

export interface NoProjectMatrix {
  /** `${status}|${role}|${uid}|${action}` → 16-hex digest of { newStatus, updates } */
  digests: Record<string, string>;
  /** every update key written anywhere in the matrix */
  keys: string[];
}

export function noProjectMatrix(): NoProjectMatrix {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(MATRIX_NOW));
  let n = 0;
  const uuid = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`);
  const digests: Record<string, string> = {};
  const keys = new Set<string>();
  try {
    for (const status of MATRIX_STATUSES) {
      for (const role of ALL_ROLES as Role[]) {
        for (const uid of ["req", "drf", "eng", "stranger"]) {
          const ticket = rowToTicket(noProjectRow(status));
          for (const a of WorkflowEngine.getActions(ticket, role, uid, undefined, { userRoles: [role] })) {
            if (a.disabledReason) continue;
            n = 0;
            const res = computeTransition(rowToTicket(noProjectRow(status)), inputFor(a, uid, role));
            for (const k of Object.keys(res.updates)) keys.add(k);
            digests[`${status}|${role}|${uid}|${a.action}`] = createHash("sha256")
              .update(stable({ newStatus: res.newStatus, updates: res.updates })).digest("hex").slice(0, 16);
          }
        }
      }
    }
  } finally {
    uuid.mockRestore();
    vi.useRealTimers();
  }
  return { digests, keys: [...keys].sort() };
}
