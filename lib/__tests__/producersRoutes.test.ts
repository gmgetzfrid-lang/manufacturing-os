// notifications Round G — N8 PRODUCERS-FREE, PROD-2: an access request is
// heard, and so is its answer.
//
//   dw1  POST /api/auth/request-access, after the row is written, tells the
//        org's Admins (DEC-92 item 1, narrowed to the people who can see the
//        pending list by PROD-15, admin-and-org Round G P5): a bell row
//        (access_request_pending → Admin → Users) and an email each — through
//        the shared-client helpers bound to the service role
//        (runWithServerClient), the role pool resolved by the real
//        resolveRoleRecipients over the same fake;
//   dw2  the decision emails the address on the request: a decline from
//        /api/admin/access-requests (external mail, queued server-side from
//        the stored row), an approval from /api/admin/create-user when the
//        membership answered a pending request.
// N8's review fix: the door is public, so what a stranger types never reaches
// a notice as typed — a name loses line breaks, controls and links, an
// address that is not one well-formed address is shown as invalid and gets
// no email leg, and past the per-org hourly cap a request gets no notice of
// its own (bell or email) — each pool member holds ONE unread "more are
// waiting" row instead; and a decided request's pool notices are marked read.
// REGRESSION FIRST: every response is the one the route gave before — the
// rate limit, the decline's authority, the member grant — except the ones
// ORG-8 (admin-and-org Round G P5) deliberately collapsed: no such workspace
// and an already-pending request now get the recorded request's neutral 200
// (REQUEST_ACCESS_ACKNOWLEDGEMENT), which names no workspace. A notice that
// cannot be sent never changes a response.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  caller: { id: "admin1", email: "admin1@acme.test" } as { id: string; email: string } | null,
  bells: [] as Array<Record<string, unknown>>,
  emails: [] as Array<Record<string, unknown>>,
  notifyThrows: false,
  countFails: false,
  openReadFails: false,
  /** PROD-16 (N14): claim_access_request_burst (20261197) — "missing" before
   *  the paste (PGRST202, today's path), "live" after it, "error" otherwise. */
  burstRpc: "missing" as "missing" | "live" | "error",
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** The function's per-org advisory lock, transcribed: one claim at a time. */
  burstLock: Promise.resolve() as Promise<void>,
}));

/** claim_access_request_burst as 20261197 writes it, over the fake: under the
 *  lock, the recipients who are ACTIVE members of the org and hold no unread
 *  server burst row (no actor) get one; it answers {told, already}. */
async function claimBurst(args: Record<string, unknown>) {
  const org = String(args.p_org);
  const recipients = [...new Set((args.p_recipients as string[]).filter(Boolean))];
  const open = (uid: string) => (s.db.tables.notifications ?? []).some((n) => n.org_id === org && n.user_id === uid
    && n.kind === "access_request_pending" && n.resource_type === "org" && n.resource_id === org && n.read_at == null && n.actor_user_id == null);
  const prev = s.burstLock;
  let release!: () => void;
  s.burstLock = new Promise<void>((r) => { release = r; });
  await prev;
  try {
    const already = recipients.filter(open).length;
    await new Promise((r) => setTimeout(r, 5));      // the window the lock closes
    const rest = recipients.filter((uid) => !open(uid)
      && (s.db.tables.org_members ?? []).some((m) => m.org_id === org && m.uid === uid && m.status === "active"));
    for (const uid of rest) {
      (s.db.tables.notifications ??= []).push({
        id: `burst-${uid}-${(s.db.tables.notifications ?? []).length}`, org_id: org, user_id: uid, kind: "access_request_pending",
        title: args.p_title, body: args.p_body, link: "/admin/users", resource_type: "org", resource_id: org,
        actor_user_id: null, actor_name: null, metadata: { accessRequestBurst: true }, read_at: null,
      });
    }
    return { data: { told: rest.length, already }, error: null };
  } finally { release(); }
}

/** access_requests whose head-count read fails (the email cap's read). */
function failingCount(b: Record<string, unknown>) {
  return new Proxy(b, {
    get(target, prop: string) {
      if (prop !== "select") return target[prop];
      return (cols: string, o?: { head?: boolean }) => {
        if (!o?.head) return (target.select as (c: string, o?: unknown) => unknown)(cols, o);
        const chain: Record<string, unknown> = {};
        for (const m of ["eq", "gte"]) chain[m] = () => chain;
        chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, count: null, error: { message: "count read failed" } }).then(ok);
        return chain;
      };
    },
  });
}

/** notifications whose plain select fails (the burst notice's open-row read). */
function failingSelect(b: Record<string, unknown>) {
  return new Proxy(b, {
    get(target, prop: string) {
      if (prop !== "select") return target[prop];
      return () => {
        const chain: Record<string, unknown> = {};
        for (const m of ["eq", "is", "in"]) chain[m] = () => chain;
        chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "open read failed" } }).then(ok);
        return chain;
      };
    },
  });
}

vi.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    const base = makeFakeSupabase(s.db);
    return {
      ...base,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        s.rpcCalls.push({ fn, args });
        if (fn !== "claim_access_request_burst" || s.burstRpc === "missing") {
          return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
        }
        if (s.burstRpc === "error") return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
        return claimBurst(args);
      },
      from: (t: string) => {
        const b = base.from(t) as unknown as Record<string, unknown>;
        if (t === "access_requests" && s.countFails) return failingCount(b);
        if (t === "notifications" && s.openReadFails) return failingSelect(b);
        return b;
      },
      auth: {
        getUser: async () => (s.caller ? { data: { user: s.caller }, error: null } : { data: { user: null }, error: { message: "bad" } }),
        admin: { createUser: async () => ({ data: null, error: { message: "exists" } }), listUsers: async () => ({ data: { users: [] }, error: null }), deleteUser: async () => ({}) },
      },
    };
  },
}));
// The two delivery helpers, captured; the role pool is resolved for real.
vi.mock("@/lib/inAppNotifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyMany: vi.fn(async (p: Record<string, unknown>) => {
    if (s.notifyThrows) throw new Error("bell down");
    s.bells.push(p);
  }),
}));
vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queueEmail: vi.fn(async (p: Record<string, unknown>) => { s.emails.push(p); }),
}));
vi.mock("@/lib/serverAuth", () => ({ assertOrgHasAccess: async () => null }));

import { POST as requestAccess } from "@/app/api/auth/request-access/route";
import { POST as decide } from "@/app/api/admin/access-requests/route";
import { POST as createUser } from "@/app/api/admin/create-user/route";
import { REQUEST_ACCESS_ACKNOWLEDGEMENT } from "@/lib/publicDoorLimiter";
import {
  renderAccessRequestOutcome, ACCESS_REQUEST_AUDIENCE, ACCESS_REQUEST_NOTICES_PER_ORG_HOUR, ADDRESS_MAX,
  noticeSafeName, wellFormedAddress,
} from "@/lib/accessRequestOutcome";

const ORG = "org1";
const member = (uid: string, roles: string[], status = "active") => ({ id: `m-${uid}`, org_id: ORG, uid, role: roles[0], roles, status, email: `${uid}@acme.test` });

beforeEach(() => {
  s.db = newFakeDb();
  s.caller = { id: "admin1", email: "admin1@acme.test" };
  s.bells = [];
  s.emails = [];
  s.notifyThrows = false;
  s.countFails = false;
  s.openReadFails = false;
  s.burstRpc = "missing";
  s.rpcCalls = [];
  s.burstLock = Promise.resolve();
  s.db.tables.orgs = [{ id: ORG, name: "Acme Refining" }];
  s.db.tables.org_members = [
    member("admin1", ["Admin"]),
    member("dc1", ["DocCtrl"]),
    member("mgr-dc", ["Manager", "DocCtrl"]),     // the DocCtrl hat held additively
    member("mgr-adm", ["Manager", "Admin"]),      // the Admin hat held additively (PROD-15: told)
    member("eng", ["Engineer"]),
    member("old-admin", ["Admin"], "suspended"),
  ];
  s.db.tables.access_requests = [];
  s.db.tables.signup_attempts = [];
});

const post = (url: string, body: Record<string, unknown>, auth = true) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer t" } : {}) }, body: JSON.stringify(body) });
const ask = (body: Record<string, unknown> = { displayName: "Greg", email: "Greg@Corp.com", orgName: "acme refining" }) =>
  requestAccess(post("https://app/api/auth/request-access", body, false));
/** The same door from a given client address (a script rotating addresses). */
const askFrom = (ip: string, body: Record<string, unknown>) =>
  requestAccess(new NextRequest("https://app/api/auth/request-access", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body),
  }));
const ACK = { ok: true, message: REQUEST_ACCESS_ACKNOWLEDGEMENT };

describe("PROD-2 dw1 — the request door tells the Admins (PROD-15: the people who can see the pending list)", () => {
  it("the audience is the Admins — the pending list's own set (PROD-15)", () => {
    expect([...ACCESS_REQUEST_AUDIENCE]).toEqual(["Admin"]);
  });

  it("after the row is written: one bell row per ACTIVE Admin (additive roles), linking to Admin → Users, no actor; one email each — a DocCtrl-only member is no longer told", async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ACK);                                       // ORG-8: the neutral answer
    expect(s.db.tables.access_requests).toHaveLength(1);
    const req = s.db.tables.access_requests[0];
    expect(req).toMatchObject({ org_id: ORG, email: "greg@corp.com", status: "pending" });
    expect(s.bells).toHaveLength(1);
    const bell = s.bells[0];
    expect(bell).toMatchObject({
      orgId: ORG, kind: "access_request_pending", link: "/admin/users", resourceType: "access_request", resourceId: req.id,
      title: "Greg asked to join Acme Refining",
    });
    expect(bell).not.toHaveProperty("actorUserId");                                // the person at the door has no account
    expect((bell.userIds as string[]).sort()).toEqual(["admin1", "mgr-adm"]); // not the Engineer, not the suspended Admin, not a DocCtrl (PROD-15)
    expect(s.emails.map((e) => e.toEmail).sort()).toEqual(["admin1@acme.test", "mgr-adm@acme.test"]);
    for (const e of s.emails) {
      expect(e).toMatchObject({ orgId: ORG, subject: "Access request waiting for review", eventType: "assignment" });
      expect(String(e.bodyText)).toContain("Greg (greg@corp.com) asked for access to Acme Refining");
    }
  });

  it("a long display name typed at the public door is bounded before it reaches a bell", async () => {
    await ask({ displayName: "x".repeat(500), email: "a@b.co", orgName: "Acme Refining" });
    expect(String(s.bells[0].title)).toBe(`${"x".repeat(80)} asked to join Acme Refining`);
  });

  it("REGRESSION: no org, a pending duplicate (both now the neutral 200 — ORG-8), the rate limit (429) and missing fields (400) notify nobody", async () => {
    const none = await ask({ displayName: "G", email: "g@c.co", orgName: "Nope" });
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual(ACK);
    s.db.tables.access_requests = [{ id: "r0", org_id: ORG, email: "g@c.co", status: "pending" }];
    const dup = await ask({ displayName: "G", email: "g@c.co", orgName: "Acme Refining" });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual(ACK);
    expect(s.db.tables.access_requests).toHaveLength(1);                          // nothing stacked
    expect((await ask({ displayName: "", email: "g@c.co", orgName: "Acme Refining" })).status).toBe(400);
    s.db.tables.signup_attempts = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, ip: "9.9.9.9", created_at: new Date().toISOString() }));
    const limited = await requestAccess(new NextRequest("https://app/api/auth/request-access", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: JSON.stringify({ displayName: "G", email: "z@c.co", orgName: "Acme Refining" }),
    }));
    expect(limited.status).toBe(429);
    expect(s.bells).toEqual([]);
    expect(s.emails).toEqual([]);
  });

  it("a notice that cannot be sent never changes the response: the request is recorded and answered ok", async () => {
    s.notifyThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await ask();
      expect(res.status).toBe(200);
      expect(s.db.tables.access_requests).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/recorded but its notice was not sent/), "bell down");
    } finally { warn.mockRestore(); }
  });
});

describe("PROD-2 — what a stranger types at the public door never reaches a notice as typed (N8's review fix)", () => {
  const PHISH_NAME = "IT Security\nACTION REQUIRED: re-verify at https://acme-sso.evil.example/login";
  const PHISH_EMAIL = "x@y.z  ACTION REQUIRED: your Acme workspace password expires today, re-verify at https://acme-sso.evil.example/login";
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it("the reviewer's case — a phishing line, a newline and a link in the name and the address: the request is recorded and answered as before; the bell carries no line break and no link; the address shows as invalid; no email at all", async () => {
    const res = await ask({ displayName: PHISH_NAME, email: PHISH_EMAIL, orgName: "Acme Refining" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ACK);                                       // ORG-8's neutral answer, as for every request
    expect(s.db.tables.access_requests).toHaveLength(1);                          // recorded, as before
    expect(s.bells).toHaveLength(1);
    const { title, body } = s.bells[0] as { title: string; body: string };
    for (const t of [title, body]) {
      expect(t).not.toMatch(/[\r\n]/);
      expect(t).not.toMatch(/https?:|evil\.example|acme-sso|password expires/i);
    }
    expect(title).toBe("IT Security ACTION REQUIRED: re-verify at [link removed] asked to join Acme Refining");
    expect(body).toContain("IT Security ACTION REQUIRED: re-verify at [link removed] (invalid address) asked for access to Acme Refining.");
    expect(s.emails).toEqual([]);                                                 // no mail from the app's sender
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not a single well-formed address — the pool was told by bell only/));
  });

  it("an address carrying a scheme and a path, or 5 KB long, gets no email leg and never appears in the bell", async () => {
    for (const email of ["https://acme-sso.evil.example/login@y.z", `${"a".repeat(5000)}@b.co`]) {
      s.db.tables.access_requests = [];
      s.bells = [];
      expect((await ask({ displayName: "Greg", email, orgName: "Acme Refining" })).status).toBe(200);
      const body = String(s.bells[0].body);
      expect(body).toContain("Greg (invalid address) asked for access to Acme Refining.");
      expect(body.length).toBeLessThan(300);
      expect(body).not.toMatch(/evil\.example|a{100}/);
    }
    expect(s.emails).toEqual([]);
  });

  it("control, zero-width and bidi characters in the name are dropped or spaced; a well-formed address still gets its email", async () => {
    await ask({ displayName: "Gr\u200beg\u202e \u0007Smith\r\n", email: "greg@corp.com", orgName: "Acme Refining" });
    expect(s.bells[0].title).toBe("Greg Smith asked to join Acme Refining");
    expect(s.emails).toHaveLength(2);
  });

  /** The pool's "more access requests are waiting" rows (keyed on the org). */
  const burstRows = () => (s.db.tables.notifications ?? []).filter((n) => n.kind === "access_request_pending" && n.resource_type === "org");

  it("a burst (the reviewer's case: a script, a new address and a new client IP each time): only the first ACCESS_REQUEST_NOTICES_PER_ORG_HOUR requests reach the bell and the mail; after that each pool member holds ONE unread 'more are waiting' row, however many more arrive", async () => {
    const burst = ACCESS_REQUEST_NOTICES_PER_ORG_HOUR + 3;          // 8 requests
    for (let i = 0; i < burst; i++) {
      // a new client IP each time: the per-IP window never fills — the org cap is what holds
      // (a header-less caller no longer escapes the window: it shares the one "unknown" budget, BILL-14)
      expect((await askFrom(`10.0.0.${i}`, { displayName: `Person ${i}`, email: `p${i}@corp.com`, orgName: "Acme Refining" })).status).toBe(200);
    }
    expect(s.db.tables.access_requests).toHaveLength(burst);                    // REGRESSION: every request recorded, answered ok
    expect(s.bells).toHaveLength(ACCESS_REQUEST_NOTICES_PER_ORG_HOUR);           // a row per request for the first 5 only
    expect(s.bells.map((b) => b.title)).toEqual(Array.from({ length: ACCESS_REQUEST_NOTICES_PER_ORG_HOUR }, (_, i) => `Person ${i} asked to join Acme Refining`));
    expect(s.emails).toHaveLength(ACCESS_REQUEST_NOTICES_PER_ORG_HOUR * 2);      // 2 pool members (the Admins) per request
    const burstNow = burstRows();
    expect(burstNow.map((n) => n.user_id).sort()).toEqual(["admin1", "mgr-adm"]);   // ONE each, not three each
    expect(burstNow[0]).toMatchObject({
      org_id: ORG, resource_id: ORG, link: "/admin/users", actor_user_id: null,
      title: "More access requests are waiting for Acme Refining", metadata: { accessRequestBurst: true },
    });
    expect(String(burstNow[0].body)).toContain("Every request is listed under Admin → Users");
    expect(String(burstNow[0].body)).not.toMatch(/Person \d|@corp\.com/);      // nothing a stranger typed
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/requests to this org in the last hour — this request gets no notice of its own; 2 pool member\(s\) newly told/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/0 pool member\(s\) newly told that more are waiting, 2 already were/));
    // a member who READ theirs is told again by the next request — only they
    burstNow.find((n) => n.user_id === "mgr-adm")!.read_at = "2026-10-07T10:00:00Z";
    expect((await askFrom("10.0.0.99", { displayName: "Person 99", email: "p99@corp.com", orgName: "Acme Refining" })).status).toBe(200);
    expect(burstRows().filter((n) => n.read_at == null).map((n) => n.user_id).sort()).toEqual(["admin1", "mgr-adm"]);
    expect(burstRows()).toHaveLength(3);                                         // the two Admins' first rows + the re-told one
    expect(s.bells).toHaveLength(ACCESS_REQUEST_NOTICES_PER_ORG_HOUR);
    expect(s.emails).toHaveLength(ACCESS_REQUEST_NOTICES_PER_ORG_HOUR * 2);
  });

  it("the cap fails closed: when the org's request count cannot be read, the request gets no bell row or email of its own — the pool gets the one 'more are waiting' row each", async () => {
    s.countFails = true;
    expect((await ask()).status).toBe(200);
    expect((await ask({ displayName: "Ann", email: "ann@corp.com", orgName: "Acme Refining" })).status).toBe(200);
    expect(s.bells).toEqual([]);
    expect(s.emails).toEqual([]);
    expect(burstRows().map((n) => n.user_id).sort()).toEqual(["admin1", "mgr-adm"]);   // at most one each
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/count could not be read — this request gets no notice of its own/));
  });

  it("a count that could not be read is never stated as a number: the burst row says requests are waiting, not 'more than 5 within an hour' (N8's final review fix)", async () => {
    s.countFails = true;
    expect((await ask()).status).toBe(200);                                     // this may be the org's only request today
    const rows = burstRows();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.title).toBe("Access requests are waiting for Acme Refining");
      expect(r.body).toBe("Access requests are waiting for Acme Refining. Every request is listed under Admin → Users: review them there.");
      expect(String(r.body)).not.toMatch(/\d|More than|within an hour/);
    }
    // REGRESSION: a count that WAS read and is over the cap keeps the cap in its words
    s.countFails = false;
    s.db.tables.notifications = [];
    for (let i = 0; i <= ACCESS_REQUEST_NOTICES_PER_ORG_HOUR; i++) await ask({ displayName: `P${i}`, email: `p${i}@corp.com`, orgName: "Acme Refining" });
    const over = burstRows();
    expect(over).toHaveLength(2);
    expect(over[0].title).toBe("More access requests are waiting for Acme Refining");
    expect(over[0].body).toBe(`More than ${ACCESS_REQUEST_NOTICES_PER_ORG_HOUR} people asked to join Acme Refining within an hour, so they are no longer announced one by one. Every request is listed under Admin → Users: review them there.`);
  });

  it("a member's browser cannot silence the burst notice with a decoy: the open-row check matches only the server's own rows (no actor — 20261160 stamps every signed-in writer)", async () => {
    s.db.tables.notifications = [{
      id: "forged", org_id: ORG, user_id: "mgr-adm", kind: "access_request_pending", resource_type: "org", resource_id: ORG,
      read_at: null, actor_user_id: "eng", title: "nothing to see",
    }];
    s.countFails = true;
    expect((await ask()).status).toBe(200);
    expect(burstRows().filter((n) => n.actor_user_id == null).map((n) => n.user_id).sort()).toEqual(["admin1", "mgr-adm"]);
    const read = s.db.calls.filter((c) => c.table === "notifications" && c.method === "is").map((c) => c.args);
    expect(read).toContainEqual(["actor_user_id", null]);
  });

  it("past the cap, when the pool's open rows cannot be read either, nothing is written — never a row per request", async () => {
    s.countFails = true;
    s.openReadFails = true;
    expect((await ask()).status).toBe(200);
    expect(s.db.tables.access_requests).toHaveLength(1);
    expect(s.bells).toEqual([]);
    expect(s.emails).toEqual([]);
    expect(s.db.tables.notifications ?? []).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/open notices could not be read \(open read failed\) — no notice was written for this request/));
  });

  // ── PROD-16 (notifications N14): the burst slot claimed atomically ──────
  it("PROD-16 — after 20261197: the route claims the burst slot through ONE call (the org, the pool, the notice's words) and writes no notifications row itself; the rows are the ones today's path writes", async () => {
    s.burstRpc = "live";
    s.countFails = true;
    expect((await ask()).status).toBe(200);
    expect(s.rpcCalls).toEqual([{ fn: "claim_access_request_burst", args: {
      p_org: ORG, p_recipients: expect.arrayContaining(["admin1", "mgr-adm"]),
      p_title: "Access requests are waiting for Acme Refining",
      p_body: "Access requests are waiting for Acme Refining. Every request is listed under Admin → Users: review them there.",
    } }]);
    expect((s.rpcCalls[0].args.p_recipients as string[]).sort()).toEqual(["admin1", "mgr-adm"]);
    // the app neither reads the open rows nor inserts: the function does both under its lock
    expect(s.db.calls.filter((c) => c.table === "notifications")).toEqual([]);
    const claimed = burstRows();
    expect(claimed.map((n) => n.user_id).sort()).toEqual(["admin1", "mgr-adm"]);
    expect(claimed[0]).toMatchObject({ org_id: ORG, resource_id: ORG, link: "/admin/users", actor_user_id: null, metadata: { accessRequestBurst: true } });
    expect(s.bells).toEqual([]);
    expect(s.emails).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/count could not be read — this request gets no notice of its own; 2 pool member\(s\) newly told that more are waiting, 0 already were$/));
  });

  it("PROD-16 — two over-cap requests that land at once give each pool member ONE unread burst row (the claim is serialised per org); before the paste the same pair runs today's unserialised two steps, said in the log", async () => {
    s.burstRpc = "live";
    s.countFails = true;
    const both = await Promise.all([
      ask({ displayName: "Ann", email: "ann@corp.com", orgName: "Acme Refining" }),
      ask({ displayName: "Bob", email: "bob@corp.com", orgName: "Acme Refining" }),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(burstRows().map((n) => n.user_id).sort()).toEqual(["admin1", "mgr-adm"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/0 pool member\(s\) newly told that more are waiting, 2 already were$/));
    // before 20261197 (PGRST202): today's path, and the log says it is unserialised
    s.burstRpc = "missing";
    s.db.tables.notifications = [];
    expect((await ask({ displayName: "Cy", email: "cy@corp.com", orgName: "Acme Refining" })).status).toBe(200);
    expect(burstRows().map((n) => n.user_id).sort()).toEqual(["admin1", "mgr-adm"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/2 pool member\(s\) newly told that more are waiting, 0 already were \(unserialised: 20261197 is not pasted — PROD-16\)$/));
  });

  it("PROD-16 — a claim that fails for any other reason writes nothing (as an unreadable open-row read does) and never changes the answer", async () => {
    s.burstRpc = "error";
    s.countFails = true;
    expect((await ask()).status).toBe(200);
    expect(s.db.tables.access_requests).toHaveLength(1);
    expect(s.db.tables.notifications ?? []).toEqual([]);
    expect(s.db.calls.filter((c) => c.table === "notifications")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be claimed \(canceling statement due to statement timeout\) — no notice was written for this request$/));
  });

  it("wellFormedAddress: one address, at most 254 characters, no control or invisible character, no scheme or path", () => {
    expect(wellFormedAddress("  greg@corp.com ")).toBe("greg@corp.com");
    expect(wellFormedAddress("o'brien+tag@sub.corp.co.uk")).toBe("o'brien+tag@sub.corp.co.uk");
    for (const bad of [
      "", null, undefined, "greg", "greg@corp", "a b@c.d", "a@b.c d", "a@b.c\nBcc: x@y.z", "a\u200b@b.co",
      "https://evil.example/x@y.z", "mailto:a@b.co", "a/b@c.co", `${"a".repeat(ADDRESS_MAX)}@b.co`,
    ]) expect(wellFormedAddress(bad as string), String(bad)).toBeNull();
  });

  it("noticeSafeName: links of every spelling become [link removed]; an ordinary name is untouched; the bound holds", () => {
    expect(noticeSafeName("Greg O'Brien-Smith")).toBe("Greg O'Brien-Smith");
    expect(noticeSafeName("Ann www.evil.example")).toBe("Ann [link removed]");
    expect(noticeSafeName("Ann evil.example/login")).toBe("Ann [link removed]");
    expect(noticeSafeName("Ann HTTP://EVIL.EXAMPLE")).toBe("Ann [link removed]");
    expect(noticeSafeName("Ann javascript:alert(1)")).toBe("Ann [link removed]");
    expect(noticeSafeName("line1\nline2\tline3")).toBe("line1 line2 line3");
    expect(noticeSafeName("x".repeat(500))).toHaveLength(80);
    expect(noticeSafeName("\u200b\n ")).toBe("");
  });
});

describe("PROD-2 dw2 — the decision reaches the address the person gave", () => {
  beforeEach(() => {
    s.db.tables.access_requests = [{ id: "req1", org_id: ORG, org_name: "Acme Refining", display_name: "Greg", email: "greg@corp.com", status: "pending" }];
    s.db.tables.email_notifications = [];
  });
  const decline = (id = "req1") => decide(post("https://app/api/admin/access-requests", { id, action: "decline" }));

  it("a decline queues ONE external email to the request's address, server-side, rendered from the stored row", async () => {
    const res = await decline();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });                                 // REGRESSION
    expect(s.db.tables.access_requests[0].status).toBe("declined");
    expect(s.db.tables.email_notifications).toHaveLength(1);
    expect(s.db.tables.email_notifications[0]).toMatchObject({
      org_id: ORG, to_user_id: "admin1", to_email: "greg@corp.com", status: "queued", event_type: "access_request_declined",
      subject: "Your request to join Acme Refining", resource_id: "req1",
      metadata: { accessRequestIds: ["req1"], sentVia: "server", external: true },
    });
  });

  it("declining a row already decided announces nothing again; a refused caller declines nothing and emails nobody", async () => {
    await decline();
    await decline();
    expect(s.db.tables.email_notifications).toHaveLength(1);
    s.db.tables.access_requests = [{ id: "req2", org_id: ORG, org_name: "Acme Refining", email: "x@corp.com", status: "pending" }];
    s.caller = { id: "eng", email: "eng@acme.test" };
    expect((await decline("req2")).status).toBe(403);
    expect(s.db.tables.email_notifications).toHaveLength(1);
  });

  it("an approval — the membership that answered a pending request — emails the person, now a member, at that address", async () => {
    s.db.tables.users = [{ id: "u-greg", email: "greg@corp.com" }];
    const res = await createUser(post("https://app/api/admin/create-user", { email: "Greg@Corp.com", password: "x", orgId: ORG, role: "Viewer" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: "u-greg" });                            // REGRESSION: the grant
    expect(s.db.tables.access_requests[0].status).toBe("approved");
    expect(s.db.tables.email_notifications).toHaveLength(1);
    const row = s.db.tables.email_notifications[0];
    expect(row).toMatchObject({ to_user_id: "u-greg", to_email: "greg@corp.com", event_type: "access_request_approved", subject: "Your request to join Acme Refining was approved" });
    expect(row.metadata).toEqual({ accessRequestIds: ["req1"], sentVia: "server" });   // the member's own address: not external
  });

  it("an 'Add member' that answered no pending request emails nobody", async () => {
    s.db.tables.access_requests = [];
    s.db.tables.users = [{ id: "u-ann", email: "ann@corp.com" }];
    expect((await createUser(post("https://app/api/admin/create-user", { email: "ann@corp.com", password: "x", orgId: ORG, role: "Viewer" }))).status).toBe(200);
    expect(s.db.tables.email_notifications ?? []).toEqual([]);
  });

  // N8's review fix: a decided request's pool notices stop waiting on anyone.
  const poolNotice = (id: string, user: string, over: Record<string, unknown> = {}) => ({
    id, org_id: ORG, user_id: user, kind: "access_request_pending", resource_type: "access_request", resource_id: "req1",
    read_at: null, metadata: { accessRequestId: "req1" }, ...over,
  });
  const seedPool = () => {
    s.db.tables.notifications = [
      poolNotice("n-admin", "admin1"), poolNotice("n-dc", "dc1"), poolNotice("n-mgr", "mgr-dc"),
      poolNotice("n-other-req", "dc1", { resource_id: "req9", metadata: { accessRequestId: "req9" } }),   // another request: stays
      poolNotice("n-other-kind", "dc1", { kind: "member_revoked" }),                                     // another kind: stays
      poolNotice("n-other-org", "dc1", { org_id: "org2" }),                                              // another org: stays
      poolNotice("n-read", "admin1", { read_at: "2026-10-01T00:00:00Z" }),                               // already read: untouched
    ];
  };
  const unread = () => (s.db.tables.notifications ?? []).filter((n) => n.read_at == null).map((n) => n.id).sort();

  it("a decline marks read every pool member's access_request_pending row about THAT request — nothing else", async () => {
    seedPool();
    expect((await decline()).status).toBe(200);
    expect(unread()).toEqual(["n-other-kind", "n-other-org", "n-other-req"]);
    expect(s.db.tables.notifications.find((n) => n.id === "n-read")!.read_at).toBe("2026-10-01T00:00:00Z");
  });

  it("an approval (the membership that answered the request) clears them the same way; an 'Add member' that answered no request clears nothing", async () => {
    seedPool();
    s.db.tables.users = [{ id: "u-greg", email: "greg@corp.com" }];
    expect((await createUser(post("https://app/api/admin/create-user", { email: "greg@corp.com", password: "x", orgId: ORG, role: "Viewer" }))).status).toBe(200);
    expect(unread()).toEqual(["n-other-kind", "n-other-org", "n-other-req"]);
    seedPool();
    s.db.tables.users = [{ id: "u-ann", email: "ann@corp.com" }];
    expect((await createUser(post("https://app/api/admin/create-user", { email: "ann@corp.com", password: "x", orgId: ORG, role: "Viewer" }))).status).toBe(200);
    expect(unread()).toEqual(["n-admin", "n-dc", "n-mgr", "n-other-kind", "n-other-org", "n-other-req"]);
  });

  it("a refused caller clears nothing; a clearing that fails never changes the decline's answer", async () => {
    seedPool();
    s.caller = { id: "eng", email: "eng@acme.test" };
    expect((await decline()).status).toBe(403);
    expect(unread()).toHaveLength(6);
    s.caller = { id: "admin1", email: "admin1@acme.test" };
    s.db.beforeUpdate = { notifications: () => { throw Object.assign(new Error("only read_at may change"), { code: "42501" }); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await decline();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(s.db.tables.access_requests[0].status).toBe("declined");
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the pool's notices were not cleared/));
    } finally { warn.mockRestore(); }
  });

  it("the message: the org's name, no link without a configured public origin, the sign-in page with one", () => {
    expect(renderAccessRequestOutcome({ outcome: "approved", orgName: "Acme" }, "").text).toBe("Your request to join Acme was approved — you now have access. Sign in to the app to get started.");
    expect(renderAccessRequestOutcome({ outcome: "approved", orgName: "Acme" }, "https://dc.acme.test").text).toContain("Sign in at https://dc.acme.test/login.");
    expect(renderAccessRequestOutcome({ outcome: "declined", orgName: null }).subject).toBe("Your request to join the workspace");
  });
});
