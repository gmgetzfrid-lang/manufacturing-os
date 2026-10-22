// drafting-flow Round G, DF-P20 merge-time fix pass — the sweep the brief's
// ruling (3) asks for: a request whose roster has NO opted-in slot runs every
// workflow action the state machine offers, across every status x every
// member of the harness (requester, drafter, two engineers, an Admin, two
// Viewers), plus the roster's own sign_slot and request_revision — each TWICE:
// with DF-P20's code path, and with it switched off (the two calls the route
// makes, examinationForAct and examinationAuditFields, answering "nothing to
// record" exactly as the route behaved before DF-P20). The responses, every
// database call (ledger rows, audit rows, ticket updates, reads) and every
// after-response task must be identical, and no `examination` key may appear
// anywhere — even though every call carries an examination body.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import type { Role, Ticket, TicketAttachment, TicketReviewRoster, TicketStatus } from "@/types/schema";

const LM = "2026-10-21T00:00:00.000Z";
const LIB = "1b000000-0000-4000-8000-000000000001";
const SIG = "5a000000-0000-4000-8000-000000000001";
const BYTES = "%PDF-1.7 the draft";

// ── the route harness (vi.hoisted state + a Proxy chain for supabaseAdmin) ──
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  errors: {} as Record<string, { code?: string; message: string }>,
  r2: [] as Array<{ kind: string; key: string }>,
  r2Fail: false,
  r2Hang: false,
  after: [] as Array<() => unknown>,
  // A/B: true runs the route as it was before DF-P20 (the two DF-P20 calls answer "nothing to record").
  noP20: false,
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
        // postgrest-js on a HEAD request: PostgREST's 404 for a missing table
        // has no body, and processResponse maps a body-less 404 to status 204
        // with error = null — a HEAD can never see PGRST205 / 42P01.
        if (head && state.errors[table] && /PGRST205|42P01/.test(state.errors[table].code ?? "")) return resolve({ data: null, error: null, count: null, status: 204 });
        if (state.errors[table]) return resolve({ data: null, error: state.errors[table] });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        // the ledger's slot rows land, so a later sign-off's update finds them
        if (prop === "insert" && table === "ticket_review_slots" && !state.errors[table]) {
          state.rows[table] = [...(state.rows[table] ?? []), ...(Array.isArray(args[0]) ? args[0] : [args[0]]) as Array<Record<string, unknown>>];
        }
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
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
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn((fn: () => unknown) => { state.after.push(fn); }) }));
vi.mock("@/lib/r2", () => ({
  R2_BUCKET: "b",
  r2: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
      const kind = cmd.constructor.name;
      state.r2.push({ kind, key: cmd.input.Key });
      if (kind === "GetObjectCommand") {
        if (state.r2Hang) return new Promise(() => {});
        if (state.r2Fail) throw new Error("timeout");
        return { ContentLength: BYTES.length, Body: (async function* () { yield new TextEncoder().encode(BYTES); })() };
      }
      return { ContentLength: 4096, ETag: '"e"' };
    }),
  },
}));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/assuranceExamination", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/assuranceExamination")>();
  return {
    ...real,
    examinationForAct: (...a: Parameters<typeof real.examinationForAct>) => (state.noP20 ? { ok: true as const, value: null } : real.examinationForAct(...a)),
    examinationAuditFields: (e: Parameters<typeof real.examinationAuditFields>[0]) => (state.noP20 ? {} : real.examinationAuditFields(e)),
  };
});
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { WorkflowEngine } from "@/lib/workflow";
import { rowToTicket } from "@/lib/ticketTransitions";

const post = (body: unknown) => workflowAction(new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A.pdf", type: "Draft", status: "staged" } as TicketAttachment;
const DRAFT2 = { id: "a-e", name: "iso_1A_sh2.pdf", url: "orgs/o1/tickets/REQ-1/iso_1A_sh2.pdf", type: "Draft", status: "staged" } as TicketAttachment;
// The configured rosters at the deploy: the DF-P5 table plus blocking checks
// filled by a person, a role and ticket.direct_approve, and a notice — none
// opted in (no records_examination).
const NO_OPT_IN = { slots: [
  { kind: "accept", label: "Requester acceptance", mode: "blocking", fill: { identity: "requester" } },
  { kind: "check", label: "Engineering check", mode: "blocking", fill: { capability: "ticket.final_approve" }, independent_of: ["drafter"] },
  { kind: "assure", label: "Inspection check", mode: "blocking", fill: { users: ["q-1"] }, independent_of: ["drafter"] },
  { kind: "lead", label: "Lead check", mode: "blocking", fill: { roles: ["Viewer"] } },
  { kind: "direct", label: "Direct approval", mode: "blocking", fill: { capability: "ticket.direct_approve" } },
  { kind: "watch", label: "Inspection notice", mode: "notify_only", fill: { users: ["q-2"] } },
] };
const MEMBERS = [member("req-1", "Requester"), member("d-1", "Drafter"), member("e-1", "Engineer-2"), member("e-2", "Engineer-3"), member("a-1", "Admin"), member("q-1", "Viewer"), member("q-2", "Viewer")];
const STATUSES: TicketStatus[] = ["PENDING_ENG_TEAM", "PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ", "PENDING_REVIEW", "PENDING_IFC", "FINAL_DRAFT", "PENDING_FINAL_APPROVAL", "CLOSED", "CANCELED"];
const EXAM = { files: ["a-d"], note: "examined" };

const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: null,
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [DRAFT, DRAFT2], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, draft_iteration: 0,
  last_modified: LM, library_id: LIB, metadata: {}, ...over,
});
const seed = () => {
  state.rows.org_members = MEMBERS.map((m) => ({ ...m }));
  state.rows.libraries = [{ id: LIB, org_id: "o1", name: "P&IDs", routing_control: NO_OPT_IN }];
  state.rows.ticket_review_slots = [];
};
const reset = () => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.r2 = []; state.r2Fail = false; state.r2Hang = false; state.after = [];
};

/** The roster a submission opens from the no-opt-in table (the route's own). */
async function openRoster(): Promise<TicketReviewRoster> {
  reset();
  seed();
  state.user = { id: "d-1" };
  state.rows.tickets = [ticketRow()];
  const res = await post({ ticketId: "t1", actionType: "submit_draft" });
  expect(res.status).toBe(200);
  const upd = state.calls.find((c) => c.table === "tickets" && c.method === "update")!.args[0] as { metadata: { review_roster: TicketReviewRoster } };
  return upd.metadata.review_roster;
}

const rowFor = (status: TicketStatus, roster: TicketReviewRoster) => ticketRow({
  status, deliverable_rev: "1A", draft_iteration: 1, assigned_engineer_id: status === "PENDING_FINAL_APPROVAL" ? "e-1" : null,
  attachments: [{ ...DRAFT, status: "submitted", rev: "1A" }, { ...DRAFT2, status: "submitted", rev: "1A" }],
  metadata: { review_roster: roster },
});

// Ids and clocks differ between two runs; nothing else may.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const normal = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "function" ? "[fn]" : x)).replace(UUID, "<uuid>").replace(ISO, "<ts>");

async function run(status: TicketStatus, roster: TicketReviewRoster, uid: string, body: Record<string, unknown>, noP20: boolean) {
  reset();
  seed();
  state.noP20 = noP20;
  state.rows.tickets = [rowFor(status, roster)];
  state.rows.e_signatures = [{ id: SIG, org_id: "o1", resource_type: "ticket", resource_id: "t1", signer_user_id: uid, content_hash: roster.contentHash, intent: "Reviewed", signed_at: "2099-01-01T00:00:00Z" }];
  state.user = { id: uid };
  const res = await post({ ticketId: "t1", ...body });
  const json = await res.json().catch(() => null);
  for (const fn of state.after.splice(0)) await fn();
  state.noP20 = false;
  return { status: res.status, json: normal(json), calls: normal(state.calls), r2: normal(state.r2) };
}

beforeEach(() => { reset(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-22T08:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); state.noP20 = false; });

describe("DF-P20 merge-time sweep — no opted-in slot: every action x status x member is byte-identical with and without DF-P20", () => {
  it("responses, every database call (ledger rows, audit rows, ticket updates) and every after-response task match; no `examination` key anywhere", async () => {
    const roster = await openRoster();
    expect(roster.slots.some((s) => "recordsExamination" in s)).toBe(false);
    let combos = 0;
    const seen = new Set<string>();
    for (const status of STATUSES) {
      for (const m of MEMBERS) {
        const t = rowToTicket(rowFor(status, roster) as never) as Ticket;
        const offered = WorkflowEngine.getActions(t, m.role as Role, m.uid, undefined, { userRoles: m.roles as Role[] }).map((a) => a.action);
        const actions = [...new Set([...offered, "sign_slot", "request_revision"])];
        for (const actionType of actions) {
          const body = { actionType, comment: "a reason", signatureId: SIG, examination: EXAM };
          const a = await run(status, roster, m.uid, body, false);
          const b = await run(status, roster, m.uid, body, true);
          const where = `${status} ${m.uid} ${actionType}`;
          expect(a.status, where).toBe(b.status);
          expect(a.json, where).toBe(b.json);
          expect(a.calls, where).toBe(b.calls);
          expect(a.r2, where).toBe(b.r2);
          expect(a.json + a.calls, where).not.toMatch(/"examination"/);
          seen.add(`${actionType}:${a.status}`);
          combos++;
        }
      }
    }
    // The sweep did exercise the roster's acts (a sign-off and a revision
    // request that landed) and many more, not only refusals.
    expect(seen.has("sign_slot:200")).toBe(true);
    expect(seen.has("request_revision:200")).toBe(true);
    expect(combos).toBeGreaterThan(100);
  }, 120_000);
});
