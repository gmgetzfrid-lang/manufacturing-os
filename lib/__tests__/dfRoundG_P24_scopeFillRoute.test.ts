// drafting-flow Round G, DF-P24 — /api/tickets/examination-scope, the one
// place a request's examination data is written (ruling (1): the drafter or
// the engineer already in the flow, or the assignment queue; values picked
// from the workspace's lists) and where a person who holds the issue
// authority records why it issues without it (ruling (2): a required reason,
// audited). The audit row first; the write compare-and-set; a write that does
// not land is named by a _NOT_APPLIED row; before 20261266 nothing is written.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, { code?: string; message: string }>,
  writeResult: null as null | { data: unknown; error: { code?: string; message: string } | null },
}));
function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let head = false;
  let writing = false;
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v)).map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        if (writing && table === "ticket_examination_scopes" && state.writeResult) return resolve(state.writeResult);
        if (state.errors[table]) return resolve({ data: null, error: state.errors[table] });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        if (writing) return resolve({ data: [{ ticket_id: "t1" }], error: null });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "insert" || prop === "update") writing = true;
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
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
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
import { POST } from "@/app/api/tickets/examination-scope/route";

const T = "7e000000-0000-4000-8000-000000000001";
const SINCE = "2026-10-01T00:00:00.000Z";
const post = (body: unknown, auth = true) => POST(new NextRequest("http://x/api/tickets/examination-scope", {
  method: "POST", headers: { ...(auth ? { authorization: "Bearer t" } : {}), "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string) => ({ org_id: "o1", uid, role, roles: [role], email: `${uid}@x.io`, display_name: uid, status: "active" });
const CFG = {
  requestTypes: { options: [] },
  examinationScope: {
    fields: [{ key: "exam", label: "Examination scope", options: [{ value: "rt5", label: "5% RT" }, { value: "rt100", label: "100% RT" }] }],
    requirements: [{ field: "exam", libraryId: "lib-1", since: SINCE }],
  },
};
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: T, org_id: "o1", ticket_id: "REQ-1", title: "x", status: "PENDING_REVIEW", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: "e-1",
  attachments: [{ id: "a", name: "d.pdf", url: "k", type: "Draft", status: "submitted", rev: "1A" }], comments: [], history: [], watchers: [], unread_by: [],
  revision_count: 0, draft_iteration: 1, deliverable_rev: "1A", last_modified: "2026-10-21T00:00:00.000Z", library_id: "lib-1", created_at: "2026-10-05T00:00:00.000Z", metadata: {}, ...over,
});
const seed = (over: Record<string, unknown> = {}) => {
  state.rows.tickets = [ticketRow(over)];
  state.rows.org_members = [member("req-1", "Requester"), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("a-1", "Admin"), member("q-1", "Viewer")];
  state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: CFG }];
};
const audits = () => state.calls.filter((c) => c.table === "audit_logs" && c.method === "insert").map((c) => c.args[0] as { action: string; details: Record<string, unknown> });
const writes = () => state.calls.filter((c) => c.table === "ticket_examination_scopes" && (c.method === "insert" || c.method === "update"));

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.writeResult = null;
});

describe("recording values — the drafter or the engineer already in the flow", () => {
  it("the drafter records a value from the list: the audit row FIRST, then the insert", async () => {
    seed();
    state.user = { id: "d-1" };
    const res = await post({ ticketId: T, values: { exam: "rt5" } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.values.exam).toMatchObject({ value: "rt5", by: "d-1", byName: "d-1" });
    const order = state.calls.filter((c) => (c.table === "audit_logs" || c.table === "ticket_examination_scopes") && (c.method === "insert" || c.method === "update")).map((c) => c.table);
    expect(order).toEqual(["audit_logs", "ticket_examination_scopes"]);
    expect(audits()[0]).toMatchObject({ action: "TICKET_EXAMINATION_SCOPE_SET", details: { changed: [{ field: "exam", from: null, to: "rt5" }], authority: "drafter", recordedBeforeApply: true } });
    expect(writes()[0].args[0]).toMatchObject({ ticket_id: T, org_id: "o1", field_values: { exam: { value: "rt5", by: "d-1" } }, waiver: null, updated_by: "d-1" });
  });
  it("the engineer may; the requester, or a member outside the flow, may not (403, nothing written)", async () => {
    seed();
    state.user = { id: "e-1" };
    expect((await post({ ticketId: T, values: { exam: "rt100" } })).status).toBe(200);
    for (const uid of ["req-1", "q-1"]) {
      state.calls = [];
      seed();
      state.user = { id: uid };
      const r = await post({ ticketId: T, values: { exam: "rt5" } });
      expect(r.status, uid).toBe(403);
      expect(audits()).toEqual([]);
      expect(writes()).toEqual([]);
    }
  });
  it("second fix pass (GAP-102 acceptance 1): the requester of a like-in-kind request (no engineer, no engineering slot) records what they already specified while it is with the drafter — not once it is under review", async () => {
    for (const status of ["PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ"]) {
      state.calls = [];
      seed({ status, assigned_engineer_id: null, engineering_required: false, assigned_drafter_id: status === "PENDING_ASSIGNMENT" ? null : "d-1" });
      state.user = { id: "req-1" };
      const r = await post({ ticketId: T, values: { exam: "rt5" } });
      expect(r.status, status).toBe(200);
      expect(audits()[0].details.authority, status).toBe("requester");
      expect(writes()[0].args[0], status).toMatchObject({ field_values: { exam: { value: "rt5", by: "req-1" } } });
    }
    state.calls = [];
    seed({ status: "PENDING_REVIEW", assigned_engineer_id: null, engineering_required: false });
    state.user = { id: "req-1" };
    expect((await post({ ticketId: T, values: { exam: "rt5" } })).status).toBe(403);
    expect(writes()).toEqual([]);
  });
  it("second fix pass: an issued request (PENDING_IFC / FINAL_DRAFT) keeps the data it issued with — values and a waiver refused (409), nothing written", async () => {
    for (const status of ["PENDING_IFC", "FINAL_DRAFT"]) {
      for (const [uid, body] of [["d-1", { values: { exam: "rt100" } }], ["a-1", { waiver: { reason: "after the fact" } }]] as const) {
        state.calls = [];
        seed({ status });
        state.user = { id: uid };
        const r = await post({ ticketId: T, ...body });
        expect(r.status, `${status} ${uid}`).toBe(409);
        expect((await r.json()).code).toBe("issued");
        expect(audits()).toEqual([]);
        expect(writes()).toEqual([]);
      }
    }
  });
  it("the assignment queue (ticket.assign — an Admin by default) may", async () => {
    seed();
    state.user = { id: "a-1" };
    const r = await post({ ticketId: T, values: { exam: "rt5" } });
    expect(r.status).toBe(200);
    expect(audits()[0].details.authority).toBe("assignment_queue");
  });
  it("a value not in the list, an unknown field, or both values and a waiver: 400, nothing written", async () => {
    for (const body of [{ values: { exam: "N/A" } }, { values: { nope: "x" } }, { values: { exam: "rt5" }, waiver: { reason: "x" } }, {}]) {
      state.calls = [];
      seed();
      state.user = { id: "d-1" };
      expect((await post({ ticketId: T, ...body })).status, JSON.stringify(body)).toBe(400);
      expect(writes()).toEqual([]);
    }
  });
  it("an existing row is updated compare-and-set on its updated_at; a lost race is 409 with a _NOT_APPLIED row naming the attempt", async () => {
    seed();
    state.rows.ticket_examination_scopes = [{ ticket_id: T, org_id: "o1", field_values: { exam: { value: "rt5", by: "e-1", at: SINCE } }, waiver: null, updated_at: "2026-10-20T00:00:00.000Z" }];
    state.user = { id: "d-1" };
    state.writeResult = { data: [], error: null };
    const r = await post({ ticketId: T, values: { exam: "rt100" } });
    expect(r.status).toBe(409);
    const upd = writes()[0];
    expect(upd.method).toBe("update");
    expect(state.calls.some((c) => c.table === "ticket_examination_scopes" && c.method === "eq" && c.args[0] === "updated_at" && c.args[1] === "2026-10-20T00:00:00.000Z")).toBe(true);
    const [attempt, notApplied] = audits();
    expect(notApplied).toMatchObject({ action: "TICKET_EXAMINATION_SCOPE_SET_NOT_APPLIED", details: { attempt: (attempt as unknown as { id: string }).id, reason: "conflict" } });
  });
  it("the same value again changes nothing (no audit row)", async () => {
    seed();
    state.rows.ticket_examination_scopes = [{ ticket_id: T, org_id: "o1", field_values: { exam: { value: "rt5", by: "e-1", at: SINCE } }, waiver: null, updated_at: SINCE }];
    state.user = { id: "d-1" };
    const r = await post({ ticketId: T, values: { exam: "rt5" } });
    expect((await r.json()).unchanged).toBe(true);
    expect(audits()).toEqual([]);
  });
  it("before 20261266: 503 not_migrated, nothing written", async () => {
    seed();
    state.errors.ticket_examination_scopes = { code: "42P01", message: 'relation "ticket_examination_scopes" does not exist' };
    state.user = { id: "d-1" };
    const r = await post({ ticketId: T, values: { exam: "rt5" } });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("not_migrated");
    expect(audits()).toEqual([]);
  });
  it("an unconfigured workspace, a closed or archived request: refused, nothing written", async () => {
    seed();
    state.rows.org_configurations = [];
    state.user = { id: "d-1" };
    expect((await post({ ticketId: T, values: { exam: "rt5" } })).status).toBe(409);
    for (const over of [{ status: "CLOSED" }, { archived_at: "2026-10-10T00:00:00.000Z" }]) {
      seed(over);
      expect((await post({ ticketId: T, values: { exam: "rt5" } })).status).toBe(409);
    }
    expect(writes()).toEqual([]);
  });
  it("no bearer is 401; a non-member is 403", async () => {
    seed();
    expect((await post({ ticketId: T, values: { exam: "rt5" } }, false)).status).toBe(401);
    state.user = { id: "stranger" };
    expect((await post({ ticketId: T, values: { exam: "rt5" } })).status).toBe(403);
  });
});

describe("a waiver — only someone who holds the issue authority now, with a reason", () => {
  it("the issuer the engine offers an issuing approval records it: the missing fields and this revision, audited", async () => {
    seed();
    state.user = { id: "a-1" };
    const r = await post({ ticketId: T, waiver: { reason: "Vendor examination report to follow" } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.waiver).toMatchObject({ reason: "Vendor examination report to follow", by: "a-1", fields: ["exam"], rev: "1A" });
    expect(audits()[0]).toMatchObject({ action: "TICKET_EXAMINATION_SCOPE_WAIVED", details: { waiver: { fields: ["exam"], rev: "1A" } } });
    expect(String(audits()[0].details.authority)).toMatch(/^issue_authority:/);
  });
  it("someone who cannot issue it now is refused (403); an empty reason is 400; nothing missing is 409", async () => {
    seed();
    state.user = { id: "d-1" };
    expect((await post({ ticketId: T, waiver: { reason: "x" } })).status).toBe(403);
    state.user = { id: "a-1" };
    expect((await post({ ticketId: T, waiver: { reason: "  " } })).status).toBe(400);
    seed();
    state.rows.ticket_examination_scopes = [{ ticket_id: T, org_id: "o1", field_values: { exam: { value: "rt5", by: "e-1", at: SINCE } }, waiver: null, updated_at: SINCE }];
    expect((await post({ ticketId: T, waiver: { reason: "x" } })).status).toBe(409);
    expect(audits()).toEqual([]);
  });
  it("withdrawn by someone who can issue it; nothing to withdraw changes nothing", async () => {
    seed();
    state.rows.ticket_examination_scopes = [{ ticket_id: T, org_id: "o1", field_values: {}, waiver: { reason: "r", by: "a-1", at: SINCE, fields: ["exam"], rev: "1A" }, updated_at: SINCE }];
    state.user = { id: "a-1" };
    const r = await post({ ticketId: T, waiver: null });
    expect(r.status).toBe(200);
    expect(audits()[0].action).toBe("TICKET_EXAMINATION_SCOPE_WAIVER_WITHDRAWN");
    expect(writes()[0].args[0]).toMatchObject({ waiver: null });
  });
});
