// notifications Round G — N17 PUSH PRODUCERS AND SIGN-OUT: OS-14, the ticket
// routes' own fan-out reaches the push channel, driven through the REAL
// handlers (the n6TicketFanout harness: a service-role Proxy chain, the
// shared client unbound).
//
//   /api/tickets/comment          a mention's bell row → sendPushSafe
//                                 ({ kind: "ticket_mention" }) for the
//                                 mentioned ACTIVE members only, scheduled
//                                 with next/server after() — after the bell
//                                 insert AND the email insert.
//   /api/tickets/workflow-action  an assignment's bell rows → sendPushSafe
//                                 ({ kind: "ticket_assigned" }) for the
//                                 ASSIGNEE only (the committed ticket's
//                                 assigned_drafter_id, when in the audience
//                                 told) — never the watchers; a self_assign
//                                 pushes nobody; no other transition pushes.
//
// Fail-safe (DEC-90): a refused bell insert pushes nobody; a push that fails,
// or cannot even be scheduled, never fails the action or touches its bell
// rows and emails, which stay exactly as before (pinned here per producer).

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
  afterCbs: [] as Array<() => unknown>,
  afterThrows: false,
  pushRejects: false,
  bellClock: 0,
  bellTick: 0,
  webPushSent: [] as string[],
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
  let orderBy: [string, boolean] | null = null;
  const rows = () => {
    const hit = (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (!orderBy) return hit;
    const [col, asc] = orderBy;
    return [...hit].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (asc ? 1 : -1));
  };
  const errOf = () => state.errors[`${table}.${method ?? "select"}`]?.shift() ?? null;
  const settle = () => {
    const err = errOf();
    if (err) return { data: null, error: err };
    if (method === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
      // a bell row is dated as the database dates it (created_at DEFAULT
      // now()), one second apart, so the real sender (R1's cap pin) reads
      // each landed row as recent and newer than the last one it pushed
      const landed = list.map((r) => ({ id: `${table}-${++state.seq}`, ...(table === "notifications" && r.created_at == null ? { created_at: new Date(state.bellClock + 1000 * ++state.bellTick).toISOString() } : {}), ...r }));
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
        if (prop === "order") orderBy = [String(args[0]), (args[1] as { ascending?: boolean } | undefined)?.ascending !== false];
        if (prop === "eq") filters.push((r) => at(r, String(args[0])) === args[1]);
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
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // after(): the callbacks are kept, in order, and run by the test (afterRun)
  after: vi.fn((cb: () => unknown) => { if (state.afterThrows) throw new Error("after() outside a request"); state.afterCbs.push(cb); }),
}));
// the server push sender: a spy that records WHEN it ran (its position in the call log)
vi.mock("@/lib/push/sendPush", () => ({
  sendPushSafe: vi.fn(async (input: Record<string, unknown>) => {
    state.calls.push({ table: "push", method: "sendPushSafe", args: [input] });
    if (state.pushRejects) throw new Error("push service down");
    return { eligible: 0, attempted: 0, sent: 0, pruned: 0, capped: 0 };
  }),
}));
// R1 (the integrator at the N17 merge): the cap pin runs the REAL sender
// (vi.importActual) behind the spy; web-push is the push service stand-in.
vi.mock("web-push", () => {
  const api = {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }) => { state.webPushSent.push(sub.endpoint); return { statusCode: 201, body: "", headers: {} }; }),
    generateVAPIDKeys: vi.fn(),
  };
  return { default: api, ...api };
});
vi.mock("@/lib/r2", () => ({
  r2: { send: vi.fn(async () => ({ ContentLength: 1048576, ETag: '"etag-1"' })) },
  R2_BUCKET: "test-bucket",
}));

import { POST as commentPost } from "@/app/api/tickets/comment/route";
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { sendPushSafe } from "@/lib/push/sendPush";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REQ = U(1), DRAFTER = U(2), W_ACTIVE = U(3), W_SUSP = U(4), ADMIN = U(6), DRAFTER2 = U(7);
const ORG = "o1";
const LM = "2026-10-02T00:00:00.000Z";
const ORIGIN = "https://ops.example.com";
const member = (uid: string, role: string, status = "active") =>
  ({ org_id: ORG, uid, role, roles: [role], email: `${uid.slice(-2)}@x.io`, display_name: null, status });
const ticketRow = (over: Row = {}) => ({
  id: "t1", org_id: ORG, ticket_id: "REQ-1", title: "Pump iso", status: "DRAFTING", request_type: "ISO", unit: "U-100",
  requester_id: REQ, requester_role: "Requester", assigned_drafter_id: DRAFTER, assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [W_ACTIVE, W_SUSP], unread_by: [], revision_count: 0, last_modified: LM,
  metadata: {}, ...over,
});
const KEY = (name: string) => `orgs/o1/tickets/REQ-1/1727000000000_${name}`;
const DRAFT = { id: "a-d", name: "iso_1A.pdf", url: KEY("iso_1A.pdf"), type: "Draft", status: "staged", uploadedBy: "02@x.io" } as TicketAttachment;
const req = (path: string, body: unknown) => new NextRequest(`http://app.local${path}`, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
});
const inserted = (table: string) => state.calls.filter((c) => c.table === table && c.method === "insert")
  .flatMap((c) => (Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Row[]);
const bellRows = () => inserted("notifications").map((r) => ({ user: r.user_id as string, kind: r.kind as string })).sort((a, b) => a.user.localeCompare(b.user));
const mailUsers = () => inserted("email_notifications").map((r) => r.to_user_id as string).sort();
const pushes = () => state.calls.filter((c) => c.table === "push").map((c) => c.args[0] as { orgId: string; kind: string; resourceId: string; recipients: string[]; writerUid?: string | null });
const indexOf = (table: string, method: string) => state.calls.findIndex((c) => c.table === table && c.method === method);
/** Runs every after() callback the request scheduled (as next/server does once the response is sent). */
const afterRun = async () => { for (const cb of state.afterCbs.splice(0)) await cb(); };

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.seq = 0;
  state.afterCbs = []; state.afterThrows = false; state.pushRejects = false;
  state.bellClock = Date.now() - 90_000; state.bellTick = 0; state.webPushSent = [];
  vi.mocked(sendPushSafe).mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  delete process.env.CRON_SECRET;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { delete process.env.NEXT_PUBLIC_SITE_URL; vi.restoreAllMocks(); });

const seedMembers = () => {
  state.rows.org_members = [
    member(REQ, "Requester"), member(DRAFTER, "Drafter"), member(W_ACTIVE, "Engineer"),
    member(W_SUSP, "Engineer", "suspended"), member(ADMIN, "Admin"), member(DRAFTER2, "Drafter"),
  ];
  state.rows.orgs = [{ id: ORG, name: "Baytown Ops" }];
};
const MENTION = `please check @[Dee Drafter](${DRAFTER}) and @[Sue Spended](${W_SUSP})`;

describe("OS-14 — a mention on a request reaches the push channel after its bell row (comment route)", () => {
  it("the mentioned ACTIVE member is pushed (ticket_mention, this ticket), after the bell insert and the email insert; the suspended one is not; bell rows and emails exactly as before", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow()];
    state.user = { id: REQ };
    const res = await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: MENTION }));
    expect(res.status).toBe(200);
    // REGRESSION: today's bell rows (a mention for the drafter, a comment row for the active watcher) and emails
    expect(bellRows()).toEqual([{ user: DRAFTER, kind: "ticket_mention" }, { user: W_ACTIVE, kind: "ticket_comment" }].sort((a, b) => a.user.localeCompare(b.user)));
    expect(mailUsers()).toEqual([DRAFTER, W_ACTIVE].sort());
    // nothing pushed before the response: the push is an after() callback
    expect(pushes()).toEqual([]);
    await afterRun();
    expect(pushes()).toEqual([{ orgId: ORG, kind: "ticket_mention", resourceId: "t1", recipients: [DRAFTER], writerUid: REQ }]);
    expect(indexOf("notifications", "insert")).toBeLessThan(indexOf("push", "sendPushSafe"));
    expect(indexOf("email_notifications", "insert")).toBeLessThan(indexOf("push", "sendPushSafe"));
  });

  it("a comment that mentions nobody pushes nothing (a plain comment row is not push-worthy); the bell and email are unchanged", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow()];
    state.user = { id: REQ };
    expect((await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "looks good" }))).status).toBe(200);
    await afterRun();
    expect(pushes()).toEqual([]);
    expect(bellRows().map((b) => b.kind)).toEqual(["ticket_comment", "ticket_comment"]);
    expect(mailUsers()).toEqual([DRAFTER, W_ACTIVE].sort());
  });

  it("a REFUSED bell insert pushes nobody (never for a refused or rail-rejected row); the emails still go as before", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow()];
    state.user = { id: REQ };
    state.errors["notifications.insert"] = [{ code: "22023", message: "kind not allowed" }];
    expect((await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: MENTION }))).status).toBe(200);
    await afterRun();
    expect(pushes()).toEqual([]);
    expect(mailUsers()).toEqual([DRAFTER, W_ACTIVE].sort());
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/bell rows were not written/), "kind not allowed");
  });

  it("a push that fails never fails the comment, and a push that cannot even be scheduled is logged — the bell rows and emails stand", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow()];
    state.user = { id: REQ };
    state.pushRejects = true;
    expect((await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: MENTION }))).status).toBe(200);
    await expect(afterRun()).rejects.toThrow(/push service down/); // next/server's after() owns a rejected callback; the response was already sent
    expect(bellRows()).toHaveLength(2);
    // after() itself throwing (outside a request): the comment still answers 200 with its rows
    state.calls = []; state.afterCbs = []; state.pushRejects = false; state.afterThrows = true;
    state.rows.tickets = [ticketRow()];
    const res = await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: MENTION }));
    expect(res.status).toBe(200);
    expect(bellRows()).toHaveLength(2);
    expect(mailUsers()).toEqual([DRAFTER, W_ACTIVE].sort());
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the mention push was not scheduled/), "after() outside a request");
  });
});

describe("OS-14 — an assignment reaches the push channel after its bell rows (workflow-action route)", () => {
  it("assign (no watchers): the assignee — whose ticket_assigned bell row landed — is pushed (ticket_assigned, this ticket), after the bell and email inserts", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, watchers: [] })];
    state.user = { id: ADMIN };
    const res = await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "assign", assignment: { id: DRAFTER2, name: "d" } }));
    expect(res.status).toBe(200);
    const bells = bellRows();
    expect(bells.length).toBeGreaterThan(0);
    expect(bells.every((b) => b.kind === "ticket_assigned")).toBe(true);
    expect(bells.map((b) => b.user)).toContain(DRAFTER2);
    expect(pushes()).toEqual([]);
    await afterRun();
    const p = pushes();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ orgId: ORG, kind: "ticket_assigned", resourceId: "t1", writerUid: ADMIN });
    // the assignee, whose bell row landed
    expect(p[0].recipients).toEqual([DRAFTER2]);
    expect(bells.map((b) => b.user)).toEqual([DRAFTER2]);
    expect(indexOf("notifications", "insert")).toBeLessThan(indexOf("push", "sendPushSafe"));
    if (indexOf("email_notifications", "insert") >= 0) expect(indexOf("email_notifications", "insert")).toBeLessThan(indexOf("push", "sendPushSafe"));
  });

  it("assign with watchers present: ONLY the assignee is pushed — the watchers share the ticket_assigned bell row (and its email) exactly as before, but were not assigned", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, watchers: [W_ACTIVE, REQ] })];
    state.user = { id: ADMIN };
    expect((await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "assign", assignment: { id: DRAFTER2, name: "d" } }))).status).toBe(200);
    // REGRESSION: the bell rows and emails are untouched by the push leg
    expect(bellRows()).toEqual([DRAFTER2, REQ, W_ACTIVE].sort().map((user) => ({ user, kind: "ticket_assigned" })));
    expect(mailUsers()).toEqual([DRAFTER2, REQ, W_ACTIVE].sort());
    await afterRun();
    expect(pushes()).toEqual([{ orgId: ORG, kind: "ticket_assigned", resourceId: "t1", recipients: [DRAFTER2], writerUid: ADMIN }]);
    // the assignee was read from the committed ticket, scoped to its org
    const read = state.calls.findIndex((c) => c.table === "tickets" && c.method === "select" && c.args[0] === "assigned_drafter_id");
    expect(read).toBeGreaterThan(indexOf("notifications", "insert"));
    expect(read).toBeLessThan(indexOf("push", "sendPushSafe"));
  });

  it("reassign_drafter with watchers present: ONLY the new drafter is pushed; the old drafter and the watchers keep their bell rows and emails as before", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "DRAFTING", assigned_drafter_id: DRAFTER, watchers: [W_ACTIVE, REQ] })];
    state.user = { id: ADMIN };
    expect((await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "reassign_drafter", comment: "out", assignment: { id: DRAFTER2, name: "d" } }))).status).toBe(200);
    const bells = bellRows();
    expect(bells.every((b) => b.kind === "ticket_assigned")).toBe(true);
    expect(bells.map((b) => b.user)).toEqual(expect.arrayContaining([DRAFTER2, REQ, W_ACTIVE]));
    const mails = mailUsers();
    await afterRun();
    expect(pushes()).toEqual([{ orgId: ORG, kind: "ticket_assigned", resourceId: "t1", recipients: [DRAFTER2], writerUid: ADMIN }]);
    expect(bellRows()).toEqual(bells);
    expect(mailUsers()).toEqual(mails);
  });

  it("self_assign pushes NOBODY — the requester, the engineer and the watchers get the bell row and email as before, but nobody else was assigned and the actor is not in the audience", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, assigned_engineer_id: W_ACTIVE, watchers: [W_ACTIVE, ADMIN] })];
    state.user = { id: DRAFTER2, email: "07@x.io" };
    expect((await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "self_assign" }))).status).toBe(200);
    const bells = bellRows();
    expect(bells.length).toBeGreaterThan(0);
    expect(bells.every((b) => b.kind === "ticket_assigned")).toBe(true);
    expect(bells.map((b) => b.user)).not.toContain(DRAFTER2);
    expect(bells.map((b) => b.user)).toEqual(expect.arrayContaining([REQ, W_ACTIVE, ADMIN]));
    expect(state.rows.tickets[0].assigned_drafter_id).toBe(DRAFTER2);
    await afterRun();
    expect(pushes()).toEqual([]);
    expect(vi.mocked(sendPushSafe)).not.toHaveBeenCalled();
  });

  it("a failed assignee read pushes nobody (fail-safe) and is logged; the bell rows and emails stand", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, watchers: [W_ACTIVE] })];
    state.user = { id: ADMIN };
    expect((await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "assign", assignment: { id: DRAFTER2, name: "d" } }))).status).toBe(200);
    const bells = bellRows();
    state.errors["tickets.select"] = [{ message: "read failed" }];
    await afterRun();
    expect(pushes()).toEqual([]);
    expect(bellRows()).toEqual(bells);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/assignee was not read/), "read failed");
  });

  it("a status transition (submit_draft) pushes nothing — only the assignment's leg was added; its bell rows and emails are exactly as before", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ attachments: [DRAFT] })];
    state.user = { id: DRAFTER };
    expect((await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "submit_draft" }))).status).toBe(200);
    await afterRun();
    expect(pushes()).toEqual([]);
    expect(bellRows().map((b) => b.user)).toEqual([REQ, W_ACTIVE].sort());
    expect(mailUsers()).toEqual([REQ, W_ACTIVE].sort());
  });

  it("a REFUSED bell insert on an assignment pushes nobody; the transition still answers 200", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, watchers: [] })];
    state.user = { id: ADMIN };
    state.errors["notifications.insert"] = [{ code: "42501", message: "row-level security" }];
    expect((await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "assign", assignment: { id: DRAFTER2, name: "d" } }))).status).toBe(200);
    await afterRun();
    expect(pushes()).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/bell rows were not written/), "row-level security");
  });

  it("after() that cannot schedule the push is logged; the assignment, its bell rows and emails stand", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, watchers: [] })];
    state.user = { id: ADMIN };
    state.afterThrows = true;
    const res = await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "assign", assignment: { id: DRAFTER2, name: "d" } }));
    expect(res.status).toBe(200);
    expect(bellRows().map((b) => b.user)).toContain(DRAFTER2);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the assignment push was not scheduled/), "after() outside a request");
  });
});

describe("R1 (the integrator at the N17 merge, DEC-90) — the ticket routes' pushes name their writer, so DEC-108's per-writer cap bounds a burst", () => {
  const VAPID = { VAPID_PUBLIC_KEY: "pub-key", VAPID_PRIVATE_KEY: "priv-key", VAPID_SUBJECT: "mailto:ops@example.com" };
  afterEach(() => { for (const k of Object.keys(VAPID)) delete process.env[k]; });

  it("6 mentions of one member by one writer: pushes 1-5 go out, the 6th is NOT pushed (capped) — and every one of the 6 bell rows and emails lands exactly as before", async () => {
    const real = await vi.importActual<typeof import("@/lib/push/sendPush")>("@/lib/push/sendPush");
    Object.assign(process.env, VAPID);
    real.__resetPushLogOnceForTests();
    const { PUSH_WRITER_CAP } = real;
    expect(PUSH_WRITER_CAP).toBe(5);
    seedMembers();
    state.rows.tickets = [ticketRow()];
    state.rows.push_subscriptions = [{
      id: "dev-1", user_id: DRAFTER, endpoint: "https://fcm.googleapis.com/fcm/send/dee-phone", p256dh: "p", auth: "k",
      last_reminded_at: null, created_at: new Date(Date.now() - 1000).toISOString(),
    }];
    state.user = { id: REQ };
    const outcomes: Array<{ sent: number; capped: number }> = [];
    for (let i = 1; i <= 6; i += 1) {
      vi.mocked(sendPushSafe).mockImplementationOnce(async (input) => {
        state.calls.push({ table: "push", method: "sendPushSafe", args: [input] });
        const out = await real.sendPushSafe(input);
        outcomes.push(out);
        return out;
      });
      const res = await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: `${MENTION} (${i})` }));
      expect(res.status).toBe(200);
      await afterRun();
    }
    // every push names the commenter as its writer
    expect(pushes()).toHaveLength(6);
    expect(pushes().every((p) => p.writerUid === REQ && p.kind === "ticket_mention" && p.recipients.join() === DRAFTER)).toBe(true);
    // 1-5 pushed to the device, the 6th capped
    expect(outcomes.map((o) => o.sent)).toEqual([1, 1, 1, 1, 1, 0]);
    expect(outcomes.map((o) => o.capped)).toEqual([0, 0, 0, 0, 0, 1]);
    expect(state.webPushSent).toHaveLength(5);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/over the per-writer push cap/));
    // REGRESSION: the 6th mention's bell row and email are exactly as the first's (and as before N17)
    const bells = inserted("notifications");
    expect(bells.filter((r) => r.user_id === DRAFTER && r.kind === "ticket_mention")).toHaveLength(6);
    expect(bells.filter((r) => r.user_id === W_ACTIVE && r.kind === "ticket_comment")).toHaveLength(6);
    const strip = (r: Row) => { const { body: _b, link: _l, created_at: _c, id: _i, metadata: _m, ...rest } = r; return rest; };
    const dee = bells.filter((r) => r.user_id === DRAFTER);
    expect(strip(dee[5])).toEqual(strip(dee[0]));
    expect(mailUsers()).toEqual([...Array(6).fill(DRAFTER), ...Array(6).fill(W_ACTIVE)].sort());
    const mails = inserted("email_notifications").filter((r) => r.to_user_id === DRAFTER);
    expect(mails.map((m) => m.subject)).toEqual(Array(6).fill(mails[0].subject));
    expect(mails.every((m) => m.event_type === "comment_mention")).toBe(true);
  });

  it("the assignment push names the actor as its writer (the same cap applies to a burst of assignments)", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ status: "PENDING_ASSIGNMENT", assigned_drafter_id: null, watchers: [] })];
    state.user = { id: ADMIN };
    expect((await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "assign", assignment: { id: DRAFTER2, name: "d" } }))).status).toBe(200);
    await afterRun();
    expect(pushes()).toEqual([{ orgId: ORG, kind: "ticket_assigned", resourceId: "t1", recipients: [DRAFTER2], writerUid: ADMIN }]);
  });
});
