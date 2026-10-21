// drafting-flow Round G, DF-P6 REVIEW-MODEL — the workflow route enforces the
// review model: the engineering gate reads the WORK (TIER-1 / DEC-33), a
// declared like-in-kind request issues with no engineer and no added wait
// (GAP-101 acceptance 2), the assigner's flag binds (GAP-111), a management
// override of the engineer's sign-off is recorded as one and never stamps
// engineer_approved_at (SM-3), the classes are the workspace's own lists
// (GAP-101 / TIER-4), an approval over a moved source is said and can be
// acknowledged (HAND-7 done-when 3) — and every request the columns cannot
// speak for runs exactly as today (REGRESSION, DEC-90 ruling (2)).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";

const LM = "2026-10-21T00:00:00.000Z";
const DOC = "d0000000-0000-4000-8000-000000000001";
const V3 = "a3000000-0000-4000-8000-000000000003";
const V4 = "a4000000-0000-4000-8000-000000000004";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, { code?: string; message: string }>,
}));
function chain(table: string) {
  const filters: Array<[string, unknown, "eq" | "is" | "in"]> = [];
  const rows = () => (state.rows[table] ?? [])
    .filter((r) => filters.every(([k, v, how]) => (how === "is" ? (r[k] ?? null) === v : how === "in" ? (v as unknown[]).includes(r[k]) : r[k] === v)))
    .map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        if (state.errors[table]) return resolve({ data: null, error: state.errors[table] });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "eq") filters.push([String(args[0]), args[1], "eq"]);
        if (prop === "is") filters.push([String(args[0]), args[1], "is"]);
        if (prop === "in") filters.push([String(args[0]), args[1], "in"]);
        if (prop === "maybeSingle" || prop === "single") {
          if (state.errors[table]) return Promise.resolve({ data: null, error: state.errors[table] });
          return Promise.resolve({ data: rows()[0] ?? null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
    rpc: vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) }, __registerScopedServerClient: () => {} }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn(() => {}) }));
vi.mock("@/lib/r2", () => ({ R2_BUCKET: "b", r2: { send: vi.fn(async () => ({ ContentLength: 4, ETag: '"e"' })) } }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ ok: true })) }));
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const DECLARED = {
  engineering_required: false,
  like_in_kind_statement: "Replacing the 6 inch gasket with an identical spiral-wound gasket",
  like_in_kind_declared_by: "req-1", like_in_kind_declared_at: "2026-10-20T00:00:00.000Z", like_in_kind_signature_id: "5a000000-0000-4000-8000-000000000001",
  work_class: null, code_class: null,
};
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "PENDING_REVIEW", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Manager", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, draft_iteration: 1, deliverable_rev: "1A",
  last_modified: LM, library_id: null, metadata: {}, ...over,
});
const seed = (requesterRole = "Manager") => {
  state.rows.org_members = [member("req-1", requesterRole), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("sup-1", "Supervisor"), member("ds-1", "DraftingSupervisor")];
};
const updates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const audits = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "insert").map((c) => c.args[0] as { action: string; details: Record<string, unknown> });
const lastHistory = (u: Record<string, unknown>) => (u.history as Array<{ action: string; details?: string }>).at(-1)!;

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {};
});

describe("TIER-1 / DEC-33 — the gate reads the work, at the route", () => {
  it("a Manager's UNDECLARED request filed after the paste (engineering_required true) cannot be approved to IFC by its requester — refused, nothing written", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ engineering_required: true, like_in_kind_statement: null, like_in_kind_declared_at: null })];
    for (const action of ["approve_draft_ifc", "approve_minor_correction"]) {
      const res = await post({ ticketId: "t1", actionType: action, comment: "typo fixed in the title block" });
      expect(res.status, action).toBe(403);
    }
    expect(updates()).toEqual([]);
  });
  it("a declared like-in-kind request filed by a Maintenance planner (not exempt under the legacy gate) is approved by its requester straight to IFC — no engineer, no added wait", async () => {
    seed("Maintenance");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ requester_role: "Maintenance", ...DECLARED })];
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(u.status).toBe("PENDING_IFC");
    expect("engineer_approved_at" in u).toBe(false);
    expect(audits()[0].details).toMatchObject({ engineeringRequired: false, likeInKindDeclared: true });
  });
  it("REGRESSION: before 20261250 (no column on the row) the legacy gate decides exactly as today — a Manager requester approves directly; a planner cannot", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow()];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    expect("engineering_required" in updates()[0]).toBe(false);
    state.calls = [];
    seed("Maintenance");
    state.rows.tickets = [ticketRow({ requester_role: "Maintenance" })];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(403);
  });
  it("REGRESSION: a pre-paste row the backfill left false WITHOUT a declaration is gated by the legacy gate, live (a Manager approves; a planner cannot)", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ engineering_required: false, like_in_kind_statement: null, like_in_kind_declared_at: null })];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    state.calls = [];
    seed("Maintenance");
    state.rows.tickets = [ticketRow({ requester_role: "Maintenance", engineering_required: false, like_in_kind_statement: null, like_in_kind_declared_at: null })];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(403);
  });
});

describe("GAP-111 — the flag binds the issue point, never drafting", () => {
  it("request_eng_review writes engineering_required = true with the engineer pick (columns present)", async () => {
    seed("Maintenance");
    state.user = { id: "ds-1" };
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", requester_role: "Maintenance", ...DECLARED })];
    const res = await post({ ticketId: "t1", actionType: "request_eng_review", comment: "new tie-in, not like for like", engineer: { id: "e-1", name: "E", email: "e-1@x.io" } });
    expect(res.status).toBe(200);
    expect(updates()[0].engineering_required).toBe(true);
    expect(updates()[0].status).toBe("PENDING_ENG_TEAM");
  });
  it("flag_engineering at DRAFTING: engineering_required = true, NO status change, the reason on the history line; drafting carries on", async () => {
    seed("Maintenance");
    state.user = { id: "ds-1" };
    state.rows.tickets = [ticketRow({ status: "DRAFTING", requester_role: "Maintenance", ...DECLARED })];
    const res = await post({ ticketId: "t1", actionType: "flag_engineering", comment: "the replacement valve is a different rating" });
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(u.engineering_required).toBe(true);
    expect("status" in u).toBe(false);
    expect(lastHistory(u)).toMatchObject({ action: "Engineering sign-off required — flagged", details: "the replacement valve is a different rating" });
  });
  it("flag_engineering needs a reason, and is not offered before 20261250 (no column) or once required", async () => {
    seed("Maintenance");
    state.user = { id: "ds-1" };
    state.rows.tickets = [ticketRow({ status: "DRAFTING", requester_role: "Maintenance", ...DECLARED })];
    expect((await post({ ticketId: "t1", actionType: "flag_engineering" })).status).toBe(400);
    state.rows.tickets = [ticketRow({ status: "DRAFTING", requester_role: "Maintenance" })];
    expect((await post({ ticketId: "t1", actionType: "flag_engineering", comment: "x" })).status).toBe(403);
    state.rows.tickets = [ticketRow({ status: "DRAFTING", requester_role: "Maintenance", engineering_required: true })];
    expect((await post({ ticketId: "t1", actionType: "flag_engineering", comment: "x" })).status).toBe(403);
    expect(updates()).toEqual([]);
  });
});

describe("SM-3 — a management override of the engineer's sign-off is recorded as one, never as engineer_approved_at", () => {
  const atFinal = { status: "PENDING_FINAL_APPROVAL", assigned_engineer_id: "e-1", requester_role: "Maintenance", engineering_required: true };
  it("a Supervisor is refused engineer_approve_final; override_engineer_final issues WITHOUT engineer_approved_at and the audit row names the override", async () => {
    seed("Maintenance");
    state.user = { id: "sup-1" };
    state.rows.tickets = [ticketRow(atFinal)];
    expect((await post({ ticketId: "t1", actionType: "engineer_approve_final" })).status).toBe(403);
    const res = await post({ ticketId: "t1", actionType: "override_engineer_final" });
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(u.status).toBe("PENDING_IFC");
    expect("engineer_approved_at" in u).toBe(false);
    expect(lastHistory(u).details).toMatch(/Management override — issued without the engineer's sign-off/);
    const row = audits().find((a) => a.action === "TICKET_OVERRIDE_ENGINEER_FINAL")!;
    expect((row.details.authority as { override?: { of: string } }).override?.of).toBe("engineering_sign_off");
  });
  it("a Supervisor's minor correction at final approval is an override too — it does not stamp engineer_approved_at", async () => {
    seed("Maintenance");
    state.user = { id: "sup-1" };
    state.rows.tickets = [ticketRow(atFinal)];
    const res = await post({ ticketId: "t1", actionType: "approve_minor_correction", comment: "fix the tag on sheet 2" });
    expect(res.status).toBe(200);
    expect("engineer_approved_at" in updates()[0]).toBe(false);
    expect(audits()[0].details).toMatchObject({ declaredClass: "minor_correction" });
  });
  it("the assigned engineer signs as the engineer — engineer_approved_at is stamped (REGRESSION)", async () => {
    seed("Maintenance");
    state.user = { id: "e-1" };
    state.rows.tickets = [ticketRow(atFinal)];
    const res = await post({ ticketId: "t1", actionType: "engineer_approve_final" });
    expect(res.status).toBe(200);
    expect(typeof updates()[0].engineer_approved_at).toBe("string");
    expect((audits()[0].details.authority as { override?: unknown }).override).toBeUndefined();
  });
});

describe("GAP-101 / TIER-4 — the classes are the workspace's own lists, set at triage", () => {
  const cfg = { requestTypes: { options: [{ value: "ISO" }] }, workClasses: { options: [{ value: "lik", label: "Like-for-like" }, { value: "new", label: "New design", engineering: true }] }, codeClasses: { options: [{ value: "c1", label: "Code 1" }] } };
  it("a configured work class lands with the assignment; an engineering class raises the requirement; a value not on the list is refused", async () => {
    seed("Maintenance");
    state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: cfg }];
    state.user = { id: "ds-1" };
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", requester_role: "Maintenance", ...DECLARED })];
    const bad = await post({ ticketId: "t1", actionType: "assign", assignment: { id: "d-1", name: "d" }, workClass: "made-up" });
    expect(bad.status).toBe(400);
    const res = await post({ ticketId: "t1", actionType: "assign", assignment: { id: "d-1", name: "d" }, workClass: "new", codeClass: "c1" });
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(u).toMatchObject({ work_class: "new", code_class: "c1", engineering_required: true, status: "DRAFTING" });
    expect((u.history as Array<{ action: string }>).some((h) => h.action === "Review class set")).toBe(true);
  });
  it("a class is refused outside triage, and before 20261250 the assignment applies as today with a warning that the class was not recorded", async () => {
    seed("Maintenance");
    state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: cfg }];
    state.user = { id: "ds-1" };
    state.rows.tickets = [ticketRow({ status: "DRAFTING", requester_role: "Maintenance", ...DECLARED })];
    expect((await post({ ticketId: "t1", actionType: "flag_engineering", comment: "x", workClass: "lik" })).status).toBe(400);
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", requester_role: "Maintenance" })];
    const res = await post({ ticketId: "t1", actionType: "assign", assignment: { id: "d-1", name: "d" }, workClass: "lik" });
    expect(res.status).toBe(200);
    expect("work_class" in updates()[0]).toBe(false);
    expect((await res.json()).warning).toMatch(/20261250 is not applied/);
  });
});

describe("HAND-7 done-when 3 — an approval over a moved source", () => {
  const moved = { metadata: { source_document: { id: DOC, document_number: "P-101", rev: "3", version_id: V3 } } };
  beforeEach(() => {
    state.rows.documents = [{ id: DOC, org_id: "o1", rev: "4", current_version_id: V4, document_number: "P-101" }];
  });
  it("acknowledged: the history line and the audit row record the move and the acknowledgement", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow(moved)];
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc", sourceDriftAcknowledged: true });
    expect(res.status).toBe(200);
    expect(lastHistory(updates()[0]).details).toMatch(/acknowledged by the approver: P-101 raised on Rev 3, now Rev 4/);
    expect(audits()[0].details.sourceDrift).toEqual({ moved: ["P-101 raised on Rev 3, now Rev 4"], acknowledged: true });
  });
  it("a client that knows about the move and says it was not acknowledged is refused (409), nothing written", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow(moved)];
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc", sourceDriftAcknowledged: false });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("source_drift_unacknowledged");
    expect(updates()).toEqual([]);
  });
  it("REGRESSION: a page that does not ask yet still approves — the move is recorded as NOT acknowledged; an unmoved source records nothing; a failed read never blocks", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow(moved)];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    expect(lastHistory(updates()[0]).details).toMatch(/not acknowledged \(the page did not ask\)/);
    state.calls = [];
    state.rows.documents = [{ id: DOC, org_id: "o1", rev: "3", current_version_id: V3, document_number: "P-101" }];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    expect(audits()[0].details.sourceDrift).toBeUndefined();
    state.calls = [];
    state.errors.documents = { code: "57014", message: "timeout" };
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    expect(audits()[0].details.sourceDriftUnchecked).toBe(true);
  });
});
