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
  historyFail: false,
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
        if (writing && table === "tickets" && state.historyFail) return resolve({ data: null, error: { message: "history write refused" } });
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
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) }, __registerScopedServerClient: () => {} }));
import { POST, GET } from "@/app/api/tickets/examination-scope/route";

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
const historyWrites = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update").map((c) => c.args[0] as { history: Array<Record<string, unknown>> });
const getMayWaive = () => GET(new NextRequest(`http://x/api/tickets/examination-scope?ticketId=${T}`, { headers: { authorization: "Bearer t" } }));
const recorded = (field_values: Record<string, unknown>) => { state.rows.ticket_examination_scopes = [{ ticket_id: T, org_id: "o1", field_values, waiver: null, updated_at: SINCE }]; };

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.writeResult = null; state.historyFail = false;
});

describe("recording values — the drafter or the engineer already in the flow", () => {
  it("the drafter records a value from the list: the audit row FIRST, then the insert", async () => {
    seed({ status: "DRAFTING" });
    state.user = { id: "d-1" };
    const res = await post({ ticketId: T, values: { exam: "rt5" } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.values.exam).toMatchObject({ value: "rt5", by: "d-1", byName: "d-1" });
    const order = state.calls.filter((c) => (c.table === "audit_logs" || c.table === "ticket_examination_scopes") && (c.method === "insert" || c.method === "update")).map((c) => c.table);
    expect(order).toEqual(["audit_logs", "ticket_examination_scopes"]);
    expect(audits()[0]).toMatchObject({ action: "TICKET_EXAMINATION_SCOPE_SET", details: { changed: [{ field: "exam", from: null, to: "rt5" }], authority: "drafter", recordedBeforeApply: true } });
    expect(writes()[0].args[0]).toMatchObject({ ticket_id: T, org_id: "o1", field_values: { exam: { value: "rt5", by: "d-1" } }, waiver: null, updated_by: "d-1" });
    // before review: no history line (only a change in review or a fill after issue writes one)
    expect(historyWrites()).toEqual([]);
  });
  it("the engineer may; the requester, or a member outside the flow, may not (403, nothing written)", async () => {
    seed({ status: "DRAFTING" });
    state.user = { id: "e-1" };
    expect((await post({ ticketId: T, values: { exam: "rt100" } })).status).toBe(200);
    for (const uid of ["req-1", "q-1"]) {
      state.calls = [];
      seed({ status: "PENDING_REVIEW" });
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
  it("second fix pass / merge-time fix pass (ruling 4(b)): an issued request keeps the data it issued with — a recorded value is never changed or cleared, and no waiver is recorded (409 issued, nothing written)", async () => {
    for (const status of ["PENDING_IFC", "FINAL_DRAFT"]) {
      for (const [uid, body] of [["d-1", { values: { exam: "rt100" } }], ["e-1", { values: { exam: null } }], ["a-1", { values: { exam: "rt100" } }], ["a-1", { waiver: { reason: "after the fact" } }]] as const) {
        state.calls = [];
        seed({ status });
        recorded({ exam: { value: "rt5", by: "e-1", at: SINCE } });
        state.user = { id: uid };
        const r = await post({ ticketId: T, ...body });
        expect(r.status, `${status} ${uid} ${JSON.stringify(body)}`).toBe(409);
        expect((await r.json()).code).toBe("issued");
        expect(audits()).toEqual([]);
        expect(writes()).toEqual([]);
        expect(historyWrites()).toEqual([]);
      }
    }
  });
  it("the assignment queue (ticket.assign — an Admin by default) may", async () => {
    seed({ status: "DRAFTING" });
    state.user = { id: "a-1" };
    const r = await post({ ticketId: T, values: { exam: "rt5" } });
    expect(r.status).toBe(200);
    expect(audits()[0].details.authority).toBe("assignment_queue");
  });
  it("a value not in the list, an unknown field, or both values and a waiver: 400, nothing written", async () => {
    for (const body of [{ values: { exam: "N/A" } }, { values: { nope: "x" } }, { values: { exam: "rt5" }, waiver: { reason: "x" } }, {}]) {
      state.calls = [];
      seed({ status: "DRAFTING" });
      state.user = { id: "d-1" };
      expect((await post({ ticketId: T, ...body })).status, JSON.stringify(body)).toBe(400);
      expect(writes()).toEqual([]);
    }
  });
  it("an existing row is updated compare-and-set on its updated_at; a lost race is 409 with a _NOT_APPLIED row naming the attempt", async () => {
    seed({ status: "DRAFTING" });
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
    seed({ status: "DRAFTING" });
    state.rows.ticket_examination_scopes = [{ ticket_id: T, org_id: "o1", field_values: { exam: { value: "rt5", by: "e-1", at: SINCE } }, waiver: null, updated_at: SINCE }];
    state.user = { id: "d-1" };
    const r = await post({ ticketId: T, values: { exam: "rt5" } });
    expect((await r.json()).unchanged).toBe(true);
    expect(audits()).toEqual([]);
  });
  it("before 20261266: 503 not_migrated, nothing written", async () => {
    seed({ status: "DRAFTING" });
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

describe("merge-time fix pass, ruling 1 — the requester fills an EMPTY field; never changes or clears what someone else recorded", () => {
  const lik = { assigned_engineer_id: null, engineering_required: false };
  it("a value the drafter (or the engineer) recorded: the requester can neither change nor clear it (403, nothing written)", async () => {
    for (const status of ["PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ"]) {
      for (const by of ["d-1", "e-1"]) {
        for (const to of ["rt100", null]) {
          state.calls = [];
          seed({ status, ...lik });
          recorded({ exam: { value: "rt5", by, at: SINCE } });
          state.user = { id: "req-1" };
          const r = await post({ ticketId: T, values: { exam: to } });
          expect(r.status, `${status} ${by} ${to}`).toBe(403);
          const j = await r.json();
          expect(j.code).toBe("recorded_by_someone_else");
          expect(j.error).toMatch(/^Examination scope was recorded by someone else/);
          expect(audits()).toEqual([]);
          expect(writes()).toEqual([]);
        }
      }
    }
  });
  it("a value the requester recorded themselves: they may change it and clear it, before review", async () => {
    for (const to of ["rt100", null]) {
      state.calls = [];
      seed({ status: "DRAFTING", ...lik });
      recorded({ exam: { value: "rt5", by: "req-1", at: SINCE } });
      state.user = { id: "req-1" };
      const r = await post({ ticketId: T, values: { exam: to } });
      expect(r.status, String(to)).toBe(200);
      expect(audits()[0].details).toMatchObject({ changed: [{ field: "exam", from: "rt5", to }], authority: "requester" });
    }
  });
  it("not once the request is in review — not even their own value", async () => {
    seed({ status: "PENDING_REVIEW", ...lik });
    recorded({ exam: { value: "rt5", by: "req-1", at: SINCE } });
    state.user = { id: "req-1" };
    expect((await post({ ticketId: T, values: { exam: "rt100" } })).status).toBe(403);
    expect(writes()).toEqual([]);
  });
  it("the drafter, by contrast, changes the requester's value before review", async () => {
    seed({ status: "DRAFTING" });
    recorded({ exam: { value: "rt5", by: "req-1", at: SINCE } });
    state.user = { id: "d-1" };
    expect((await post({ ticketId: T, values: { exam: "rt100" } })).status).toBe(200);
  });
});

describe("merge-time fix pass, ruling 4(a) — in review only the engineer of record changes a value, each change on the request's history (old → new)", () => {
  for (const status of ["PENDING_REVIEW", "PENDING_FINAL_APPROVAL"]) {
    it(`${status}: the drafter, the queue and the requester are refused (403 in_review, nothing written)`, async () => {
      for (const uid of ["d-1", "a-1", "req-1"]) {
        state.calls = [];
        seed({ status });
        recorded({ exam: { value: "rt5", by: "d-1", at: SINCE } });
        state.user = { id: uid };
        const r = await post({ ticketId: T, values: { exam: "rt100" } });
        expect(r.status, uid).toBe(403);
        if (uid !== "req-1") expect((await r.json()).code, uid).toBe("in_review");
        expect(audits()).toEqual([]);
        expect(writes()).toEqual([]);
        expect(historyWrites()).toEqual([]);
      }
    });
    it(`${status}: the engineer of record changes it — the audit row first, then the value, then one history line old → new (compare-and-set, last_modified untouched)`, async () => {
      seed({ status, history: [{ action: "Submitted", date: SINCE }] });
      recorded({ exam: { value: "rt5", by: "d-1", at: SINCE } });
      state.user = { id: "e-1" };
      const r = await post({ ticketId: T, values: { exam: "rt100" } });
      expect(r.status).toBe(200);
      expect((await r.json()).historyNotWritten).toBeUndefined();
      const [a] = audits();
      expect(a).toMatchObject({ action: "TICKET_EXAMINATION_SCOPE_SET", details: { changed: [{ field: "exam", from: "rt5", to: "rt100" }], authority: "engineer_of_record", phase: "in_review", historyLine: true } });
      const order = state.calls.filter((c) => c.method === "insert" || c.method === "update").map((c) => c.table);
      expect(order).toEqual(["audit_logs", "ticket_examination_scopes", "tickets"]);
      const h = historyWrites()[0];
      expect(Object.keys(h)).toEqual(["history"]);
      expect(h.history).toHaveLength(2);
      expect(h.history[1]).toMatchObject({
        action: "Examination data changed in review", user: "e-1@x.io", actorId: "e-1", attempt: (a as unknown as { id: string }).id,
        details: "Examination scope: 5% RT → 100% RT (changed by the engineer of record while the request was in review)",
      });
      expect(state.calls.some((c) => c.table === "tickets" && c.method === "eq" && c.args[0] === "last_modified" && c.args[1] === "2026-10-21T00:00:00.000Z")).toBe(true);
    });
  }
  it("a clear by the engineer of record reads old → — on the history", async () => {
    seed({ status: "PENDING_REVIEW" });
    recorded({ exam: { value: "rt5", by: "d-1", at: SINCE } });
    state.user = { id: "e-1" };
    expect((await post({ ticketId: T, values: { exam: null } })).status).toBe(200);
    expect(historyWrites()[0].history.at(-1)!.details).toMatch(/^Examination scope: 5% RT → —/);
  });
  it("a request in review with no engineer of record: nobody changes it; the sentence names the ways forward", async () => {
    seed({ status: "PENDING_REVIEW", assigned_engineer_id: null });
    state.user = { id: "d-1" };
    const r = await post({ ticketId: T, values: { exam: "rt5" } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/has no engineer of record.*record why it issues without the missing data, or it can be sent back for revision/);
  });
  it("DEC-90: a history line that cannot be written never undoes or blocks the change — said in the answer; the audit row stays the record", async () => {
    seed({ status: "PENDING_REVIEW" });
    recorded({ exam: { value: "rt5", by: "d-1", at: SINCE } });
    state.historyFail = true;
    state.user = { id: "e-1" };
    const r = await post({ ticketId: T, values: { exam: "rt100" } });
    expect(r.status).toBe(200);
    expect((await r.json())).toMatchObject({ ok: true, historyNotWritten: true });
    expect(writes()).toHaveLength(1);
  });
});

describe("merge-time fix pass, ruling 4(b) — after issue a MISSING field may still be filled (drafter, engineer, queue): completed after issue, re-opening nothing", () => {
  for (const status of ["PENDING_IFC", "FINAL_DRAFT"]) {
    it(`${status}: the drafter, the engineer and the queue fill it — marked afterIssue for the revision issued, and a history line; the request's status untouched`, async () => {
      for (const [uid, authority] of [["d-1", "drafter"], ["e-1", "engineer"], ["a-1", "assignment_queue"]] as const) {
        state.calls = [];
        seed({ status });
        state.user = { id: uid };
        const r = await post({ ticketId: T, values: { exam: "rt5" } });
        expect(r.status, uid).toBe(200);
        const j = await r.json();
        expect(j.values.exam, uid).toMatchObject({ value: "rt5", by: uid, afterIssue: { rev: "1A" } });
        expect(audits()[0].details, uid).toMatchObject({ authority, phase: "after_issue", completedAfterIssue: true, changed: [{ field: "exam", from: null, to: "rt5" }] });
        const h = historyWrites();
        expect(h, uid).toHaveLength(1);
        expect(Object.keys(h[0])).toEqual(["history"]);
        expect(h[0].history.at(-1)).toMatchObject({ action: "Examination data completed after issue", details: "Examination scope: — → 5% RT (completed after issue — not part of what the request issued with)" });
      }
    });
  }
  it("the requester, or a member outside the flow, may not (403)", async () => {
    for (const uid of ["req-1", "q-1"]) {
      state.calls = [];
      seed({ status: "PENDING_IFC" });
      state.user = { id: uid };
      expect((await post({ ticketId: T, values: { exam: "rt5" } })).status, uid).toBe(403);
      expect(writes()).toEqual([]);
    }
  });
  it("one call that fills a missing field AND changes a recorded one is refused whole (409, nothing written)", async () => {
    seed({ status: "PENDING_IFC" });
    state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: { ...CFG, examinationScope: { ...CFG.examinationScope, fields: [...CFG.examinationScope.fields, { key: "gov", label: "Governing code", options: [{ value: "c1", label: "C1" }] }] } } }];
    recorded({ exam: { value: "rt5", by: "e-1", at: SINCE } });
    state.user = { id: "d-1" };
    const r = await post({ ticketId: T, values: { gov: "c1", exam: "rt100" } });
    expect(r.status).toBe(409);
    expect(writes()).toEqual([]);
  });
});

describe("merge-time fix pass, item 7 — GET answers whether this viewer may record a waiver (the page shows the control only then)", () => {
  it("the issuer may; the drafter (no issuing act) may not; an issued, closed or unconfigured request: no", async () => {
    seed();
    state.user = { id: "a-1" };
    expect(await (await getMayWaive()).json()).toEqual({ mayWaive: true });
    state.user = { id: "d-1" };
    expect(await (await getMayWaive()).json()).toEqual({ mayWaive: false });
    for (const over of [{ status: "PENDING_IFC" }, { status: "CLOSED" }]) {
      seed(over);
      state.user = { id: "a-1" };
      expect(await (await getMayWaive()).json(), JSON.stringify(over)).toEqual({ mayWaive: false });
    }
    seed();
    state.rows.org_configurations = [];
    state.user = { id: "a-1" };
    expect(await (await getMayWaive()).json()).toEqual({ mayWaive: false });
    expect(state.calls.some((c) => c.method === "insert" || c.method === "update")).toBe(false);
  });
  it("no bearer is 401; a non-member is 403", async () => {
    seed();
    expect((await GET(new NextRequest(`http://x/api/tickets/examination-scope?ticketId=${T}`))).status).toBe(401);
    state.user = { id: "stranger" };
    expect((await getMayWaive()).status).toBe(403);
  });
});
