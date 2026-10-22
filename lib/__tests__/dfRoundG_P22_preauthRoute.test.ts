// drafting-flow Round G, DF-P22 — /api/tickets/preauthorizations: a person
// records their OWN standing pre-authorization (an e-signature over exactly
// the statement the route composes), they or an Admin revoke it
// (immediately for every use not yet made; a sign-off already completed under
// it stands — merge-time fix pass), audit row first; before 20261264 the route
// answers 503 and writes nothing. A record whose grantor's membership lapsed
// after it was created is listed as not in force; a grantor who is not active
// gets a clear 403.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, { code?: string; message: string }>,
  users: {} as Record<string, string>,
}));
vi.mock("@/lib/supabaseAdmin", () => {
  const builder = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: unknown = null;
    const matched = () => (st.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const b: Record<string, unknown> = {
      select: () => b, order: () => b, limit: () => b,
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return b; },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return b; },
      gte: (k: string, v: string) => { filters.push((r) => String(r[k]) >= v); return b; },
      insert: (rows: unknown) => { op = "insert"; payload = rows; return b; },
      update: (p: unknown) => { op = "update"; payload = p; return b; },
      maybeSingle: async () => (st.errors[table] ? { data: null, error: st.errors[table] } : { data: matched()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        const err = st.errors[`${table}:${op}`] ?? (op === "select" ? st.errors[table] : undefined);
        if (err) return resolve({ data: null, error: err });
        if (op === "insert") {
          const rows = (Array.isArray(payload) ? payload : [payload]) as Row[];
          if (table === "ticket_preauthorizations" && rows.some((r) => (st.tables[table] ?? []).some((x) => x.id === r.id))) return resolve({ data: null, error: { code: "23505", message: "duplicate" } });
          st.tables[table] = [...(st.tables[table] ?? []), ...rows.map((r) => ({ created_at: "2026-10-22T12:00:00Z", revoked_at: null, ...r }))];
          return resolve({ data: null, error: null });
        }
        if (op === "update") { const mm = matched(); for (const r of mm) Object.assign(r, payload as Row); return resolve({ data: mm.map((r) => ({ id: r.id })), error: null }); }
        return resolve({ data: matched(), error: null });
      },
    };
    return b;
  };
  return {
    supabaseAdmin: {
      from: (t: string) => builder(t),
      auth: { getUser: async (token: string) => (st.users[token] ? { data: { user: { id: st.users[token] } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    },
  };
});
import { GET, POST, PATCH } from "@/app/api/tickets/preauthorizations/route";
import { preauthorizationStatement, PREAUTH_AUDIT, PREAUTH_REVOCATION_SCOPE } from "@/lib/ticketPreauthorization";

const ORG = "aaaaaaaa-0000-4000-8000-0000000000aa";
const LIB = "aaaaaaaa-0000-4000-8000-0000000000bb";
const ID = "bbbbbbbb-0000-4000-8000-0000000000aa";
const SIG = "cccccccc-0000-4000-8000-0000000000aa";
const QA = "dddddddd-0000-4000-8000-0000000000aa";
const ADMIN = "dddddddd-0000-4000-8000-0000000000bb";
const OTHER = "dddddddd-0000-4000-8000-0000000000cc";
const EXPIRES = new Date(Date.now() + 30 * 86_400_000).toISOString();
const statement = preauthorizationStatement({ libraryId: LIB, libraryName: "Piping", requestType: "ISO", workClass: null, expiresAt: EXPIRES });
const req = (method: string, body?: unknown, token = "t-qa", query = "") =>
  new NextRequest(`http://localhost/api/tickets/preauthorizations${query}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const body = (over: Row = {}) => ({ orgId: ORG, id: ID, libraryId: LIB, requestType: "ISO", expiresAt: EXPIRES, signatureId: SIG, ...over });

beforeEach(() => {
  st.users = { "t-qa": QA, "t-admin": ADMIN, "t-other": OTHER };
  st.errors = {};
  st.tables = {
    org_members: [
      { org_id: ORG, uid: QA, role: "Viewer", roles: ["Viewer"], display_name: "Quinn", email: "q@x.io", status: "active", created_at: "2026-01-01T00:00:00Z" },
      { org_id: ORG, uid: ADMIN, role: "Manager", roles: ["Manager", "Admin"], display_name: "Ada", email: "a@x.io", status: "active", created_at: "2026-01-01T00:00:00Z" },
      { org_id: ORG, uid: OTHER, role: "Viewer", roles: ["Viewer"], display_name: "Oz", email: "o@x.io", status: "active", created_at: "2026-01-01T00:00:00Z" },
    ],
    libraries: [{ id: LIB, name: "Piping", org_id: ORG }],
    e_signatures: [{ id: SIG, org_id: ORG, resource_type: "ticket_preauthorization", resource_id: ID, signer_user_id: QA, intent: "Acknowledged", statement, signed_at: new Date().toISOString() }],
    ticket_preauthorizations: [],
    audit_logs: [],
  };
});

describe("POST — record the caller's own", () => {
  it("records it: audit row first, then the row; the statement is the one signed", async () => {
    const res = await POST(req("POST", body()));
    expect(res.status).toBe(200);
    expect(st.tables.audit_logs.map((a) => a.action)).toEqual([PREAUTH_AUDIT.recorded]);
    expect(st.tables.ticket_preauthorizations).toHaveLength(1);
    expect(st.tables.ticket_preauthorizations[0]).toMatchObject({ id: ID, org_id: ORG, grantor_id: QA, grantor_name: "Quinn", library_id: LIB, request_type: "ISO", work_class: null, statement, signature_id: SIG, expires_at: EXPIRES });
  });
  it("refuses a signature over another statement, someone else's signature, another record's — nothing written", async () => {
    for (const sig of [{ statement: "something else" }, { signer_user_id: OTHER }, { resource_id: "bbbbbbbb-0000-4000-8000-0000000000ff" }, { intent: "Approved" }]) {
      st.tables.e_signatures = [{ ...st.tables.e_signatures[0], ...sig }];
      const res = await POST(req("POST", body()));
      expect(res.status, JSON.stringify(sig)).toBe(400);
    }
    expect(st.tables.ticket_preauthorizations).toEqual([]);
    expect(st.tables.audit_logs).toEqual([]);
  });
  it("refuses an unscoped draft, a missing or too-long expiry, a library of another workspace, a non-member", async () => {
    expect((await POST(req("POST", body({ libraryId: null, requestType: null })))).status).toBe(400);
    expect((await POST(req("POST", body({ expiresAt: "" })))).status).toBe(400);
    expect((await POST(req("POST", body({ expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })))).status).toBe(400);
    st.tables.libraries = [{ id: LIB, name: "Piping", org_id: "elsewhere" }];
    expect((await POST(req("POST", body())))).toHaveProperty("status", 400);
    st.users["t-stranger"] = "dddddddd-0000-4000-8000-0000000000ff";
    expect((await POST(req("POST", body(), "t-stranger"))).status).toBe(403);
    expect((await POST(req("POST", body(), "t-none"))).status).toBe(401);
    expect(st.tables.ticket_preauthorizations).toEqual([]);
  });
  it("before 20261264: 503 with the reason, nothing written", async () => {
    st.errors.ticket_preauthorizations = { code: "42P01", message: 'relation "public.ticket_preauthorizations" does not exist' };
    const res = await POST(req("POST", body()));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe("not_migrated");
    expect(st.tables.audit_logs).toEqual([]);
  });
});

describe("PATCH — revoke: the person, or an Admin; once; immediately for every use not yet made", () => {
  beforeEach(async () => { await POST(req("POST", body())); st.tables.audit_logs = []; });
  it("someone else (not an Admin) cannot revoke it", async () => {
    const res = await PATCH(req("PATCH", { orgId: ORG, id: ID, action: "revoke" }, "t-other"));
    expect(res.status).toBe(403);
    expect(st.tables.ticket_preauthorizations[0].revoked_at).toBeNull();
  });
  it("the person revokes it: audit row first, revoked_at / revoked_by set; again is a no-op", async () => {
    const res = await PATCH(req("PATCH", { orgId: ORG, id: ID, action: "revoke", reason: "changed roles" }));
    expect(res.status).toBe(200);
    expect(st.tables.audit_logs.map((a) => a.action)).toEqual([PREAUTH_AUDIT.revoked]);
    expect(st.tables.ticket_preauthorizations[0]).toMatchObject({ revoked_by: QA, revoke_reason: "changed roles" });
    expect(st.tables.ticket_preauthorizations[0].revoked_at).toEqual(expect.any(String));
    const again = await PATCH(req("PATCH", { orgId: ORG, id: ID, action: "revoke" }));
    expect(((await again.json()) as { alreadyRevoked?: boolean }).alreadyRevoked).toBe(true);
  });
  it("merge-time fix pass: the answer says what revoking means — immediately for every use not yet made; a completed sign-off stands", async () => {
    const res = await PATCH(req("PATCH", { orgId: ORG, id: ID, action: "revoke" }));
    expect(((await res.json()) as { message?: string }).message).toBe(PREAUTH_REVOCATION_SCOPE);
  });
  it("merge-time fix pass: a grantor who is not an active member gets a clear 403; an Admin still revokes their record", async () => {
    st.tables.org_members.find((x) => x.uid === QA)!.status = "suspended";
    const res = await PATCH(req("PATCH", { orgId: ORG, id: ID, action: "revoke" }));
    expect(res.status).toBe(403);
    const out = (await res.json()) as { error?: string; code?: string };
    expect(out.code).toBe("not_active_member");
    expect(out.error).toMatch(/not an active member of this workspace, so you cannot revoke/);
    expect(out.error).toMatch(/never used again, and an Admin can revoke it/);
    expect(st.tables.ticket_preauthorizations[0].revoked_at).toBeNull();
    const byAdmin = await PATCH(req("PATCH", { orgId: ORG, id: ID, action: "revoke" }, "t-admin"));
    expect(byAdmin.status).toBe(200);
    expect(st.tables.ticket_preauthorizations[0]).toMatchObject({ revoked_by: ADMIN });
  });
  it("an Admin (by the held collection, not the headline) revokes anyone's", async () => {
    const res = await PATCH(req("PATCH", { orgId: ORG, id: ID, action: "revoke" }, "t-admin"));
    expect(res.status).toBe(200);
    expect(st.tables.ticket_preauthorizations[0]).toMatchObject({ revoked_by: ADMIN });
    expect(st.tables.audit_logs[0]).toMatchObject({ details: { byGrantor: false } });
  });
});

describe("GET — the caller's own; an Admin sees the workspace's", () => {
  it("lists by role", async () => {
    await POST(req("POST", body()));
    const mine = (await (await GET(req("GET", undefined, "t-qa", `?orgId=${ORG}`))).json()) as { records: unknown[]; admin: boolean };
    expect(mine.records).toHaveLength(1);
    expect(mine.admin).toBe(false);
    const other = (await (await GET(req("GET", undefined, "t-other", `?orgId=${ORG}`))).json()) as { records: unknown[] };
    expect(other.records).toHaveLength(0);
    const adm = (await (await GET(req("GET", undefined, "t-admin", `?orgId=${ORG}`))).json()) as { records: unknown[]; admin: boolean };
    expect(adm.records).toHaveLength(1);
    expect(adm.admin).toBe(true);
  });
  it("merge-time fix pass: each record carries its grantor's membership — continuous; suspended and restored, or removed and re-added, after it was recorded: lapsed (shown as not in force)", async () => {
    await POST(req("POST", body()));
    type Listed = { records: Array<{ id: string; grantorMembership?: string }> };
    const list = async (token = "t-admin") => ((await (await GET(req("GET", undefined, token, `?orgId=${ORG}`))).json()) as Listed).records;
    expect((await list())[0].grantorMembership).toBe("continuous");
    // suspended now: lapsed (the Admin's list says so)
    st.tables.org_members.find((x) => x.uid === QA)!.status = "suspended";
    expect((await list())[0].grantorMembership).toBe("lapsed");
    // restored — still lapsed: revoke_member recorded the suspension and the restore after the record
    st.tables.org_members.find((x) => x.uid === QA)!.status = "active";
    st.tables.audit_logs.push(
      { action: "MEMBER_SUSPENDED", resource_type: "member", resource_id: QA, org_id: ORG, timestamp: "2026-10-23T00:00:00Z" },
      { action: "MEMBER_RESTORED", resource_type: "member", resource_id: QA, org_id: ORG, timestamp: "2026-10-24T00:00:00Z" },
    );
    expect((await list())[0].grantorMembership).toBe("lapsed");
    expect((await list("t-qa"))[0].grantorMembership).toBe("lapsed");
    // removed and re-added: a membership row newer than the record
    st.tables.audit_logs = [];
    st.tables.org_members.find((x) => x.uid === QA)!.created_at = "2026-10-25T00:00:00Z";
    expect((await list())[0].grantorMembership).toBe("lapsed");
    // the membership history cannot be read: never shown as in force — 503, said
    st.errors.audit_logs = { message: "timeout" };
    const res = await GET(req("GET", undefined, "t-admin", `?orgId=${ORG}`));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toMatch(/Couldn't check the grantors' memberships/);
  });
});
