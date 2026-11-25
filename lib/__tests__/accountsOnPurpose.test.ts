import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// A small stand-in database: tables of rows and the filters the code uses.
const db: Record<string, Array<Record<string, unknown>>> = {};
const deleted: string[] = [];
let failReads = false;
const authUsers: Array<{ id: string; email: string; app_metadata?: Record<string, unknown> }> = [];
const tokens: Record<string, string> = { admin: "u-admin", gone: "u-gone", member: "u-member", stranger: "u-stranger" };

function query(table: string) {
  let rows = [...(db[table] ?? [])];
  let op: "select" | "delete" | "update" | "insert" = "select";
  let patch: Record<string, unknown> = {};
  const q: Record<string, unknown> = {};
  const done = () => {
    if (failReads && op === "select") return { data: null, error: { message: "network down" } };
    if (op === "delete") { db[table] = (db[table] ?? []).filter((r) => !rows.includes(r)); return { data: rows, error: null }; }
    if (op === "update") { rows.forEach((r) => Object.assign(r, patch)); return { data: rows, error: null }; }
    return { data: rows, error: null };
  };
  Object.assign(q, {
    select: () => q,
    eq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] === v); return q; },
    in: (k: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[k])); return q; },
    ilike: (k: string, v: string) => { rows = rows.filter((r) => String(r[k] ?? "").toLowerCase() === v.toLowerCase()); return q; },
    limit: () => q,
    order: () => q,
    delete: () => { op = "delete"; return q; },
    update: (p: Record<string, unknown>) => { op = "update"; patch = p; return q; },
    insert: (row: Record<string, unknown>) => { (db[table] ??= []).push(row); op = "insert"; return q; },
    maybeSingle: () => Promise.resolve((() => { const r = done(); return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error }; })()),
    single: () => Promise.resolve((() => { const r = done(); return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error }; })()),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(done()).then(ok, bad),
  });
  return q;
}

vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (t: string) => query(t),
    auth: {
      getUser: async (tok: string) => {
        // The auth server itself can't answer (a database freeze).
        if (tok === "busy") return { data: { user: null }, error: { message: "upstream request timeout", status: 504 } };
        const id = tokens[tok];
        const u = authUsers.find((x) => x.id === id);
        return u ? { data: { user: { ...u, app_metadata: u.app_metadata ?? {} } }, error: null } : { data: { user: null }, error: { message: "bad token", status: 403 } };
      },
      admin: {
        deleteUser: async (id: string) => { deleted.push(id); const i = authUsers.findIndex((u) => u.id === id); if (i >= 0) authUsers.splice(i, 1); return { error: null }; },
        listUsers: async () => ({ data: { users: authUsers }, error: null }),
        updateUserById: async () => ({ error: null }),
      },
    },
  },
}));
vi.mock("@/lib/signinPolicyServer", () => ({
  policiesForUser: async () => [], sanitizeExpiry: () => new Date(Date.now() + 3600e3).toISOString(), signInMethod: () => "password",
  suspendMemberships: async () => 0, tempMeta: () => ({}),
}));

const ORG = "215b762d-7be4-4cbd-bdb1-4b2703d81296";
const post = (url: string, token: string, body: unknown = {}) =>
  new NextRequest(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  failReads = false;
  deleted.length = 0;
  authUsers.splice(0, authUsers.length,
    { id: "u-admin", email: "admin@kern.test", app_metadata: { password_owned: true } },
    { id: "u-member", email: "member@kern.test", app_metadata: { password_owned: true } },
    { id: "u-stranger", email: "someone@gmail.test" },
    { id: "u-gone", email: "gone@kern.test", app_metadata: { password_owned: true } },
  );
  db.org_members = [
    { id: "m1", org_id: ORG, uid: "u-admin", email: "admin@kern.test", role: "Admin", roles: ["Admin"], status: "active" },
    { id: "m2", org_id: ORG, uid: "u-member", email: "member@kern.test", role: "Engineer-1", roles: ["Engineer-1"], status: "active" },
    { id: "m3", org_id: ORG, uid: "u-gone", email: "gone@kern.test", role: "Viewer", roles: ["Viewer"], status: "active" },
  ];
  db.orgs = [{ id: ORG, name: "Kern", created_by: "u-admin" }];
  db.users = [{ id: "u-admin", email: "admin@kern.test" }, { id: "u-member", email: "member@kern.test" }, { id: "u-stranger", email: "someone@gmail.test" }];
  db.audit_logs = [];
});

describe("an account nobody added", () => {
  it("is refused at sign-in and deleted, with its profile", async () => {
    const { POST } = await import("@/app/api/auth/after-signin/route");
    const res = await POST(post("http://x/api/auth/after-signin", "stranger"));
    expect((await res.json()).action).toBe("not_added");
    expect(deleted).toEqual(["u-stranger"]);
    expect(db.users.some((u) => u.id === "u-stranger")).toBe(false);
  });

  it("is never deleted when the membership read fails: the check fails instead", async () => {
    const { POST } = await import("@/app/api/auth/after-signin/route");
    failReads = true;
    const res = await POST(post("http://x/api/auth/after-signin", "stranger"));
    expect(res.status).toBe(503);
    expect(deleted).toEqual([]);
  });

  it("a member signs in as before", async () => {
    const { POST } = await import("@/app/api/auth/after-signin/route");
    const res = await POST(post("http://x/api/auth/after-signin", "member"));
    expect((await res.json()).action).toBe("ok");
    expect(deleted).toEqual([]);
  });

  it("the first admin of a workspace just paid for is not deleted (it made the workspace)", async () => {
    const { isStray } = await import("@/lib/accountsServer");
    db.org_members = db.org_members.filter((m) => m.uid !== "u-admin");
    expect(await isStray("u-admin")).toBe(false);
    expect(await isStray("u-stranger")).toBe(true);
  });
});

describe("where the app opens", () => {
  it("answers from the server: active workspaces only, this device's last one first", async () => {
    const { pickMembership } = await import("@/lib/membershipClient");
    const m = (orgId: string, status: string) => ({ id: orgId, orgId, orgName: null, role: "Admin", roles: ["Admin"], status, email: null });
    expect(pickMembership({ memberships: [m("a", "active"), m("b", "active")], defaultOrgId: "a" }, "b")?.orgId).toBe("b");
    expect(pickMembership({ memberships: [m("a", "suspended"), m("b", "active")], defaultOrgId: "a" }, "a")?.orgId).toBe("b");
    expect(pickMembership({ memberships: [m("a", "suspended")], defaultOrgId: "a" }, "a")).toBeNull();
  });

  it("a failed read is a 503, never an empty list", async () => {
    const { GET } = await import("@/app/api/auth/membership/route");
    failReads = true;
    const res = await GET(new NextRequest("http://x/api/auth/membership", { headers: { authorization: "Bearer member" } }));
    expect(res.status).toBe(503);
  });

  it("a bad sign-in is a 401 (sign in again), not 'no workspace'", async () => {
    const { GET } = await import("@/app/api/auth/membership/route");
    const res = await GET(new NextRequest("http://x/api/auth/membership", { headers: { authorization: "Bearer nope" } }));
    expect(res.status).toBe(401);
  });

  it("a sign-in the auth server couldn't check is a 503 (try again), never 401", async () => {
    const { GET } = await import("@/app/api/auth/membership/route");
    const res = await GET(new NextRequest("http://x/api/auth/membership", { headers: { authorization: "Bearer busy" } }));
    expect(res.status).toBe(503);
  });
});

describe("removing someone", () => {
  it("deletes their sign-in when it was their last workspace", async () => {
    const { POST } = await import("@/app/api/admin/remove-member/route");
    const res = await POST(post("http://x/api/admin/remove-member", "admin", { orgId: ORG, memberId: "m3" }));
    expect(await res.json()).toEqual({ removed: true, accountDeleted: true });
    expect(deleted).toEqual(["u-gone"]);
    expect(db.org_members.some((m) => m.id === "m3")).toBe(false);
  });

  it("keeps their sign-in when they're in another workspace", async () => {
    db.org_members.push({ id: "m9", org_id: "other-org", uid: "u-gone", email: "gone@kern.test", role: "Viewer", roles: ["Viewer"], status: "active" });
    const { POST } = await import("@/app/api/admin/remove-member/route");
    const res = await POST(post("http://x/api/admin/remove-member", "admin", { orgId: ORG, memberId: "m3" }));
    expect((await res.json()).accountDeleted).toBe(false);
    expect(deleted).toEqual([]);
  });

  it("only admins remove people, and nobody removes themselves", async () => {
    const { POST } = await import("@/app/api/admin/remove-member/route");
    expect((await POST(post("http://x/api/admin/remove-member", "member", { orgId: ORG, memberId: "m3" }))).status).toBe(403);
    expect((await POST(post("http://x/api/admin/remove-member", "admin", { orgId: ORG, memberId: "m1" }))).status).toBe(400);
    expect(deleted).toEqual([]);
  });
});

describe("one email, one person", () => {
  it("emails compare trimmed and lower case", async () => {
    const { normEmail, looksLikeEmail } = await import("@/lib/accountsServer");
    expect(normEmail("  Name@Kern.COM ")).toBe("name@kern.com");
    expect(looksLikeEmail("name@kern.com")).toBe(true);
    expect(looksLikeEmail("name@kern")).toBe(false);
  });

  it("finds the person by their sign-in email, whatever the case", async () => {
    const { accountByEmail, emailInUse } = await import("@/lib/accountsServer");
    expect((await accountByEmail("MEMBER@kern.test"))?.id).toBe("u-member");
    expect(await emailInUse(" Admin@Kern.test")).toBe(true);
    expect(await emailInUse("new@kern.test")).toBe(false);
  });
});
