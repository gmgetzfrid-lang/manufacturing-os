// Round E — package B, the capability policy's SERVER side:
//
//   * WF-11: every policy and grant write goes through
//     POST /api/admin/capability-policy — bearer auth, active membership,
//     controller tier by the collection, Admin for a critical capability and
//     for ANY grant, self-grant refused, validateCapabilityPolicy on the
//     result, compare-and-set write, before/after audit row; migration
//     20261056 holds the same rails in a trigger against a direct write.
//   * WF-10: the server-side loader keeps an entry for SERVER_CACHE_TTL_MS
//     with the row's updated_at as its version, the route invalidates it on
//     write, and a sessionless read never poisons the cache.
//   * WF-16: a workflow action admitted by a personal grant names the grant
//     in its audit row; expired grants are pruned (and the pruning audited)
//     on every write.
//   * DEC-13 stage 3: the engineer gate consults `ticket.engineer_gate_exempt`
//     (default byte-identical to the hardcoded test); migration 20261057
//     adds the same CASE row to the SQL evaluator, byte-faithful otherwise.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import {
  CAPABILITY_DEFS, policyAllows, tokensFor, loadCapabilityPolicy, loadCapabilityPolicyEntry, invalidateCapabilityPolicy,
  __resetCapabilityPolicyCache, SERVER_CACHE_TTL_MS, parseStoredCapabilityPolicy, CAPABILITY_POLICY_ROUTE,
  saveCapabilityPolicy, addUserGrant, revokeUserGrant,
  type CapabilityPolicy,
} from "@/lib/capabilityPolicy";
import {
  WorkflowEngine, engineerApprovalRequired, requiresEngineerApproval, decisiveGrants,
  isEngineerRole, isManagementRole, isDocCtrlRole,
} from "@/lib/workflow";
import type { Ticket, Role } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const mig = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, `marker not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker not found after ${from}: ${to}`).toBeGreaterThan(a);
  return text.slice(a, b);
}
function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  return { onlyInA: A.filter((l) => !B.includes(l)), onlyInB: B.filter((l) => !A.includes(l)) };
}
/** SQL with every string literal blanked — so a probe's LIKE pattern cannot
 *  trip a "no writes in the verification block" check. */
const noLiterals = (sql: string) => sql.replace(/'(?:[^']|'')*'/g, "''");

// ── the mocked clients ───────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  /** the next org_configurations UPDATE matches no row (a concurrent write) */
  conflict: false,
  auditError: null as null | { message: string },
  session: null as null | { access_token: string },
  browserRows: {} as Record<string, Array<Record<string, unknown>>>,
}));
function chain(table: string, rowsOf: () => Array<Record<string, unknown>>) {
  const filters: Array<[string, unknown]> = [];
  let head = false;
  let writing: "update" | "insert" | null = null;
  const rows = () => rowsOf().filter((r) => filters.every(([k, v]) => r[k] === v));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => {
          if (writing === "insert" && table === "audit_logs" && state.auditError) return resolve({ data: null, error: state.auditError });
          if (writing === "insert") return resolve({ data: [], error: null });
          if (writing === "update" && table === "org_configurations" && state.conflict) { state.conflict = false; return resolve({ data: [], error: null }); }
          return resolve(head ? { data: null, error: null, count: rows().length } : { data: rows(), error: null, count: rows().length });
        };
      }
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "is") filters.push([String(args[0]), args[1]]);
        if (prop === "update") writing = "update";
        if (prop === "insert" || prop === "upsert") writing = "insert";
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: rows()[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t, () => state.rows[t] ?? []),
  },
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: state.session } })) },
    from: (t: string) => chain(t, () => state.browserRows[t] ?? []),
  },
}));
import { POST as policyRoute } from "@/app/api/admin/capability-policy/route";
import { POST as workflowAction } from "@/app/api/tickets/workflow-action/route";

const post = (handler: (req: NextRequest) => Promise<Response>, url: string, body: unknown, bearer = "Bearer t") => handler(new NextRequest(url, {
  method: "POST", headers: { ...(bearer ? { authorization: bearer } : {}), "content-type": "application/json" }, body: JSON.stringify(body),
}));
const policy = (body: unknown, bearer?: string) => post(policyRoute, "http://x" + CAPABILITY_POLICY_ROUTE, body, bearer);
const workflow = (body: unknown) => post(workflowAction, "http://x/api/tickets/workflow-action", body);
const member = (uid: string, role: string, roles = [role]) => ({ org_id: "o1", uid, role, roles, email: `${uid}@x.io`, display_name: uid, status: "active" });
const config = (data: unknown, updated_at: string | null = "2026-09-01T00:00:00.000000+00:00") => ({ org_id: "o1", key: "capability_policy", data, updated_at });
const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const inserts = (table: string) => state.calls.filter((c) => c.table === table && c.method === "insert").map((c) => c.args[0] as Record<string, unknown>);
const updates = (table: string) => state.calls.filter((c) => c.table === table && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.user = null; state.rows = {}; state.calls = []; state.conflict = false; state.auditError = null; state.session = null; state.browserRows = {};
});

// ═══════════════════════════════════════════════════════════════════════════
// DEC-13 stage 3 — the engineer gate is a real capability
// ═══════════════════════════════════════════════════════════════════════════
const ticket = (over: Partial<Ticket>): Ticket => ({
  id: "t1", orgId: "o1", status: "PENDING_REVIEW", requesterId: "req-1", requesterRole: "Requester",
  requestType: "ISO", unit: "U-100", assignedDrafterId: "d-1", assignedEngineerId: null, attachments: [],
  ...over,
} as unknown as Ticket);
const acts = (t: Ticket, role: string, uid: string, p?: CapabilityPolicy, requesterRoles?: string[] | null) =>
  WorkflowEngine.getActions(t, role as Role, uid, p, { userRoles: [role as Role], activeMemberCount: 5, requesterRoles }).map((a) => a.action);
/** The hardcoded predicate the capability replaces — kept here as the oracle. */
const legacyRequired = (snap: string | undefined, cur: readonly string[] | null | undefined) => {
  const exempt = (r: string) => isEngineerRole(r) || isManagementRole(r) || isDocCtrlRole(r);
  const bySnap = !snap || !exempt(snap);
  if (cur === null || cur === undefined) return bySnap;
  return bySnap || (cur.length === 0 ? true : !cur.some(exempt));
};
const ROLES = ["Admin", "Manager", "Supervisor", "DocCtrl", "Engineer-1", "Engineer-4", "DraftingSupervisor", "Drafter", "Requester", "Viewer", "Contractor", "Auditor", "Safety", "Operations"];

describe("DEC-13 stage 3 — ticket.engineer_gate_exempt", () => {
  it("is a registered capability with the shipped default that reproduces the hardcoded gate", () => {
    const def = CAPABILITY_DEFS.find((d) => d.id === "ticket.engineer_gate_exempt")!;
    expect(def.label).toBe("Approve own request without an engineer");
    expect(def.defaultRoles).toEqual(["Admin", "Manager", "Supervisor", "Engineer", "DocCtrl"]);
    expect(def.critical).toBeUndefined();
    expect(def.area).toBe("Requests");
    expect(tokensFor({}, "ticket.engineer_gate_exempt")).toEqual(def.defaultRoles);
  });
  it("with no policy, engineerApprovalRequired is byte-identical to the legacy predicate over every role × collection", () => {
    const collections: Array<readonly string[] | null | undefined> = [undefined, null, [], ...ROLES.map((r) => [r]), ["Requester", "Engineer-2"], ["Drafter", "Manager"], ["Viewer", "DocCtrl"]];
    for (const snap of [undefined, ...ROLES]) {
      for (const cur of collections) {
        expect(engineerApprovalRequired(snap, cur), `snapshot=${snap} current=${JSON.stringify(cur)}`).toBe(legacyRequired(snap, cur));
        expect(engineerApprovalRequired(snap, cur, {}), `policy {} snapshot=${snap}`).toBe(legacyRequired(snap, cur));
      }
      expect(requiresEngineerApproval(snap)).toBe(legacyRequired(snap, undefined));
    }
  });
  it("the org's list decides who is exempt: narrowing makes a Manager route through an engineer; widening lets a Requester self-approve", () => {
    const narrowed: CapabilityPolicy = { caps: { "ticket.engineer_gate_exempt": ["Admin", "Engineer"] } };
    expect(engineerApprovalRequired("Manager", ["Manager"], narrowed)).toBe(true);
    expect(engineerApprovalRequired("Admin", ["Admin"], narrowed)).toBe(false);
    const t = ticket({ requesterRole: "Manager" });
    expect(acts(t, "Manager", "req-1", undefined, ["Manager"])).toContain("approve_draft_ifc");
    expect(acts(t, "Manager", "req-1", narrowed, ["Manager"])).toContain("request_final_engineer_approval");
    expect(acts(t, "Manager", "req-1", narrowed, ["Manager"])).not.toContain("approve_draft_ifc");
    const widened: CapabilityPolicy = { caps: { "ticket.engineer_gate_exempt": ["Admin", "Manager", "Supervisor", "Engineer", "DocCtrl", "Requester"] } };
    expect(engineerApprovalRequired("Requester", ["Requester"], widened)).toBe(false);
    const r = ticket({});
    expect(acts(r, "Requester", "req-1", undefined, ["Requester"])).toContain("request_final_engineer_approval");
    expect(acts(r, "Requester", "req-1", widened, ["Requester"])).toContain("approve_draft_ifc");
    expect(acts(r, "Requester", "req-1", widened, ["Requester"])).not.toContain("request_final_engineer_approval");
  });
  it("the DEC-16 disjunction is NOT configurable: the snapshot OR the current collection still fails closed", () => {
    const widened: CapabilityPolicy = { caps: { "ticket.engineer_gate_exempt": ["*"] } };
    expect(engineerApprovalRequired("Requester", [], widened)).toBe(true);        // no longer a member
    expect(engineerApprovalRequired(undefined, ["Admin"], widened)).toBe(true);   // no snapshot at all
    const narrowed: CapabilityPolicy = { caps: { "ticket.engineer_gate_exempt": ["Admin"] } };
    expect(engineerApprovalRequired("Manager", ["Admin"], narrowed)).toBe(true);  // snapshot says required
    expect(engineerApprovalRequired("Admin", ["Manager"], narrowed)).toBe(true);  // current says required
    expect(engineerApprovalRequired("Admin", ["Admin"], narrowed)).toBe(false);
  });
  it("a personal grant of the capability exempts that requester only; a request-type override narrows it per type", () => {
    const granted: CapabilityPolicy = { grants: [{ cap: "ticket.engineer_gate_exempt", uid: "req-1", expiresAt: null }] };
    expect(engineerApprovalRequired("Requester", ["Requester"], granted, "req-1")).toBe(false);
    expect(engineerApprovalRequired("Requester", ["Requester"], granted, "req-2")).toBe(true);
    expect(acts(ticket({}), "Requester", "req-1", granted, ["Requester"])).toContain("approve_draft_ifc");
    const scoped: CapabilityPolicy = { caps: { "ticket.engineer_gate_exempt": [
      { tokens: ["Admin", "Manager", "Supervisor", "Engineer", "DocCtrl"] },
      { tokens: ["Admin"], when: { requestType: ["ASBUILT"] } },
    ] } };
    expect(engineerApprovalRequired("Manager", ["Manager"], scoped, "req-1", { requestType: "ISO" })).toBe(false);
    expect(engineerApprovalRequired("Manager", ["Manager"], scoped, "req-1", { requestType: "ASBUILT" })).toBe(true);
    expect(acts(ticket({ requesterRole: "Manager", requestType: "ASBUILT" }), "Manager", "req-1", scoped, ["Manager"])).toContain("request_final_engineer_approval");
    expect(acts(ticket({ requesterRole: "Manager", requestType: "ISO" }), "Manager", "req-1", scoped, ["Manager"])).toContain("approve_draft_ifc");
    // the simulator's row for this capability is the same call the gate makes
    expect(policyAllows(scoped, "ticket.engineer_gate_exempt", "Manager", ["Manager"], "req-1", { requestType: "ASBUILT" })).toBe(false);
  });
  it("getActions passes the policy, the requester and the resource to the gate (pinned by source)", () => {
    expect(src("lib/workflow.ts")).toContain("const needsEngineerApproval = engineerApprovalRequired(ticket.requesterRole, ctx?.requesterRoles, policy, ticket.requesterId, resource);");
  });
});

describe("20261057 — the SQL default CASE gains the engineer-gate row, byte-faithful to 20261052 otherwise", () => {
  const m57 = mig("20261057_rp_roundE_engineer_gate_capability.sql");
  const m52 = mig("20261052_rp_phase7_capability_resource_dimension.sql");
  const fn57 = between(m57, "CREATE OR REPLACE FUNCTION org_capability_allows_for", "COMMIT;");
  const fn52 = between(m52, "CREATE OR REPLACE FUNCTION org_capability_allows_for", "-- The 3-argument entry point");
  it("re-creates org_capability_allows_for with exactly ONE added line; the 3-argument wrapper is untouched", () => {
    const { onlyInA, onlyInB } = lineDiff(fn52, fn57);
    expect(onlyInA).toEqual([]);
    expect(onlyInB).toEqual(["      WHEN 'ticket.engineer_gate_exempt' THEN '[\"Admin\",\"Manager\",\"Supervisor\",\"Engineer\",\"DocCtrl\"]'::jsonb"]);
    expect(fn57.split("\n").length).toBe(fn52.split("\n").length + 1);
    expect(m57).not.toContain("CREATE OR REPLACE FUNCTION org_capability_allows(");
    expect(m57).not.toMatch(/DROP FUNCTION/);
    expect(fn57).toMatch(/SECURITY DEFINER SET search_path = public/);
  });
  it("the CASE mirrors CAPABILITY_DEFS capability-for-capability (18 rows) and still denies unknowns", () => {
    const caseBlock = between(fn57, "v_tokens := CASE p_cap", "END;");
    const sqlDefaults = new Map<string, string[]>();
    for (const m of caseBlock.matchAll(/WHEN '([^']+)'\s+THEN '(\[[^\]]*\])'::jsonb/g)) sqlDefaults.set(m[1], JSON.parse(m[2]) as string[]);
    for (const def of CAPABILITY_DEFS) expect(sqlDefaults.get(def.id), def.id).toEqual(def.defaultRoles);
    expect(sqlDefaults.size).toBe(CAPABILITY_DEFS.length);
    expect(CAPABILITY_DEFS.length).toBe(18);
    expect(caseBlock).toMatch(/ELSE '\[\]'::jsonb/);
  });
  it("one paste: BEGIN/COMMIT around the DDL, then ONE final SELECT of probes (ok boolean) and aggregate counts (n text)", () => {
    expect(m57.indexOf("BEGIN;")).toBeLessThan(m57.indexOf("CREATE OR REPLACE FUNCTION"));
    expect(m57.indexOf("COMMIT;")).toBeLessThan(m57.indexOf("-- ── Verification"));
    const tail = m57.slice(m57.indexOf("COMMIT;") + "COMMIT;".length);
    expect((noLiterals(tail).match(/;/g) ?? []).length).toBe(1);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,[\s\S]*NULL::text AS n/);
    expect((tail.match(/UNION ALL/g) ?? []).length).toBe(6);
    expect(noLiterals(tail)).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/);
    expect(tail).toMatch(/COUNT\(\*\)[\s\S]*::text/);
    expect(tail).not.toMatch(/SELECT \*|SELECT data\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WF-10 — the server-side cache: short TTL, version stamp, invalidation,
// and no poisoning by a sessionless read
// ═══════════════════════════════════════════════════════════════════════════
describe("WF-10 — loadCapabilityPolicy on the server", () => {
  const clientReturning = (result: { data: unknown; error: unknown }) => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }) }),
  }) as never;
  const A = { data: { data: { caps: { "ticket.assign": ["Admin"] } }, updated_at: "2026-09-01T00:00:00+00:00" }, error: null };
  const B = { data: { data: { caps: { "ticket.assign": ["DocCtrl"] } }, updated_at: "2026-09-02T00:00:00+00:00" }, error: null };
  afterEach(() => vi.useRealTimers());

  it("a server read is cached for SERVER_CACHE_TTL_MS (5 s) — not a minute — and carries the row's updated_at as its version", async () => {
    expect(SERVER_CACHE_TTL_MS).toBe(5_000);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T10:00:00Z"));
    const first = await loadCapabilityPolicyEntry("o-ttl", clientReturning(A));
    expect(first.policy.caps?.["ticket.assign"]).toEqual(["Admin"]);
    expect(first.version).toBe("2026-09-01T00:00:00+00:00");
    vi.setSystemTime(new Date("2026-09-17T10:00:04.999Z"));
    expect((await loadCapabilityPolicy("o-ttl", clientReturning(B))).caps?.["ticket.assign"]).toEqual(["Admin"]);
    vi.setSystemTime(new Date("2026-09-17T10:00:05.001Z"));
    const later = await loadCapabilityPolicyEntry("o-ttl", clientReturning(B));
    expect(later.policy.caps?.["ticket.assign"]).toEqual(["DocCtrl"]);
    expect(later.version).toBe("2026-09-02T00:00:00+00:00");
  });
  it("invalidateCapabilityPolicy(orgId) drops the entry so the very next read is fresh", async () => {
    await loadCapabilityPolicy("o-inv", clientReturning(A));
    expect((await loadCapabilityPolicy("o-inv", clientReturning(B))).caps?.["ticket.assign"]).toEqual(["Admin"]);
    invalidateCapabilityPolicy("o-inv");
    expect((await loadCapabilityPolicy("o-inv", clientReturning(B))).caps?.["ticket.assign"]).toEqual(["DocCtrl"]);
  });
  it("done-when 3: a sessionless read on the server (no client → the browser singleton) returns defaults for THIS call and is never cached", async () => {
    state.browserRows.org_configurations = []; // RLS with no session: nothing comes back
    const poisoned = await loadCapabilityPolicyEntry("o-poison");
    expect(poisoned.policy).toEqual({ caps: {}, grants: [] });
    expect(poisoned.version).toBeNull();
    // Had that been cached, the stored narrowing would be invisible for the TTL.
    expect((await loadCapabilityPolicy("o-poison", clientReturning(A))).caps?.["ticket.assign"]).toEqual(["Admin"]);
  });
  it("an errored read still returns defaults without caching; parseStoredCapabilityPolicy reads both stored shapes", async () => {
    const errored = { data: null, error: { message: "boom" } };
    expect((await loadCapabilityPolicyEntry("o-err", clientReturning(errored)))).toEqual({ policy: {}, version: null });
    expect((await loadCapabilityPolicy("o-err", clientReturning(A))).caps?.["ticket.assign"]).toEqual(["Admin"]);
    expect(parseStoredCapabilityPolicy({ "ticket.assign": ["Admin"], nope: ["x"] })).toEqual({ caps: { "ticket.assign": ["Admin"] }, grants: [] });
    expect(parseStoredCapabilityPolicy({ caps: { "ticket.assign": ["Admin"] }, grants: [{ cap: "nope", uid: "u" }, { cap: "ticket.assign" }, { cap: "ticket.assign", uid: "u" }] }))
      .toEqual({ caps: { "ticket.assign": ["Admin"] }, grants: [{ cap: "ticket.assign", uid: "u" }] });
    expect(parseStoredCapabilityPolicy(null)).toEqual({ caps: {}, grants: [] });
  });
  it("the residual window is documented exactly and the workflow route reads the versioned entry", () => {
    const cp = src("lib/capabilityPolicy.ts");
    expect(cp).toMatch(/a warm serverless instance OTHER than the one that served the write keeps\n\/\/ its entry for at most SERVER_CACHE_TTL_MS after the write/);
    expect(cp).toContain("const sessionless = !client && typeof window === \"undefined\";");
    expect(cp).toContain("if (!sessionless) cache.set(orgId, { at: Date.now(), policy, version });");
    const r = src("app/api/tickets/workflow-action/route.ts");
    expect(r).toContain("const { policy: capPolicy, version: policyVersion } = await loadCapabilityPolicyEntry(ticket.orgId, supabaseAdmin);");
    expect(r).not.toContain("loadCapabilityPolicy(ticket.orgId");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WF-11 — POST /api/admin/capability-policy
// ═══════════════════════════════════════════════════════════════════════════
const STORED: CapabilityPolicy = {
  caps: { "ticket.assign": ["Admin", "Manager", "Supervisor", "DraftingSupervisor"], "ticket.manage": ["Admin", "Manager", "Supervisor"] },
  grants: [
    { cap: "ticket.assign", uid: "v1", expiresAt: PAST, grantedBy: "a1", grantedAt: PAST },
    { cap: "ticket.assign", uid: "v2", expiresAt: null, grantedBy: "a1", grantedAt: PAST },
  ],
};
const LIVE_V2 = STORED.grants![1];
function seedPolicyOrg() {
  state.rows.org_members = [member("a1", "Admin"), member("c1", "DocCtrl"), member("m1", "Manager", ["Manager", "DocCtrl"]), member("v1", "Viewer"), member("v2", "Viewer"), member("d1", "Drafter")];
  state.rows.org_configurations = [config(STORED)];
}

describe("WF-11 — the policy route: who may write, and what", () => {
  beforeEach(seedPolicyOrg);

  it("401 without a bearer / with a bad token; 403 for a non-member and for a non-controller", async () => {
    expect((await policy({ op: "save", orgId: "o1", caps: {} }, "")).status).toBe(401);
    expect((await policy({ op: "save", orgId: "o1", caps: {} })).status).toBe(401);
    state.user = { id: "zz" };
    expect((await policy({ op: "save", orgId: "o1", caps: {} })).status).toBe(403);
    state.user = { id: "d1" };
    const r = await policy({ op: "save", orgId: "o1", caps: {} });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/only Admin or DocCtrl/);
    expect(updates("org_configurations")).toHaveLength(0);
    expect(inserts("audit_logs")).toHaveLength(0);
    // bad op / missing org
    state.user = { id: "a1" };
    expect((await policy({ op: "nope", orgId: "o1" })).status).toBe(400);
    expect((await policy({ op: "save", caps: {} })).status).toBe(400);
  });

  it("a DocCtrl (headline Manager, additive DocCtrl — the collection) saves a non-critical change: CAS write, grants preserved, expired grant pruned, audit row", async () => {
    state.user = { id: "m1" };
    const res = await policy({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin", "DocCtrl"], "ticket.manage": ["Admin", "Manager", "Supervisor"] } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.pruned).toBe(1);
    expect(json.policy).toEqual({ caps: { "ticket.assign": ["Admin", "DocCtrl"], "ticket.manage": ["Admin", "Manager", "Supervisor"] }, grants: [LIVE_V2] });
    const [upd] = updates("org_configurations");
    expect(upd.data).toEqual(json.policy);
    // compare-and-set on the stamp that was read
    expect(state.calls.some((c) => c.table === "org_configurations" && c.method === "eq" && c.args[0] === "updated_at" && c.args[1] === "2026-09-01T00:00:00.000000+00:00")).toBe(true);
    const [audit] = inserts("audit_logs");
    expect(audit.action).toBe("CAPABILITY_POLICY_CHANGED");
    expect(audit.user_id).toBe("m1");
    expect(audit.resource_type).toBe("org_configuration");
    const d = audit.details as Record<string, unknown>;
    expect(d.op).toBe("save");
    expect(d.via).toBe("route");
    expect(d.before).toEqual(STORED);
    expect(d.after).toEqual(json.policy);
    expect(d.pruned).toEqual([STORED.grants![0]]);
  });

  it("done-when 2: a critical capability is Admin's to change — a DocCtrl is refused (403), writing the default explicitly is not a change, an Admin may", async () => {
    state.user = { id: "c1" };
    const refused = await policy({ op: "save", orgId: "o1", caps: { "ticket.manage": ["Admin", "DocCtrl"] } });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toMatch(/Only an Admin may change a critical capability \(Management override\)/);
    expect(updates("org_configurations")).toHaveLength(0);
    // the shipped default for an absent critical key, written explicitly, is no change
    const same = await policy({ op: "save", orgId: "o1", caps: { "ticket.force_close": ["Admin", "Manager", "Supervisor"], "ticket.reassign_engineer": ["Admin"] } });
    expect(same.status).toBe(200);
    state.calls = [];
    state.user = { id: "a1" };
    expect((await policy({ op: "save", orgId: "o1", caps: { "ticket.manage": ["Admin", "DocCtrl"] } })).status).toBe(200);
    expect(updates("org_configurations")).toHaveLength(1);
  });

  it("done-when 1: validateCapabilityPolicy runs on the server — an Admin removing Admin from a critical capability gets 400 and nothing is written", async () => {
    state.user = { id: "a1" };
    const res = await policy({ op: "save", orgId: "o1", caps: { "ticket.force_close": ["Manager"] } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Admin cannot be removed from a critical capability/);
    expect(updates("org_configurations")).toHaveLength(0);
    expect(inserts("audit_logs")).toHaveLength(0);
    // a scoped rule is a second door: refused too
    const scoped = await policy({ op: "save", orgId: "o1", caps: { "ticket.manage": [{ tokens: ["Admin"] }, { tokens: ["DocCtrl"], when: { requestType: ["ASBUILT"] } }] } });
    expect(scoped.status).toBe(400);
    expect((await policy({ op: "save", orgId: "o1", caps: "nope" })).status).toBe(400);
    expect((await policy({ op: "save", orgId: "o1", caps: { "ticket.assign": "Admin" } })).status).toBe(400);
  });

  it("done-when 2/3: ANY grant is Admin-only, a self-grant is refused, the target must be an active member, the expiry must be valid and future", async () => {
    state.user = { id: "c1" };
    const doc = await policy({ op: "grant", orgId: "o1", uid: "v1", cap: "ticket.manage" });
    expect(doc.status).toBe(403);
    expect((await doc.json()).error).toMatch(/Only an Admin may grant or revoke/);
    expect((await policy({ op: "revoke", orgId: "o1", uid: "v2", cap: "ticket.assign" })).status).toBe(403);
    state.user = { id: "a1" };
    const self = await policy({ op: "grant", orgId: "o1", uid: "a1", cap: "ticket.manage" });
    expect(self.status).toBe(403);
    expect((await self.json()).error).toMatch(/cannot grant a permission to yourself/);
    expect((await policy({ op: "grant", orgId: "o1", uid: "ghost", cap: "ticket.manage" })).status).toBe(400);
    expect((await policy({ op: "grant", orgId: "o1", uid: "v1", cap: "nope" })).status).toBe(400);
    expect((await policy({ op: "grant", orgId: "o1", uid: "v1", cap: "ticket.assign", expiresAt: "not-a-date" })).status).toBe(400);
    expect((await policy({ op: "grant", orgId: "o1", uid: "v1", cap: "ticket.assign", expiresAt: PAST })).status).toBe(400);
    expect((await policy({ op: "grant", orgId: "o1", uid: "", cap: "ticket.assign" })).status).toBe(400);
    expect(updates("org_configurations")).toHaveLength(0);
    expect(inserts("audit_logs")).toHaveLength(0);
  });

  it("an Admin's grant replaces the (person, capability) pair, is stamped by the server, keeps other live grants, prunes the expired one, and is audited", async () => {
    state.user = { id: "a1" };
    const res = await policy({ op: "grant", orgId: "o1", uid: "v1", cap: "ticket.assign", expiresAt: FUTURE, note: " cover for Sam " });
    expect(res.status).toBe(200);
    const { policy: after } = await res.json() as { policy: CapabilityPolicy };
    expect(after.caps).toEqual(STORED.caps);
    expect(after.grants).toHaveLength(2);
    expect(after.grants![0]).toEqual(LIVE_V2);
    const g = after.grants![1];
    expect(g).toMatchObject({ cap: "ticket.assign", uid: "v1", expiresAt: FUTURE, note: "cover for Sam", grantedBy: "a1" });
    expect(Number.isNaN(Date.parse(g.grantedAt!))).toBe(false);
    const [audit] = inserts("audit_logs");
    const d = audit.details as Record<string, unknown>;
    expect(d.op).toBe("grant");
    expect(d.grant).toEqual(g);
    expect(d.pruned).toEqual([STORED.grants![0]]);
    expect(policyAllows(after, "ticket.assign", "Viewer", null, "v1")).toBe(true);
  });

  it("revoke removes the pair and names it in the audit row; a first-ever policy is INSERTed", async () => {
    state.user = { id: "a1" };
    const res = await policy({ op: "revoke", orgId: "o1", uid: "v2", cap: "ticket.assign" });
    expect(res.status).toBe(200);
    const { policy: after } = await res.json() as { policy: CapabilityPolicy };
    expect(after.grants).toEqual([]);
    expect((inserts("audit_logs")[0].details as Record<string, unknown>).revoked).toEqual(LIVE_V2);
    // no stored row yet → insert, not update
    state.calls = [];
    state.rows.org_configurations = [];
    expect((await policy({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin"] } })).status).toBe(200);
    expect(updates("org_configurations")).toHaveLength(0);
    const [ins] = inserts("org_configurations");
    expect(ins).toMatchObject({ org_id: "o1", key: "capability_policy", data: { caps: { "ticket.assign": ["Admin"] }, grants: [] } });
  });

  it("done-when 2 of WF-16: a concurrent write is a 409 — nothing lost, nothing audited; an audit failure is surfaced, never swallowed", async () => {
    state.user = { id: "a1" };
    state.conflict = true;
    const res = await policy({ op: "grant", orgId: "o1", uid: "v1", cap: "ticket.assign" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed while you were editing/);
    expect(inserts("audit_logs")).toHaveLength(0);
    state.calls = [];
    state.auditError = { message: "audit down" };
    const failed = await policy({ op: "grant", orgId: "o1", uid: "v1", cap: "ticket.assign" });
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toMatch(/saved, but its audit row could not be written \(audit down\)/);
  });

  it("done-when of WF-10: a write invalidates this process's cache", async () => {
    const stale = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { data: { caps: { "ticket.assign": ["Viewer"] } }, updated_at: "x" }, error: null }) }) }) }) }) } as never;
    expect((await loadCapabilityPolicy("o1", stale)).caps?.["ticket.assign"]).toEqual(["Viewer"]);
    state.user = { id: "a1" };
    expect((await policy({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin"] } })).status).toBe(200);
    const fresh = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { data: { caps: { "ticket.assign": ["Admin"] } }, updated_at: "y" }, error: null }) }) }) }) }) } as never;
    expect((await loadCapabilityPolicy("o1", fresh)).caps?.["ticket.assign"]).toEqual(["Admin"]);
  });

  it("the browser helpers post to the route with the session bearer and surface the server's error; no direct table write remains", async () => {
    type FakeResponse = { ok: boolean; status: number; json: () => Promise<Record<string, unknown>> };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit): Promise<FakeResponse> => ({
      ok: true, status: 200, json: async () => ({ ok: true, policy: { caps: {}, grants: [] }, body: init.body }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      state.session = { access_token: "sess-1" };
      await saveCapabilityPolicy({ orgId: "o1", policy: { caps: { "ticket.assign": ["Admin"] }, grants: [LIVE_V2] }, actorUserId: "a1" });
      await addUserGrant({ orgId: "o1", uid: "v1", cap: "ticket.assign", expiresAt: FUTURE, note: "n", actorUserId: "a1" });
      await revokeUserGrant({ orgId: "o1", uid: "v1", cap: "ticket.assign", actorUserId: "a1" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
      expect(bodies[0]).toEqual({ op: "save", orgId: "o1", caps: { "ticket.assign": ["Admin"] } }); // grants are the server's
      expect(bodies[1]).toEqual({ op: "grant", orgId: "o1", uid: "v1", cap: "ticket.assign", expiresAt: FUTURE, note: "n" });
      expect(bodies[2]).toEqual({ op: "revoke", orgId: "o1", uid: "v1", cap: "ticket.assign" });
      for (const c of fetchMock.mock.calls) {
        expect(c[0]).toBe(CAPABILITY_POLICY_ROUTE);
        expect((c[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer sess-1" });
      }
      // the client-side rail still speaks first, without a round-trip
      await expect(saveCapabilityPolicy({ orgId: "o1", policy: { caps: { "ticket.manage": ["Manager"] } }, actorUserId: "a1" })).rejects.toThrow(/Admin cannot be removed/);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 403, json: async () => ({ error: "You cannot grant a permission to yourself — ask another Admin." }) }));
      await expect(addUserGrant({ orgId: "o1", uid: "a1", cap: "ticket.manage", actorUserId: "a1" })).rejects.toThrow(/cannot grant a permission to yourself/);
      state.session = null;
      await expect(revokeUserGrant({ orgId: "o1", uid: "v1", cap: "ticket.assign", actorUserId: "a1" })).rejects.toThrow(/Not signed in/);
    } finally { vi.unstubAllGlobals(); }
    const cp = src("lib/capabilityPolicy.ts");
    expect(cp).not.toMatch(/\.upsert\(/);
    expect(cp).not.toMatch(/from\("audit_logs"\)/);
    expect(state.calls.filter((c) => c.table === "org_configurations" && (c.method === "update" || c.method === "upsert" || c.method === "insert"))).toHaveLength(0);
  });
});

describe("20261056 — the write guard at the database", () => {
  const m56 = mig("20261056_rp_roundE_capability_policy_write_guard.sql");
  const fn = between(m56, "CREATE OR REPLACE FUNCTION capability_policy_write_guard", "DROP TRIGGER IF EXISTS");
  it("is a pinned SECURITY DEFINER trigger function with the service pass and the controller check", () => {
    expect(fn).toMatch(/RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
    expect(fn).toContain("IF auth.uid() IS NULL THEN RETURN NEW; END IF;");
    expect(fn).toContain("IF NEW.key <> 'capability_policy' THEN RETURN NEW; END IF;");
    expect(fn).toMatch(/IF NOT is_org_controller\(NEW\.org_id\) THEN\s*\n\s*RAISE EXCEPTION 'Only an Admin or DocCtrl may change the capability policy'/);
    expect(fn).toContain("v_admin := caller_holds_any_role(NEW.org_id, ARRAY['Admin']::text[]);");
  });
  it("its critical list is CAPABILITY_DEFS critical: true, in order; Admin stays on the bare list AND on every rule; a change is Admin's", () => {
    const critical = CAPABILITY_DEFS.filter((d) => d.critical).map((d) => `'${d.id}'`).join(", ");
    expect(fn).toContain(`FOREACH v_cap IN ARRAY ARRAY[${critical}] LOOP`);
    expect(fn).toContain("v_entry := COALESCE(NEW.data->'caps'->v_cap, NEW.data->v_cap);");
    expect(fn).toMatch(/IF v_entry IS DISTINCT FROM v_old_entry AND NOT v_admin THEN\s*\n\s*RAISE EXCEPTION 'Only an Admin may change a critical capability/);
    expect(fn).toContain("IF v_tokens IS NULL OR jsonb_typeof(v_tokens) <> 'array' OR NOT (v_tokens ? 'Admin' OR v_tokens ? '*') THEN");
    expect(fn).toContain("ELSIF NOT (v_entry ? 'Admin' OR v_entry ? '*') THEN");
    expect((fn.match(/Admin cannot be removed from a critical capability/g) ?? []).length).toBe(2);
  });
  it("grants: any change requires Admin; a new grant to auth.uid() is a refused self-grant; the direct write is audited in-transaction", () => {
    expect(fn).toContain("IF COALESCE(NEW.data->'grants', '[]'::jsonb) IS DISTINCT FROM COALESCE(v_old->'grants', '[]'::jsonb) THEN");
    expect(fn).toMatch(/IF NOT v_admin THEN\s*\n\s*RAISE EXCEPTION 'Only an Admin may grant or revoke a personal permission'/);
    expect(fn).toContain("IF v_grant->>'uid' = auth.uid()::text");
    expect(fn).toContain("AND NOT (COALESCE(v_old->'grants', '[]'::jsonb) @> jsonb_build_array(v_grant)) THEN");
    expect(fn).toContain("RAISE EXCEPTION 'A personal permission cannot be granted to yourself'");
    expect(fn).toContain("INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)");
    expect(fn).toContain("VALUES ('CAPABILITY_POLICY_CHANGED', 'org_configuration', NEW.org_id::text, NEW.org_id, auth.uid(), v_email, v_role,");
    expect(fn).toContain("jsonb_build_object('op', lower(TG_OP), 'via', 'direct_write', 'before', v_old, 'after', NEW.data)");
    expect(fn).toContain("v_old := CASE WHEN TG_OP = 'UPDATE' THEN OLD.data ELSE NULL END;");
  });
  it("installs BEFORE INSERT OR UPDATE keyed to the capability_policy row; narrowing only (no TEMP TABLE needed)", () => {
    const trg = between(m56, "CREATE TRIGGER trg_capability_policy_write_guard", ";");
    expect(trg).toMatch(/BEFORE INSERT OR UPDATE ON org_configurations\s*\n\s*FOR EACH ROW\s*\n\s*WHEN \(NEW\.key = 'capability_policy'\)\s*\n\s*EXECUTE FUNCTION capability_policy_write_guard\(\)/);
    expect(m56).toContain("DROP TRIGGER IF EXISTS trg_capability_policy_write_guard ON org_configurations;");
    expect(m56).toMatch(/Widening: no/);
    expect(m56).not.toMatch(/TEMP TABLE/);
  });
  it("one paste: BEGIN/COMMIT around the DDL, one final SELECT — 6 probes (ok), 4 aggregate counts (n text), read-only, deparsed-safe", () => {
    expect(m56.indexOf("BEGIN;")).toBeLessThan(m56.indexOf("CREATE OR REPLACE FUNCTION"));
    expect(m56.indexOf("COMMIT;")).toBeGreaterThan(m56.indexOf("CREATE TRIGGER"));
    expect(m56.indexOf("COMMIT;")).toBeLessThan(m56.indexOf("-- ── Verification"));
    const tail = m56.slice(m56.indexOf("COMMIT;") + "COMMIT;".length);
    expect((noLiterals(tail).match(/;/g) ?? []).length).toBe(1);
    expect((tail.match(/UNION ALL/g) ?? []).length).toBe(9);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,[\s\S]*NULL::text AS n/);
    expect(noLiterals(tail)).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/);
    expect(tail).toContain("tgname = 'trg_capability_policy_write_guard'");
    expect(tail).toContain("pg_get_function_identity_arguments(p.oid) = 'p_org uuid, p_roles text[]'");
    expect(tail).toContain("policyname IN ('org_config_cap_policy_insert', 'org_config_cap_policy_update', 'org_config_cap_policy_delete')");
    // pg_policies probes never LIKE a bare cast (deparsed qual/with_check)
    expect(tail).not.toMatch(/(qual|with_check) LIKE/);
    expect((tail.match(/COUNT\(\*\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(tail).not.toMatch(/SELECT \*|SELECT data\b|SELECT c\.data\b/);
    expect(tail).toContain("deferred from 20261052");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WF-16 — the workflow route audits WHY an action was permitted
// ═══════════════════════════════════════════════════════════════════════════
const ticketRow = (over: Record<string, unknown>) => ({
  id: "t1", org_id: "o1", ticket_id: "REQ-1", title: "x", status: "PENDING_ASSIGNMENT", request_type: "ISO", unit: "U-100",
  requester_id: "req-1", requester_role: "Requester", assigned_drafter_id: null, assigned_engineer_id: null,
  attachments: [], history: [], watchers: [], unread_by: [], comments: [], ...over,
});
const authorityOf = () => (inserts("audit_logs").find((a) => String(a.action).startsWith("TICKET_"))!.details as { authority: Record<string, unknown> }).authority;

describe("WF-16 — grant use is audited on the workflow route", () => {
  beforeEach(() => {
    state.rows.org_members = [member("a1", "Admin"), member("req-1", "Requester"), member("d1", "Drafter"), member("v1", "Viewer"), member("v3", "Viewer")];
    state.rows.tickets = [ticketRow({})];
  });
  it("decisiveGrants names the grant without which the action would not be offered — and nothing when roles already suffice", () => {
    const t = ticket({ status: "PENDING_ASSIGNMENT", assignedDrafterId: null });
    const g = { cap: "ticket.assign" as const, uid: "v1", expiresAt: null };
    const p: CapabilityPolicy = { grants: [g, { cap: "ticket.self_assign", uid: "v1", expiresAt: null }, { cap: "ticket.assign", uid: "v1", expiresAt: PAST }] };
    expect(decisiveGrants(t, "Viewer" as Role, "v1", p, { userRoles: ["Viewer" as Role] }, "assign")).toEqual([g]);
    expect(decisiveGrants(t, "Viewer" as Role, "v1", p, { userRoles: ["Viewer" as Role] }, "self_assign")).toEqual([p.grants![1]]);
    expect(decisiveGrants(t, "Admin" as Role, "v1", p, { userRoles: ["Admin" as Role] }, "assign")).toEqual([]);
    expect(decisiveGrants(t, "Viewer" as Role, "v1", undefined, undefined, "assign")).toEqual([]);
    // two grants each sufficient (a co-reviewer approves via direct_approve OR
    // manage): neither is individually decisive → both named
    const review = ticket({ status: "PENDING_REVIEW" });
    const both: CapabilityPolicy = { grants: [{ cap: "ticket.manage", uid: "v1", expiresAt: null }, { cap: "ticket.direct_approve", uid: "v1", expiresAt: null }] };
    expect(decisiveGrants(review, "Viewer" as Role, "v1", both, { userRoles: ["Viewer" as Role] }, "approve_draft_ifc")).toEqual(both.grants);
    expect(decisiveGrants(review, "Viewer" as Role, "v1", { grants: [both.grants![1]] }, { userRoles: ["Viewer" as Role] }, "approve_draft_ifc")).toEqual([both.grants![1]]);
  });
  it("a Viewer admitted by a personal grant: the TICKET_ASSIGN audit row says via 'grant' and names the grant", async () => {
    state.user = { id: "v1" };
    const grant = { cap: "ticket.assign", uid: "v1", expiresAt: FUTURE, grantedBy: "a1", grantedAt: PAST, note: "covering assignments" };
    state.rows.org_configurations = [config({ grants: [grant] }, "2026-09-10T00:00:00+00:00")];
    const res = await workflow({ ticketId: "t1", actionType: "assign", assignment: { id: "d1", name: "d1" } });
    expect(res.status).toBe(200);
    const authority = authorityOf();
    expect(authority.via).toBe("grant");
    expect(authority.grants).toEqual([{ cap: "ticket.assign", expiresAt: FUTURE, grantedBy: "a1", grantedAt: PAST, note: "covering assignments" }]);
    expect(authority.roles).toEqual(["Viewer"]);
    expect(authority.policyVersion).toBe("2026-09-10T00:00:00+00:00");
    expect(authority.identity).toBeUndefined();
  });
  it("an Admin doing the same: via 'role', no grant named; the assigned drafter's own action carries its identity relation", async () => {
    state.user = { id: "a1" };
    state.rows.org_configurations = [config({ grants: [{ cap: "ticket.assign", uid: "a1", expiresAt: null }] })];
    expect((await workflow({ ticketId: "t1", actionType: "assign", assignment: { id: "d1", name: "d1" } })).status).toBe(200);
    const admin = authorityOf();
    expect(admin.via).toBe("role");
    expect(admin.grants).toBeUndefined();
    expect(admin.roles).toEqual(["Admin"]);
    state.calls = [];
    state.user = { id: "d1" };
    state.rows.tickets = [ticketRow({ status: "DRAFTING", assigned_drafter_id: "d1" })];
    expect((await workflow({ ticketId: "t1", actionType: "save_progress" })).status).toBe(200);
    const drafter = authorityOf();
    expect(drafter.via).toBe("role");
    expect(drafter.identity).toEqual(["drafter"]);
  });
  it("the audit write stays server-side and carries the authority field (verified-sound item 5)", () => {
    const r = src("app/api/tickets/workflow-action/route.ts");
    expect(r).toContain("const usedGrants = decisiveGrants(ticket, callerRole, caller.id, capPolicy, engineCtx, action.action);");
    expect(r).toContain("details: { from: ticket.status, to: newStatus, label: action.label, authority },");
  });
});
