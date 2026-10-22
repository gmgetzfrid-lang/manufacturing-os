// drafting-flow Round G, DF-P24 — the examination-scope issue gate in the
// workflow route (GAP-102 acceptances 4 and 1; DEC-90 rulings (1)–(3), (6)
// for DF-P24), driven through the route itself:
//   * REGRESSION FIRST: a workspace that configures nothing — and one whose
//     requirement names another class — runs every action the state machine
//     offers across every status x every member of the harness, plus
//     sign_slot / request_revision, byte-identical with the WHOLE gate
//     removed (second fix pass: the route's one issueScopeGate call answers
//     "none" in arm B, so any read, preview or key the gate adds anywhere
//     shows as a difference — responses, every database call, every
//     after-response task); no read of ticket_examination_scopes and no
//     `examinationScope` key. A workspace whose 'drafting' row cannot be
//     read differs ONLY by `examinationScope: { configUnchecked: true }` on
//     the audit row of an issuing approval or a completing sign-off (the
//     stated exception — the route cannot know what was configured);
//   * a configured requirement refuses an issuing approval (409
//     examination_scope_missing, nothing written) for a request filed after
//     it; data recorded → it issues with zero added touches (acceptance 1);
//     a request filed before it issues with a warning; a waiver for this
//     revision lets it issue, recorded on the audit row; another revision's
//     waiver does not; before 20261266 it issues (not migrated, recorded);
//     an unreadable row is a 503;
//   * a roster sign-off that completes the review is gated (its dry run
//     too, so no signature is minted for a refused sign-off); one that does
//     not complete it is not;
//   * a non-issuing action never reads the row.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import type { Role, Ticket, TicketAttachment, TicketReviewRoster, TicketStatus } from "@/types/schema";

const LM = "2026-10-21T00:00:00.000Z";
const LIB = "1b000000-0000-4000-8000-000000000001";
const LIB2 = "1b000000-0000-4000-8000-000000000002";
const SIG = "5a000000-0000-4000-8000-000000000001";
const BYTES = "%PDF-1.7 the draft";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, { code?: string; message: string }>,
  after: [] as Array<() => unknown>,
  noP24: false,
  draftingCfgError: false,
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
        if (head && state.errors[table] && /PGRST205|42P01/.test(state.errors[table].code ?? "")) return resolve({ data: null, error: null, count: null, status: 204 });
        if (state.errors[table]) return resolve({ data: null, error: state.errors[table] });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "insert" && (table === "ticket_review_slots" || table === "ticket_examination_scopes") && !state.errors[table]) {
          state.rows[table] = [...(state.rows[table] ?? []), ...(Array.isArray(args[0]) ? args[0] : [args[0]]) as Array<Record<string, unknown>>];
        }
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "eq") filters.push([String(args[0]), args[1], "eq"]);
        if (prop === "is") filters.push([String(args[0]), args[1], "is"]);
        if (prop === "in") filters.push([String(args[0]), args[1], "in"]);
        if (prop === "maybeSingle" || prop === "single") {
          if (state.errors[table]) return Promise.resolve({ data: null, error: state.errors[table] });
          if (state.draftingCfgError && table === "org_configurations" && filters.some(([k, v]) => k === "key" && v === "drafting")) return Promise.resolve({ data: null, error: { code: "PGRST000", message: "timeout" } });
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
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn((fn: () => unknown) => { state.after.push(fn); }) }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "b",
  r2: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
      if (cmd.constructor.name === "GetObjectCommand") return { ContentLength: BYTES.length, Body: (async function* () { yield new TextEncoder().encode(BYTES); })() };
      return { ContentLength: 4096, ETag: '"e"' };
    }),
  },
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ ok: true })) }));
// A/B (second fix pass): with noP24 the route's single gate call decides
// "none" without running anything — the route without DF-P24's gate.
vi.mock("@/lib/examinationScopeGate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/examinationScopeGate")>();
  return { ...real, issueScopeGate: (...a: Parameters<typeof real.issueScopeGate>) => (state.noP24 ? Promise.resolve({ kind: "none" as const }) : real.issueScopeGate(...a)) };
});
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { POST as scopeRoute, GET as scopeGet } from "@/app/api/tickets/examination-scope/route";
import { WorkflowEngine, ISSUING_APPROVALS } from "@/lib/workflow";
import { rowToTicket } from "@/lib/ticketTransitions";

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "staged" } as TicketAttachment;
const MEMBERS = [member("req-1", "Requester"), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("e-2", "Engineer-3"), member("a-1", "Admin"), member("q-1", "Viewer"), member("q-2", "Viewer")];
const STATUSES: TicketStatus[] = ["PENDING_ENG_TEAM", "PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_IFC", "FINAL_DRAFT", "PENDING_FINAL_APPROVAL", "CLOSED", "CANCELED"];
const SINCE = "2026-10-01T00:00:00.000Z";
const FIELDS = [{ key: "exam", label: "Examination scope", options: [{ value: "rt5", label: "5% RT" }] }, { key: "gov", label: "Governing code", options: [{ value: "c1", label: "Code one" }] }];
const scopeCfg = (requirements: Array<Record<string, unknown>>) => ({ requestTypes: { options: [] }, workClasses: { options: [{ value: "code", label: "Code piping" }] }, examinationScope: { fields: FIELDS, requirements } });
const ENGINEERING_ONLY = { slots: [{ kind: "check", label: "Engineering check", mode: "blocking", fill: { capability: "ticket.final_approve" }, independent_of: ["drafter"] }] };

const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [DRAFT], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, draft_iteration: 0,
  last_modified: LM, library_id: LIB, created_at: "2026-10-05T00:00:00.000Z", metadata: {}, ...over,
});
const reviewRow = (over: Record<string, unknown> = {}) => ticketRow({ status: "PENDING_REVIEW", deliverable_rev: "1A", draft_iteration: 1, attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }], ...over });
const reset = () => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.after = []; state.noP24 = false; state.draftingCfgError = false;
};
const seed = (cfg: Record<string, unknown> | null, routing: unknown = null) => {
  state.rows.org_members = MEMBERS.map((m) => ({ ...m }));
  state.rows.libraries = [{ id: LIB, org_id: "o1", name: "P&IDs", routing_control: routing }];
  state.rows.ticket_review_slots = [];
  if (cfg) state.rows.org_configurations = [{ org_id: "o1", key: "drafting", data: cfg }];
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const normal = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "function" ? "[fn]" : x)).replace(UUID, "<uuid>").replace(ISO, "<ts>");
const scopeReads = () => state.calls.filter((c) => c.table === "ticket_examination_scopes");
const auditRow = () => state.calls.find((c) => c.table === "audit_logs" && c.method === "insert" && /^TICKET_[A-Z_]+$/.test(String((c.args[0] as { action?: string }).action)) && !String((c.args[0] as { action?: string }).action).endsWith("_FILES_HASHED"))?.args[0] as { action: string; details: Record<string, unknown> } | undefined;
const ticketUpdates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update");

/** The member the engine offers an issuing approval at PENDING_REVIEW on the serial path. */
function issuer(row: Record<string, unknown>): { uid: string; action: string } {
  const t = rowToTicket(row as never) as Ticket;
  for (const m of MEMBERS) {
    const a = WorkflowEngine.getActions(t, m.role as Role, m.uid, undefined, { userRoles: m.roles as Role[], activeMemberCount: MEMBERS.length }).find((x) => ISSUING_APPROVALS.has(x.action) && !x.disabledReason && !x.requiresComment);
    if (a) return { uid: m.uid, action: a.action };
  }
  throw new Error("no issuer in the harness");
}

beforeEach(() => { reset(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-22T08:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });

async function run(cfg: Record<string, unknown> | null, row: Record<string, unknown>, uid: string, body: Record<string, unknown>, noP24: boolean, routing: unknown = null, cfgError = false) {
  reset();
  seed(cfg, routing);
  state.noP24 = noP24;
  state.draftingCfgError = cfgError;
  state.rows.tickets = [row];
  state.rows.e_signatures = [{ id: SIG, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: uid, content_hash: "h", intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z" }];
  state.user = { id: uid };
  const res = await post({ ticketId: "t1", ...body });
  const json = await res.json().catch(() => null);
  for (const fn of state.after.splice(0)) await fn();
  return { status: res.status, json: normal(json), calls: normal(state.calls), reads: scopeReads().length };
}

describe("REGRESSION FIRST — an unconfigured workspace (and a requirement on another class) is today's route, byte for byte", () => {
  it("every action x status x member: identical with and without DF-P24; no scope read; no examinationScope key", async () => {
    let combos = 0;
    const cfgs: Array<Record<string, unknown> | null> = [null, { requestTypes: { options: [] } }, scopeCfg([{ field: "exam", workClass: "other-class", since: SINCE }, { field: "gov", libraryId: LIB2, since: SINCE }])];
    for (const cfg of cfgs) {
      for (const status of STATUSES) {
        for (const m of MEMBERS) {
          const row = status === "PENDING_REVIEW" || status === "PENDING_FINAL_APPROVAL" ? reviewRow({ status, assigned_engineer_id: status === "PENDING_FINAL_APPROVAL" ? "e-1" : null }) : ticketRow({ status });
          const t = rowToTicket(row as never) as Ticket;
          const offered = WorkflowEngine.getActions(t, m.role as Role, m.uid, undefined, { userRoles: m.roles as Role[] }).map((a) => a.action);
          for (const actionType of [...new Set([...offered, "sign_slot", "request_revision"])]) {
            const body = { actionType, comment: "a reason", signatureId: SIG, issueAsIsAcknowledged: true };
            const a = await run(cfg, row, m.uid, body, false);
            const b = await run(cfg, row, m.uid, body, true);
            const where = `${JSON.stringify(cfg)?.slice(0, 40)} ${status} ${m.uid} ${actionType}`;
            expect(a.status, where).toBe(b.status);
            expect(a.json, where).toBe(b.json);
            expect(a.calls, where).toBe(b.calls);
            expect(a.reads, where).toBe(0);
            expect(a.calls + a.json, where).not.toMatch(/examinationScope|examination_scope/);
            combos++;
          }
        }
      }
    }
    expect(combos).toBeGreaterThan(300);
  }, 180_000);

  it("second fix pass: a 'drafting' row that cannot be read differs ONLY by configUnchecked on an issuing act's audit row — no read, nothing else", async () => {
    let combos = 0;
    let unchecked = 0;
    const KEY = /,"examinationScope":\{"configUnchecked":true\}/g;
    for (const status of STATUSES) {
      for (const m of MEMBERS) {
        const row = status === "PENDING_REVIEW" || status === "PENDING_FINAL_APPROVAL" ? reviewRow({ status, assigned_engineer_id: status === "PENDING_FINAL_APPROVAL" ? "e-1" : null }) : ticketRow({ status });
        const t = rowToTicket(row as never) as Ticket;
        const offered = WorkflowEngine.getActions(t, m.role as Role, m.uid, undefined, { userRoles: m.roles as Role[] }).map((a) => a.action);
        for (const actionType of [...new Set([...offered, "sign_slot", "request_revision"])]) {
          const body = { actionType, comment: "a reason", signatureId: SIG, issueAsIsAcknowledged: true };
          const a = await run(scopeCfg([{ field: "exam", libraryId: LIB, since: SINCE }]), row, m.uid, body, false, null, true);
          const b = await run(scopeCfg([{ field: "exam", libraryId: LIB, since: SINCE }]), row, m.uid, body, true, null, true);
          const where = `${status} ${m.uid} ${actionType}`;
          expect(a.status, where).toBe(b.status);
          expect(a.json, where).toBe(b.json);
          expect(a.calls.replace(KEY, ""), where).toBe(b.calls);
          expect(a.reads, where).toBe(0);
          if (KEY.test(a.calls)) {
            unchecked++;
            expect(ISSUING_APPROVALS.has(actionType) || actionType === "sign_slot", where).toBe(true);
          }
          KEY.lastIndex = 0;
          combos++;
        }
      }
    }
    expect(combos).toBeGreaterThan(100);
    expect(unchecked).toBeGreaterThan(0);
  }, 180_000);
});

describe("merge-time fix pass 2, item 3 — a malformed requestTypes no longer hides the examination-data configuration from the gate", () => {
  const BAD = { options: "not a list" };
  it("malformed requestTypes with no requirement here (none, or one on another library): every action x status x member byte-identical with the gate removed, no read; with a requirement here, only an issuing act is refused", async () => {
    let combos = 0;
    let gated = 0;
    const cfgs: Array<[Record<string, unknown>, boolean]> = [
      [{ requestTypes: BAD }, false],
      [{ ...scopeCfg([{ field: "exam", libraryId: LIB2, since: SINCE }]), requestTypes: BAD }, false],
      [{ ...scopeCfg([{ field: "exam", libraryId: LIB, since: SINCE }]), requestTypes: BAD }, true],
    ];
    for (const [cfg, applies] of cfgs) {
      for (const status of STATUSES) {
        for (const m of MEMBERS) {
          const row = status === "PENDING_REVIEW" || status === "PENDING_FINAL_APPROVAL" ? reviewRow({ status, assigned_engineer_id: status === "PENDING_FINAL_APPROVAL" ? "e-1" : null }) : ticketRow({ status });
          const t = rowToTicket(row as never) as Ticket;
          const offered = WorkflowEngine.getActions(t, m.role as Role, m.uid, undefined, { userRoles: m.roles as Role[] }).map((a) => a.action);
          for (const actionType of [...new Set([...offered, "sign_slot", "request_revision"])]) {
            const body = { actionType, comment: "a reason", signatureId: SIG, issueAsIsAcknowledged: true };
            const a = await run(cfg, row, m.uid, body, false);
            const b = await run(cfg, row, m.uid, body, true);
            const where = `${applies} ${status} ${m.uid} ${actionType}`;
            if (!applies || a.json === b.json) {
              expect(a.status, where).toBe(b.status);
              expect(a.json, where).toBe(b.json);
              if (!applies) {
                expect(a.calls, where).toBe(b.calls);
                expect(a.reads, where).toBe(0);
              }
            } else {
              // the gate now reads this workspace's requirement: an issuing act is refused with it
              expect(ISSUING_APPROVALS.has(actionType) || actionType === "sign_slot", where).toBe(true);
              expect(a.status, where).toBe(409);
              expect(JSON.parse(a.json).code, where).toBe("examination_scope_missing");
              gated++;
            }
            combos++;
          }
        }
      }
    }
    expect(combos).toBeGreaterThan(300);
    expect(gated).toBeGreaterThan(0);
  }, 180_000);
});

describe("ruling (2) — the gate on an issuing approval", () => {
  const cfg = scopeCfg([{ field: "exam", libraryId: LIB, since: SINCE }, { field: "gov", libraryId: LIB, since: SINCE }]);
  it("missing data for a request filed after the requirement: 409 with the sentence, nothing written", async () => {
    const row = reviewRow();
    const who = issuer(row);
    const r = await run(cfg, row, who.uid, { actionType: who.action }, false);
    expect(r.status).toBe(409);
    expect(JSON.parse(r.json)).toMatchObject({ code: "examination_scope_missing", missing: [{ field: "exam", label: "Examination scope" }, { field: "gov", label: "Governing code" }] });
    expect(JSON.parse(r.json).error).toMatch(/^This request can't issue yet: Examination scope and Governing code must be recorded/);
    expect(ticketUpdates()).toEqual([]);
    expect(state.calls.some((c) => c.table === "audit_logs")).toBe(false);
  });
  it("acceptance 1 — data already recorded: it issues with zero added touches (same answer as an unconfigured workspace; the audit row names what it was checked against)", async () => {
    const row = reviewRow();
    const who = issuer(row);
    const base = await run(null, row, who.uid, { actionType: who.action, issueAsIsAcknowledged: true }, false);
    reset();
    const filled = { ticket_id: "t1", org_id: "o1", field_values: { exam: { value: "rt5", by: "e-1", at: SINCE }, gov: { value: "c1", by: "d-1", at: SINCE } }, waiver: null };
    seed(cfg);
    state.rows.ticket_examination_scopes = [filled];
    state.rows.tickets = [row];
    state.user = { id: who.uid };
    const res = await post({ ticketId: "t1", actionType: who.action, issueAsIsAcknowledged: true });
    expect(res.status).toBe(base.status);
    expect(normal(await res.json())).toBe(base.json);
    expect(auditRow()!.details.examinationScope).toEqual({ required: [
      { field: "exam", enforced: true, since: SINCE, value: "rt5" }, { field: "gov", enforced: true, since: SINCE, value: "c1" },
    ] });
  });
  it("a request filed BEFORE the requirement (in flight when it was configured) issues; what is missing is a warning", async () => {
    const row = reviewRow({ created_at: "2026-09-01T00:00:00.000Z" });
    const who = issuer(row);
    const r = await run(cfg, row, who.uid, { actionType: who.action }, false);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.json).examinationScopeWarning).toMatch(/filed before the requirement was set, so it can still issue/);
    expect(JSON.parse(r.json)).not.toHaveProperty("warning");
    expect(auditRow()!.details.examinationScope).toMatchObject({ missing: ["exam", "gov"], warnedNotRefused: ["exam", "gov"] });
  });
  it("a waiver recorded for this revision lets it issue, named on the audit row; one for another revision does not", async () => {
    const row = reviewRow();
    const who = issuer(row);
    reset();
    seed(cfg);
    state.rows.tickets = [row];
    state.rows.ticket_examination_scopes = [{ ticket_id: "t1", org_id: "o1", field_values: {}, waiver: { reason: "vendor data", by: "a-1", at: SINCE, fields: ["exam", "gov"], rev: "1A" } }];
    state.user = { id: who.uid };
    const ok = await post({ ticketId: "t1", actionType: who.action });
    expect(ok.status).toBe(200);
    expect(auditRow()!.details.examinationScope).toMatchObject({ missing: ["exam", "gov"], waiver: { reason: "vendor data", by: "a-1", rev: "1A" } });
    reset();
    seed(cfg);
    state.rows.tickets = [row];
    state.rows.ticket_examination_scopes = [{ ticket_id: "t1", org_id: "o1", field_values: {}, waiver: { reason: "vendor data", by: "a-1", at: SINCE, fields: ["exam", "gov"], rev: "0B" } }];
    state.user = { id: who.uid };
    expect((await post({ ticketId: "t1", actionType: who.action })).status).toBe(409);
  });
  it("before 20261266 (42P01): it issues — nothing could be recorded — and the audit row says so; an unreadable row is a 503", async () => {
    const row = reviewRow();
    const who = issuer(row);
    reset();
    seed(cfg);
    state.rows.tickets = [row];
    state.errors.ticket_examination_scopes = { code: "42P01", message: 'relation "ticket_examination_scopes" does not exist' };
    state.user = { id: who.uid };
    expect((await post({ ticketId: "t1", actionType: who.action })).status).toBe(200);
    expect(auditRow()!.details.examinationScope).toEqual({ notMigrated: true, required: ["exam", "gov"] });
    reset();
    seed(cfg);
    state.rows.tickets = [row];
    state.errors.ticket_examination_scopes = { code: "PGRST000", message: "upstream timeout" };
    state.user = { id: who.uid };
    const r = await post({ ticketId: "t1", actionType: who.action });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("examination_scope_unreadable");
    expect(ticketUpdates()).toEqual([]);
  });
  it("a drafting configuration that cannot be read is no configuration (today's path, no read)", async () => {
    const row = reviewRow();
    const who = issuer(row);
    reset();
    seed(cfg);
    state.rows.tickets = [row];
    state.draftingCfgError = true;
    state.user = { id: who.uid };
    expect((await post({ ticketId: "t1", actionType: who.action })).status).toBe(200);
    expect(scopeReads()).toEqual([]);
    // Fix pass (minor 4): the issuing row says the gate was unchecked, so an
    // issue that bypassed it can be told apart from an unconfigured workspace.
    expect(auditRow()!.details.examinationScope).toEqual({ configUnchecked: true });
  });
  it("fix pass (minor 3): an unreadable row for a request filed BEFORE every requirement issues (never a 503); the row says it was unchecked", async () => {
    const row = reviewRow({ created_at: "2026-09-01T00:00:00.000Z" });
    const who = issuer(row);
    reset();
    seed(cfg);
    state.rows.tickets = [row];
    state.errors.ticket_examination_scopes = { code: "PGRST000", message: "upstream timeout" };
    state.user = { id: who.uid };
    const r = await post({ ticketId: "t1", actionType: who.action });
    expect(r.status).toBe(200);
    expect(auditRow()!.details.examinationScope).toEqual({ unchecked: true, required: ["exam", "gov"] });
    expect(ticketUpdates().length).toBeGreaterThan(0);
  });
  it("fix pass (minor 3): a requirement with no readable since binds nothing — an unreadable row is not a 503 there either", async () => {
    const row = reviewRow();
    const who = issuer(row);
    reset();
    seed(scopeCfg([{ field: "exam", libraryId: LIB }]));
    state.rows.tickets = [row];
    state.errors.ticket_examination_scopes = { code: "PGRST000", message: "upstream timeout" };
    state.user = { id: who.uid };
    expect((await post({ ticketId: "t1", actionType: who.action })).status).toBe(200);
  });
  it("merge-time fix pass (clock skew): a request filed less than 15 minutes after `since` is in flight — it issues, warned; from 15 minutes on it is refused", async () => {
    const one = scopeCfg([{ field: "exam", libraryId: LIB, since: SINCE }]);
    for (const [created, status] of [["2026-10-01T00:00:00.000Z", 200], ["2026-10-01T00:14:59.999Z", 200], ["2026-10-01T00:15:00.000Z", 409]] as const) {
      const row = reviewRow({ created_at: created });
      const who = issuer(row);
      const r = await run(one, row, who.uid, { actionType: who.action }, false);
      expect(r.status, created).toBe(status);
      if (status === 200) expect(JSON.parse(r.json).examinationScopeWarning, created).toMatch(/filed before the requirement was set, so it can still issue/);
    }
  });
  it("merge-time fix pass 2: the refusal names who can act now — with an engineer of record, them or a revision, and the caller's waiver; never the drafter", async () => {
    const one = scopeCfg([{ field: "exam", libraryId: LIB, since: SINCE }]);
    const row = reviewRow({ status: "PENDING_FINAL_APPROVAL", assigned_engineer_id: "e-1" });
    const who = issuer(row);
    const r = await run(one, row, who.uid, { actionType: who.action, comment: "a reason" }, false);
    expect(r.status).toBe(409);
    expect(JSON.parse(r.json).error).toBe("This request can't issue yet: Examination scope must be recorded for it first (this workspace requires it for its library). Its engineer of record can record it on the request page, or the request can be sent back for revision; you can instead record why it issues without it.");
    const none = await run(one, reviewRow(), issuer(reviewRow()).uid, { actionType: issuer(reviewRow()).action }, false);
    expect(JSON.parse(none.json).error).toMatch(/It has no engineer of record, so you can record why it issues without it, or the request can be sent back for revision\.$/);
  });
  it("a requirement on the request's WORK CLASS binds the same way", async () => {
    const row = reviewRow({ work_class: "code" });
    const who = issuer(row);
    const r = await run(scopeCfg([{ field: "exam", workClass: "code", since: SINCE }]), row, who.uid, { actionType: who.action }, false);
    expect(r.status).toBe(409);
    expect(JSON.parse(r.json).error).toMatch(/for work class "Code piping"/);
  });
  it("a non-issuing action never reads the examination data", async () => {
    for (const actionType of ["request_revision", "save_progress"]) {
      const row = actionType === "save_progress" ? ticketRow() : reviewRow();
      const r = await run(cfg, row, actionType === "save_progress" ? "d-1" : "req-1", { actionType, comment: "fix it" }, false);
      expect(r.reads, actionType).toBe(0);
    }
  });
});

describe("ruling (2) — a roster sign-off that completes the review", () => {
  const cfg = scopeCfg([{ field: "exam", libraryId: LIB, since: SINCE }]);
  async function openRoster(): Promise<TicketReviewRoster> {
    reset();
    seed(null, ENGINEERING_ONLY);
    state.user = { id: "d-1" };
    state.rows.tickets = [ticketRow()];
    const res = await post({ ticketId: "t1", actionType: "submit_draft" });
    expect(res.status).toBe(200);
    return (ticketUpdates()[0].args[0] as { metadata: { review_roster: TicketReviewRoster } }).metadata.review_roster;
  }
  it("is refused — its dry run too, so no signature is minted for it; with the data recorded the dry run answers ok", async () => {
    const roster = await openRoster();
    const signer = roster.slots[0].primaries[0];
    const row = reviewRow({ metadata: { review_roster: roster } });
    const dry = await run(cfg, row, signer, { actionType: "sign_slot", dryRun: true }, false, ENGINEERING_ONLY);
    expect(dry.status).toBe(409);
    expect(JSON.parse(dry.json).code).toBe("examination_scope_missing");
    reset();
    seed(cfg, ENGINEERING_ONLY);
    state.rows.tickets = [row];
    state.rows.ticket_examination_scopes = [{ ticket_id: "t1", org_id: "o1", field_values: { exam: { value: "rt5", by: signer, at: SINCE } }, waiver: null }];
    state.user = { id: signer };
    const ok = await post({ ticketId: "t1", actionType: "sign_slot", dryRun: true });
    expect(ok.status).toBe(200);
    expect((await ok.json()).dryRun).toBe(true);
  });
  it("fix pass (minor 5): a waiver needs the issue authority — a sign-off that would not complete the review is not it (403); the completing signer may (200)", async () => {
    const roster = await openRoster();
    const signer = roster.slots[0].primaries[0];
    const twoSlots: TicketReviewRoster = { ...roster, slots: [...roster.slots, { ...roster.slots[0], id: "s2", kind: "lead", label: "Lead", primaries: ["q-1"], engineering: false }] };
    const waive = async (r: TicketReviewRoster) => {
      reset();
      seed(cfg, ENGINEERING_ONLY);
      const TU = "7e000000-0000-4000-8000-000000000001";
      state.rows.tickets = [reviewRow({ id: TU, metadata: { review_roster: r } })];
      state.user = { id: signer };
      return scopeRoute(new NextRequest("http://x/api/tickets/examination-scope", {
        method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ ticketId: TU, waiver: { reason: "vendor report to follow" } }),
      }));
    };
    const peer = await waive(twoSlots);
    expect(peer.status).toBe(403);
    expect(state.calls.some((c) => c.table === "audit_logs" && c.method === "insert")).toBe(false);
    const completing = await waive(roster);
    expect(completing.status).toBe(200);
    expect((await completing.json()).waiver).toMatchObject({ fields: ["exam"], by: signer });
  });
  it("merge-time fix pass (ruling 2): someone the workflow route would refuse cannot waive — the waiver's authority is the route's own (a routed library's request in review with no roster: the engine offers the serial approval, the route refuses it, and so does the waiver)", async () => {
    const TU = "7e000000-0000-4000-8000-000000000001";
    const row = reviewRow({ id: TU });
    const who = issuer(row);
    const asWho = (routing: unknown) => { reset(); seed(cfg, routing); state.rows.tickets = [row]; state.user = { id: who.uid }; };
    const waive = () => scopeRoute(new NextRequest("http://x/api/tickets/examination-scope", {
      method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ ticketId: TU, waiver: { reason: "vendor report to follow" } }),
    }));
    const mayWaive = async () => (await (await scopeGet(new NextRequest(`http://x/api/tickets/examination-scope?ticketId=${TU}`, { headers: { authorization: "Bearer t" } }))).json()).mayWaive;
    // The workflow route refuses this member's issuing approval (TIER-5)…
    asWho(ENGINEERING_ONLY);
    const act = await post({ ticketId: TU, actionType: who.action, issueAsIsAcknowledged: true });
    expect(act.status).toBe(409);
    expect((await act.json()).code).toBe("routing_needs_roster");
    // …so they cannot record a waiver either (403, nothing written), and the page is told not to offer it.
    asWho(ENGINEERING_ONLY);
    const refused = await waive();
    expect(refused.status).toBe(403);
    expect(state.calls.some((c) => (c.table === "audit_logs" || c.table === "ticket_examination_scopes") && (c.method === "insert" || c.method === "update"))).toBe(false);
    asWho(ENGINEERING_ONLY);
    expect(await mayWaive()).toBe(false);
    // Control: the same member on the same request in an unrouted library may.
    asWho(null);
    expect(await mayWaive()).toBe(true);
    asWho(null);
    expect((await waive()).status).toBe(200);
  });
  it("REGRESSION (second fix pass): unconfigured, or a requirement elsewhere — a completing sign-off and its dry run are byte-identical with the whole gate removed (the sweep's rows carry no roster)", async () => {
    const roster = await openRoster();
    const signer = roster.slots[0].primaries[0];
    const row = reviewRow({ metadata: { review_roster: roster } });
    for (const cfg of [null, { requestTypes: { options: [] } }, scopeCfg([{ field: "exam", libraryId: LIB2, since: SINCE }])]) {
      for (const dryRun of [true, false]) {
        const body = { actionType: "sign_slot", signatureId: SIG, dryRun };
        const a = await run(cfg, row, signer, body, false, ENGINEERING_ONLY);
        const b = await run(cfg, row, signer, body, true, ENGINEERING_ONLY);
        expect(a.status, `${dryRun}`).toBe(b.status);
        expect(a.json).toBe(b.json);
        expect(a.calls).toBe(b.calls);
        expect(a.reads).toBe(0);
        expect(a.calls + a.json).not.toMatch(/examinationScope|examination_scope/);
      }
    }
  });
  it("a sign-off that does NOT complete the review is never gated (no read)", async () => {
    const roster = await openRoster();
    const twoSlots: TicketReviewRoster = { ...roster, slots: [...roster.slots, { ...roster.slots[0], id: "s2", kind: "lead", label: "Lead", primaries: ["q-1"], engineering: false }] };
    const signer = roster.slots[0].primaries[0];
    const r = await run(cfg, reviewRow({ metadata: { review_roster: twoSlots } }), signer, { actionType: "sign_slot", dryRun: true }, false, ENGINEERING_ONLY);
    expect(r.status).toBe(200);
    expect(r.reads).toBe(0);
  });
});
