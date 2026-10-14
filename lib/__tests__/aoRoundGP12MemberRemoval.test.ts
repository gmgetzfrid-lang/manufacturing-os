// admin-and-org ORG-7 (Round G, P12) — the member-removal remainders P8
// could not reach, under the integrator's DEC-90 rulings:
//   · done-when 2: the documents page's signed-in principal and the View-as
//     simulator pass what they know (isActiveMember) — the simulator the
//     SIMULATED member's real status, never a hard-coded true;
//   · done-when 3: a SUSPENDED member's personal grant is listed under their
//     name with a "suspended" mark — never a bare uid, never hidden — and
//     the attestation record keeps it beside the live population;
//   · done-when 4: the team rung's display-name read is scoped to the org,
//     so a supervisor who belongs to two workspaces is named, not replaced
//     by the team's name;
//   · the re-add residual: /api/admin/create-user clears a removed person's
//     stale inherited acl_index entries (prune_removed_member_acl_index)
//     BEFORE the membership is created again, within a time budget, and
//     never blocks the add.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
type Filter = { m: string; args: unknown[] };
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  readError: {} as Record<string, string>,
  writes: [] as Array<{ table: string; m: string; row: unknown }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown>; membersAtCall: number }>,
  rpcReply: null as null | ((args: Record<string, unknown>, n: number) => { data: unknown; error: unknown }),
  order: [] as string[],
}));

function fake() {
  function from(table: string) {
    const filters: Filter[] = [];
    let write: { m: string; row: unknown } | null = null;
    let range: [number, number] | null = null;
    let limit: number | null = null;
    const rows = () => {
      let out = [...(db.tables[table] ?? [])];
      for (const f of filters) {
        const [k, v] = f.args as [string, unknown];
        if (f.m === "eq") out = out.filter((r) => r[k] === v);
        if (f.m === "neq") out = out.filter((r) => r[k] !== v);
        if (f.m === "in") out = out.filter((r) => (v as unknown[]).includes(r[k]));
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      return out;
    };
    const run = (single: boolean) => {
      if (db.readError[table] && !write) return { data: null, error: { message: db.readError[table] } };
      if (write) {
        db.writes.push({ table, m: write.m, row: write.row });
        db.order.push(`${table}.${write.m}`);
        if (write.m === "insert") (db.tables[table] ??= []).push(...(Array.isArray(write.row) ? write.row as Row[] : [write.row as Row]));
        return { data: single ? null : [{ id: "x" }], error: null };
      }
      db.order.push(`${table}.select`);
      const r = rows();
      if (single) return r.length > 1 ? { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } } : { data: r[0] ?? null, error: null };
      return { data: r, error: null };
    };
    const c: Record<string, unknown> = {};
    const h: ProxyHandler<Record<string, unknown>> = {
      get(_t, p: string) {
        if (p === "then") return (res: (v: unknown) => void, rej?: (e: unknown) => void) => Promise.resolve().then(() => run(false)).then(res, rej);
        return (...args: unknown[]) => {
          if (p === "eq" || p === "neq" || p === "in") filters.push({ m: p, args });
          if (p === "insert" || p === "update" || p === "upsert" || p === "delete") write = { m: p, row: args[0] };
          if (p === "range") range = [args[0] as number, args[1] as number];
          if (p === "limit") limit = args[0] as number;
          if (p === "maybeSingle" || p === "single") return Promise.resolve(run(true));
          return new Proxy(c, h);
        };
      },
    };
    return new Proxy(c, h);
  }
  return { from };
}

vi.mock("@/lib/supabase", () => ({ supabase: fake() }));
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    ...fake(),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const membersAtCall = (db.tables.org_members ?? []).filter((m) => m.uid === args.p_uid).length;
      db.rpcCalls.push({ fn, args, membersAtCall });
      db.order.push(`rpc.${fn}`);
      return db.rpcReply ? db.rpcReply(args, db.rpcCalls.length) : { data: { pruned: 0, examined: 0, phase: null, after: null, limit: 2000, done: true }, error: null };
    },
    auth: {
      getUser: async () => ({ data: { user: { id: "a1", email: "admin@x.io" } }, error: null }),
      admin: { createUser: async () => ({ data: { user: null }, error: { message: "exists" } }), listUsers: async () => ({ data: { users: [] }, error: null }), deleteUser: async () => ({}) },
    },
  },
}));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/complianceNotify", () => ({ notifyCompliance: vi.fn(async () => true), loadScanRetryPlan: vi.fn(async () => ({ only: () => () => true })) }));
vi.mock("@/lib/serverAuth", () => ({ assertOrgHasAccess: async () => null }));
vi.mock("@/lib/accessRequestOutcome", () => ({ clearAccessRequestNotices: vi.fn(async () => {}), queueAccessRequestOutcome: vi.fn(async () => {}) }));

import { listAccessGrantsDetailed, recertifyAccess } from "@/lib/accessRecert";
import { effectiveOwnerForDocument } from "@/lib/ownership";
import { POST as createUser } from "@/app/api/admin/create-user/route";

beforeEach(() => {
  db.tables = {}; db.readError = {}; db.writes = []; db.rpcCalls = []; db.rpcReply = null; db.order = [];
});

// ── done-when 3 ────────────────────────────────────────────────────────────
describe("ORG-7 done-when 3 — a suspended member's personal grant is listed, named and marked", () => {
  const seed = (extra: Partial<Row> = {}) => {
    db.tables.org_members = [
      { org_id: "o1", uid: "adm", display_name: "Ada", email: "ada@x", role: "Admin", roles: ["Admin"], status: "active" },
      { org_id: "o1", uid: "eng", display_name: "Eng", email: "eng@x", role: "Engineer-2", roles: ["Engineer-2"], status: "active" },
      { org_id: "o1", uid: "sus", display_name: "Sue Spended", email: "sue@x", role: "Drafter", roles: ["Drafter"], status: "suspended" },
      { org_id: "o1", uid: "inv", display_name: null, email: "ivy@x", role: "Viewer", roles: ["Viewer"], status: "invited" },
      // the same person active in ANOTHER workspace changes nothing here
      { org_id: "o2", uid: "sus", display_name: "Sue (other ws)", email: "sue@x", role: "Admin", roles: ["Admin"], status: "active" },
    ];
    db.tables.team_members = []; db.tables.teams = [];
    db.tables.libraries = [{
      id: "L1", visibility: "private", owner_user_id: null, owner_team_id: null,
      acl: { rules: [
        { effect: "allow", subject: { type: "user", id: "eng" }, actions: ["read"] },
        { effect: "allow", subject: { type: "user", id: "sus" }, actions: ["read", "download"] },
        { effect: "allow", subject: { type: "user", id: "inv" }, actions: ["read"] },
      ] },
      acl_index: { allow: { users: { read: ["eng", "sus", "inv"], download: ["sus"] } } },
      recert_policy: null, last_recertified_at: null, last_recertified_by: null, next_recertification_date: null, recert_notified_at: null,
      ...extra,
    }];
  };

  it("listed under their name with their status, never a bare uid, never among those who can read today", async () => {
    seed();
    const eff = await listAccessGrantsDetailed("o1", "L1");
    expect(eff.complete).toBe(true);
    expect(eff.live.map((g) => g.subjectId).sort()).toEqual(["adm", "eng"]);
    expect(eff.suspended.map((g) => [g.subjectName, g.memberStatus, g.status])).toEqual([
      ["ivy@x", "invited", "suspended"],
      ["Sue Spended", "suspended", "suspended"],
    ]);
    expect(eff.suspended.find((g) => g.subjectId === "sus")!.actions.sort()).toEqual(["download", "read"]);
    for (const g of eff.suspended) expect(g.subjectName).not.toBe(g.subjectId);
  });

  it("an expired rule naming a suspended member carries their name too", async () => {
    seed({ acl: { rules: [{ effect: "allow", subject: { type: "user", id: "sus" }, actions: ["read"], expiresAt: "2020-01-01T00:00:00Z" }] }, acl_index: { allow: { users: { read: ["sus"] } } } });
    const eff = await listAccessGrantsDetailed("o1", "L1");
    expect(eff.expired.map((g) => g.subjectName)).toEqual(["Sue Spended"]);
    expect(eff.suspended).toEqual([]); // the expired rule is not a standing grant
  });

  it("a deny naming them outranks the grant when they return — not listed as a standing grant", async () => {
    seed({ acl_index: { allow: { users: { read: ["eng", "sus"] } }, deny: { users: { read: ["sus"] } } } });
    const eff = await listAccessGrantsDetailed("o1", "L1");
    expect(eff.suspended.map((g) => g.subjectId)).toEqual([]);
  });

  it("the non-active members' read failing refuses the attestation (fail safe: a hidden grant is what the ruling forbids)", async () => {
    seed();
    db.readError.org_members = "timeout";
    const eff = await listAccessGrantsDetailed("o1", "L1");
    expect(eff.complete).toBe(false);
  });

  it("the record keeps the suspended grant beside the live population, marked; grant_count is the live population", async () => {
    seed();
    const out = await recertifyAccess({ libraryId: "L1", orgId: "o1", actorId: "adm", actorName: "Ada" });
    expect(out.grantCount).toBe(2);
    const ev = db.writes.find((w) => w.table === "access_recertification_events")!.row as Row;
    expect(ev.grant_count).toBe(2);
    const snap = ev.grants_snapshot as Array<Row>;
    expect(snap.filter((g) => g.status === "active").map((g) => g.subjectId).sort()).toEqual(["adm", "eng"]);
    expect(snap.filter((g) => g.status === "suspended").map((g) => g.subjectName).sort()).toEqual(["Sue Spended", "ivy@x"]);
    for (const g of snap) expect(g.subjectName).not.toBe(g.subjectId);
  });

  it("REGRESSION: with no non-active member, the list and the record are exactly the live population", async () => {
    seed();
    db.tables.org_members = db.tables.org_members.filter((m) => m.status === "active");
    const eff = await listAccessGrantsDetailed("o1", "L1");
    expect(eff.suspended).toEqual([]);
    await recertifyAccess({ libraryId: "L1", orgId: "o1", actorId: "adm" });
    const ev = db.writes.find((w) => w.table === "access_recertification_events")!.row as Row;
    expect((ev.grants_snapshot as Row[]).map((g) => g.subjectId).sort()).toEqual(["adm", "eng"]);
  });

  it("the review modal lists them by name with the status mark", () => {
    const modal = readFileSync(join(process.cwd(), "components/documents/AccessRecertModal.tsx"), "utf8");
    expect(modal).toMatch(/setSuspended\(eff\.suspended \?\? \[\]\)/);
    expect(modal).toMatch(/\{g\.subjectName\}<\/span>\s*<span[^>]*>\{g\.memberStatus \?\? "suspended"\}<\/span>/);
  });
});

// ── done-when 4 ────────────────────────────────────────────────────────────
describe("ORG-7 done-when 4 — the team rung's name is read in this workspace", () => {
  it("a supervisor who is a member of two workspaces is named (not the team's name)", async () => {
    db.tables.libraries = [{ id: "L1", org_id: "o1", owner_user_id: null, owner_name: null, owner_team_id: "t1" }];
    db.tables.teams = [{ id: "t1", supervisor_user_id: "sup", name: "Piping team" }];
    db.tables.org_members = [
      { org_id: "o1", uid: "sup", status: "active", display_name: "Sam Super", email: "sam@x" },
      { org_id: "o2", uid: "sup", status: "active", display_name: "Sam (elsewhere)", email: "sam@x" },
    ];
    const eff = await effectiveOwnerForDocument({ libraryId: "L1", ownerUserId: null, collectionId: null });
    expect(eff).toMatchObject({ userId: "sup", source: "team", name: "Sam Super" });
  });
  it("REGRESSION: a supervisor in one workspace is named as before", async () => {
    db.tables.libraries = [{ id: "L1", org_id: "o1", owner_user_id: null, owner_name: null, owner_team_id: "t1" }];
    db.tables.teams = [{ id: "t1", supervisor_user_id: "sup", name: "Piping team" }];
    db.tables.org_members = [{ org_id: "o1", uid: "sup", status: "active", display_name: null, email: "sam@x" }];
    expect((await effectiveOwnerForDocument({ libraryId: "L1", ownerUserId: null, collectionId: null, orgId: "o1" })).name).toBe("sam@x");
  });
});

// ── done-when 2 ────────────────────────────────────────────────────────────
describe("ORG-7 done-when 2 — isActiveMember where the caller knows it", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("the documents page's signed-in principal passes it (a principal exists only for an ACTIVE membership)", () => {
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(page).toMatch(/orgId: activeOrgId \?\? undefined,\s*teamIds: myTeamIds,[\s\S]{0,600}isActiveMember: true,\s*\};\s*\}, \[uid, activeRole, roles, activeOrgId, myTeamIds\]\);/);
    expect(src("components/providers/RoleContext.tsx")).toContain("setActiveRole(active ? headline : null);");
  });
  it("the View-as simulator passes the SIMULATED member's real status, read from their row", () => {
    const sim = src("components/permissions/ViewAsSimulator.tsx");
    expect(sim).toContain('select("uid, display_name, email, role, roles, status")');
    expect(sim).toContain('isActiveMember: who.status === "active"');
    expect(sim).not.toMatch(/teamIds, isActiveMember: true/);
  });
});

// ── the re-add residual ────────────────────────────────────────────────────
describe("ORG-7 re-add — stale inherited index entries are cleared before the membership exists again", () => {
  const post = () => createUser(new NextRequest("https://app/api/admin/create-user", {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ email: "pat@x.io", password: "pw", orgId: "o1", role: "Drafter" }),
  }));
  const seed = (prunedAclGrants: number | null) => {
    db.tables.org_members = [{ org_id: "o1", uid: "a1", email: "admin@x.io", role: "Admin", roles: ["Admin"], status: "active" }];
    db.tables.users = [{ id: "pat", email: "pat@x.io" }];
    db.tables.libraries = [{ id: "L1", org_id: "o1" }, { id: "L2", org_id: "o1" }, { id: "LX", org_id: "o2" }];
    db.tables.access_requests = [];
    db.tables.audit_logs = prunedAclGrants === null ? [] : [{
      org_id: "o1", action: "MEMBER_REMOVED", resource_id: "pat", timestamp: "2026-10-12T00:00:00Z",
      details: { memberEmail: "pat@x.io", prunedAclGrants },
    }];
  };

  it("a removal that pruned a grant: the workspace's libraries are walked through the RPC BEFORE the insert, while no membership exists", async () => {
    seed(2);
    db.rpcReply = (args, n) => n === 1
      ? { data: { pruned: 40, examined: 2000, phase: "documents", after: "d-2000", limit: 2000, done: false }, error: null }
      : { data: { pruned: 3, examined: 7, phase: null, after: null, limit: 2000, done: true }, error: null };
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(body).toMatchObject({ uid: "pat", aclIndexCleanup: { done: true, pruned: 43, calls: 2 } });
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["prune_removed_member_acl_index", "prune_removed_member_acl_index"]);
    expect(db.rpcCalls[0].args).toMatchObject({ p_org_id: "o1", p_uid: "pat", p_library_ids: ["L1", "L2"], p_collection_ids: [], p_phase: "documents", p_after: null, p_limit: 2000 });
    expect(db.rpcCalls[1].args).toMatchObject({ p_phase: "documents", p_after: "d-2000" });
    expect(db.rpcCalls.every((c) => c.membersAtCall === 0)).toBe(true);
    expect(db.order.indexOf("rpc.prune_removed_member_acl_index")).toBeLessThan(db.order.indexOf("org_members.insert"));
  });

  it("a call that fails does not block the add: the member is created and the cleanup's state returned", async () => {
    seed(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.rpcReply = () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ uid: "pat", aclIndexCleanup: { done: false, error: expect.stringMatching(/statement timeout/) } });
    expect((db.tables.org_members ?? []).some((m) => m.uid === "pat" && m.org_id === "o1")).toBe(true);
    expect(warn.mock.calls.some((c) => /nightly rebuild/.test(String(c[0])))).toBe(true);
    warn.mockRestore();
  });

  it("before 20261204 (no RPC): nothing is said and the add is unchanged", async () => {
    seed(1);
    db.rpcReply = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.prune_removed_member_acl_index in the schema cache" } });
    const res = await post();
    expect(await res.json()).toEqual({ uid: "pat" });
  });

  it("REGRESSION: a person never removed, or whose removal pruned no grant, makes no call and the answer is as before", async () => {
    seed(null);
    expect(await (await post()).json()).toEqual({ uid: "pat" });
    expect(db.rpcCalls).toEqual([]);
    beforeEachReset(); seed(0);
    expect(await (await post()).json()).toEqual({ uid: "pat" });
    expect(db.rpcCalls).toEqual([]);
  });

  it("a removal record that cannot be read never blocks the add", async () => {
    seed(3);
    db.readError.audit_logs = "permission denied";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ uid: "pat", aclIndexCleanup: { done: false, error: "permission denied" } });
    expect(db.rpcCalls).toEqual([]);
    warn.mockRestore();
  });

  it("the walk is bounded by a time budget (the rest is the nightly rebuild's)", () => {
    const route = readFileSync(join(process.cwd(), "app/api/admin/create-user/route.ts"), "utf8");
    expect(route).toMatch(/const READD_ACL_INDEX_BUDGET_MS = 5_000;/);
    expect(route).toMatch(/deadlineMs: READD_ACL_INDEX_BUDGET_MS/);
    // only the insert path (the re-activation of a suspended row keeps its grants by design)
    expect(route.indexOf("clearStaleInheritedAclIndex(orgId, userId)")).toBeGreaterThan(route.indexOf("return NextResponse.json({ uid: userId, roles: merged, merged: true"));
  });
});

function beforeEachReset() {
  db.tables = {}; db.readError = {}; db.writes = []; db.rpcCalls = []; db.rpcReply = null; db.order = [];
}
