// lib/__tests__/ticketAttention.test.ts
//
// Freezes the single source of truth for "does this ticket need MY action?".
// The sidebar badge, the header bell, the /inbox cockpit, and the Drafting
// Request Portal all share this rule (lib/ticketAttention.ts), so these
// expectations guard against the surfaces drifting apart again — in particular
// the supervisor's PENDING_IFC responsibility, which the routing layer
// (lib/ticketRouting.ts) sends them but the portal previously failed to flag.

import { describe, it, expect } from "vitest";
import {
  isActionRequired, isManagementRole, isEngineerRole, MANAGEMENT_ROLES,
} from "@/lib/ticketAttention";
import type { Ticket, Role, TicketStatus } from "@/types/schema";

function mk(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "t-1",
    orgId: "org-1",
    ticketId: "KE-DDRT-26-0001",
    title: "Pump iso",
    unit: "U-100",
    requestType: "ISO",
    status: "PENDING_ASSIGNMENT",
    requesterId: "u-req",
    createdAt: "2026-06-15T12:00:00.000Z",
    ...over,
  } as Ticket;
}

const ctx = (roles: Role[], uid: string | null = "me") => ({ uid, roles });

describe("role predicates", () => {
  it("recognises the supervisory roles", () => {
    expect(isManagementRole(["DraftingSupervisor"])).toBe(true);
    expect(isManagementRole(["Admin"])).toBe(true);
    expect(isManagementRole(["Viewer", "Manager"])).toBe(true);
    expect(isManagementRole(["Drafter"])).toBe(false);
    expect(MANAGEMENT_ROLES).toContain("DraftingSupervisor");
  });
  it("recognises any engineer level", () => {
    expect(isEngineerRole(["Engineer-1"])).toBe(true);
    expect(isEngineerRole(["Engineer-4"])).toBe(true);
    expect(isEngineerRole(["Drafter"])).toBe(false);
  });
});

describe("supervisor / admin attention — the gap this closes", () => {
  it("flags PENDING_IFC for a supervisor, matching ticketRouting", () => {
    const t = mk({ status: "PENDING_IFC", assignedDrafterId: "someone-else" });
    expect(isActionRequired(t, ctx(["DraftingSupervisor"]))).toBe(true);
    expect(isActionRequired(t, ctx(["Admin"]))).toBe(true);
  });
  it("flags every assignment / review / approval / IFC gate for management", () => {
    const gates: TicketStatus[] = [
      "PENDING_ASSIGNMENT", "PENDING_ENG_INITIAL", "PENDING_REVIEW",
      "PENDING_FINAL_APPROVAL", "PENDING_IFC",
    ];
    for (const status of gates) {
      expect(isActionRequired(mk({ status }), ctx(["Admin"]))).toBe(true);
    }
  });
  it("does NOT flag DRAFTING — that's the drafter's bench, not the supervisor's", () => {
    expect(isActionRequired(mk({ status: "DRAFTING", assignedDrafterId: "d1" }), ctx(["Admin"]))).toBe(false);
  });
});

describe("personal-assignment attention", () => {
  it("flags the assigned drafter on their in-flight states", () => {
    const states: TicketStatus[] = ["DRAFTING", "REVISION_REQ", "PENDING_IFC"];
    for (const status of states) {
      expect(isActionRequired(mk({ status, assignedDrafterId: "me" }), ctx(["Drafter"]))).toBe(true);
    }
  });
  it("does not flag a drafter for someone else's in-flight ticket", () => {
    expect(isActionRequired(mk({ status: "DRAFTING", assignedDrafterId: "other" }), ctx(["Drafter"]))).toBe(false);
  });
  it("offers the unassigned pool to any drafter", () => {
    expect(isActionRequired(mk({ status: "PENDING_ASSIGNMENT" }), ctx(["Drafter"]))).toBe(true);
  });
  it("flags the requester to review then acknowledge", () => {
    expect(isActionRequired(mk({ status: "PENDING_REVIEW", requesterId: "me" }), ctx(["Requester"]))).toBe(true);
    expect(isActionRequired(mk({ status: "FINAL_DRAFT", requesterId: "me" }), ctx(["Requester"]))).toBe(true);
  });
});

describe("engineer attention", () => {
  it("flags initial review and the open team / approval gates", () => {
    expect(isActionRequired(mk({ status: "PENDING_ENG_INITIAL" }), ctx(["Engineer-2"]))).toBe(true);
    expect(isActionRequired(mk({ status: "PENDING_ENG_TEAM" }), ctx(["Engineer-2"]))).toBe(true);
    expect(isActionRequired(mk({ status: "PENDING_REVIEW" }), ctx(["Engineer-2"]))).toBe(true);
  });
  it("stops nagging the pool once another engineer claims the ticket", () => {
    expect(isActionRequired(mk({ status: "PENDING_ENG_TEAM", assignedEngineerId: "eng-x" }), ctx(["Engineer-2"]))).toBe(false);
  });
  it("still flags the engineer who owns the claimed ticket", () => {
    expect(isActionRequired(mk({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: "me" }), ctx(["Engineer-2"]))).toBe(true);
  });
});

describe("guards", () => {
  it("returns false without a uid", () => {
    expect(isActionRequired(mk({ status: "PENDING_IFC" }), ctx(["Admin"], null))).toBe(false);
  });
  it("a plain viewer is never on the hook", () => {
    const states: TicketStatus[] = ["PENDING_ASSIGNMENT", "PENDING_IFC", "PENDING_REVIEW", "DRAFTING"];
    for (const status of states) {
      expect(isActionRequired(mk({ status }), ctx(["Viewer"]))).toBe(false);
    }
  });
});
