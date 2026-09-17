// Round E — package D (roles & admin): ROLE-1..5, DOCACL-3, SURF-9 + WF-20.
//
//   * ROLE-1: the dormant department labels keep their ONE job — being
//     named: as a content-ACL role subject (binds by collection) and as a
//     capability-policy token, including a request-type override.
//   * ROLE-2: the four Engineer tiers are one role wearing four labels —
//     recorded at the type; nothing outside ROLE_RANK treats them as ranks.
//   * ROLE-3: Requester vs the department labels — WF-8 already made the
//     review right identity-bound; the difference is now documented.
//   * ROLE-5: Viewer / Auditor subtract the SAME way everywhere — one
//     helper, deny-if-any, no controller escape; audit-page admission is the
//     `admin.audit_view` capability.
//   * SURF-9 / WF-20: ONE server-enforced admin gate — the registry, the
//     evaluator (grants honoured, fail closed), the route, and the layout.
//   * DOCACL-3 / DEC-43: controllers are unscoped by design; a controller
//     read that only the bypass allowed is audited at the bytes egress.
// (ROLE-4's picker roster is pinned in rolePickerCensus.test.ts.)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { ALL_ROLES, type Role, type Ticket, type AccessControl } from "@/types/schema";
import {
  ROLE_CAPABILITIES, ENGINEER_TIER_ROLES, DORMANT_ROLES, capabilitiesAdded, pickerNote, DORMANT_ROLE_JOB, REQUESTER_ROLE_NOTE,
} from "@/lib/roleCapabilities";
import { READ_ONLY_ROLES, holdsReadOnlyRole } from "@/lib/roleHeld";
import {
  CAPABILITY_DEFS, policyAllows, roleTokenMatches, tokensFor, normalizeStoredPolicy, __resetCapabilityPolicyCache, type CapabilityPolicy,
} from "@/lib/capabilityPolicy";
import { canServeContent, canWithAclChain, controllerBypassDecided } from "@/lib/permissions";
import { WorkflowEngine } from "@/lib/workflow";
import { ADMIN_SURFACES, adminSurface, adminSurfaceForPath, adminSurfaceAllows } from "@/lib/adminSurfaces";
import { POLICY_TOKENS } from "@/components/permissions/CapabilityPolicyEditor";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const setEq = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

/** Every string-literal array (`[...]`) or Set literal in a source file, as a
 *  role set — both quote styles, so a page's own gate can be compared to the
 *  registry whatever style it uses. */
function roleSetsIn(source: string): string[][] {
  const out: string[][] = [];
  for (const m of source.matchAll(/\[([^[\]]*)\]/g)) {
    const strings = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    if (strings.length > 0) out.push(strings);
  }
  return out;
}
const sourceHasRoleSet = (source: string, roles: readonly string[]) => roleSetsIn(source).some((s) => setEq(s, roles));

const P = (role: Role, roles?: Role[], extra: Partial<{ uid: string; teamIds: string[] }> = {}) => ({
  uid: extra.uid ?? "u1", role, roles, orgId: "org1", teamIds: extra.teamIds ?? [], isActiveMember: true,
});
const acl = (rules: AccessControl["rules"]): AccessControl => ({ rules });

// ── ROLE-1 ──────────────────────────────────────────────────────────────────
describe("ROLE-1 — a dormant department label is addressable: ACL subject and policy token", () => {
  it("the policy editor's token list names every dormant role; every role in ALL_ROLES is reachable through some token (tiers via `Engineer`)", () => {
    for (const r of DORMANT_ROLES) expect(POLICY_TOKENS).toContain(r);
    for (const r of ALL_ROLES) expect(POLICY_TOKENS.some((t) => t !== "*" && roleTokenMatches(t, r)), r).toBe(true);
    for (const tier of ENGINEER_TIER_ROLES) expect(POLICY_TOKENS).not.toContain(tier); // DEC-4: one token, four labels
    expect(POLICY_TOKENS[0]).toBe("*");
  });
  it("a request-type override may name a department: ['Requester','Safety'] reviews INCIDENT, not ISO; Requester alone does not", () => {
    const p: CapabilityPolicy = { caps: { "ticket.initial_review": [
      { tokens: ["Admin", "Manager", "Supervisor", "Engineer"] },
      { tokens: ["Safety"], when: { requestType: ["INCIDENT"] } },
    ] } };
    expect(policyAllows(p, "ticket.initial_review", "Requester", ["Requester", "Safety"], "s1", { requestType: "INCIDENT" })).toBe(true);
    expect(policyAllows(p, "ticket.initial_review", "Requester", ["Requester", "Safety"], "s1", { requestType: "ISO" })).toBe(false);
    expect(policyAllows(p, "ticket.initial_review", "Requester", ["Requester"], "s2", { requestType: "INCIDENT" })).toBe(false);
    // the headline is irrelevant — Safety held anywhere in the collection matches (CHAIN-1)
    expect(policyAllows(p, "ticket.initial_review", "Safety", null, "s3", { requestType: "INCIDENT" })).toBe(true);
  });
  it("an ACL rule naming Safety reaches a member holding it additively (headline Requester) — allow AND deny", () => {
    const allowRead = acl([{ effect: "allow", subject: { type: "role", id: "Safety" }, actions: ["read"] }]);
    expect(canServeContent({ principal: P("Requester", ["Requester", "Safety"]), aclChain: [allowRead], visibility: "private" })).toBe(true);
    expect(canServeContent({ principal: P("Requester", ["Requester"]), aclChain: [allowRead], visibility: "private" })).toBe(false);
    const denyWrite = acl([
      { effect: "allow", subject: { type: "role", id: "Requester" }, actions: ["write"] },
      { effect: "deny", subject: { type: "role", id: "Safety" }, actions: ["write"] },
    ]);
    expect(canWithAclChain({ principal: P("Requester", ["Requester", "Safety"]), action: "write", aclChain: [denyWrite], defaultAllow: true })).toBe(false);
    expect(canWithAclChain({ principal: P("Requester", ["Requester"]), action: "write", aclChain: [denyWrite], defaultAllow: true })).toBe(true);
    // and the database's node_visible evaluates every held role (20261041)
    expect(src("supabase/migrations/20261041_rp_phase5_node_visible_additive.sql")).toContain("FROM unnest(v_roles) r");
  });
  it("the picker says what the job is", () => {
    for (const r of DORMANT_ROLES) expect(pickerNote(r, ["Requester"])).toContain(DORMANT_ROLE_JOB);
    expect(DORMANT_ROLE_JOB).toMatch(/request-type override/);
  });
});

// ── ROLE-2 ──────────────────────────────────────────────────────────────────
describe("ROLE-2 / DEC-4 — the Engineer tiers are one role with four labels", () => {
  it("identical capabilities, one matching token, no tier adds anything over another", () => {
    const base = JSON.stringify(ROLE_CAPABILITIES["Engineer-1"]);
    for (const t of ENGINEER_TIER_ROLES) {
      expect(JSON.stringify(ROLE_CAPABILITIES[t])).toBe(base);
      expect(roleTokenMatches("Engineer", t)).toBe(true);
      for (const u of ENGINEER_TIER_ROLES) expect(capabilitiesAdded(t, [u])).toEqual([]);
    }
    expect(ENGINEER_TIER_ROLES).toEqual(["Engineer-1", "Engineer-2", "Engineer-3", "Engineer-4"]);
  });
  it("the decision is recorded AT THE TYPE, and the documented contract is a string match on 'Engineer'", () => {
    const t = src("types/schema.ts");
    const i = t.indexOf('| "Engineer-1"');
    expect(t.slice(Math.max(0, i - 800), i)).toMatch(/DEC-4 \/ ROLE-2: Engineer-1\.\.4 are ONE role wearing four LABELS/);
    expect(src("lib/workflow.ts")).toContain('return !!role && role.includes("Engineer");');
  });
  it("the library wizard's default upload set names all four tiers (it named two — the tiers as ranks)", () => {
    const w = src("app/(protected)/admin/libraries/LibraryWizard.tsx");
    expect((w.match(/\["DocCtrl", "Admin", \.\.\.ENGINEER_TIER_ROLES\]/g) ?? []).length).toBe(2);
    expect(w).not.toMatch(/\["DocCtrl", "Admin", "Engineer-1", "Engineer-2"\]/);
  });
});

// ── ROLE-3 ──────────────────────────────────────────────────────────────────
describe("ROLE-3 — Requester vs the department labels", () => {
  const t = (over: Partial<Ticket>): Ticket => ({
    id: "t1", orgId: "o1", status: "PENDING_REVIEW", requesterId: "req-1", requesterRole: "Requester",
    requestType: "ISO", unit: "U-100", assignedDrafterId: "d-1", assignedEngineerId: null, attachments: [], ...over,
  } as unknown as Ticket);
  const acts = (tk: Ticket, role: string, uid: string, roles: string[] = [role]) =>
    WorkflowEngine.getActions(tk, role as Role, uid, undefined, { userRoles: roles as Role[], activeMemberCount: 5 }).map((a) => a.action);

  it("reviewing someone else's returned draft needs identity (WF-8): a Requester stranger gets nothing; a Safety stranger gets nothing; the requester keeps it", () => {
    expect(acts(t({}), "Requester", "stranger")).toEqual([]);
    expect(acts(t({}), "Requester", "stranger", ["Requester", "Safety"])).toEqual([]);
    expect(acts(t({}), "Requester", "req-1")).toContain("request_revision");
    // the role-wide default is unchanged and only substitutes on a requester-less ticket
    expect(tokensFor({}, "ticket.requester_review")).toEqual(["Requester"]);
    expect(acts(t({ requesterId: null as unknown as string }), "Requester", "stranger")).toContain("request_revision");
    expect(acts(t({ requesterId: null as unknown as string }), "Safety", "stranger")).toEqual([]);
  });
  it("the difference is documented where the roster is read: the capability map, the picker note, the in-app role model", () => {
    const rc = src("lib/roleCapabilities.ts");
    expect(rc).toMatch(/ROLE-3: `Requester` is the "may file requests" marker AND the shipped/);
    expect(pickerNote("Requester", ["Drafter"])).toBe(REQUESTER_ROLE_NOTE);
    const tree = src("components/permissions/RoleModelTree.tsx");
    expect(tree).toContain("Dormant department labels (DEC-3): identical to Requester in authority, in no policy default.");
    expect(tree).toContain("never someone else's ticket (WF-8)");
    expect(tree).toContain("A capability-policy token — including a request-type override — may name it");
  });
});

// ── ROLE-5 ──────────────────────────────────────────────────────────────────
describe("ROLE-5 — Viewer and Auditor subtract the same way at every restriction-style check", () => {
  it("holdsReadOnlyRole: deny-if-any across the collection, no headline shortcut, no controller escape", () => {
    expect(READ_ONLY_ROLES).toEqual(["Viewer", "Auditor"]);
    expect(holdsReadOnlyRole(["Drafter", "Viewer"])).toBe(true);
    expect(holdsReadOnlyRole(["Auditor", "Requester"])).toBe(true);
    expect(holdsReadOnlyRole(["Admin", "Auditor"])).toBe(true);
    expect(holdsReadOnlyRole(["Admin", "DocCtrl", "Drafter"])).toBe(false);
    expect(holdsReadOnlyRole([])).toBe(false);
    expect(holdsReadOnlyRole(null)).toBe(false);
  });
  it("the three client restriction sites use the one helper (the document gate lost its controller escape; the DB assets overlay already had none)", () => {
    const docs = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(docs).toMatch(/canEdit=\{!holdsReadOnlyRole\(roles\)\}/);
    expect(docs).not.toMatch(/canEdit=\{isController \|\| !hasAnyRole\(\["Viewer", "Auditor"\]\)\}/);
    const plot = src("app/(protected)/plot-plans/[id]/page.tsx");
    expect(plot).toMatch(/const canFlip = !holdsReadOnlyRole\(roles\);/);
    expect(plot).not.toMatch(/hasAnyRole\(\["Viewer", "Auditor"\]\)/);
    const users = src("app/(protected)/admin/users/page.tsx");
    expect(users).toMatch(/memberRoles\.length > 1 && holdsReadOnlyRole\(memberRoles\)/);
    const m45 = src("supabase/migrations/20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql");
    expect(m45).toContain("NOT caller_holds_any_role(org_id, ARRAY[''Viewer'',''Auditor'']::text[])");
    // no restriction-style check anywhere else spells the pair by hand
    for (const f of ["app/(protected)/documents/[libraryId]/page.tsx", "app/(protected)/plot-plans/[id]/page.tsx", "components/navigation/Sidebar.tsx"]) {
      expect(src(f)).not.toMatch(/activeRole !== "Viewer"/);
    }
  });
  it("audit-page access is a capability: admin.audit_view, default = the roles the page hardcoded, grants honoured", () => {
    const def = CAPABILITY_DEFS.find((d) => d.id === "admin.audit_view");
    expect(def?.defaultRoles).toEqual(["Admin", "Manager", "Supervisor", "DocCtrl", "Auditor"]);
    expect(def?.critical).toBeFalsy();
    expect(policyAllows({}, "admin.audit_view", "Requester", ["Requester", "Auditor"], "a1")).toBe(true);
    expect(policyAllows({ caps: { "admin.audit_view": ["Admin"] } }, "admin.audit_view", "Auditor", null, "a1")).toBe(false);
    expect(policyAllows({ grants: [{ cap: "admin.audit_view", uid: "d1", expiresAt: null }] }, "admin.audit_view", "Drafter", null, "d1")).toBe(true);
    expect(adminSurface("audit")?.cap).toBe("admin.audit_view");
    expect(src("app/(protected)/admin/audit/page.tsx")).not.toMatch(/const ADMIN_ROLES = new Set/);
    // the loader keeps a stored entry / grant for it (the id is valid)
    expect(normalizeStoredPolicy({ caps: { "admin.audit_view": ["Admin"] }, grants: [{ cap: "admin.audit_view", uid: "d1" }] }))
      .toEqual({ caps: { "admin.audit_view": ["Admin"] }, grants: [{ cap: "admin.audit_view", uid: "d1" }] });
  });
});

// ── SURF-9 / WF-20: the registry ────────────────────────────────────────────
describe("SURF-9 — one admin-surface registry, mirroring every /admin page", () => {
  const adminDir = join(process.cwd(), "app", "(protected)", "admin");
  const pageDirs = readdirSync(adminDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(adminDir, d.name, "page.tsx"))).map((d) => d.name).sort();

  it("every /admin/<x>/page.tsx has exactly one registry entry and vice versa; keys are the path segment", () => {
    expect(ADMIN_SURFACES.map((s) => s.key).sort()).toEqual(pageDirs);
    for (const s of ADMIN_SURFACES) expect(s.path).toBe(`/admin/${s.key}`);
    expect(new Set(ADMIN_SURFACES.map((s) => s.key)).size).toBe(ADMIN_SURFACES.length);
  });
  it("adminSurfaceForPath maps a pathname (query/hash tolerated); an unknown admin path is null (the gate denies)", () => {
    expect(adminSurfaceForPath("/admin/users")?.key).toBe("users");
    expect(adminSurfaceForPath("/admin/assets?unit=U-100")?.key).toBe("assets");
    expect(adminSurfaceForPath("/admin/archive-view#top")?.key).toBe("archive-view");
    expect(adminSurfaceForPath("/admin/nope")).toBeNull();
    expect(adminSurfaceForPath("/dashboard")).toBeNull();
    expect(adminSurfaceForPath(null)).toBeNull();
  });
  it("each ENTRY / WRITES set is spelled identically in the page's own source (no surface changed who may open it)", () => {
    for (const s of ADMIN_SURFACES) {
      const page = src(`app/(protected)/admin/${s.key}/page.tsx`);
      // storage is the ONE deliberate narrowing (SURF-9's resolution states it): the page never gated
      // entry, only its writes; its entry is its stats API's set — pinned below
      if (s.entry !== "*" && !s.cap && s.key !== "storage") expect(sourceHasRoleSet(page, s.entry), `${s.key} entry`).toBe(true);
      if (s.writes) expect(sourceHasRoleSet(page, s.writes), `${s.key} writes`).toBe(true);
    }
    // the storage page's entry is what its stats API admits
    expect(sourceHasRoleSet(src("app/api/admin/storage-stats/route.ts"), adminSurface("storage")!.entry as string[])).toBe(true);
  });
  it("the API routes behind a surface use the surface's role set (pinned until they call the gate themselves — SURF-19)", () => {
    const table: Array<[string, readonly string[]]> = [
      ["app/api/admin/purge/route.ts", adminSurface("storage")!.writes!],
      ["app/api/admin/shed/route.ts", adminSurface("storage")!.writes!],
      ["app/api/admin/shed/commit/route.ts", adminSurface("storage")!.writes!],
      ["app/api/admin/archives/route.ts", adminSurface("storage")!.writes!],
      ["app/api/admin/orphans/route.ts", adminSurface("storage")!.writes!],
      ["app/api/admin/archive-settings/route.ts", adminSurface("storage")!.writes!],
      ["app/api/admin/archive-cancel/route.ts", adminSurface("storage")!.writes!],
      ["app/api/admin/ticket-shed/route.ts", adminSurface("storage")!.writes!],
      ["app/api/admin/ticket-shed/commit/route.ts", adminSurface("storage")!.writes!],
      ["app/api/admin/ticket-shed/restore/route.ts", adminSurface("storage")!.writes!],
      ["app/api/admin/restore/begin/route.ts", adminSurface("restore")!.entry as string[]],
      ["app/api/admin/restore/apply/route.ts", adminSurface("restore")!.entry as string[]],
      ["app/api/admin/restore/apply-table/route.ts", adminSurface("restore")!.entry as string[]],
      ["app/api/admin/restore/preview/route.ts", adminSurface("restore")!.entry as string[]],
      ["app/api/data-export/run/route.ts", adminSurface("data-export")!.writes!],
      ["app/api/data-export/runs/route.ts", adminSurface("data-export")!.writes!],
      ["app/api/data-export/destinations/route.ts", adminSurface("data-export")!.writes!],
      ["app/api/stripe/checkout/route.ts", adminSurface("billing")!.writes!],
      ["app/api/stripe/portal/route.ts", adminSurface("billing")!.writes!],
    ];
    for (const [file, roles] of table) {
      const m = /const [A-Z_]*ROLES = (\[[^\]]*\]);/.exec(src(file));
      expect(m, file).not.toBeNull();
      expect(setEq(JSON.parse(m![1]) as string[], roles), file).toBe(true);
    }
  });
  it("the three capability surfaces carry the page's historical default as their entry set", () => {
    for (const key of ["audit", "analytics", "archive-view"]) {
      const s = adminSurface(key)!;
      expect(s.cap).toBeDefined();
      expect(s.entry).toEqual(CAPABILITY_DEFS.find((d) => d.id === s.cap)!.defaultRoles);
    }
  });
});

describe("SURF-9 / WF-20 — adminSurfaceAllows: the single entry decision", () => {
  it("role surfaces read the FULL collection; '*' surfaces need an active member with a role; empty is denied", () => {
    const teams = adminSurface("teams")!;
    expect(adminSurfaceAllows(teams, ["Drafter", "Manager"], null, "u")).toBe(true);
    expect(adminSurfaceAllows(teams, ["Drafter"], null, "u")).toBe(false);
    expect(adminSurfaceAllows(teams, [], null, "u")).toBe(false);
    expect(adminSurfaceAllows(adminSurface("holds")!, ["Viewer"], null, "u")).toBe(true);
    expect(adminSurfaceAllows(adminSurface("holds")!, [], null, "u")).toBe(false);
    expect(adminSurfaceAllows(adminSurface("holds")!, [" ", ""], null, "u")).toBe(false);
  });
  it("capability surfaces: the shipped default, a narrowing, a per-person grant (live and expired)", () => {
    const an = adminSurface("analytics")!;
    expect(adminSurfaceAllows(an, ["Manager"], {}, "m1")).toBe(true);
    expect(adminSurfaceAllows(an, ["Drafter"], {}, "d1")).toBe(false);
    expect(adminSurfaceAllows(an, ["Viewer", "DocCtrl"], {}, "c1")).toBe(true); // headline irrelevant
    expect(adminSurfaceAllows(an, ["Manager"], { caps: { "admin.analytics_view": ["Admin"] } }, "m1")).toBe(false);
    expect(adminSurfaceAllows(an, ["Drafter"], { grants: [{ cap: "admin.analytics_view", uid: "d1", expiresAt: null }] }, "d1")).toBe(true);
    expect(adminSurfaceAllows(an, ["Drafter"], { grants: [{ cap: "admin.analytics_view", uid: "d1", expiresAt: "2000-01-01T00:00:00Z" }] }, "d1")).toBe(false);
    expect(adminSurfaceAllows(an, ["Drafter"], { grants: [{ cap: "admin.analytics_view", uid: "d1", expiresAt: null }] }, "d2")).toBe(false);
    expect(adminSurfaceAllows(an, ["Drafter"], { grants: [{ cap: "admin.analytics_view", uid: "d1", expiresAt: null }] }, null)).toBe(false);
  });
});

// ── the gate route and the analytics data route (server side) ───────────────
const state = vi.hoisted(() => ({
  actor: null as null | { userId: string; roles: string[] } | { error: string; status: number },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  errorTables: new Set<string>(),
  calls: [] as Array<{ table: string; method: string; args: unknown[]; client: "admin" | "caller" }>,
}));
/** `client` says which Supabase client issued the call: the service-role
 *  `admin` (the gate's own reads) or the `caller`-scoped one (RLS applies). */
function chain(table: string, client: "admin" | "caller" = "admin") {
  const filters: Array<[string, unknown]> = [];
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) =>
        resolve(state.errorTables.has(table) ? { data: null, error: { message: "boom" } } : { data: rows(), error: null });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args, client });
        if (prop === "eq") filters.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") {
          if (state.errorTables.has(table)) return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: rows()[0] ?? null, error: null });
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/serverAuth", () => ({
  authorizeOrgRole: vi.fn(async (_req: Request, orgId: string, allowed: string[]) => {
    const a = state.actor;
    if (!a) return { error: "Missing access token", status: 401 };
    if ("error" in a) return a;
    if (!a.roles.some((r) => allowed.includes(r))) return { error: "Insufficient role", status: 403 };
    return { userId: a.userId, email: `${a.userId}@x.io`, orgId, role: a.roles[0] ?? "", roles: a.roles, admin: { from: (t: string) => chain(t) } };
  }),
  callerScopedClient: vi.fn((req: Request) => {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!bearer) return { error: "Missing access token", status: 401 };
    return { from: (t: string) => chain(t, "caller") };
  }),
}));
import { GET as gateGet } from "@/app/api/admin/gate/route";
import { GET as analyticsGet } from "@/app/api/admin/analytics/route";

const gate = (surface: string, orgId = "o1") => gateGet(new NextRequest(`http://x/api/admin/gate?orgId=${orgId}&surface=${surface}`, { headers: { authorization: "Bearer t" } }));
const analytics = (orgId = "o1") => analyticsGet(new NextRequest(`http://x/api/admin/analytics?orgId=${orgId}`, { headers: { authorization: "Bearer t" } }));
const policyRow = (data: unknown) => ({ org_id: "o1", key: "capability_policy", data });

beforeEach(() => {
  __resetCapabilityPolicyCache();
  state.actor = null; state.rows = {}; state.errorTables = new Set(); state.calls = [];
});

describe("/api/admin/gate — the decision is made on the server", () => {
  it("401 with no session; 400 for an unknown surface; 403 'Insufficient role' passes through", async () => {
    expect((await gate("teams")).status).toBe(401);
    state.actor = { userId: "m1", roles: ["Manager"] };
    expect((await gate("nope")).status).toBe(400);
    state.actor = { error: "Not a member of this org", status: 403 };
    const res = await gate("teams");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Not a member of this org");
  });
  it("a role surface admits by collection and refuses with the surface's message", async () => {
    state.actor = { userId: "m1", roles: ["Drafter", "Manager"] };
    const ok = await gate("teams");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ allowed: true, surface: "teams" });
    state.actor = { userId: "d1", roles: ["Drafter"] };
    const no = await gate("teams");
    expect(no.status).toBe(403);
    expect((await no.json()).error).toBe("Only Admins and Managers can manage teams.");
    // no policy read for a role surface
    expect(state.calls.filter((c) => c.table === "org_configurations")).toHaveLength(0);
  });
  it("a capability surface: default, narrowed by the stored policy, widened by a per-person grant — read with the service client", async () => {
    state.actor = { userId: "m1", roles: ["Manager"] };
    expect((await gate("analytics")).status).toBe(200);
    expect(state.calls.some((c) => c.table === "org_configurations" && c.method === "eq" && c.args[0] === "key" && c.args[1] === "capability_policy")).toBe(true);
    state.rows.org_configurations = [policyRow({ caps: { "admin.analytics_view": ["Admin"] } })];
    expect((await gate("analytics")).status).toBe(403);
    state.actor = { userId: "d1", roles: ["Drafter"] };
    state.rows.org_configurations = [policyRow({ caps: {}, grants: [{ cap: "admin.analytics_view", uid: "d1", expiresAt: null }] })];
    expect((await gate("analytics")).status).toBe(200);
    state.rows.org_configurations = [policyRow({ caps: {}, grants: [{ cap: "admin.audit_view", uid: "d1", expiresAt: null }] })];
    expect((await gate("audit")).status).toBe(200);
    expect((await gate("archive-view")).status).toBe(403);
    state.actor = { userId: "a1", roles: ["Requester", "Auditor"] };
    state.rows.org_configurations = [];
    expect((await gate("audit")).status).toBe(200);
  });
  it("FAILS CLOSED: a policy that cannot be read is a 503 denial, never an admission on the defaults", async () => {
    state.actor = { userId: "a1", roles: ["Admin"] };
    state.errorTables.add("org_configurations");
    const res = await gate("analytics");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/Could not verify your permissions/);
    // a role surface does not depend on the policy and still answers
    expect((await gate("settings")).status).toBe(200);
  });
});

describe("/api/admin/analytics — the dashboard's data sits behind the same gate", () => {
  it("403 for a member outside admin.analytics_view, and NO ticket read happens; 200 with rows inside it", async () => {
    state.actor = { userId: "d1", roles: ["Drafter"] };
    state.rows.tickets = [{ id: "t1", org_id: "o1" }];
    state.rows.documents = [{ id: "d", org_id: "o1", status: "Issued" }];
    expect((await analytics()).status).toBe(403);
    expect(state.calls.filter((c) => c.table === "tickets")).toHaveLength(0);
    state.actor = { userId: "m1", roles: ["Manager"] };
    const res = await analytics();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tickets: [{ id: "t1", org_id: "o1" }], documents: [{ id: "d", org_id: "o1", status: "Issued" }] });
    expect(state.calls.some((c) => c.table === "tickets" && c.method === "eq" && c.args[1] === "o1")).toBe(true);
  });
  it("the rows are read AS THE CALLER (their own bearer, RLS applied) — the service client decides the gate and reads nothing else", async () => {
    state.actor = { userId: "m1", roles: ["Manager"] };
    state.rows.tickets = [{ id: "t1", org_id: "o1" }];
    state.rows.documents = [{ id: "d", org_id: "o1", status: "Issued" }];
    expect((await analytics()).status).toBe(200);
    const reads = state.calls.filter((c) => c.table === "tickets" || c.table === "documents");
    expect(reads.length).toBeGreaterThan(0);
    // never wider than the caller's own session: documents_acl_select must apply
    expect(reads.every((c) => c.client === "caller")).toBe(true);
    expect(state.calls.filter((c) => c.client === "admin").map((c) => c.table)).toEqual(
      state.calls.filter((c) => c.client === "admin" && c.table === "org_configurations").map((c) => c.table),
    );
    // the caller-scoped client is built from the request's own bearer, by the shared helper — pinned at the source
    const r = src("app/api/admin/analytics/route.ts");
    expect(r).toContain("const asCaller = callerScopedClient(req);");
    expect(r).toMatch(/asCaller\.from\("tickets"\)\.select\("\*"\)\.eq\("org_id", orgId\),\s*\n\s*asCaller\.from\("documents"\)/);
    expect(r).not.toMatch(/actor\.admin\.from|supabaseAdmin/);
  });
  it("callerScopedClient (the real helper): anon key + the request's bearer, persistSession off; 401 without a bearer", async () => {
    const real = await vi.importActual<typeof import("@/lib/serverAuth")>("@/lib/serverAuth");
    const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    try {
      const withBearer = real.callerScopedClient(new Request("http://x", { headers: { authorization: "Bearer abc" } }));
      expect("error" in withBearer).toBe(false);
      expect(typeof (withBearer as { from?: unknown }).from).toBe("function");
      expect(real.callerScopedClient(new Request("http://x"))).toEqual({ error: "Missing access token", status: 401 });
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = saved.anon;
    }
    const helper = src("lib/serverAuth.ts").slice(src("lib/serverAuth.ts").indexOf("export function callerScopedClient"));
    const body = helper.slice(0, helper.indexOf("\n}\n") + 2);
    expect(body).toContain("createClient(supabaseUrl, anonKey, {");
    expect(body).toContain("global: { headers: { Authorization: `Bearer ${accessToken}` } },");
    expect(body).toContain("auth: { persistSession: false },");
    expect(body).not.toContain("serviceRoleKey");
  });
});

describe("WF-20 — the layout is the one client gate, and it cannot fail open", () => {
  it("the admin layout asks the gate for the current surface and renders only a matching 200", () => {
    const l = src("app/(protected)/admin/layout.tsx");
    expect(l).toContain("const surface = adminSurfaceForPath(pathname);");
    expect(l).toMatch(/fetch\(`\/api\/admin\/gate\?orgId=\$\{encodeURIComponent\(activeOrgId\)\}&surface=\$\{encodeURIComponent\(surfaceKey\)\}`/);
    expect(l).toContain('if (res.ok && body?.allowed === true && body?.surface === surfaceKey) {');
    expect(l).toContain('if (gate.status === "allowed" && gate.key === surfaceKey) return <>{children}</>;');
    expect(l).toMatch(/catch \{\s*\n\s*if \(alive\) setGate\(\{ status: "denied"/);
    expect(l).not.toMatch(/setAllowed\(true\)|status: "allowed"[^\n]*catch/);
    expect(l).toContain('cache: "no-store"');
  });
  it("an unverifiable session is never a denial: no token → stays checking; 401 → retryable and worded as such; a session arriving or refreshing re-asks by itself", () => {
    const l = src("app/(protected)/admin/layout.tsx");
    expect(l).toMatch(/const token = data\.session\?\.access_token \?\? "";\s*\n[^\n]*\n[^\n]*\n\s*if \(!token\) return;/);
    expect(l).toContain("const unverified = res.status === 401;");
    expect(l).toContain("retryable: unverified || res.status >= 500,");
    expect(l).toContain('"Your session could not be verified — it may have expired. Try again, or sign in again."');
    expect(l).toContain('{gate.unverified ? "Could not verify your access" : surface ? `${surface.label}: not available to you` : "Not an admin page"}');
    expect(l).toMatch(/supabase\.auth\.onAuthStateChange\(\(event, session\) => \{\s*\n\s*if \(event !== "SIGNED_IN" && event !== "TOKEN_REFRESHED"\) return;\s*\n\s*if \(!session\?\.access_token\) return;\s*\n\s*if \(gateRef\.current\.status === "allowed"\) return;\s*\n\s*setAttempt\(\(n\) => n \+ 1\);/);
    expect(l).toContain("return () => subscription.unsubscribe();");
    // a 403 (the gate's real answer) is still not retryable
    expect(l).not.toMatch(/retryable: true[^\n]*403|res\.status === 403/);
  });
  it("analytics and archive-view no longer read the policy in the browser; analytics data comes through the gated route", () => {
    const a = src("app/(protected)/admin/analytics/page.tsx");
    expect(a).not.toMatch(/policyAllows|loadCapabilityPolicy|setAllowed/);
    expect(a).not.toMatch(/\.from\('tickets'\)|\.from\('documents'\)/);
    expect(a).toMatch(/fetch\(`\/api\/admin\/analytics\?orgId=/);
    const v = src("app/(protected)/admin/archive-view/page.tsx");
    expect(v).not.toMatch(/policyAllows|loadCapabilityPolicy|setAllowed/);
  });
});

// ── DOCACL-3 / DEC-43 ───────────────────────────────────────────────────────
describe("DOCACL-3 / DEC-43 — controllers are unscoped by design; a bypass-decided read is audited", () => {
  it("controllerBypassDecided: true only when the controller tier is the sole reason the bytes are served", () => {
    const priv = { visibility: "private" as const };
    expect(controllerBypassDecided({ principal: P("Admin"), aclChain: [], ...priv })).toBe(true);
    expect(controllerBypassDecided({ principal: P("Manager", ["Manager", "DocCtrl"]), aclChain: [], ...priv })).toBe(true);
    // the person's OTHER roles would have been served → not bypass-decided
    const allowDrafter = acl([{ effect: "allow", subject: { type: "role", id: "Drafter" }, actions: ["read"] }]);
    expect(controllerBypassDecided({ principal: P("Admin", ["Admin", "Drafter"]), aclChain: [allowDrafter], ...priv })).toBe(false);
    expect(controllerBypassDecided({ principal: P("Admin", ["Admin", "Requester"]), aclChain: [allowDrafter], ...priv })).toBe(true);
    // not a controller / not restricted / effective owner → false
    expect(controllerBypassDecided({ principal: P("Manager", ["Manager"]), aclChain: [], ...priv })).toBe(false);
    expect(controllerBypassDecided({ principal: P("Admin"), aclChain: [], visibility: "normal" })).toBe(false);
    expect(controllerBypassDecided({ principal: P("Admin"), aclChain: [], ...priv, effectiveOwnerUserId: "u1" })).toBe(false);
    // and the served decision itself is unchanged: the rail still serves
    expect(canServeContent({ principal: P("Admin"), aclChain: [], ...priv })).toBe(true);
  });
  it("the download route writes CONTROLLER_RESTRICTED_READ best-effort, after the same evaluation, never blocking the rail", () => {
    const r = src("app/api/storage/download-url/route.ts");
    expect(r).toContain("const allowed = canServeContent(contentCheck);");
    expect(r).toContain("if (allowed && controllerBypassDecided(contentCheck)) {");
    expect(r).toContain('action: "CONTROLLER_RESTRICTED_READ"');
    expect(r).toMatch(/details: \{ path, visibility, roles: contentCheck\.principal\.roles \},\s*\n\s*\}\)\.then\(\(\) => undefined, \(\) => undefined\);/);
    // DEC-43 acceptance: a download ownership would have served leaves NO row —
    // the explicit owner is part of the evaluation, the folder / library / team
    // cascade is asked before the insert (and only then)
    const check = r.slice(r.indexOf("const contentCheck = {"), r.indexOf("const allowed = canServeContent(contentCheck);"));
    expect(check).toContain("effectiveOwnerUserId: (doc.owner_user_id as string | null) ?? null,");
    const bypass = r.slice(r.indexOf("if (allowed && controllerBypassDecided(contentCheck)) {"), r.indexOf("if (!allowed) {"));
    expect(bypass).toMatch(/const \{ data: isOwner \} = await supabaseAdmin\.rpc\("user_is_effective_owner", \{[\s\S]*?p_uid: user\.id,\s*\n\s*\}\);\s*\n\s*if \(isOwner !== true\) \{\s*\n\s*await supabaseAdmin\.from\("audit_logs"\)\.insert\(\{/);
    expect((r.match(/supabaseAdmin\.rpc\("user_is_effective_owner"/g) ?? []).length).toBe(2);
  });
});
