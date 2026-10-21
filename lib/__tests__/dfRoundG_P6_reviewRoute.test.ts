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
  // DF-P6 fix pass 2 (major 2): an error for a head-count read only.
  countErrors: {} as Record<string, { code?: string; message: string }>,
}));
function chain(table: string) {
  const filters: Array<[string, unknown, "eq" | "is" | "in"]> = [];
  let head = false;
  const rows = () => (state.rows[table] ?? [])
    .filter((r) => filters.every(([k, v, how]) => (how === "is" ? (r[k] ?? null) === v : how === "in" ? (v as unknown[]).includes(r[k]) : r[k] === v)))
    .map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        if (head && state.countErrors[table]) return resolve({ data: null, error: state.countErrors[table], count: null });
        if (state.errors[table]) return resolve({ data: null, error: state.errors[table] });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head === true) head = true;
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
const DECL_SIG = { id: "5a000000-0000-4000-8000-000000000001", org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: "req-1" };
const seed = (requesterRole = "Manager") => {
  state.rows.org_members = [member("req-1", requesterRole), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("sup-1", "Supervisor"), member("ds-1", "DraftingSupervisor")];
  // DF-P6 fix pass (minor 11): a declaration stands on its e-signature.
  state.rows.e_signatures = [{ ...DECL_SIG }];
};
const updates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const audits = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "insert").map((c) => c.args[0] as { action: string; details: Record<string, unknown> });
const lastHistory = (u: Record<string, unknown>) => (u.history as Array<{ action: string; details?: string }>).at(-1)!;

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.countErrors = {};
});

describe("TIER-1 / DEC-33 — the gate reads the work, at the route", () => {
  it("a Manager's UNDECLARED request filed after the paste (engineering_required true) is never plainly approved to IFC by its requester: the minor correction is refused (403), and an approval without a comment is refused (400, the override needs the why — fix pass 4, DEC-90 ruling (3)); nothing written", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ engineering_required: true, review_model_filed: true, like_in_kind_statement: null, like_in_kind_declared_at: null })];
    expect((await post({ ticketId: "t1", actionType: "approve_minor_correction", comment: "typo fixed in the title block" })).status).toBe(403);
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(400);
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

describe("fix pass (review) — the requester's own override, at the route (issues 1 and 2)", () => {
  // filed under the review model (DF-P6 fix pass 2: review_model_filed true)
  const undeclared = { engineering_required: true, review_model_filed: true, like_in_kind_statement: null, like_in_kind_declared_at: null };
  it("issue 1: a TWO-member workspace (a Manager and a Drafter, no engineer): the Manager's undeclared request issues by the recorded override — PENDING_IFC, the override on the history line, the marker on the request, authority.override in the audit row, no engineer_approved_at", async () => {
    state.rows.org_members = [member("req-1", "Manager"), member("d-1", "Drafter")];
    state.rows.e_signatures = [];
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow(undeclared)];
    expect((await post({ ticketId: "t1", actionType: "request_final_engineer_approval", engineer: { id: "d-1", name: "d", email: "d@x" } })).status).toBe(403);
    // fix pass 4 (review, major 2): the requester's own override needs the why
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(400);
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc", comment: "no engineer on staff; like-for-like gasket" });
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(u.status).toBe("PENDING_IFC");
    expect("engineer_approved_at" in u).toBe(false);
    expect(lastHistory(u).details).toMatch(/Management override — issued without the engineer's sign-off/);
    expect((u.metadata as Record<string, unknown>).engineering_override).toMatchObject({ uid: "req-1", action: "approve_draft_ifc" });
    const row = audits().find((a) => a.action === "TICKET_APPROVE_DRAFT_IFC")!;
    expect((row.details.authority as { override?: { of: string } }).override?.of).toBe("engineering_sign_off");
  });
  it("issue 1: a workspace of 3+ with NO member the engineer pick accepts: the Manager requester may override too", async () => {
    state.rows.org_members = [member("req-1", "Manager"), member("d-1", "Drafter"), member("v-1", "Viewer")];
    state.rows.e_signatures = [];
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow(undeclared)];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc", comment: "nobody can be picked" })).status).toBe(200);
  });
  it("fix pass 4 (review, major 2 — DEC-90 ruling (3) as given): in a workspace of 3+ with an engineer to pick, the Manager requester's own override is TAKEN — at PENDING_REVIEW and at PENDING_FINAL_APPROVAL — with a required comment, recorded as an override (history, marker, authority.override naming the self-override); another manager's needs no comment", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow(undeclared)];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(400);
    expect(updates()).toEqual([]);
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc", comment: "the engineer is away; identical replacement" });
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(u.status).toBe("PENDING_IFC");
    expect("engineer_approved_at" in u).toBe(false);
    expect(lastHistory(u).details).toMatch(/Management override — issued without the engineer's sign-off/);
    expect((u.metadata as Record<string, unknown>).engineering_override).toMatchObject({ uid: "req-1", action: "approve_draft_ifc" });
    const row = audits().find((a) => a.action === "TICKET_APPROVE_DRAFT_IFC")!;
    expect((row.details.authority as { override?: { of: string; reason: string } }).override).toMatchObject({ of: "engineering_sign_off", reason: expect.stringMatching(/the request's requester \(a self-override/) });
    for (const action of ["override_engineer_final", "approve_minor_correction"]) {
      state.calls = [];
      state.rows.tickets = [ticketRow({ ...undeclared, status: "PENDING_FINAL_APPROVAL", assigned_engineer_id: "e-1" })];
      expect((await post({ ticketId: "t1", actionType: action })).status, action).toBe(400);
      const ok = await post({ ticketId: "t1", actionType: action, comment: "engineer unavailable this week" });
      expect(ok.status, action).toBe(200);
      expect(updates()[0].status, action).toBe("PENDING_IFC");
      expect("engineer_approved_at" in updates()[0], action).toBe(false);
      expect((updates()[0].metadata as Record<string, unknown>).engineering_override, action).toMatchObject({ uid: "req-1", action });
    }
    state.calls = [];
    state.user = { id: "sup-1" };
    state.rows.tickets = [ticketRow({ ...undeclared, status: "PENDING_FINAL_APPROVAL", assigned_engineer_id: "e-1" })];
    expect((await post({ ticketId: "t1", actionType: "override_engineer_final" })).status).toBe(200);
  });
});

describe("fix pass (review, minor 11) — a declaration stands only on its e-signature", () => {
  it("a declared row whose signature is not on record (a restored or hand-written row) is evaluated as UNDECLARED: a planner requester is refused the direct approval; the audit row says why when an action is taken", async () => {
    seed("Maintenance");
    state.rows.e_signatures = [];
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ requester_role: "Maintenance", ...DECLARED })];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(403);
    // another ticket's / another signer's signature is no record either
    state.rows.e_signatures = [{ ...DECL_SIG, resource_id: "t2" }];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(403);
    state.rows.e_signatures = [{ ...DECL_SIG, signer_user_id: "sup-1" }];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(403);
    expect(updates()).toEqual([]);
    // the route can still be asked to send it to an engineer, and records the reason
    const res = await post({ ticketId: "t1", actionType: "request_final_engineer_approval", comment: "please check the rating", engineer: { id: "e-1", name: "E", email: "e-1@x.io" } });
    expect(res.status).toBe(200);
    expect(audits().find((a) => a.action === "TICKET_REQUEST_FINAL_ENGINEER_APPROVAL")?.details).toMatchObject({ declarationUnverified: "missing" });
  });
  it("fix pass 4 (review, minor 3): a signature read that FAILS is a retryable 503 for every action the declaration decides — never a 403, and never an in-memory 'required' a write could make permanent", async () => {
    seed("Maintenance");
    state.errors.e_signatures = { code: "57014", message: "timeout" };
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ requester_role: "Maintenance", ...DECLARED })];
    const res = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("declaration_unreadable");
    expect(updates()).toEqual([]);
    // an action the declaration does not decide carries on (evaluated as declared)
    expect((await post({ ticketId: "t1", actionType: "request_revision", comment: "the north arrow is missing" })).status).toBe(200);
  });
  it("fix pass 4 (review, minor 3): a declared engineering-first request filed under the review model — the type's mandatory request_eng_review during a signature read error answers 503 and writes nothing (the declaration is not lost); once the read answers, the loop runs and leaves engineering_required alone; flag_engineering answers 503 too", async () => {
    seed("Maintenance");
    state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: { requestTypes: { options: [{ value: "ISO", label: "ISO", engineeringFirst: true }] } } }];
    state.user = { id: "ds-1" };
    const row = ticketRow({ status: "PENDING_ASSIGNMENT", requester_role: "Maintenance", assigned_drafter_id: null, ...DECLARED, review_model_filed: true });
    state.rows.tickets = [row];
    state.errors.e_signatures = { code: "57014", message: "timeout" };
    const body = { ticketId: "t1", actionType: "request_eng_review", comment: "type routes through engineering first", engineer: { id: "e-1", name: "E", email: "e-1@x.io" } };
    const refused = await post(body);
    expect(refused.status).toBe(503);
    expect((await refused.json()).code).toBe("declaration_unreadable");
    expect(updates()).toEqual([]);
    state.rows.tickets = [{ ...row, status: "DRAFTING", assigned_drafter_id: "d-1" }];
    expect((await post({ ticketId: "t1", actionType: "flag_engineering", comment: "different rating" })).status).toBe(503);
    expect(updates()).toEqual([]);
    delete state.errors.e_signatures;
    state.rows.tickets = [row];
    const ok = await post(body);
    expect(ok.status).toBe(200);
    expect(updates()[0].status).toBe("PENDING_ENG_TEAM");
    expect("engineering_required" in updates()[0]).toBe(false);
  });
});

describe("GAP-111 — the flag binds the issue point, never drafting", () => {
  it("request_eng_review writes engineering_required = true with the engineer pick (columns present, a request filed under the review model)", async () => {
    seed("Maintenance");
    state.user = { id: "ds-1" };
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", requester_role: "Maintenance", ...DECLARED, review_model_filed: true })];
    const res = await post({ ticketId: "t1", actionType: "request_eng_review", comment: "new tie-in, not like for like", engineer: { id: "e-1", name: "E", email: "e-1@x.io" } });
    expect(res.status).toBe(200);
    expect(updates()[0].engineering_required).toBe(true);
    expect(updates()[0].status).toBe("PENDING_ENG_TEAM");
  });
  it("fix pass 3 (review, major): on a pre-paste row (review_model_filed false) request_eng_review — an optional scope review or an engineering-first type's mandatory loop — writes NO engineering_required: the ticket keeps its lane (DEC-90 ruling (2)); flag_engineering still binds it explicitly", async () => {
    seed("Manager");
    state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: { requestTypes: { options: [{ value: "ISO", label: "ISO", engineeringFirst: true }] } } }];
    state.user = { id: "ds-1" };
    const legacy = { status: "PENDING_ASSIGNMENT", requester_role: "Manager", assigned_drafter_id: null, engineering_required: false, review_model_filed: false };
    state.rows.tickets = [ticketRow(legacy)];
    const res = await post({ ticketId: "t1", actionType: "request_eng_review", comment: "type routes through engineering first", engineer: { id: "e-1", name: "E", email: "e-1@x.io" } });
    expect(res.status).toBe(200);
    expect(updates()[0].status).toBe("PENDING_ENG_TEAM");
    expect("engineering_required" in updates()[0]).toBe(false);
    // the optional scope review (the type is not engineering-first) on a legacy row: no write either
    state.calls = [];
    state.rows.org_configurations = [];
    state.rows.tickets = [ticketRow(legacy)];
    expect((await post({ ticketId: "t1", actionType: "request_eng_review", comment: "quick scope question", engineer: { id: "e-1", name: "E", email: "e-1@x.io" } })).status).toBe(200);
    expect("engineering_required" in updates()[0]).toBe(false);
    // flag_engineering is the explicit way to bind a legacy row
    state.calls = [];
    state.rows.tickets = [ticketRow({ ...legacy, status: "DRAFTING", assigned_drafter_id: "d-1" })];
    expect((await post({ ticketId: "t1", actionType: "flag_engineering", comment: "the replacement valve is a different rating" })).status).toBe(200);
    expect(updates()[0].engineering_required).toBe(true);
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
  it("DF-P18 (DEC-90 ruling (2) for DF-P18; DEC-44 (DF-P6) reversal (2)): an approval the move flags is refused without the acknowledgement (409, nothing written); an unmoved source applies as before and records nothing; a failed read refuses (503) only an issuing approval of a request with source documents", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow(moved)];
    const absent = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(absent.status).toBe(409);
    expect((await absent.json()).code).toBe("source_drift_unacknowledged");
    expect(updates()).toEqual([]);
    state.calls = [];
    state.rows.documents = [{ id: DOC, org_id: "o1", rev: "3", current_version_id: V3, document_number: "P-101" }];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    expect(audits()[0].details.sourceDrift).toBeUndefined();
    expect(audits()[0].details.sourceDriftUnchecked).toBeUndefined();
    state.calls = [];
    state.errors.documents = { code: "57014", message: "timeout" };
    const unchecked = await post({ ticketId: "t1", actionType: "approve_draft_ifc" });
    expect(unchecked.status).toBe(503);
    expect((await unchecked.json()).code).toBe("source_drift_unchecked");
    expect(updates()).toEqual([]);
  });
  it("REGRESSION (DF-P18): a request with NO source documents reads no document and approves exactly as before, with or without the field", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.errors.documents = { code: "57014", message: "timeout" };
    state.rows.tickets = [ticketRow({})];
    expect((await post({ ticketId: "t1", actionType: "approve_draft_ifc" })).status).toBe(200);
    expect(audits()[0].details.sourceDrift).toBeUndefined();
    expect(state.calls.some((c) => c.table === "documents")).toBe(false);
  });
  it("REGRESSION (DF-P18): a non-issuing action on a request whose source moved is never asked for the acknowledgement, and a failed documents read never blocks it", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.errors.documents = { code: "57014", message: "timeout" };
    state.rows.tickets = [ticketRow(moved)];
    const res = await post({ ticketId: "t1", actionType: "request_revision", comment: "please fix the title block" });
    expect(res.status).toBe(200);
    expect(audits()[0].details.sourceDrift).toBeUndefined();
  });
});

describe("fix pass (review, minor 12) — a roster sign-off refused over an unacknowledged move names its signature", () => {
  it("sign_slot with sourceDriftAcknowledged:false: 409 source_drift_unacknowledged AND a TICKET_SIGN_SLOT_NOT_APPLIED row naming the caller's signature; nothing written to the ticket", async () => {
    const { openRoster } = await import("@/lib/ticketRoster");
    const { parseRoutingControl } = await import("@/lib/routingControl");
    seed("Manager");
    state.rows.documents = [{ id: DOC, org_id: "o1", rev: "4", current_version_id: V4, document_number: "P-101" }];
    const parsed = parseRoutingControl({ slots: [{ kind: "check", label: "Engineering check", mode: "blocking", fill: { roles: ["Engineer"] } }] });
    if (!parsed || !parsed.ok) throw new Error("bad control");
    const r = openRoster({ id: "r-1", control: parsed.control, level: "library", cycle: "1A",
      files: [{ id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", sha256: "f".repeat(64) }],
      ctx: { members: state.rows.org_members as never, policy: null, resource: { requestType: "ISO", unit: null }, requesterId: "req-1" }, openedBy: "d-1", now: LM });
    if (!r.ok) throw new Error(r.error);
    const SIG = "5b000000-0000-4000-8000-000000000001";
    state.rows.e_signatures = [{ ...DECL_SIG }, { id: SIG, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: "e-1" }];
    state.user = { id: "e-1" };
    state.rows.tickets = [ticketRow({ library_id: "1b000000-0000-4000-8000-000000000001", metadata: { review_roster: r.roster, source_document: { id: DOC, document_number: "P-101", rev: "3", version_id: V3 } } })];
    const res = await post({ ticketId: "t1", actionType: "sign_slot", signatureId: SIG, sourceDriftAcknowledged: false });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("source_drift_unacknowledged");
    const row = audits().find((a) => a.action === "TICKET_SIGN_SLOT_NOT_APPLIED")!;
    expect(row.details).toMatchObject({ signatureId: SIG, status: 409, code: "source_drift_unacknowledged", refusedBeforeApply: true });
    expect(updates()).toEqual([]);
  });
});

describe("fix pass 2 (review, issue 1) — at the route, a pre-paste row the backfill set true keeps its requester's paths", () => {
  it("a legacy row (no role stamped, backfilled true, review_model_filed false), its requester now a Manager, at PENDING_FINAL_APPROVAL with an engineer assigned, in a workspace of 5: the requester's override is taken (renamed, recorded as an override) — as yesterday", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ requester_role: null, status: "PENDING_FINAL_APPROVAL", assigned_engineer_id: "e-1", engineering_required: true, review_model_filed: false, like_in_kind_statement: null, like_in_kind_declared_at: null })];
    const res = await post({ ticketId: "t1", actionType: "override_engineer_final" });
    expect(res.status).toBe(200);
    expect(updates()[0].status).toBe("PENDING_IFC");
    expect("engineer_approved_at" in updates()[0]).toBe(false);
    state.calls = [];
    expect((await post({ ticketId: "t1", actionType: "approve_minor_correction", comment: "typo in the title block" })).status).toBe(200);
  });
  it("the same request filed under the review model: the requester's override is taken with a comment (fix pass 4, DEC-90 ruling (3)) — refused without one (400)", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ requester_role: null, status: "PENDING_FINAL_APPROVAL", assigned_engineer_id: "e-1", engineering_required: true, review_model_filed: true, like_in_kind_statement: null, like_in_kind_declared_at: null })];
    expect((await post({ ticketId: "t1", actionType: "override_engineer_final" })).status).toBe(400);
    expect(updates()).toEqual([]);
    expect((await post({ ticketId: "t1", actionType: "override_engineer_final", comment: "engineer away" })).status).toBe(200);
  });
});

describe("fix pass 2 (review, major 2) — the active-member count is checked; a failed read never reads as a small workspace", () => {
  it("an issuing approval or an override is refused 503 (nothing written) when the count cannot be read — the requester's own override is not opened by the failure", async () => {
    seed("Manager");
    state.countErrors.org_members = { code: "57014", message: "canceling statement due to statement timeout" };
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ engineering_required: true, review_model_filed: true, like_in_kind_statement: null, like_in_kind_declared_at: null })];
    for (const action of ["approve_draft_ifc", "approve_minor_correction"]) {
      const res = await post({ ticketId: "t1", actionType: action, comment: "typo" });
      expect(res.status, action).toBe(503);
      expect((await res.json()).code, action).toBe("member_count_unreadable");
    }
    state.rows.tickets = [ticketRow({ engineering_required: true, review_model_filed: true, like_in_kind_statement: null, like_in_kind_declared_at: null, status: "PENDING_FINAL_APPROVAL", assigned_engineer_id: "e-1" })];
    expect((await post({ ticketId: "t1", actionType: "override_engineer_final" })).status).toBe(503);
    expect(updates()).toEqual([]);
  });
  it("any other action is evaluated with separation of duties ACTIVE and its audit row says the count was not checked", async () => {
    seed("Manager");
    state.countErrors.org_members = { code: "57014", message: "timeout" };
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ engineering_required: true, review_model_filed: true, like_in_kind_statement: null, like_in_kind_declared_at: null })];
    const res = await post({ ticketId: "t1", actionType: "request_revision", comment: "the north arrow is missing" });
    expect(res.status).toBe(200);
    expect(audits().find((a) => a.action === "TICKET_REQUEST_REVISION")?.details).toMatchObject({ memberCountUnchecked: true });
  });
  it("REGRESSION: a read that answers leaves the audit row without the mark", async () => {
    seed("Manager");
    state.user = { id: "req-1" };
    state.rows.tickets = [ticketRow({ engineering_required: true, review_model_filed: true, like_in_kind_statement: null, like_in_kind_declared_at: null })];
    expect((await post({ ticketId: "t1", actionType: "request_revision", comment: "the north arrow is missing" })).status).toBe(200);
    expect("memberCountUnchecked" in (audits().find((a) => a.action === "TICKET_REQUEST_REVISION")?.details ?? {})).toBe(false);
  });
});

describe("fix pass 2 (review, minor 7) — the engineering-first loop on a declared request", () => {
  it("request_eng_review as an engineering-first type's mandatory loop on a declared request does not write engineering_required", async () => {
    seed("Maintenance");
    state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: { requestTypes: { options: [{ value: "ISO", label: "ISO", engineeringFirst: true }] } } }];
    state.user = { id: "ds-1" };
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", requester_role: "Maintenance", assigned_drafter_id: null, ...DECLARED })];
    const res = await post({ ticketId: "t1", actionType: "request_eng_review", comment: "type routes through engineering first", engineer: { id: "e-1", name: "E", email: "e-1@x.io" } });
    expect(res.status).toBe(200);
    expect(updates()[0].status).toBe("PENDING_ENG_TEAM");
    expect("engineering_required" in updates()[0]).toBe(false);
  });
});
