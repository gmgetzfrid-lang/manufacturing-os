// notifications Round G — N6 EMAIL-PIPELINE-AND-CRON: the ticket routes'
// own fan-out and the handback notice, driven through the REAL handlers.
//
//   NEDGE-14   /api/tickets/comment and /api/tickets/workflow-action filter
//              their service-role fan-out to ACTIVE members of the ticket's
//              org: a suspended watcher gets neither a bell row nor an email;
//              an active one gets both. (DF-P1's audit-first order, read
//              scope and hold release are untouched — the routes' own tests
//              in dfRoundG_P1_rails.test.ts still pin them.)
//   NEDGE-15   /api/tickets/handback runs emit() bound to the service role:
//              the requester gets the bell row and the email; a suspended
//              watcher gets neither. The REAL dispatcher runs (not mocked).
//   NEDGE-10   comment mention markup reaches the email as names; the email
//              carries the render layer's footer.
//   DELIV-7    a refused bell / email insert in the routes is logged, never
//              silently dropped; notify() answers whether its row landed and
//              notifyMany reports {sent, failed}; emit() reports an audience
//              that resolved to nobody.

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
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const errOf = () => state.errors[`${table}.${method ?? "select"}`]?.shift() ?? null;
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
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/r2", () => ({
  r2: { send: vi.fn(async () => ({ ContentLength: 1048576, ETag: '"etag-1"' })) },
  R2_BUCKET: "test-bucket",
}));

import { POST as commentPost } from "@/app/api/tickets/comment/route";
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";
import { POST as handbackPost } from "@/app/api/tickets/handback/route";
import { notify, notifyMany } from "@/lib/inAppNotifications";
import { emit } from "@/lib/notify/dispatch";
import { runWithServerClient } from "@/lib/serverClientScope";

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

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.errors = {}; state.seq = 0;
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
    member(W_SUSP, "Engineer", "suspended"), member(W_INACTIVE, "Engineer", "inactive"),
  ];
  state.rows.orgs = [{ id: ORG, name: "Baytown Ops" }];
};

describe("NEDGE-14 — the comment route mails and bells ACTIVE members only", () => {
  it("a suspended or inactive watcher gets neither a bell row nor an email; the active watcher and the drafter get both", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow()];
    state.user = { id: REQ };
    const res = await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "looks good" }));
    expect(res.status).toBe(200);
    expect(bellUsers()).toEqual([DRAFTER, W_ACTIVE].sort());
    expect(mailUsers()).toEqual([DRAFTER, W_ACTIVE].sort());
    // the address lookup itself asks for ACTIVE members (comment/route.ts, the first fan-out read)
    const memberReads = state.calls.filter((c) => c.table === "org_members" && c.method === "eq" && c.args[0] === "status");
    expect(memberReads.some((c) => c.args[1] === "active")).toBe(true);
  });

  it("NEDGE-10: a mention renders as the name in the email — never the uuid — and the email carries the footer", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow()];
    state.user = { id: REQ };
    await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: `please check @[Dee Drafter](${DRAFTER}) before Friday` }));
    const mail = inserted("email_notifications").find((m) => m.to_user_id === DRAFTER)!;
    expect(mail.subject).toBe("You were mentioned: REQ-1 Pump iso");
    for (const body of [String(mail.body_text), String(mail.body_html)]) {
      expect(body).toContain("@Dee Drafter");
      expect(body).not.toContain(DRAFTER);
      expect(body).toContain(`${ORIGIN}/settings/notifications`);
    }
    expect(String(mail.body_html)).toContain("Baytown Ops sent this notification.");
    expect(mail.metadata).toMatchObject({ mention: true, postedBy: REQ, rendered: true });
    // the bell row keeps its in-app link and kind
    expect(inserted("notifications").find((n) => n.user_id === DRAFTER)).toMatchObject({ kind: "ticket_mention", link: expect.stringMatching(/^\/requests\/t1\?c=/) });
  });

  it("REGRESSION (fail-open): a membership read that fails keeps today's bell audience and mails nobody — a transient error never silently drops a notice", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow()];
    state.user = { id: REQ };
    // the route's own caller check reads org_members first (maybeSingle); the fan-out read is the next select
    let n = 0;
    const realPush = state.calls.push.bind(state.calls);
    state.calls.push = (c) => {
      if (c.table === "org_members" && c.method === "select" && (c.args[0] === "uid, email")) { n += 1; if (n === 1) (state.errors["org_members.select"] ??= []).push({ message: "connection reset" }); }
      return realPush(c);
    };
    const res = await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "x" }));
    state.calls.push = realPush;
    expect(res.status).toBe(200);
    expect(bellUsers()).toEqual([DRAFTER, W_ACTIVE, W_SUSP, W_INACTIVE].sort());
    expect(mailUsers()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/active-membership read failed/), "connection reset");
  });

  it("DELIV-7 dw3: a refused bell insert and a refused email insert are logged; the comment still answers ok", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow()];
    state.user = { id: REQ };
    state.errors["notifications.insert"] = [{ message: "bell refused" }];
    state.errors["email_notifications.insert"] = [{ message: "queue refused" }];
    const res = await commentPost(req("/api/tickets/comment", { ticketId: "t1", text: "x" }));
    expect(res.status).toBe(200);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/bell rows were not written/), "bell refused");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/emails were not queued/), "queue refused");
  });
});

describe("NEDGE-14 — the workflow-action route mails and bells ACTIVE members only", () => {
  it("submit_draft: the requester and the active watcher get both; the suspended and inactive watchers get neither", async () => {
    seedMembers();
    state.rows.tickets = [ticketRow({ attachments: [DRAFT] })];
    state.user = { id: DRAFTER };
    const res = await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "submit_draft" }));
    expect(res.status).toBe(200);
    expect(bellUsers()).toEqual([REQ, W_ACTIVE].sort());
    expect(mailUsers()).toEqual([REQ, W_ACTIVE].sort());
    const mail = inserted("email_notifications")[0];
    expect(String(mail.body_html)).toContain(`href="${ORIGIN}/requests/t1"`);
    expect(String(mail.body_html)).toContain(`href="${ORIGIN}/settings/notifications"`);
    expect(mail.metadata).toMatchObject({ action: "submit_draft", rendered: true });
  });

  it("REGRESSION: with every watcher suspended the stale workflow alerts are still retired (the supersede step runs before the audience is checked)", async () => {
    seedMembers();
    state.rows.org_members = state.rows.org_members.map((m) => (m.uid === REQ ? { ...m, status: "suspended" } : m));
    state.rows.tickets = [ticketRow({ attachments: [DRAFT], watchers: [W_SUSP] })];
    state.rows.notifications = [{ id: "old", org_id: ORG, user_id: W_SUSP, resource_id: "t1", read_at: null, metadata: { action: "assign" } }];
    state.user = { id: DRAFTER };
    expect((await workflowAction(req("/api/tickets/workflow-action", { ticketId: "t1", actionType: "submit_draft" }))).status).toBe(200);
    expect((state.rows.notifications.find((n) => n.id === "old")!.metadata as Row).superseded_at).toBeTruthy();
    expect(inserted("notifications")).toEqual([]);
    expect(inserted("email_notifications")).toEqual([]);
  });
});

describe("NEDGE-15 — the handback notice is delivered: emit() runs bound to the service role (the REAL dispatcher)", () => {
  const seedHandback = () => {
    seedMembers();
    state.rows.org_members.push(member(U(9), "DocCtrl"));
    state.rows.tickets = [ticketRow({ status: "FINAL_DRAFT", metadata: { source_document: { id: "d1", document_number: "P-1" } }, watchers: [W_ACTIVE, W_SUSP] })];
    state.rows.document_versions = [{ id: "v1", org_id: ORG, record_id: "d1", revision_label: "3", related_ticket_id: "t1", review_state: null, created_by: U(9) }];
  };

  it("the requester (and the active drafter and watcher) get the bell row and the email; the suspended watcher gets neither; the route answers ok", async () => {
    seedHandback();
    state.user = { id: U(9) };
    const res = await handbackPost(req("/api/tickets/handback", { ticketId: "t1", versionId: "v1" }));
    expect(res.status).toBe(200);
    expect(bellUsers()).toEqual([REQ, DRAFTER, W_ACTIVE].sort());
    expect(mailUsers()).toEqual([REQ, DRAFTER, W_ACTIVE].sort());
    const bell = inserted("notifications").find((n) => n.user_id === REQ)!;
    expect(bell).toMatchObject({ kind: "ticket_status", title: "REQ-1: deliverable published as Rev 3", link: "/requests/t1", actor_user_id: U(9) });
    const mail = inserted("email_notifications").find((m) => m.to_user_id === REQ)!;
    // NEDGE-4: the emit() email now carries the event's link, absolute, and the footer
    expect(String(mail.body_text)).toContain(`${ORIGIN}/requests/t1`);
    expect(mail.metadata).toMatchObject({ link: `${ORIGIN}/requests/t1`, rendered: true });
    // nothing went through the unbound (anon) client
    expect(state.calls.filter((c) => c.table.startsWith("anon:"))).toEqual([]);
  });

  it("the reproduction: the same emit() on the UNBOUND shared client reaches nobody — and now says so", async () => {
    seedHandback();
    const out = await emit({
      orgId: ORG, category: "status", kind: "ticket_status", title: "x", body: "y", link: "/requests/t1",
      resource: { type: "ticket", id: "t1" }, actorUserId: U(9), audience: { involved: [REQ] },
    });
    expect(out).toEqual({ recipients: 0 });
    expect(inserted("notifications")).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[notify] emit reached no recipient", expect.objectContaining({ orgId: ORG, kind: "ticket_status", resource: "ticket:t1" }));
    // bound, it delivers — and reports what landed
    const bound = await runWithServerClient(admin.client, () => emit({
      orgId: ORG, category: "status", kind: "ticket_status", title: "x", body: "y", link: "/requests/t1",
      resource: { type: "ticket", id: "t1" }, actorUserId: U(9), audience: { involved: [REQ, W_SUSP] },
    }));
    expect(bound).toEqual({ recipients: 1, inapp: { sent: 1, failed: 0 } });
  });
});

describe("DELIV-7 dw1 — notify() answers whether its row landed; notifyMany reports {sent, failed}; neither ever throws", () => {
  it("bound to the service role a row lands (true); on the unbound client it is refused (false), logged, not thrown", async () => {
    seedMembers();
    const ok = await runWithServerClient(admin.client, () => notify({ orgId: ORG, userId: REQ, kind: "ticket_comment", title: "t" }));
    expect(ok).toBe(true);
    const refused = await notify({ orgId: ORG, userId: REQ, kind: "ticket_comment", title: "t" });
    expect(refused).toBe(false);
    expect(warn).toHaveBeenCalledWith("[notify] insert failed", "row-level security");
  });

  it("notifyMany counts each landed and refused row, drops the actor and duplicates as before", async () => {
    seedMembers();
    state.errors["notifications.insert"] = [null, { message: "refused" }];
    const out = await runWithServerClient(admin.client, () => notifyMany({
      orgId: ORG, userIds: [REQ, DRAFTER, DRAFTER, W_ACTIVE], actorUserId: W_ACTIVE, kind: "ticket_comment", title: "t",
    }));
    expect(out).toEqual({ sent: 1, failed: 1 });
    expect(await notifyMany({ orgId: ORG, userIds: [W_ACTIVE], actorUserId: W_ACTIVE, kind: "ticket_comment", title: "t" })).toEqual({ sent: 0, failed: 0 });
  });
});
