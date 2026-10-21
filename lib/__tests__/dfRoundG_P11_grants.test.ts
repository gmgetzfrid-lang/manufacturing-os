// drafting-flow Round G, DF-P11 — the capability-policy halves:
//   * HAND-2: holds.release ships to the controller tier (Admin, DocCtrl);
//     an org that stored a wider list keeps it; a grant still widens.
//   * projects-and-cost QUAL-14 done-when 2: a personal grant of a capability
//     decided per project (quality.sign_off) may name ONE project. Both
//     evaluators read it (policyAllows here; org_capability_allows_for's
//     grant loop in 20261239, pinned by dfRoundG_P11_migration.test.ts), and
//     the route stores one only once the live database reads it (probe
//     capability_grant_scope_ready, fail closed).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  readError: {} as Record<string, { message: string; code?: string } | undefined>,
  rpc: {} as Record<string, { data: unknown; error: null | { message: string; code?: string } }>,
  rpcCalls: [] as string[],
}));
function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let cols: string[] | null = null;
  let op: { kind: "update"; patch: Row } | { kind: "insert"; row: Row } | null = null;
  let returning = false;
  const rows = () => (db.tables[name] ??= []);
  const project = (r: Row): Row => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r });
  const run = () => {
    if (op?.kind === "insert") { rows().push({ ...op.row }); return { data: null, error: null }; }
    if (!op && db.readError[name]) return { data: null, error: db.readError[name] };
    const hit = rows().filter((r) => filters.every((f) => f(r)));
    if (op?.kind === "update") {
      for (const r of hit) Object.assign(r, op.patch);
      return { data: returning ? hit.map(project) : null, error: null };
    }
    return { data: hit.map(project), error: null };
  };
  const q = {
    select(c?: string) {
      if (op) returning = true;
      cols = c && c.trim() !== "*" ? c.split(",").map((x) => x.trim()) : null;
      return q;
    },
    eq(k: string, v: unknown) { filters.push((r) => r[k] === v); return q; },
    is(k: string, v: unknown) { filters.push((r) => (r[k] ?? null) === v); return q; },
    update(patch: Row) { op = { kind: "update", patch }; return q; },
    insert(row: Row) { op = { kind: "insert", row }; return q; },
    maybeSingle() {
      const out = run();
      return Promise.resolve({ data: (out.data as Row[] | null)?.[0] ?? null, error: out.error });
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve().then(run).then(resolve, reject);
    },
  };
  return q;
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => (db.user ? { data: { user: db.user }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (t: string) => table(t),
    rpc: async (fn: string) => { db.rpcCalls.push(fn); return db.rpc[fn] ?? { data: null, error: { message: `function ${fn}() does not exist`, code: "PGRST202" } }; },
  },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => table(t) } }));

import {
  policyAllows, validateCapabilityPolicy, grantAppliesTo, sameGrant, CAPABILITY_DEFS, PROJECT_SCOPED_CAPS,
  __resetCapabilityPolicyCache, type CapabilityPolicy,
} from "@/lib/capabilityPolicy";
import { POST as policyRoute } from "@/app/api/admin/capability-policy/route";
import { holdControlsFor, isHoldOpener } from "@/lib/holds";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

// ═══════════════════════════════════════════════════════════════════════════
// HAND-2 — the shipped default
// ═══════════════════════════════════════════════════════════════════════════
describe("HAND-2 — holds.release ships to Admin and DocCtrl", () => {
  it("the definition's default is the controller tier; holds.open stays everyone", () => {
    expect(CAPABILITY_DEFS.find((d) => d.id === "holds.release")?.defaultRoles).toEqual(["Admin", "DocCtrl"]);
    expect(CAPABILITY_DEFS.find((d) => d.id === "holds.open")?.defaultRoles).toEqual(["*"]);
  });
  it("under the default: Admin, DocCtrl and a Manager who also holds DocCtrl release; every other role does not", () => {
    expect(policyAllows({}, "holds.release", "Admin")).toBe(true);
    expect(policyAllows({}, "holds.release", "DocCtrl")).toBe(true);
    expect(policyAllows({}, "holds.release", "Manager", ["DocCtrl"])).toBe(true);
    for (const r of ["Manager", "Supervisor", "DraftingSupervisor", "Engineer-1", "Drafter", "Requester", "Viewer", "Auditor", "Contractor"]) {
      expect(policyAllows({}, "holds.release", r), r).toBe(false);
    }
    expect(policyAllows(null, "holds.release", "Drafter")).toBe(false);
  });
  it("REGRESSION: an org that stored a wider list keeps it, and a personal grant still widens", () => {
    expect(policyAllows({ caps: { "holds.release": ["*"] } }, "holds.release", "Drafter")).toBe(true);
    expect(policyAllows({ caps: { "holds.release": ["Admin", "DocCtrl", "Manager"] } }, "holds.release", "Manager")).toBe(true);
    const granted: CapabilityPolicy = { grants: [{ cap: "holds.release", uid: "coord", expiresAt: null }] };
    expect(policyAllows(granted, "holds.release", "Requester", [], "coord")).toBe(true);
    expect(policyAllows(granted, "holds.release", "Requester", [], "other")).toBe(false);
  });
  it("fix pass: the hold's OPENER keeps release of their own hold (the UPDATE policy's own-hold leg); nobody else outside the policy gains it", () => {
    // a Supervisor's own "pending field walk" hold
    expect(holdControlsFor({}, "Supervisor", ["Supervisor"], "sup", { openedBy: "sup" }).canRelease).toBe(true);
    // someone else's hold: refused under the default
    expect(holdControlsFor({}, "Supervisor", ["Supervisor"], "sup", { openedBy: "dc1" }).canRelease).toBe(false);
    // no hold in hand: the policy's answer alone
    expect(holdControlsFor({}, "Supervisor", ["Supervisor"], "sup").canRelease).toBe(false);
    // a read-only role still subtracts (ROLE-5), opener or not
    expect(holdControlsFor({}, "Viewer", ["Viewer"], "v", { openedBy: "v" }).canRelease).toBe(false);
    // an absent identity never matches
    expect(isHoldOpener({ openedBy: null }, null)).toBe(false);
    expect(isHoldOpener({ openedBy: "u" }, null)).toBe(false);
    expect(isHoldOpener(null, "u")).toBe(false);
    expect(isHoldOpener({ openedBy: "u" }, "u")).toBe(true);
    // a controller releases anyone's
    expect(holdControlsFor({}, "DocCtrl", ["DocCtrl"], "dc", { openedBy: "sup" }).canRelease).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// QUAL-14 done-when 2 — the evaluator and the rail
// ═══════════════════════════════════════════════════════════════════════════
describe("QUAL-14 — a personal grant on one project (policyAllows)", () => {
  const scoped: CapabilityPolicy = {
    caps: { "quality.sign_off": [] },
    grants: [{ cap: "quality.sign_off", uid: "eng", projectId: P1, expiresAt: null }],
  };
  it("applies on the project it names, and nowhere else", () => {
    expect(policyAllows(scoped, "quality.sign_off", "Engineer-1", [], "eng", { projectId: P1 })).toBe(true);
    expect(policyAllows(scoped, "quality.sign_off", "Engineer-1", [], "eng", { projectId: P2 })).toBe(false);
    // a decision with no project in hand never matches a scoped grant
    expect(policyAllows(scoped, "quality.sign_off", "Engineer-1", [], "eng")).toBe(false);
    expect(policyAllows(scoped, "quality.sign_off", "Engineer-1", [], "someone-else", { projectId: P1 })).toBe(false);
  });
  it("REGRESSION: an unscoped grant still applies everywhere (WF-13 row 6)", () => {
    const wide: CapabilityPolicy = { caps: { "quality.sign_off": [] }, grants: [{ cap: "quality.sign_off", uid: "eng", expiresAt: null }] };
    expect(policyAllows(wide, "quality.sign_off", "Engineer-1", [], "eng", { projectId: P1 })).toBe(true);
    expect(policyAllows(wide, "quality.sign_off", "Engineer-1", [], "eng", { projectId: P2 })).toBe(true);
    expect(policyAllows(wide, "quality.sign_off", "Engineer-1", [], "eng")).toBe(true);
  });
  it("an expired scoped grant is dead", () => {
    const expired: CapabilityPolicy = { grants: [{ cap: "quality.sign_off", uid: "eng", projectId: P1, expiresAt: "2020-01-01T00:00:00Z" }] };
    expect(policyAllows(expired, "quality.sign_off", "Engineer-1", [], "eng", { projectId: P1 })).toBe(false);
  });
  it("grantAppliesTo / sameGrant: one grant per (person, capability, project-or-none)", () => {
    expect(grantAppliesTo({ cap: "quality.sign_off", uid: "u" }, null)).toBe(true);
    expect(grantAppliesTo({ cap: "quality.sign_off", uid: "u", projectId: null }, { projectId: P1 })).toBe(true);
    expect(grantAppliesTo({ cap: "quality.sign_off", uid: "u", projectId: P1 }, { projectId: P1 })).toBe(true);
    expect(grantAppliesTo({ cap: "quality.sign_off", uid: "u", projectId: P1 }, { projectId: P2 })).toBe(false);
    expect(sameGrant({ uid: "u", cap: "quality.sign_off" }, { uid: "u", cap: "quality.sign_off", projectId: null })).toBe(true);
    expect(sameGrant({ uid: "u", cap: "quality.sign_off", projectId: P1 }, { uid: "u", cap: "quality.sign_off" })).toBe(false);
    expect(sameGrant({ uid: "u", cap: "quality.sign_off", projectId: P1 }, { uid: "u", cap: "quality.sign_off", projectId: P2 })).toBe(false);
  });
  it("the rail refuses a project on a capability not decided per project, and an invalid project", () => {
    expect(PROJECT_SCOPED_CAPS.has("quality.sign_off")).toBe(true);
    expect(PROJECT_SCOPED_CAPS.has("holds.release" as never)).toBe(false);
    expect(validateCapabilityPolicy({ grants: [{ cap: "quality.sign_off", uid: "u", projectId: P1 }] })).toBeNull();
    expect(validateCapabilityPolicy({ grants: [{ cap: "holds.release", uid: "u", projectId: P1 }] }))
      .toMatch(/cannot be scoped to a project/);
    expect(validateCapabilityPolicy({ grants: [{ cap: "quality.sign_off", uid: "u", projectId: "" as unknown as string }] }))
      .toMatch(/invalid project/);
    expect(validateCapabilityPolicy({ grants: [{ cap: "quality.sign_off", uid: "u", projectId: 7 as unknown as string }] }))
      .toMatch(/invalid project/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// QUAL-14 done-when 2 — the route
// ═══════════════════════════════════════════════════════════════════════════
describe("QUAL-14 — /api/admin/capability-policy stores a project-scoped grant only when the database reads it", () => {
  const post = (body: Record<string, unknown>) => policyRoute(new NextRequest("http://localhost/api/admin/capability-policy", {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const V = "2026-10-01T00:00:00+00:00";
  const storedGrants = () => ((db.tables.org_configurations?.[0]?.data as CapabilityPolicy | undefined)?.grants ?? []);
  const audits = () => (db.tables.audit_logs ?? []).filter((r) => r.action === "CAPABILITY_POLICY_CHANGED");
  beforeEach(() => {
    __resetCapabilityPolicyCache();
    db.user = { id: "a1", email: "a@x" };
    db.readError = {};
    db.rpc = { capability_grant_scope_ready: { data: true, error: null } };
    db.rpcCalls = [];
    db.tables = {
      org_members: [
        { org_id: "o1", uid: "a1", role: "Admin", roles: ["Admin"], email: "a@x", status: "active" },
        { org_id: "o1", uid: "eng", role: "Engineer-1", roles: ["Engineer-1"], email: "e@x", status: "active" },
      ],
      org_configurations: [{ org_id: "o1", key: "capability_policy", data: { caps: {}, grants: [] }, updated_at: V }],
      projects: [{ id: P1, org_id: "o1" }, { id: P2, org_id: "other-org" }],
    };
  });

  it("a grant on a project of this workspace, with the probe live → stored with its projectId and audited", async () => {
    const res = await post({ op: "grant", orgId: "o1", uid: "eng", cap: "quality.sign_off", projectId: P1 });
    expect(res.status).toBe(200);
    expect(storedGrants()).toHaveLength(1);
    expect(storedGrants()[0]).toMatchObject({ cap: "quality.sign_off", uid: "eng", projectId: P1 });
    expect(db.rpcCalls).toContain("capability_grant_scope_ready");
    expect(audits()).toHaveLength(1);
    expect((audits()[0].details as Row).grant).toMatchObject({ projectId: P1 });
  });
  it("before 20261239 (the probe function is absent) → 409, nothing stored, no audit row", async () => {
    db.rpc = {};
    const res = await post({ op: "grant", orgId: "o1", uid: "eng", cap: "quality.sign_off", projectId: P1 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/needs migration 20261239/);
    expect(storedGrants()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });
  it("a probe that cannot be read, or answers anything but true, refuses (fail closed)", async () => {
    db.rpc = { capability_grant_scope_ready: { data: null, error: { message: "statement timeout", code: "57014" } } };
    const r1 = await post({ op: "grant", orgId: "o1", uid: "eng", cap: "quality.sign_off", projectId: P1 });
    expect(r1.status).toBe(409);
    expect((await r1.json()).error).toMatch(/Couldn't confirm the database reads a grant's project \(statement timeout\)/);
    db.rpc = { capability_grant_scope_ready: { data: false, error: null } };
    expect((await post({ op: "grant", orgId: "o1", uid: "eng", cap: "quality.sign_off", projectId: P1 })).status).toBe(409);
    expect(storedGrants()).toHaveLength(0);
  });
  it("a project of another workspace → 400; a project read that fails → 503; nothing stored", async () => {
    const r1 = await post({ op: "grant", orgId: "o1", uid: "eng", cap: "quality.sign_off", projectId: P2 });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toMatch(/not in this workspace/);
    db.readError.projects = { message: "upstream" };
    expect((await post({ op: "grant", orgId: "o1", uid: "eng", cap: "quality.sign_off", projectId: P1 })).status).toBe(503);
    expect(storedGrants()).toHaveLength(0);
  });
  it("a project on a capability not decided per project → 400 before any lookup", async () => {
    const res = await post({ op: "grant", orgId: "o1", uid: "eng", cap: "holds.release", projectId: P1 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/decided per project/);
    expect(db.rpcCalls).toHaveLength(0);
  });
  it("REGRESSION: an unscoped grant needs no probe and is stored exactly as before", async () => {
    db.rpc = {};
    const res = await post({ op: "grant", orgId: "o1", uid: "eng", cap: "quality.sign_off" });
    expect(res.status).toBe(200);
    expect(storedGrants()[0]).not.toHaveProperty("projectId");
    expect(db.rpcCalls).toHaveLength(0);
  });
  it("grants on two projects and one unscoped coexist; revoke names which one", async () => {
    db.tables.projects.push({ id: P2, org_id: "o1" });
    db.tables.projects = db.tables.projects.filter((p) => !(p.id === P2 && p.org_id === "other-org"));
    expect((await post({ op: "grant", orgId: "o1", uid: "eng", cap: "quality.sign_off", projectId: P1 })).status).toBe(200);
    expect((await post({ op: "grant", orgId: "o1", uid: "eng", cap: "quality.sign_off", projectId: P2 })).status).toBe(200);
    expect((await post({ op: "grant", orgId: "o1", uid: "eng", cap: "quality.sign_off" })).status).toBe(200);
    expect(storedGrants()).toHaveLength(3);
    // re-granting the same project replaces, never duplicates
    expect((await post({ op: "grant", orgId: "o1", uid: "eng", cap: "quality.sign_off", projectId: P1, note: "renewed" })).status).toBe(200);
    expect(storedGrants()).toHaveLength(3);
    const res = await post({ op: "revoke", orgId: "o1", uid: "eng", cap: "quality.sign_off", projectId: P1 });
    expect(res.status).toBe(200);
    expect((audits().at(-1)!.details as Row).revoked).toMatchObject({ projectId: P1, note: "renewed" });
    const left = storedGrants().map((g) => g.projectId ?? null).sort();
    expect(left).toEqual([P2, null].sort());
    // the unscoped revoke takes the unscoped grant only
    expect((await post({ op: "revoke", orgId: "o1", uid: "eng", cap: "quality.sign_off" })).status).toBe(200);
    expect(storedGrants().map((g) => g.projectId)).toEqual([P2]);
  });
});
