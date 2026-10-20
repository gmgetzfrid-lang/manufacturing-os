// admin-and-org Round G, package P13 — ORG-22: the shared actor resolver
// (lib/principal.ts resolveActorPrincipal) tells a membership read that
// SUCCEEDED and found no ACTIVE row (the actor is known not to be an active
// member of that workspace) apart from one that FAILED (unknown). The first
// answers isActiveMember: false, so lib/acl.ts drops every ACL grant before
// any rule matches; the second keeps today's "never wider" fallback.
// Regression first: an active member's principal is exactly what it was.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  member: { data: null as unknown, error: null as { message: string } | null },
  throwOnRead: false,
  teamIds: ["team-1"] as string[],
  reads: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase", () => {
  const chain = (filters: Record<string, unknown>): unknown => new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "maybeSingle") {
        return async () => {
          state.reads.push(filters);
          if (state.throwOnRead) throw new Error("socket hang up");
          return state.member;
        };
      }
      if (prop === "then") return undefined;
      return (...args: unknown[]) => chain(prop === "eq" ? { ...filters, [String(args[0])]: args[1] } : filters);
    },
  });
  return { supabase: { from: (table: string) => chain({ table }) } };
});
vi.mock("@/lib/teams", () => ({ getMyTeamIds: async () => state.teamIds }));

import { resolveActorPrincipal } from "@/lib/principal";
import { canWithAclChain, canDiscover } from "@/lib/permissions";
import type { AccessControl } from "@/types/schema";

const ORG = "11111111-1111-4111-8111-111111111111";
const UID = "22222222-2222-4222-8222-222222222222";
// A library whose ACL grants this very person read and write by uid — the
// rule a suspension keeps (grants are not stripped on suspend).
const personalAllow: AccessControl = {
  inherit: true,
  visibility: "normal",
  rules: [{ id: "r1", effect: "allow", subject: { type: "user", id: UID }, actions: ["read", "write"] }],
} as unknown as AccessControl;

beforeEach(() => {
  state.member = { data: null, error: null };
  state.throwOnRead = false;
  state.teamIds = ["team-1"];
  state.reads = [];
});

describe("ORG-22 — a successful membership read with no ACTIVE row is a known non-member", () => {
  it("reproduced on HEAD (before the fix the principal carried no isActiveMember): it now answers false, keeping the headline and teams", async () => {
    const p = await resolveActorPrincipal({ uid: UID, orgId: ORG, headlineRole: "Engineer-2" });
    expect(state.reads[0]).toMatchObject({ table: "org_members", org_id: ORG, uid: UID, status: "active" });
    expect(p).toEqual({ uid: UID, role: "Engineer-2", orgId: ORG, teamIds: ["team-1"], isActiveMember: false });
  });

  it("lib/acl.ts then refuses before any rule: a suspended member's own ALLOW no longer reads as a grant in the client pre-check", async () => {
    const p = await resolveActorPrincipal({ uid: UID, orgId: ORG, headlineRole: "Engineer-2" });
    expect(canWithAclChain({ principal: p, action: "write", aclChain: [personalAllow] })).toBe(false);
    expect(canWithAclChain({ principal: p, action: "read", aclChain: [personalAllow] })).toBe(false);
    expect(canDiscover({ principal: p, aclChain: [personalAllow] })).toBe(false);
  });
});

describe("ORG-22 — every other branch is today's", () => {
  it("regression: an active member's principal is unchanged (collection, teams, isActiveMember true) and their own ALLOW still grants", async () => {
    state.member = { data: { role: "Engineer-2", roles: ["Engineer-2", "Drafter"] }, error: null };
    const p = await resolveActorPrincipal({ uid: UID, orgId: ORG, headlineRole: "Engineer-2" });
    expect(p).toEqual({ uid: UID, role: "Engineer-2", roles: ["Engineer-2", "Drafter"], orgId: ORG, teamIds: ["team-1"], isActiveMember: true });
    expect(canWithAclChain({ principal: p, action: "write", aclChain: [personalAllow] })).toBe(true);
  });

  it("a FAILED read keeps the never-wider fallback: the caller's headline and teams, no isActiveMember (status unknown)", async () => {
    state.member = { data: null, error: { message: "statement timeout" } };
    const p = await resolveActorPrincipal({ uid: UID, orgId: ORG, headlineRole: "Engineer-2" });
    expect(p).toEqual({ uid: UID, role: "Engineer-2", orgId: ORG, teamIds: ["team-1"] });
    expect("isActiveMember" in p).toBe(false);
    expect(canWithAclChain({ principal: p, action: "write", aclChain: [personalAllow] })).toBe(true);
  });

  it("no workspace named: nothing was read for a workspace, so nothing is known — today's fallback, no isActiveMember", async () => {
    const p = await resolveActorPrincipal({ uid: UID, headlineRole: "Engineer-2" });
    expect(state.reads).toHaveLength(0);
    expect(p).toEqual({ uid: UID, role: "Engineer-2", orgId: undefined, teamIds: ["team-1"] });
  });

  it("a read that throws keeps the bare fallback (no teams, no isActiveMember), as before", async () => {
    state.throwOnRead = true;
    const p = await resolveActorPrincipal({ uid: UID, orgId: ORG, headlineRole: "Viewer" });
    expect(p).toEqual({ uid: UID, role: "Viewer", orgId: ORG });
  });

  it("no uid: the fallback without any read, as before", async () => {
    const p = await resolveActorPrincipal({ uid: "", orgId: ORG, headlineRole: "Viewer" });
    expect(state.reads).toHaveLength(0);
    expect(p).toEqual({ uid: "", role: "Viewer", orgId: ORG });
  });
});
