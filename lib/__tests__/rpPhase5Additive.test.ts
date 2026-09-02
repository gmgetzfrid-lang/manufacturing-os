// Roles-and-permissions Phase 5 — role resolution reads the COLLECTION.
//
// OWN-3/DEC-2: a member holding DocCtrl additively (headline Manager) is a
// controller everywhere the app decides publish/supersede authority.
// CHAIN-1: a RESTRICTION binds if ANY held role is restricted — adding a
// higher-ranked role never lifts it. SURF-10: authorizeOrgRole admits by the
// union. OWN-6: the mutator principal carries teams (resolved from the same
// rows the DB reads). OWN-10: the simulator reads real teams and never
// hides a lookup failure.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessControl, AclIndex, Role } from "@/types/schema";

// ── Mocks for the DB-backed helpers ─────────────────────────────────────────
const dbState = vi.hoisted(() => ({
  member: null as null | { role?: string | null; roles?: unknown },
  memberError: null as null | { message: string },
  teams: [] as string[],
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

function makeChain(table: string) {
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => {
          if (table === "org_members") resolve({ data: dbState.member ? [dbState.member] : [], error: dbState.memberError });
          else if (table === "team_members") resolve({ data: dbState.teams.map((t) => ({ team_id: t })), error: null });
          else resolve({ data: [], error: null });
        };
      }
      return (...args: unknown[]) => {
        dbState.calls.push({ table, method: prop, args });
        if (prop === "maybeSingle" || prop === "single") {
          if (table === "org_members") return Promise.resolve({ data: dbState.member, error: dbState.memberError });
          return Promise.resolve({ data: null, error: null });
        }
        return new Proxy(chain, handler);
      };
    },
  };
  return new Proxy(chain, handler);
}

vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => makeChain(t) } }));
// lib/serverAuth.ts builds its own clients from @supabase/supabase-js.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1", email: "u1@x" } }, error: null })) },
    from: (t: string) => makeChain(t),
  }),
}));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => {}) }));

import {
  heldRoles, isControllerPrincipal, canPublishOnLibrary, canPublishViaIndex, canDiscover, canWithAclChain,
} from "@/lib/permissions";
import { evaluateAclChain } from "@/lib/acl";
import { evaluatePublishGuard } from "@/lib/documentGuards";
import { resolveActorPrincipal } from "@/lib/principal";
import { getOrgControllers } from "@/lib/ownership";
import { authorizeOrgRole } from "@/lib/serverAuth";

beforeEach(() => {
  dbState.member = null; dbState.memberError = null; dbState.teams = []; dbState.calls = [];
});

const P = (role: Role, roles?: Role[], extra: Partial<{ teamIds: string[]; uid: string }> = {}) => ({
  uid: extra.uid ?? "u1", role, roles, orgId: "org1", teamIds: extra.teamIds ?? [], isActiveMember: true,
});
const acl = (rules: AccessControl["rules"]): AccessControl => ({ rules });

describe("OWN-3 — the controller tier is a property of the collection", () => {
  it("heldRoles = headline ∪ additive, deduped, never empty", () => {
    expect(heldRoles({ role: "Manager", roles: ["Manager", "DocCtrl"] })).toEqual(["Manager", "DocCtrl"]);
    expect(heldRoles({ role: "Viewer" })).toEqual(["Viewer"]);
  });

  it("['Manager','DocCtrl'] (headline Manager) IS a controller; ['Manager'] alone is NOT", () => {
    expect(isControllerPrincipal({ role: "Manager", roles: ["Manager", "DocCtrl"] })).toBe(true);
    expect(isControllerPrincipal({ role: "Manager", roles: ["Manager"] })).toBe(false);
    expect(isControllerPrincipal({ role: "Manager" })).toBe(false);
  });

  it("the additive DocCtrl may publish on a library with NO acl (controller short-circuit)", () => {
    expect(canPublishOnLibrary({ principal: P("Manager", ["Manager", "DocCtrl"]), libraryAcl: undefined })).toBe(true);
    expect(canPublishOnLibrary({ principal: P("Manager", ["Manager"]), libraryAcl: undefined })).toBe(false);
  });

  it("controller-by-collection sees private nodes and passes canWithAclChain", () => {
    expect(canDiscover({ principal: P("Manager", ["Manager", "DocCtrl"]), aclChain: [], visibility: "private" })).toBe(true);
    expect(canDiscover({ principal: P("Manager", ["Manager"]), aclChain: [], visibility: "private" })).toBe(false);
    expect(canWithAclChain({ principal: P("Supervisor", ["Supervisor", "Admin"]), action: "write", aclChain: [], defaultAllow: false })).toBe(true);
  });

  it("evaluatePublishGuard: force past a hold needs the controller tier — by collection", () => {
    const state = { checkedOutBy: null, activeHolds: [{ id: "h1" } as never] } as never;
    const blocked = evaluatePublishGuard(state, { actorUserId: "u1", actorRole: "Manager", force: true });
    expect(blocked.ok).toBe(false);
    const forced = evaluatePublishGuard(state, { actorUserId: "u1", actorRole: "Manager", actorRoles: ["Manager", "DocCtrl"], force: true });
    expect(forced.ok).toBe(true);
  });

  it("getOrgControllers queries the UNION (role IN … OR roles overlaps)", async () => {
    await getOrgControllers("org1");
    const or = dbState.calls.find((c) => c.table === "org_members" && c.method === "or");
    expect(or?.args[0]).toBe("role.in.(Admin,DocCtrl),roles.ov.{Admin,DocCtrl}");
  });
});

describe("CHAIN-1 — restrictions bind on ANY held role; grants follow any held role", () => {
  it("an ACL deny naming Auditor still matches an Auditor who was also given Requester", () => {
    const rules = acl([
      { effect: "allow", subject: { type: "org", id: "org1" }, actions: ["read", "write"] },
      { effect: "deny", subject: { type: "role", id: "Auditor" }, actions: ["write"] },
    ]);
    // Legacy headline-only context: the restriction was lifted by the higher headline.
    const legacy = evaluateAclChain([rules], { uid: "u1", role: "Requester", orgId: "org1", isActiveMember: true });
    expect(legacy?.can("write")).toBe(true);
    // Collection-aware: the deny binds.
    const now = evaluateAclChain([rules], { uid: "u1", role: "Requester", roles: ["Auditor", "Requester"], orgId: "org1", isActiveMember: true });
    expect(now?.can("write")).toBe(false);
  });

  it("canPublishViaIndex: a deny naming an additively-held role binds; an allow naming one grants", () => {
    const idx = {
      allow: { roles: { publish: ["DraftingSupervisor"] } },
      deny: { roles: { publish: ["Contractor"] } },
    } as unknown as AclIndex;
    // Allow via additive role (ADD-1).
    expect(canPublishViaIndex(idx, P("Requester", ["Requester", "DraftingSupervisor"]))).toBe(true);
    expect(canPublishViaIndex(idx, P("Requester", ["Requester"]))).toBe(false);
    // Deny via additive role wins even when the headline is granted (CHAIN-1).
    expect(canPublishViaIndex(idx, P("DraftingSupervisor", ["DraftingSupervisor", "Contractor"]))).toBe(false);
  });

  it("source pins: the two UI restriction sites evaluate the collection", () => {
    const page = readFileSync(join(process.cwd(), "app", "(protected)", "documents", "[libraryId]", "page.tsx"), "utf8");
    expect(page).toMatch(/canEdit=\{isController \|\| !hasAnyRole\(\["Viewer", "Auditor"\]\)\}/);
    expect(page).not.toMatch(/activeRole !== "Viewer" && activeRole !== "Auditor"/);
    const sidebar = readFileSync(join(process.cwd(), "components", "navigation", "Sidebar.tsx"), "utf8");
    expect(sidebar).toMatch(/hasAnyRole\(\['Viewer', 'Contractor'\]\)/);
    expect(sidebar).not.toMatch(/activeRole === 'Viewer' \|\| activeRole === 'Contractor'/);
    expect(sidebar).toMatch(/const isAdmin = hasAnyRole\(\['Admin', 'DocCtrl'\]\);/);
  });

  it("source pin: download-url seeds held roles from the headline (roles: [] no longer drops it)", () => {
    const route = readFileSync(join(process.cwd(), "app", "api", "storage", "download-url", "route.ts"), "utf8");
    expect(route).toMatch(/const heldRoles: string\[\] = normalizeRoles\(mem2\?\.roles, mem2\?\.role\);/);
    expect(route).not.toMatch(/\(mem2\?\.roles as string\[\] \| null\) \?\? \[/);
  });
});

describe("OWN-6 — the mutator principal carries roles AND teams, resolved like the DB", () => {
  it("resolveActorPrincipal reads org_members.role/roles + team_members, seeding roles from the headline", async () => {
    dbState.member = { role: "Manager", roles: ["Manager", "DocCtrl"] };
    dbState.teams = ["team-cad"];
    const p = await resolveActorPrincipal({ uid: "u1", orgId: "org1", headlineRole: "Manager" });
    expect(p.role).toBe("Manager");
    expect(p.roles).toEqual(["Manager", "DocCtrl"]);
    expect(p.teamIds).toEqual(["team-cad"]);
    expect(p.isActiveMember).toBe(true);
    expect(isControllerPrincipal(p)).toBe(true);
  });

  it("a team-only publisher passes the SAME evaluator the mutator uses (canPublishViaIndex with resolved teams)", async () => {
    dbState.member = { role: "Requester", roles: ["Requester"] };
    dbState.teams = ["team-cad"];
    const p = await resolveActorPrincipal({ uid: "u1", orgId: "org1", headlineRole: "Requester" });
    const idx = { allow: { teams: { publish: ["team-cad"] } } } as unknown as AclIndex;
    expect(canPublishViaIndex(idx, p)).toBe(true);
    // Without the resolved teams (the old {uid, role} principal) the same grant was refused.
    expect(canPublishViaIndex(idx, { uid: "u1", role: "Requester", orgId: "org1" })).toBe(false);
  });

  it("fails SAFE, never open: a membership read error keeps the caller's headline and adds no roles", async () => {
    dbState.member = null; dbState.memberError = { message: "boom" };
    dbState.teams = ["team-cad"];
    const p = await resolveActorPrincipal({ uid: "u1", orgId: "org1", headlineRole: "Viewer" });
    expect(p.role).toBe("Viewer");
    expect(p.roles).toBeUndefined();
    expect(isControllerPrincipal(p)).toBe(false);
  });

  it("a roles: [] row (pre-backfill) still evaluates its headline", async () => {
    dbState.member = { role: "DocCtrl", roles: [] };
    const p = await resolveActorPrincipal({ uid: "u1", orgId: "org1", headlineRole: "DocCtrl" });
    expect(p.roles).toEqual(["DocCtrl"]);
    expect(isControllerPrincipal(p)).toBe(true);
  });
});

describe("OWN-10 — the simulator (source pins; the component reaches the live client)", () => {
  const sim = readFileSync(join(process.cwd(), "components", "permissions", "ViewAsSimulator.tsx"), "utf8");

  it("queries team_members by uid and READS the error into a visible state", () => {
    expect(sim).toMatch(/from\("team_members"\)\.select\("team_id"\)\.eq\("uid", pick\)/);
    expect(sim).not.toMatch(/eq\("user_id", pick\)/);
    expect(sim).toMatch(/if \(error\) \{ setTeamIds\(\[\]\); setTeamsErr\(error\.message\); return; \}/);
    expect(sim).toMatch(/Team memberships could not be loaded/);
  });

  it("evaluates the same principal shape the mutators build: roles collection + teams + library owner", () => {
    expect(sim).toMatch(/roles: who\.roles as Role\[\], orgId: activeOrgId \?\? undefined, teamIds, isActiveMember: true/);
    expect(sim).toMatch(/isControllerPrincipal\(principal\)/);
    expect(sim).toMatch(/effectiveOwnerUserId: l\.ownerUserId/);
    expect(sim).toMatch(/select\("id, name, acl, acl_index, visibility, owner_user_id"\)/);
  });
});

describe("SURF-10 — authorizeOrgRole reads the union of role and roles[]", () => {
  const req = () => new Request("http://test/api/admin/purge", { headers: { authorization: "Bearer tok" } });
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://sb";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  });

  it("admits a ['Manager','DocCtrl'] member (headline Manager) to an Admin/DocCtrl route", async () => {
    dbState.member = { role: "Manager", roles: ["Manager", "DocCtrl"], status: "active" } as never;
    const r = await authorizeOrgRole(req(), "org1", ["Admin", "DocCtrl"]);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.role).toBe("Manager");          // headline preserved for audit rows
      expect(r.roles).toEqual(["Manager", "DocCtrl"]);
    }
  });

  it("still refuses a ['Manager'] member — and a pre-backfill roles: [] row evaluates its headline", async () => {
    dbState.member = { role: "Manager", roles: ["Manager"], status: "active" } as never;
    const refused = await authorizeOrgRole(req(), "org1", ["Admin", "DocCtrl"]);
    expect(refused).toEqual({ error: "Insufficient role", status: 403 });

    dbState.member = { role: "DocCtrl", roles: [], status: "active" } as never;
    const admitted = await authorizeOrgRole(req(), "org1", ["Admin", "DocCtrl"]);
    expect("error" in admitted).toBe(false);
  });

  it("inactive membership is refused before the role gate", async () => {
    dbState.member = { role: "Admin", roles: ["Admin"], status: "suspended" } as never;
    const r = await authorizeOrgRole(req(), "org1", ["Admin"]);
    expect(r).toEqual({ error: "Not a member of this org", status: 403 });
  });
});
