// notifications Round G — N8 PRODUCERS-FREE, PROD-2: an access request is
// heard, and so is its answer.
//
//   dw1  POST /api/auth/request-access, after the row is written, tells the
//        org's Admin / DocCtrl pool (DEC-44 (N8) item 1): a bell row
//        (access_request_pending → Admin → Users) and an email each — through
//        the shared-client helpers bound to the service role
//        (runWithServerClient), the role pool resolved by the real
//        resolveRoleRecipients over the same fake;
//   dw2  the decision emails the address on the request: a decline from
//        /api/admin/access-requests (external mail, queued server-side from
//        the stored row), an approval from /api/admin/create-user when the
//        membership answered a pending request.
// REGRESSION FIRST: every response is the one the route gave before — the
// rate limit, the 404 / 409, the decline's authority, the member grant —
// and a notice that cannot be sent never changes a response.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { newFakeDb, makeFakeSupabase, type FakeDb } from "./helpers/fakeSupabase";

const s = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  caller: { id: "admin1", email: "admin1@acme.test" } as { id: string; email: string } | null,
  bells: [] as Array<Record<string, unknown>>,
  emails: [] as Array<Record<string, unknown>>,
  notifyThrows: false,
}));

vi.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    const base = makeFakeSupabase(s.db);
    return {
      ...base,
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
import { renderAccessRequestOutcome, ACCESS_REQUEST_AUDIENCE } from "@/lib/accessRequestOutcome";

const ORG = "org1";
const member = (uid: string, roles: string[], status = "active") => ({ id: `m-${uid}`, org_id: ORG, uid, role: roles[0], roles, status, email: `${uid}@acme.test` });

beforeEach(() => {
  s.db = newFakeDb();
  s.caller = { id: "admin1", email: "admin1@acme.test" };
  s.bells = [];
  s.emails = [];
  s.notifyThrows = false;
  s.db.tables.orgs = [{ id: ORG, name: "Acme Refining" }];
  s.db.tables.org_members = [
    member("admin1", ["Admin"]),
    member("dc1", ["DocCtrl"]),
    member("mgr-dc", ["Manager", "DocCtrl"]),     // the DocCtrl hat held additively
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

describe("PROD-2 dw1 — the request door tells the Admin / DocCtrl pool", () => {
  it("the audience is exactly the plan's default pool", () => {
    expect([...ACCESS_REQUEST_AUDIENCE]).toEqual(["Admin", "DocCtrl"]);
  });

  it("after the row is written: one bell row per ACTIVE Admin / DocCtrl (additive roles), linking to Admin → Users, no actor; one email each", async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, orgName: "Acme Refining" });     // REGRESSION: the response
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
    expect((bell.userIds as string[]).sort()).toEqual(["admin1", "dc1", "mgr-dc"]); // not the Engineer, not the suspended Admin
    expect(s.emails.map((e) => e.toEmail).sort()).toEqual(["admin1@acme.test", "dc1@acme.test", "mgr-dc@acme.test"]);
    for (const e of s.emails) {
      expect(e).toMatchObject({ orgId: ORG, subject: "Access request waiting for review", eventType: "assignment" });
      expect(String(e.bodyText)).toContain("Greg (greg@corp.com) asked for access to Acme Refining");
    }
  });

  it("a long display name typed at the public door is bounded before it reaches a bell", async () => {
    await ask({ displayName: "x".repeat(500), email: "a@b.co", orgName: "Acme Refining" });
    expect(String(s.bells[0].title)).toBe(`${"x".repeat(80)} asked to join Acme Refining`);
  });

  it("REGRESSION: no org (404), a pending duplicate (409), the rate limit (429) and missing fields (400) notify nobody", async () => {
    expect((await ask({ displayName: "G", email: "g@c.co", orgName: "Nope" })).status).toBe(404);
    s.db.tables.access_requests = [{ id: "r0", org_id: ORG, email: "g@c.co", status: "pending" }];
    expect((await ask({ displayName: "G", email: "g@c.co", orgName: "Acme Refining" })).status).toBe(409);
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

  it("the message: the org's name, no link without a configured public origin, the sign-in page with one", () => {
    expect(renderAccessRequestOutcome({ outcome: "approved", orgName: "Acme" }, "").text).toBe("Your request to join Acme was approved — you now have access. Sign in to the app to get started.");
    expect(renderAccessRequestOutcome({ outcome: "approved", orgName: "Acme" }, "https://dc.acme.test").text).toContain("Sign in at https://dc.acme.test/login.");
    expect(renderAccessRequestOutcome({ outcome: "declined", orgName: null }).subject).toBe("Your request to join the workspace");
  });
});
