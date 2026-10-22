// drafting-flow Round G, DF-P22 fix pass 2 — the escalation DIGEST survives
// every transition of the request it is filed under.
//
// A digest (lib/ticketSla.ts metadata.action sla_escalation_digest) names
// several overdue requests but is stored with resource_id = the first one.
// The workflow route's supersede step reads every unread notice whose
// resource_id is the ticket; before this fix it stamped the digest
// superseded on ANY non-partial transition of that first request — an
// open-to-open save included — so the escalation of all the requests it
// named left the contact's bell. Now no transition of that request, an exit
// included, retires it (lib/ticketSla.ts slaNoticeSurvivesTransition).
//
// Drives the real handler against a Proxy-chain supabaseAdmin (the
// dfRoundG_P3_routing / sweepRoundD3 pattern).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import { SLA_ESCALATION_DIGEST_ACTION } from "@/lib/ticketSla";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  /** Answer the next tickets UPDATE whose payload carries this key with this error. */
  failUpdateWith: null as null | { key: string; error: { code: string; message: string } },
}));
function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  let head = false;
  let payload: unknown = undefined;
  let failing: null | { code: string; message: string } = null;
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v)).map((r) => ({ ...r }));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        if (failing) return resolve({ data: null, error: failing });
        if (head) return resolve({ data: null, error: null, count: rows().length });
        if (payload !== undefined && (state.rows[table] ?? []).length === 0 && filters.length === 0) return resolve({ data: [], error: null });
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "insert" || prop === "update" || prop === "upsert") payload = args[0];
        if (prop === "update" && table === "tickets" && state.failUpdateWith && state.failUpdateWith.key in (args[0] as Record<string, unknown>)) {
          failing = state.failUpdateWith.error;
          state.failUpdateWith = null;
        }
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") {
          if (failing) return Promise.resolve({ data: null, error: failing });
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
    auth: {
      getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
      admin: { getUserById: vi.fn(async () => ({ data: { user: null }, error: { message: "n/a" } })) },
    },
    from: (t: string) => chain(t),
    rpc: vi.fn(async () => ({ error: { code: "PGRST202", message: "Could not find the function" } })),
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({ ContentLength: 2048, ETag: '"etag-1"' })) }, R2_BUCKET: "test-bucket" }));
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";

const req = (body: unknown) => new NextRequest("http://x/api/tickets/workflow-action", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
});
const post = (body: unknown) => workflowAction(req(body));
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const LM = "2026-10-13T00:00:00.000Z";
const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "DRAFTING", request_type: "ISO", unit: "U-100",
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: "d-1", assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [], unread_by: [], revision_count: 0, last_modified: LM, ...over,
});
const updateOf = (table: string) => state.calls.filter((c) => c.table === table && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const ORG = [member("req-1", "Requester"), member("d-1", "Drafter"), member("d-2", "Drafter"), member("e-1", "Engineer-2"),
  member("a-1", "Admin"), member("sup-1", "DraftingSupervisor")];

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.failUpdateWith = null;
  delete process.env.CRON_SECRET;
});

const digestRows = () => [
  { id: "n-wf", org_id: "o1", resource_id: "t1", user_id: "sup-1", read_at: null, metadata: { action: "assign", status: "DRAFTING" } },
  { id: "n-breach", org_id: "o1", resource_id: "t1", user_id: "sup-1", read_at: null, metadata: { action: "sla_breach", sla: "breach", status: "DRAFTING" } },
  { id: "n-digest", org_id: "o1", resource_id: "t1", user_id: "a-1", read_at: null,
    metadata: { action: SLA_ESCALATION_DIGEST_ACTION, sla: "escalation", digest: true, periodDays: 2,
      tickets: [{ id: "t1", breachedAt: LM, periodIndex: 1 }, { id: "t2", breachedAt: LM, periodIndex: 1 }, { id: "t3", breachedAt: LM, periodIndex: 1 }] } },
];
const supersededActions = () => updateOf("notifications").map((u) => (u.metadata as Record<string, unknown>).action as string).sort();

describe("DF-P22 — the escalation digest is never retired by its first request's transition", () => {
  it("open-to-open (save_progress, reassign_drafter) on the request it is filed under: the workflow alert is retired, the digest and the 'Overdue' row are kept", async () => {
    for (const [actor, body] of [["d-1", { actionType: "save_progress" }], ["a-1", { actionType: "reassign_drafter", comment: "leave", assignment: { id: "d-2", name: "x" } }]] as const) {
      state.calls = [];
      state.user = { id: actor };
      state.rows.org_members = ORG;
      state.rows.tickets = [ticketRow({ status: "DRAFTING", sla_breached_at: LM })];
      state.rows.notifications = digestRows();
      const res = await post({ ticketId: "t1", ...body });
      expect(res.status, body.actionType).toBe(200);
      expect(supersededActions(), body.actionType).toEqual(["assign"]);
    }
  });
  it("an exit (close / cancel) of that request retires its own SLA row, never the digest that speaks for the others too", async () => {
    for (const [status, actor, body] of [
      ["FINAL_DRAFT", "req-1", { actionType: "close_ticket" }],
      ["DRAFTING", "req-1", { actionType: "cancel_request", comment: "not needed" }],
    ] as const) {
      state.calls = [];
      state.user = { id: actor };
      state.rows.org_members = ORG;
      state.rows.tickets = [ticketRow({ status, sla_breached_at: LM })];
      state.rows.notifications = digestRows();
      const res = await post({ ticketId: "t1", ...body });
      expect(res.status, body.actionType).toBe(200);
      expect(supersededActions(), body.actionType).toEqual(["assign", "sla_breach"]);
    }
  });
});
