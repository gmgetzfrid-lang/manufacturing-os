// notifications Round G — N19 NOTICE RECORD REMAINDERS, DELIV-18 (the ticket
// comment fan-out's email leg; drafting-flow EVID-9 done-when 2), driven
// through the REAL /api/tickets/comment handler (the n6TicketFanout harness).
//
//   * a member with an address whom THEIR OWN preference leaves out of the
//     comment's email (email off, delivery "never", or the event's switch)
//     gets one not_emailed record — the columns their email would have
//     carried — written after the response (next/server after()), AFTER the
//     queued emails; nothing for a member with no address;
//   * REGRESSION, pinned before and after 20261258: who gets a bell row, who
//     is emailed and every queued email row are byte-identical to the route
//     without the record (the record is a separate statement that runs
//     last); before 20261258 the old status CHECK refuses the record, said
//     once, and later comments in the process do not ask again (the N18
//     latch); a record that never answers holds no email.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { __resetCapabilityPolicyCache } from "@/lib/capabilityPolicy";
import { resetDeliveryRecordLatches, notEmailedRecordLatch } from "@/lib/deliveryRecordLatch";

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
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((cb: () => unknown) => { if (state.afterThrows) throw new Error("after() outside a request"); state.afterCbs.push(cb); }),
}));
vi.mock("@/lib/r2", () => ({ r2: { send: vi.fn(async () => ({})) }, R2_BUCKET: "test-bucket" }));
vi.mock("@/lib/push/sendPush", () => ({ sendPushSafe: vi.fn(async () => ({})) }));

import { POST as commentPost } from "@/app/api/tickets/comment/route";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REQ = U(1), DRAFTER = U(2), W_ON = U(3), W_OFF = U(4), W_NOADDR = U(5), W_NEVER = U(6), W_MUTED = U(7);
const ORG = "o1";
const ORIGIN = "https://ops.example.com";
const member = (uid: string, role: string, email: string | null = `${uid.slice(-2)}@x.io`) =>
  ({ org_id: ORG, uid, role, roles: [role], email, display_name: null, status: "active" });
const ticketRow = () => ({
  id: "t1", org_id: ORG, ticket_id: "REQ-1", title: "Pump iso", status: "DRAFTING", request_type: "ISO", unit: "U-100",
  requester_id: REQ, requester_role: "Requester", assigned_drafter_id: DRAFTER, assigned_engineer_id: null,
  attachments: [], comments: [], history: [], watchers: [W_ON, W_OFF, W_NOADDR, W_NEVER, W_MUTED], unread_by: [], revision_count: 0,
  last_modified: "2026-10-02T00:00:00.000Z", metadata: {},
});
const req = (body: unknown) => new NextRequest("http://app.local/api/tickets/comment", {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
});
const inserted = (table: string) => state.calls.filter((c) => c.table === table && c.method === "insert")
  .flatMap((c) => (Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Row[]);
const queued = () => inserted("email_notifications").filter((r) => r.status === "queued");
const records = () => inserted("email_notifications").filter((r) => r.status === "not_emailed");
const runAfter = async () => { const cbs = state.afterCbs.splice(0); for (const cb of cbs) await cb(); };
/** the status CHECK before 20261258: a not_emailed row is refused (the queued rows are not) */
const before258 = () => {
  const real = state.calls.push.bind(state.calls);
  state.calls.push = (c) => {
    if (c.table === "email_notifications" && c.method === "insert") {
      const rows = (Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Row[];
      if (rows.some((r) => r.status === "not_emailed")) (state.errors["email_notifications.insert"] ??= []).unshift({ code: "23514", message: 'new row for relation "email_notifications" violates check constraint "email_notifications_status_check"' });
    }
    return real(c);
  };
  return () => { state.calls.push = real; };
};

let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __resetCapabilityPolicyCache();
  resetDeliveryRecordLatches();
  state.user = { id: REQ }; state.rows = {}; state.calls = []; state.errors = {}; state.seq = 0; state.afterCbs = []; state.afterThrows = false;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  process.env.NEXT_PUBLIC_SITE_URL = ORIGIN;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  state.rows.org_members = [
    member(REQ, "Requester"), member(DRAFTER, "Drafter"), member(W_ON, "Engineer"), member(W_OFF, "Engineer"),
    member(W_NOADDR, "Engineer", null), member(W_NEVER, "Engineer"), member(W_MUTED, "Engineer"),
  ];
  state.rows.orgs = [{ id: ORG, name: "Baytown Ops" }];
  state.rows.tickets = [ticketRow()];
  state.rows.notification_preferences = [
    { user_id: W_OFF, email_enabled: false },
    { user_id: W_NOADDR, email_enabled: false },          // opted out AND no address: left out for another reason first
    { user_id: W_NEVER, digest_frequency: "never" },
    { user_id: W_MUTED, email_on_watched_activity: false, email_on_mention: true },
  ];
});
afterEach(() => { delete process.env.NEXT_PUBLIC_SITE_URL; vi.restoreAllMocks(); });

describe("DELIV-18 — the comment fan-out records the people whose own preference turned its email off", () => {
  it("REGRESSION: bell rows to every active recipient; email to exactly the opted-in members with an address — nothing written for the others until after the response", async () => {
    const res = await commentPost(req({ ticketId: "t1", text: "looks good" }));
    expect(res.status).toBe(200);
    expect(inserted("notifications").map((r) => r.user_id).sort()).toEqual([DRAFTER, W_ON, W_OFF, W_NOADDR, W_NEVER, W_MUTED].sort());
    expect(queued().map((r) => r.to_user_id).sort()).toEqual([DRAFTER, W_ON].sort());
    expect(records()).toEqual([]);                 // not yet: after() holds it
    await runAfter();
    expect(records().length).toBe(3);
  });

  it("after the response: one statement records each opted-out member with an address — the columns their email would have carried — and nobody else", async () => {
    await commentPost(req({ ticketId: "t1", text: "looks good" }));
    const mail = queued().find((r) => r.to_user_id === W_ON)!;
    await runAfter();
    const recInserts = state.calls.filter((c) => c.table === "email_notifications" && c.method === "insert");
    expect(recInserts.length).toBe(2);             // the queued rows, then ONE record statement
    expect(records().map((r) => r.to_user_id).sort()).toEqual([W_OFF, W_NEVER, W_MUTED].sort());
    const off = records().find((r) => r.to_user_id === W_OFF)!;
    expect(off).toEqual({
      org_id: ORG, to_user_id: W_OFF, to_email: "04@x.io",
      subject: mail.subject, body_text: mail.body_text, body_html: mail.body_html,
      resource_type: "ticket", resource_id: "t1", event_type: "watcher_activity",
      metadata: { mention: false, postedBy: REQ, commentId: (mail.metadata as Row).commentId, rendered: true, not_emailed: { byTheirChoice: true, reason: "preference" } },
      status: "not_emailed",
    });
  });

  it("a mention follows the mention switch: the muted watcher is emailed when mentioned (email_on_mention on); the opted-out one is recorded with the mention subject and event", async () => {
    await commentPost(req({ ticketId: "t1", text: `see @[W](${W_MUTED}) and @[O](${W_OFF})` }));
    expect(queued().map((r) => r.to_user_id).sort()).toEqual([DRAFTER, W_ON, W_MUTED].sort());
    await runAfter();
    const off = records().find((r) => r.to_user_id === W_OFF)!;
    expect(off).toMatchObject({ subject: "You were mentioned: REQ-1 Pump iso", event_type: "comment_mention", metadata: expect.objectContaining({ mention: true }) });
    expect(records().map((r) => r.to_user_id).sort()).toEqual([W_OFF, W_NEVER].sort());
  });

  it("REGRESSION, before 20261258: the queued emails are byte-identical; the refused record is said once, and the next comment in the process does not ask again", async () => {
    await commentPost(req({ ticketId: "t1", text: "looks good" }));
    await runAfter();
    const norm = (rows: Row[]) => JSON.parse(JSON.stringify(rows).split(String((rows[0].metadata as Row).commentId)).join("C"));
    const afterPaste = norm(queued());
    state.calls = []; state.seq = 0;
    resetDeliveryRecordLatches();
    const restore = before258();
    await commentPost(req({ ticketId: "t1", text: "looks good" }));
    await runAfter();
    expect(norm(queued())).toEqual(afterPaste);
    expect(records()).toEqual([expect.anything(), expect.anything(), expect.anything()]); // asked once, refused (the stand-in records the attempt)
    expect(notEmailedRecordLatch.held()).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/needs migration 20261258/));
    const tries = state.calls.filter((c) => c.table === "email_notifications" && c.method === "insert").length;
    await commentPost(req({ ticketId: "t1", text: "again" }));
    await runAfter();
    expect(state.calls.filter((c) => c.table === "email_notifications" && c.method === "insert").length).toBe(tries + 1); // the queued rows only
    restore();
  });

  it("no opted-out member with an address: nothing is scheduled", async () => {
    state.rows.notification_preferences = [];
    await commentPost(req({ ticketId: "t1", text: "x" }));
    await runAfter();
    expect(records()).toEqual([]);
    expect(queued().map((r) => r.to_user_id).sort()).toEqual([DRAFTER, W_ON, W_OFF, W_NEVER, W_MUTED].sort());
  });

  it("a membership read that fails mails nobody and records nobody (no address was read) — today's fail-open bell audience", async () => {
    let n = 0;
    const real = state.calls.push.bind(state.calls);
    state.calls.push = (c) => {
      if (c.table === "org_members" && c.method === "select" && c.args[0] === "uid, email") { n += 1; if (n === 1) (state.errors["org_members.select"] ??= []).push({ message: "connection reset" }); }
      return real(c);
    };
    await commentPost(req({ ticketId: "t1", text: "x" }));
    state.calls.push = real;
    expect(queued()).toEqual([]);
    await runAfter();
    expect(records()).toEqual([]);
  });

  it("after() unavailable: the record still runs (in the background), after the queued emails", async () => {
    state.afterThrows = true;
    await commentPost(req({ ticketId: "t1", text: "looks good" }));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const order = state.calls.filter((c) => c.table === "email_notifications" && c.method === "insert")
      .map((c) => ((Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Row[])[0].status);
    expect(order).toEqual(["queued", "not_emailed"]);
  });

  it("a record that never answers holds no email and no response", async () => {
    const real = state.calls.push.bind(state.calls);
    let hang = false;
    state.calls.push = (c) => { if (c.table === "email_notifications" && c.method === "insert" && ((Array.isArray(c.args[0]) ? c.args[0] : [c.args[0]]) as Row[])[0].status === "not_emailed") hang = true; return real(c); };
    const res = await commentPost(req({ ticketId: "t1", text: "looks good" }));
    expect(res.status).toBe(200);
    expect(queued().length).toBe(2);
    expect(hang).toBe(false);                      // the record has not even been asked yet
    state.calls.push = real;
  });
});
