// Round D1 — the remaining HIGH group without a migration: DEC-16 (WF-12 /
// DRAFT-3: the engineer gate fails closed on the filing snapshot OR the
// requester's current collection), OWN-11 done-when 2 (the ready-to-publish
// notice reaches someone who can act and says why), CHAIN-2 close-out (SQL and
// TypeScript rank tables agree for all 19 roles), CHAIN-5 (the 19 role names
// are pinned — DEC-5), CHAIN-7 (link set = admit set).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowEngine, engineerApprovalRequired, requiresEngineerApproval } from "@/lib/workflow";
import { roleRank } from "@/lib/roleCapabilities";
import { ALL_ROLES, type Role, type Ticket } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("DEC-16 — engineerApprovalRequired fails closed on either value", () => {
  it("a stale-high snapshot no longer short-circuits: Manager-at-filing, Requester-now → required", () => {
    expect(requiresEngineerApproval("Manager")).toBe(false);
    expect(engineerApprovalRequired("Manager", ["Requester"])).toBe(true);
    expect(engineerApprovalRequired("Manager", ["Manager"])).toBe(false);
    expect(engineerApprovalRequired("Manager", ["Requester", "DocCtrl"])).toBe(false);
  });
  it("a promoted engineer's old tickets are not forced through review; unknown current lets the snapshot decide; a departed requester requires one", () => {
    expect(engineerApprovalRequired("Requester", ["Engineer-2"])).toBe(true); // snapshot says required — the !isEng clause rescues an engineer approver
    expect(engineerApprovalRequired("Engineer-1", ["Requester"])).toBe(true); // demoted engineer: current says required
    expect(engineerApprovalRequired("Engineer-1", ["Engineer-1"])).toBe(false);
    expect(engineerApprovalRequired("Manager", null)).toBe(false);
    expect(engineerApprovalRequired("Manager", undefined)).toBe(false);
    expect(engineerApprovalRequired("Manager", [])).toBe(true);
    expect(engineerApprovalRequired(undefined, ["Manager"])).toBe(true); // no snapshot at all fails closed
  });
  it("getActions at PENDING_REVIEW: the demoted requester is offered the engineer route, not direct IFC approval", () => {
    const ticket = { id: "t1", orgId: "o1", ticketId: "REQ-1", title: "x", unit: "U", requestType: "Revision", status: "PENDING_REVIEW", requesterId: "u1", requesterRole: "Manager", attachments: [], createdAt: "2026-09-01T00:00:00Z" } as unknown as Ticket;
    const asBefore = WorkflowEngine.getActions(ticket, "Requester" as Role, "u1", undefined, { userRoles: ["Requester"], activeMemberCount: 5 }).map((a) => a.action);
    expect(asBefore).toContain("approve_draft_ifc"); // snapshot alone (unknown current) — the old behaviour
    const now = WorkflowEngine.getActions(ticket, "Requester" as Role, "u1", undefined, { userRoles: ["Requester"], activeMemberCount: 5, requesterRoles: ["Requester"] }).map((a) => a.action);
    expect(now).toContain("request_final_engineer_approval");
    expect(now).not.toContain("approve_draft_ifc");
    const stillManager = WorkflowEngine.getActions(ticket, "Manager" as Role, "u1", undefined, { userRoles: ["Manager"], activeMemberCount: 5, requesterRoles: ["Manager"] }).map((a) => a.action);
    expect(stillManager).toContain("approve_draft_ifc");
  });
  it("the route looks the requester's current collection up; the page passes it; the rule is documented", () => {
    const r = src("app/api/tickets/workflow-action/route.ts");
    expect(r).toContain('.eq("org_id", ticket.orgId).eq("uid", ticket.requesterId).eq("status", "active").maybeSingle();');
    expect(r).toContain("requesterRoles = heldRoles(reqMember as { role?: unknown; roles?: unknown } | null);");
    expect(r).toMatch(/closeWithoutReviewTypes,\s*\n\s*requesterRoles,\s*\n\s*\}\);/);
    const p = src("app/(protected)/requests/[id]/page.tsx");
    expect(p).toContain("const [requesterRoles, setRequesterRoles] = useState<string[] | null>(null);");
    expect(p).toMatch(/closeWithoutReviewTypes,\s*\n\s*requesterRoles,\s*\n\s*\}\);/);
    expect(src("types/schema.ts")).toMatch(/requester's role STAMPED AT FILING[\s\S]*DEC-16/);
    expect(src("lib/workflow.ts")).toContain("const needsEngineerApproval = engineerApprovalRequired(ticket.requesterRole, ctx?.requesterRoles);");
  });
});

describe("OWN-11 done-when 2 — the ready-to-publish notice reaches someone who can act", () => {
  it("watchers are owner AND controllers (Round D2 replaced the automatic publish itself — see sweepRoundD2)", () => {
    const rc = src("lib/reviewControl.ts");
    expect(rc).toContain("const watchers = uniq([...(owner.userId ? [owner.userId] : []), ...controllers]).filter((u) => u !== input.signerUserId);");
    expect(rc).not.toContain("uniq([...(owner.userId ? [owner.userId] : controllers)])");
  });
});

describe("CHAIN-2 close-out — the SQL rank table (20261046) and roleRank agree for all 19 roles", () => {
  it("every role has the same rank in both", () => {
    const m46 = src("supabase/migrations/20261046_rp_phase6_sweep_authority_by_collection.sql");
    const a = m46.indexOf("CREATE OR REPLACE FUNCTION role_rank(p_role text)"); const b = m46.indexOf("$$;", a);
    const sql = m46.slice(a, b);
    const table = new Map<string, number>();
    for (const x of sql.matchAll(/WHEN '([A-Za-z0-9-]+)' THEN (\d+)/g)) table.set(x[1], Number(x[2]));
    expect(table.size).toBe(19);
    for (const role of ALL_ROLES) expect(table.get(role), role).toBe(roleRank(role));
    expect(sql).toMatch(/ELSE 0 END;/);
  });
});

describe("CHAIN-5 / DEC-5 — role identity is the name; the nineteen strings are pinned", () => {
  it("ALL_ROLES holds exactly the audit's 19 roles, and the constraint is recorded beside them", () => {
    expect([...ALL_ROLES].sort()).toEqual([
      "Accounting", "Admin", "Auditor", "Contractor", "DocCtrl", "Drafter", "DraftingSupervisor",
      "Engineer-1", "Engineer-2", "Engineer-3", "Engineer-4", "HR", "Maintenance", "Manager",
      "Operations", "Requester", "Safety", "Supervisor", "Viewer",
    ]);
    const t = src("types/schema.ts");
    const i = t.indexOf("export const ALL_ROLES");
    expect(t.slice(Math.max(0, i - 900), i)).toMatch(/DEC-5 \/ CHAIN-5: role identity IS the role's NAME/);
  });
});

describe("CHAIN-7 — the set shown the Users link equals the set the page admits", () => {
  it("Admin / DocCtrl see the section; a Manager sees exactly the Users entry; the page admits all three", () => {
    const sb = src("components/navigation/Sidebar.tsx");
    expect(sb).toContain("const isAdmin = hasAnyRole(['Admin', 'DocCtrl']);");
    expect(sb).toContain("] : hasAnyRole(['Manager']) ? [usersEntry] : [];");
    expect(sb).toContain("const usersEntry: NavLeaf = { label: 'Users', href: '/admin/users', icon: Users, tone: 'blue' };");
    expect(src("app/(protected)/admin/users/page.tsx")).toContain("if (!hasAnyRole(['Admin', 'Manager', 'DocCtrl'])) {");
  });
});
