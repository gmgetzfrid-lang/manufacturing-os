// drafting-flow Round G, DF-P14 QUEUE READ AND STATUS-LABEL REMAINDERS —
// /api/tickets/workflow-action, driven through the REAL handler (the
// notifications N6 harness: a stateful service-role stand-in).
//
//   UI-7 / GAP-108 acceptance 4 (the integrator's ruling under DEC-90: every
//   notice, email and chip says ticketStatusLabel(status); a stored value
//   stays only where something machine-reads it):
//     * the bell body with no comment reads "Status: <label>";
//     * the email's text and HTML read the label;
//     * the refusal a person reads names the stage in words;
//     * the bell row's and the email row's `metadata.status` keep the stored
//       value (the bell's reconcile machine-reads it), and every notice sent
//       today is still sent to the same people.
//   GAP-13 / GAP-107 acceptance 1 (ruling (2)): the org's own reasons for
//   ending a request (lib/ticketOutcomeReasons.ts):
//     * none configured → a cancel behaves exactly as today (a bare category,
//       or none), and a named reason is refused;
//     * configured → a configured reason of the category it is sent with is
//       accepted and recorded (metadata.outcome_reason, the history line, the
//       audit row); a bare category is still accepted; any other reason, a
//       reason without its category, or one of another category is refused
//       with nothing written; a list that cannot be read is a 503, nothing
//       written.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import type { TicketAttachment } from "@/types/schema";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Row[]>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  /** `${table}.${method}` → errors handed out one per call, in order. */
  errors: {} as Record<string, Array<{ code?: string; message: string } | null>>,
  seq: 0,
  /** The 1-based org_configurations 'drafting' read that fails, or 0. */
  failDraftingRead: 0,
  draftingReads: 0,
}));

const at = (r: Row, k: string): unknown => {
  const m = /^(\w+)->>(\w+)$/.exec(k);
  if (!m) return r[k];
  const v = (r[m[1]] as Row | null | undefined)?.[m[2]];
  return v == null ? null : String(v);
};

/** The service-role client: filters applied, writes land. */
function chain(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let method: string | null = null;
  let payload: unknown = null;
  let head = false;
  const eqs: Array<[string, unknown]> = [];
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const errOf = () => {
    if (table === "org_configurations" && method === null && eqs.some(([k, v]) => k === "key" && v === "drafting")) {
      state.draftingReads += 1;
      if (state.draftingReads === state.failDraftingRead) return { message: "canceling statement due to statement timeout" };
    }
    return state.errors[`${table}.${method ?? "select"}`]?.shift() ?? null;
  };
  const settle = () => {
    const err = errOf();
    if (err) return { data: null, error: err };
    if (method === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
      const landed = list.map((r) => ({ id: `${table}-${++state.seq}`, ...r }));
      state.rows[table] = [...(state.rows[table] ?? []), ...landed];
      return { data: landed, error: null };
    }
    if (method === "update") {
      const hit = rows();
      for (const r of hit) Object.assign(r, payload as Row);
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
    if (head) return { data: null, error: null, count: rows().length };
    return { data: rows().map((r) => ({ ...r })), error: null, count: rows().length };
  };
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(settle());
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (["insert", "update", "upsert", "delete"].includes(prop) && method === null) { method = prop; payload = args[0]; }
        if (prop === "eq") { eqs.push([String(args[0]), args[1]]); filters.push((r) => at(r, String(args[0])) === args[1]); }
        if (prop === "in") { const s = new Set(args[1] as unknown[]); filters.push((r) => s.has(at(r, String(args[0])))); }
        if (prop === "is") filters.push((r) => (args[1] === null ? at(r, String(args[0])) == null : at(r, String(args[0])) === args[1]));
        if (prop === "not" && args[1] === "is" && args[2] === null) filters.push((r) => at(r, String(args[0])) != null);
        if (prop === "contains") filters.push((r) => Array.isArray(r[String(args[0])]) && (args[1] as unknown[]).every((x) => (r[String(args[0])] as unknown[]).includes(x)));
        if (prop === "maybeSingle" || prop === "single") {
          const out = settle();
          const list = (out.data as Row[] | null) ?? [];
          return Promise.resolve({ data: out.error ? null : (Array.isArray(out.data) ? list[0] ?? null : out.data), error: out.error });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
const admin = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/supabaseAdmin", () => {
  const client = {
    auth: {
      getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }),
      admin: { getUserById: vi.fn(async () => ({ data: { user: null }, error: { message: "nope" } })) },
    },
    from: (t: string) => chain(t),
    rpc: vi.fn(async (fn: string, args: unknown) => {
      state.calls.push({ table: "rpc", method: fn, args: [args] });
      if (fn === "email_gate") return { data: true, error: null };
      return { data: null, error: null };
    }),
  };
  admin.client = client;
  return { supabaseAdmin: client };
});
// The shared client: the anon key with no session (RLS shows nothing, refuses
// writes) unless a request is bound to the service role (lib/serverClientScope).
vi.mock("@/lib/supabase", () => {
  let scoped: (() => unknown) | null = null;
  const anonChain = (table: string) => {
    let write = false;
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => {
          state.calls.push({ table: `anon:${table}`, method: write ? "write" : "select", args: [] });
          resolve(write ? { data: null, error: { code: "42501", message: "row-level security" } } : { data: [], error: null });
        };
        return () => {
          if (["insert", "update", "upsert", "delete"].includes(prop)) write = true;
          if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: null, error: null });
          return new Proxy(c, h);
        };
      },
    };
    return new Proxy(c, h);
  };
  const anon = {
    from: anonChain,
    rpc: async () => ({ data: null, error: { code: "42501", message: "not allowed" } }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  };
  return {
    __registerScopedServerClient: (read: () => unknown) => { scoped = read; },
    supabase: new Proxy({}, {
      get(_t, prop) {
        const impl = (scoped?.() ?? anon) as Record<PropertyKey, unknown>;
        const v = impl[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(impl) : v;
      },
    }),
  };
});
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => chain(t) }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/r2", () => ({
  r2: { send: vi.fn(async () => ({ ContentLength: 1048576, ETag: '"etag-1"' })) },
  R2_BUCKET: "test-bucket",
}));

import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REQ = U(1), DRAFTER = U(2), W_ACTIVE = U(3), W_SUSP = U(4), W_INACTIVE = U(5);
const ORG = "o1";
const LM = "2026-10-02T00:00:00.000Z";
const ORIGIN = "https://ops.example.com";
const member = (uid: string, role: string, status = "active") =>
  ({ org_id: ORG, uid, role, roles: [role], email: `${uid.slice(-2)}@x.io`, display_name: null, status });
const ticketRow = (over: Row = {}) => ({
  id: "t1", org_id: ORG, ticket_id: "REQ-1", title: "Pump iso", status: "DRAFTING", request_type: "ISO", unit: "U-100",
  requester_id: REQ, requester_role: "Requester", assigned_drafter_id: DRAFTER, assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [W_ACTIVE, W_SUSP, W_INACTIVE], unread_by: [], revision_count: 0, last_modified: LM,
  metadata: {}, ...over,
});
const KEY = (name: string) => `orgs/o1/tickets/REQ-1/1727000000000_${name}`;
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: KEY("iso_1A.pdf"), type: "Draft", status: "staged", uploadedBy: "02@x.io" } as TicketAttachment;
const req = (path: string, body: unknown) => new NextRequest(`http://app.local${path}`, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
});
const inserted = (table: string) => state.calls.filter((c) => c.table === table && c.method === "insert")
  .flatMap((c) => (Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Row[]);
const bellUsers = () => inserted("notifications").map((r) => r.user_id as string).sort();
const mailUsers = () => inserted("email_notifications").map((r) => r.to_user_id as string).sort();

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.seq = 0; state.failDraftingRead = 0; state.draftingReads = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  delete process.env.CRON_SECRET;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { delete process.env.NEXT_PUBLIC_SITE_URL; vi.restoreAllMocks(); });


const seedMembers = () => {
  state.rows.org_members = [
    member(REQ, "Requester"), member(DRAFTER, "Drafter"), member(W_ACTIVE, "Engineer"),
    member(W_SUSP, "Engineer", "suspended"), member(W_INACTIVE, "Engineer", "inactive"),
    member(SUP, "Admin"), // the management tier (ticket.manage) may cancel any request
  ];
  state.rows.orgs = [{ id: ORG, name: "Baytown Ops" }];
};
const SUP = U(7);
const REASONS = [
  { id: "not_drafting_work", label: "Not drafting work", category: "rejected" },
  { id: "vendor_did_it", label: "The vendor did it directly", category: "handled_out_of_band" },
];
const drafting = (extra: Row = {}) => ({ org_id: ORG, key: "drafting", data: { requestTypes: { label: "Request Type", enabled: true, options: [{ label: "ISO", value: "ISO" }] }, ...extra } });
const ticketUpdates = () => state.calls.filter((c) => c.table === "tickets" && c.method === "update").map((c) => c.args[0] as Row);
const auditRows = () => inserted("audit_logs");
const cancel = (body: Row) => workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "cancel_request", comment: "filed twice", ...body }));

describe("UI-7 — the workflow route's own words name the stage, never the stored value", () => {
  it("submit_draft with no comment: the bell body and the email say the label; metadata keeps the stored value; the same people are told", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ attachments: [DRAFT] })];
    state.user = { id: DRAFTER };
    const res = await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "submit_draft" }));
    expect(res.status).toBe(200);
    // REGRESSION: exactly the audience N6 pins (the requester and the active watcher), bell and mail
    expect(bellUsers()).toEqual([REQ, W_ACTIVE].sort());
    expect(mailUsers()).toEqual([REQ, W_ACTIVE].sort());
    for (const bell of inserted("notifications")) {
      expect(bell.body).toBe("Status: In review");
      expect(bell.metadata).toMatchObject({ action: "submit_draft", status: "PENDING_REVIEW" });
    }
    for (const mail of inserted("email_notifications")) {
      expect(String(mail.body_text)).toContain("Status is now: In review");
      expect(String(mail.body_html)).toContain("Status: <b>In review</b>");
      for (const b of [String(mail.body_text), String(mail.body_html)]) expect(b).not.toContain("PENDING_REVIEW");
      expect(mail.metadata).toMatchObject({ action: "submit_draft", status: "PENDING_REVIEW", rendered: true });
    }
  });

  it("a comment is still the bell body, as before", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ attachments: [DRAFT] })];
    state.user = { id: DRAFTER };
    await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "submit_draft", comment: "Rev A for review" }));
    expect(inserted("notifications").map((n) => n.body)).toEqual(["Rev A for review", "Rev A for review"]);
  });

  it("the refusal a person reads names the stage in words (the code and status code unchanged)", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "PENDING_IFC" })];
    state.user = { id: W_ACTIVE };
    const res = await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "approve_draft_ifc" }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).toBe('Action "approve_draft_ifc" is not available to you at status “Ready to issue (IFC)”');
    expect(j.error).not.toContain("PENDING_IFC");
    expect(ticketUpdates()).toEqual([]);
  });
});

describe("GAP-13 / GAP-107 acceptance 1 — no reasons configured: every cancel works exactly as today", () => {
  it("a bare category is recorded as before; nothing about a reason is written", async () => {
    seedMembers();
    state.rows.org_configurations = [drafting()];
    state.rows.tickets = [ticketRow()];
    state.user = { id: REQ };
    const res = await cancel({ outcome: "duplicate" });
    expect(res.status).toBe(200);
    const upd = ticketUpdates()[0];
    expect(upd).toMatchObject({ status: "CANCELED", outcome: "duplicate" });
    expect("metadata" in upd).toBe(false);
    const hist = upd.history as Array<Row>;
    expect(hist[hist.length - 1].details).toBe("filed twice");
    const audit = auditRows().find((r) => r.action === "TICKET_CANCEL_REQUEST")!;
    expect(audit.details).toMatchObject({ outcomeIntended: "duplicate" });
    expect((audit.details as Row).outcomeReason).toBeUndefined();
  });
  it("a cancel with no category (today's no-category path) still applies", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow()];
    state.user = { id: REQ };
    const res = await cancel({});
    expect(res.status).toBe(200);
    expect(ticketUpdates()[0]).toMatchObject({ status: "CANCELED", outcome: null });
  });
  it("a reason named where none is configured is refused, nothing written", async () => {
    seedMembers();
    state.rows.org_configurations = [drafting()];
    state.rows.tickets = [ticketRow()];
    state.user = { id: REQ };
    const res = await cancel({ outcome: "rejected", outcomeReason: "not_drafting_work" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "outcome_reason_invalid", error: expect.stringMatching(/no reasons configured/) });
    expect(ticketUpdates()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });
});

describe("GAP-13 / GAP-107 acceptance 1 — the org's reasons, configured", () => {
  const seed = () => {
    seedMembers();
    state.rows.org_configurations = [drafting({ outcomeReasons: REASONS })];
    state.rows.tickets = [ticketRow({ metadata: { source_document: { id: "d1" } } })];
  };
  it("a configured reason of the category it is sent with: recorded on the row (beside what metadata held), in the history line and in the audit row", async () => {
    seed();
    state.user = { id: SUP };
    const res = await cancel({ outcome: "rejected", outcomeReason: "not_drafting_work", comment: "This is a maintenance job" });
    expect(res.status).toBe(200);
    const upd = ticketUpdates()[0];
    expect(upd).toMatchObject({ status: "CANCELED", outcome: "rejected" });
    expect(upd.metadata).toEqual({ source_document: { id: "d1" }, outcome_reason: { id: "not_drafting_work", label: "Not drafting work", category: "rejected" } });
    const hist = upd.history as Array<Row>;
    expect(hist[hist.length - 1].details).toBe("This is a maintenance job [How it ended: Rejected — Not drafting work]");
    const audit = auditRows().find((r) => r.action === "TICKET_CANCEL_REQUEST")!;
    expect(audit.details).toMatchObject({ outcomeIntended: "rejected", outcomeReason: { id: "not_drafting_work", label: "Not drafting work" } });
  });
  it("a bare category is still accepted (the ruling: a configured reason OR a bare category)", async () => {
    seed();
    state.user = { id: REQ };
    const res = await cancel({ outcome: "duplicate" });
    expect(res.status).toBe(200);
    expect(ticketUpdates()[0]).toMatchObject({ status: "CANCELED", outcome: "duplicate" });
    expect((ticketUpdates()[0].metadata as Row | undefined)?.outcome_reason).toBeUndefined();
  });
  it.each([
    ["an unknown reason", { outcome: "rejected", outcomeReason: "made_up" }, /not one of this workspace's reasons/],
    ["a reason of another category", { outcome: "withdrawn", outcomeReason: "not_drafting_work" }, /is a reason for "Rejected", not for "Withdrawn"/],
    ["a reason without its category", { outcomeReason: "not_drafting_work" }, /together with how the request ends/],
    ["a reason that is not a string", { outcome: "rejected", outcomeReason: 7 }, /together with how the request ends/],
  ])("%s is refused (400), nothing written", async (_label, body, msg) => {
    seed();
    state.user = { id: SUP };
    const res = await cancel(body as Row);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "outcome_reason_invalid", error: expect.stringMatching(msg as RegExp) });
    expect(ticketUpdates()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });
  it("a category the action cannot record is refused by the outcome check first, as before", async () => {
    seed();
    state.user = { id: SUP };
    const res = await cancel({ outcome: "completed", outcomeReason: "not_drafting_work" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("outcome_invalid");
    expect(ticketUpdates()).toEqual([]);
  });
  it("the reason list cannot be read: 503, nothing written — never an unchecked reason", async () => {
    seed();
    state.failDraftingRead = 2; // the route's first drafting read (the type flags) succeeds; the reason read fails
    state.user = { id: SUP };
    const res = await cancel({ outcome: "rejected", outcomeReason: "not_drafting_work" });
    expect(res.status).toBe(503);
    expect(ticketUpdates()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });
  it("a malformed stored list reads as the entries that are well-formed (an entry with no words or an unknown category is ignored)", async () => {
    seedMembers();
    state.rows.org_configurations = [drafting({ outcomeReasons: [{ id: "x", label: "", category: "rejected" }, { id: "y", label: "Y", category: "abandoned" }, ...REASONS] })];
    state.rows.tickets = [ticketRow()];
    state.user = { id: SUP };
    expect((await cancel({ outcome: "rejected", outcomeReason: "x" })).status).toBe(400);
    expect((await cancel({ outcome: "handled_out_of_band", outcomeReason: "vendor_did_it" })).status).toBe(200);
  });
});
