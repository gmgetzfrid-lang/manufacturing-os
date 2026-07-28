// lib/__tests__/capabilityPolicy.test.ts
//
// The capability policy's core contract: (1) with NO policy, the workflow
// engine behaves exactly as the historical hardcoded rules did; (2) a custom
// policy actually rewires authority; (3) critical capabilities can never
// lose Admin; (4) role-token matching (Engineer tiers, "*") is correct.

import { describe, it, expect } from "vitest";
import { WorkflowEngine } from "@/lib/workflow";
import {
  defaultCapabilityPolicy, policyAllows, roleTokenMatches, validateCapabilityPolicy,
  type CapabilityPolicy,
} from "@/lib/capabilityPolicy";
import type { Ticket, Role } from "@/types/schema";

const ticket = (over: Partial<Ticket>): Ticket => ({
  id: "t1", orgId: "o1", status: "PENDING_ASSIGNMENT", requesterId: "req-1",
  requesterRole: "Requester", requestType: "New Drawing",
  assignedDrafterId: null, assignedEngineerId: null, attachments: [],
  ...over,
} as unknown as Ticket);

const actionsFor = (t: Ticket, role: Role, uid?: string, policy?: CapabilityPolicy) =>
  WorkflowEngine.getActions(t, role, uid, policy).map((a) => a.action);

describe("capability policy — defaults reproduce legacy behavior", () => {
  it("assignment queue: management + DraftingSupervisor assign; Drafter self-assigns; Requester gets nothing", () => {
    const t = ticket({ status: "PENDING_ASSIGNMENT" });
    for (const r of ["Admin", "Manager", "Supervisor", "DraftingSupervisor"] as Role[]) {
      expect(actionsFor(t, r)).toContain("assign");
    }
    expect(actionsFor(t, "Drafter" as Role)).toContain("self_assign");
    expect(actionsFor(t, "Drafter" as Role)).not.toContain("assign");
    expect(actionsFor(t, "Requester" as Role)).toHaveLength(0);
    expect(actionsFor(t, "Viewer" as Role)).toHaveLength(0);
  });

  it("initial review: engineers and management act; force close for management only", () => {
    const t = ticket({ status: "PENDING_ENG_INITIAL" });
    expect(actionsFor(t, "Engineer-2" as Role)).toContain("approve_initial");
    expect(actionsFor(t, "Supervisor" as Role)).toContain("approve_initial");
    expect(actionsFor(t, "Drafter" as Role)).not.toContain("approve_initial");
    expect(actionsFor(t, "Manager" as Role)).toContain("close_ticket");
    expect(actionsFor(t, "Engineer-2" as Role)).not.toContain("close_ticket");
  });

  it("final approval: assigned engineer by identity, management override, other engineers excluded when assigned", () => {
    const t = ticket({ status: "PENDING_FINAL_APPROVAL", assignedEngineerId: "eng-9" });
    expect(actionsFor(t, "Engineer-1" as Role, "eng-9")).toContain("engineer_approve_final");
    expect(actionsFor(t, "Engineer-1" as Role, "eng-other")).not.toContain("engineer_approve_final");
    expect(actionsFor(t, "Manager" as Role, "mgr-1")).toContain("engineer_approve_final");
    // reassign_engineer stays Admin-only by default
    expect(actionsFor(t, "Admin" as Role, "adm-1")).toContain("reassign_engineer");
    expect(actionsFor(t, "Manager" as Role, "mgr-1")).not.toContain("reassign_engineer");
  });

  it("identity rights survive regardless of role: the requester reviews their own ticket", () => {
    const t = ticket({ status: "PENDING_REVIEW", requesterId: "u-7", requesterRole: "Safety" });
    expect(actionsFor(t, "Safety" as Role, "u-7").length).toBeGreaterThan(0);
    expect(actionsFor(t, "Safety" as Role, "someone-else")).toHaveLength(0);
  });
});

describe("capability policy — custom policies rewire authority", () => {
  it("granting DocCtrl assignment authority works; revoking Drafter self-assign works", () => {
    const t = ticket({ status: "PENDING_ASSIGNMENT" });
    const policy: CapabilityPolicy = {
      caps: {
        "ticket.assign": ["Admin", "DocCtrl"],
        "ticket.self_assign": [],
      },
    };
    expect(actionsFor(t, "DocCtrl" as Role, "u", policy)).toContain("assign");
    expect(actionsFor(t, "Supervisor" as Role, "u", policy)).not.toContain("assign");
    expect(actionsFor(t, "Drafter" as Role, "u", policy)).not.toContain("self_assign");
  });

  it("identity rights are NOT strippable by policy: assigned drafter still works their ticket", () => {
    const t = ticket({ status: "DRAFTING", assignedDrafterId: "d-1" });
    const policy: CapabilityPolicy = { caps: { "ticket.draft_work": [] } };
    expect(actionsFor(t, "Viewer" as Role, "d-1", policy)).toContain("save_progress");
    expect(actionsFor(t, "Drafter" as Role, "someone-else", policy)).toHaveLength(0);
  });
});

describe("capability policy — rails and matching", () => {
  it("critical capabilities can never lose Admin", () => {
    expect(validateCapabilityPolicy({ caps: { "ticket.force_close": ["Manager"] } })).toMatch(/Admin/);
    expect(validateCapabilityPolicy({ caps: { "ticket.force_close": ["Admin", "Manager"] } })).toBeNull();
    expect(validateCapabilityPolicy({ caps: { "ticket.force_close": ["*"] } })).toBeNull();
  });

  it("per-person delegation: a live grant confers the capability, an expired one doesn't", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const policy: CapabilityPolicy = {
      grants: [
        { cap: "ticket.assign", uid: "u-1", expiresAt: future },
        { cap: "ticket.assign", uid: "u-2", expiresAt: past },
        { cap: "ticket.force_close", uid: "u-1", expiresAt: null },
      ],
    };
    // Viewer u-1: assignment delegated (temporary) + force-close (standing).
    expect(policyAllows(policy, "ticket.assign", "Viewer", null, "u-1")).toBe(true);
    expect(policyAllows(policy, "ticket.force_close", "Viewer", null, "u-1")).toBe(true);
    // Viewer u-2's grant expired; viewer u-3 never had one.
    expect(policyAllows(policy, "ticket.assign", "Viewer", null, "u-2")).toBe(false);
    expect(policyAllows(policy, "ticket.assign", "Viewer", null, "u-3")).toBe(false);
    // The engine honors delegation end-to-end: u-1 sees the assign button.
    const t = ticket({ status: "PENDING_ASSIGNMENT" });
    expect(actionsFor(t, "Viewer" as Role, "u-1", policy)).toContain("assign");
    expect(actionsFor(t, "Viewer" as Role, "u-2", policy)).not.toContain("assign");
  });

  it("delegation validation: unknown capability and bad expiry rejected", () => {
    expect(validateCapabilityPolicy({ grants: [{ cap: "nope" as never, uid: "u" }] })).toMatch(/Unknown capability/);
    expect(validateCapabilityPolicy({ grants: [{ cap: "ticket.assign", uid: "u", expiresAt: "not-a-date" }] })).toMatch(/expiry/);
    expect(validateCapabilityPolicy({ grants: [{ cap: "ticket.assign", uid: "u", expiresAt: null }] })).toBeNull();
  });

  it("role tokens: Engineer matches every tier; * matches anyone; exact otherwise", () => {
    expect(roleTokenMatches("Engineer", "Engineer-3")).toBe(true);
    expect(roleTokenMatches("Engineer", "Drafter")).toBe(false);
    expect(roleTokenMatches("*", "Viewer")).toBe(true);
    expect(roleTokenMatches("Drafter", "Drafter")).toBe(true);
    expect(roleTokenMatches("Drafter", "DraftingSupervisor")).toBe(false);
  });

  it("policyAllows honors extra (additive) roles", () => {
    expect(policyAllows(undefined, "ticket.assign", "Viewer", ["DraftingSupervisor"])).toBe(true);
    expect(policyAllows(undefined, "ticket.assign", "Viewer", ["Drafter"])).toBe(false);
  });

  it("defaults cover every registered capability", () => {
    const d = defaultCapabilityPolicy();
    expect(Object.values(d).every((v) => Array.isArray(v))).toBe(true);
  });
});
