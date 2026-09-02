// Roles-and-permissions Phase 6 — app-side behavior.
//
// GAP-5/OWN-12: only ACTIVE members can be effective owners (fall-through).
// SURF-1/DEC-20: revocation goes through one RPC, refusals are loud, the
// controllers are told what became unowned. SURF-3: legal hold is a
// controller decision app-side too. SURF-4: force-release is one RPC call —
// a refusal leaves nothing half-done. DEC-9: supervisor changes are audited
// and clearing while owning libraries is refused. DEC-21: a sole signed
// primary who is the publisher does not complete the review.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const db = vi.hoisted(() => ({
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
  singles: {} as Record<string, { data?: unknown; error?: unknown }>,
  rpc: { data: null as unknown, error: null as unknown },
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
}));

function makeChain(table: string) {
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") {
        const r = db.tables[table] ?? { data: [], error: null };
        return (resolve: (v: unknown) => void) => resolve({ data: r.data ?? [], error: r.error ?? null });
      }
      return (...args: unknown[]) => {
        db.calls.push({ table, method: prop, args });
        if (prop === "maybeSingle" || prop === "single") {
          const r = db.singles[table] ?? db.tables[table] ?? { data: null, error: null };
          const d = Array.isArray(r.data) ? (r.data as unknown[])[0] ?? null : r.data ?? null;
          return Promise.resolve({ data: d, error: r.error ?? null });
        }
        return new Proxy(chain, handler);
      };
    },
  };
  return new Proxy(chain, handler);
}

const notified = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const audited = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => makeChain(t),
    rpc: async (fn: string, args: unknown) => { db.rpcCalls.push({ fn, args }); return db.rpc; },
  },
}));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn(async (n: Record<string, unknown>) => { notified.push(n); }) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (e: Record<string, unknown>) => { audited.push(e); }) }));

import { resolveEffectiveOwner, effectiveOwnerForDocument } from "@/lib/ownership";
import { revokeMember } from "@/lib/members";
import { setTeamSupervisor, deleteTeam } from "@/lib/teams";
import { reviewCompletionForDraft } from "@/lib/reviewControl";

beforeEach(() => {
  db.tables = {}; db.singles = {}; db.rpc = { data: null, error: null }; db.calls = []; db.rpcCalls = [];
  notified.length = 0; audited.length = 0;
});

describe("GAP-5 / OWN-12 — only active members are effective owners", () => {
  it("resolveEffectiveOwner skips an inactive owner and falls through to the next level, then null", () => {
    const active = new Set(["lib-owner"]);
    const r = resolveEffectiveOwner({ owner_user_id: "gone", owner_name: "Gone" }, { owner_user_id: "also-gone" }, { owner_user_id: "lib-owner", owner_name: "Lib" }, active);
    expect(r).toEqual({ userId: "lib-owner", name: "Lib", source: "library" });
    const none = resolveEffectiveOwner({ owner_user_id: "gone" }, null, { owner_user_id: "gone2" }, new Set());
    expect(none.userId).toBeNull();
    // Legacy callers (no set) keep prior behavior.
    expect(resolveEffectiveOwner({ owner_user_id: "gone" }).userId).toBe("gone");
  });

  it("effectiveOwnerForDocument: a departed document owner falls through to an ACTIVE team supervisor", async () => {
    db.singles["collections"] = { data: null };
    db.singles["libraries"] = { data: { owner_user_id: null, owner_name: null, owner_team_id: "t1", org_id: "org1" } };
    db.singles["teams"] = { data: { supervisor_user_id: "sup", name: "Drafting" } };
    // Only the supervisor is active; the document's owner uid is not.
    db.tables["org_members"] = { data: [{ uid: "sup", display_name: "Sue" }] };
    db.singles["org_members"] = { data: { display_name: "Sue", email: "sue@x" } };
    const r = await effectiveOwnerForDocument({ ownerUserId: "departed", ownerName: "Old", collectionId: null, libraryId: "lib1" });
    expect(r).toEqual({ userId: "sup", name: "Sue", source: "team" });
  });

  it("effectiveOwnerForDocument: when the supervisor is inactive too, the document is UNOWNED (never a silent reassignment)", async () => {
    db.singles["collections"] = { data: null };
    db.singles["libraries"] = { data: { owner_user_id: null, owner_name: null, owner_team_id: "t1", org_id: "org1" } };
    db.singles["teams"] = { data: { supervisor_user_id: "sup", name: "Drafting" } };
    db.tables["org_members"] = { data: [] };
    const r = await effectiveOwnerForDocument({ ownerUserId: "departed", collectionId: null, libraryId: "lib1" });
    expect(r.userId).toBeNull();
  });
});

describe("SURF-1 / DEC-20 — revokeMember", () => {
  it("a refused revocation surfaces as an error, never a disappearing row", async () => {
    db.rpc = { data: null, error: { message: "Only an Admin can remove a member from the workspace." } };
    await expect(revokeMember({ memberId: "m1", mode: "remove", orgId: "org1", actorUserId: "a" }))
      .rejects.toThrow(/Only an Admin/);
    expect(db.rpcCalls[0]).toEqual({ fn: "revoke_member", args: { p_member_id: "m1", p_mode: "remove" } });
  });

  it("a remove that cleared ownership notifies the controllers with the list (GAP-5 'clear, audit, notify')", async () => {
    db.rpc = { data: { mode: "remove", uid: "u9", cleared: { libraries: [{ id: "l1", name: "Drawings" }], collections: [], documents: [{ id: "d1", name: "P-100" }], teams: [] }, endedCheckouts: 1, revokedGrants: 0 }, error: null };
    db.tables["org_members"] = { data: [{ uid: "c1" }, { uid: "a" }] }; // controllers (actor excluded)
    const r = await revokeMember({ memberId: "m1", mode: "remove", orgId: "org1", actorUserId: "a", memberLabel: "Pat" });
    expect(r.cleared?.libraries[0].name).toBe("Drawings");
    expect(notified).toHaveLength(1);
    expect(notified[0].userId).toBe("c1");
    expect(notified[0].kind).toBe("member_revoked");
    expect(String(notified[0].title)).toMatch(/Pat was removed — 2 items now unowned/);
    expect(String(notified[0].body)).toMatch(/cleared, not reassigned/);
  });

  it("suspend/restore never notify about ownership (nothing was cleared)", async () => {
    db.rpc = { data: { mode: "suspend", uid: "u9" }, error: null };
    await revokeMember({ memberId: "m1", mode: "suspend", orgId: "org1", actorUserId: "a" });
    expect(notified).toHaveLength(0);
  });

  it("a mode mismatch from the database is treated as 'nothing changed'", async () => {
    db.rpc = { data: { mode: "suspend", uid: "u9" }, error: null };
    await expect(revokeMember({ memberId: "m1", mode: "remove", orgId: "org1", actorUserId: "a" })).rejects.toThrow(/not confirmed/);
  });
});

describe("DEC-9 — team supervision", () => {
  it("clearing the supervisor of a team that OWNS libraries is refused with the list", async () => {
    db.singles["teams"] = { data: { id: "t1", name: "Drafting", supervisor_user_id: "sup" } };
    db.tables["libraries"] = { data: [{ id: "l1", name: "Drawings" }] };
    await expect(setTeamSupervisor({ teamId: "t1", orgId: "org1", supervisorUserId: null, actorId: "a" }))
      .rejects.toThrow(/owns 1 library \(Drawings\)/);
    expect(db.calls.some((c) => c.table === "teams" && c.method === "update")).toBe(false);
  });

  it("a supervisor change is a CHECKED write and writes one audit row naming both people and the affected libraries", async () => {
    db.singles["teams"] = { data: { id: "t1", name: "Drafting", supervisor_user_id: "old" } };
    db.tables["libraries"] = { data: [{ id: "l1", name: "Drawings" }] };
    db.tables["teams"] = { data: [{ id: "t1" }] };
    const r = await setTeamSupervisor({ teamId: "t1", orgId: "org1", supervisorUserId: "new", actorId: "a" });
    expect(r.affectedLibraries).toEqual([{ id: "l1", name: "Drawings" }]);
    const row = audited.find((e) => e.action === "TEAM_SUPERVISOR_CHANGED");
    expect(row).toBeDefined();
    expect((row!.details as Record<string, unknown>).previousSupervisor).toBe("old");
    expect((row!.details as Record<string, unknown>).newSupervisor).toBe("new");
    expect((row!.details as Record<string, unknown>).affectedLibraries).toEqual([{ id: "l1", name: "Drawings" }]);
  });

  it("a refused supervisor write (zero rows) throws instead of logging a change that never happened", async () => {
    db.singles["teams"] = { data: { id: "t1", name: "Drafting", supervisor_user_id: "old" } };
    db.tables["libraries"] = { data: [] };
    db.tables["teams"] = { data: [] };
    await expect(setTeamSupervisor({ teamId: "t1", orgId: "org1", supervisorUserId: "new", actorId: "a" })).rejects.toThrow(/NOT changed/);
    expect(audited.find((e) => e.action === "TEAM_SUPERVISOR_CHANGED")).toBeUndefined();
  });

  it("deleting a team clears its library ownership (audited) BEFORE the delete", async () => {
    db.tables["libraries"] = { data: [{ id: "l1", name: "Drawings" }] };
    db.tables["teams"] = { data: [] };
    await deleteTeam("t1", { orgId: "org1", actorId: "a" });
    const clear = db.calls.findIndex((c) => c.table === "libraries" && c.method === "update");
    const del = db.calls.findIndex((c) => c.table === "teams" && c.method === "delete");
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(clear).toBeLessThan(del);
    expect(audited.map((e) => e.action)).toEqual(["OWNER_TEAM_CLEARED", "TEAM_DELETED"]);
  });
});

describe("DEC-21 — reviewer independence in app-side completion", () => {
  const signed = (uid: string, slot = "primary") => ({ id: `r-${uid}`, document_id: "d1", document_version_id: "v1", reviewer_user_id: uid, slot, status: "signed", signature_id: `sig-${uid}`, activated: true });

  it("a sole signed primary who is the publisher is NOT complete (policy defaults on)", async () => {
    db.tables["document_review_signoffs"] = { data: [signed("me")] };
    db.singles["documents"] = { data: { library_id: "lib1" } };
    db.singles["libraries"] = { data: { review_control: { mode: "require" } } };
    const r = await reviewCompletionForDraft("d1", "v1", "me");
    expect(r.signed).toBe(1);
    expect(r.independent).toBe(false);
    expect(r.complete).toBe(false);
  });

  it("the same roster IS complete for a publisher who is not on it, and for a signer alongside an independent primary", async () => {
    db.tables["document_review_signoffs"] = { data: [signed("me")] };
    db.singles["documents"] = { data: { library_id: "lib1" } };
    db.singles["libraries"] = { data: { review_control: { mode: "require" } } };
    expect((await reviewCompletionForDraft("d1", "v1", "someone-else")).complete).toBe(true);
    db.tables["document_review_signoffs"] = { data: [signed("me"), signed("peer")] };
    expect((await reviewCompletionForDraft("d1", "v1", "me")).complete).toBe(true);
  });

  it("a library that opted out (requireIndependentReviewer: false) is unaffected", async () => {
    db.tables["document_review_signoffs"] = { data: [signed("me")] };
    db.singles["documents"] = { data: { library_id: "lib1" } };
    db.singles["libraries"] = { data: { review_control: { mode: "require", requireIndependentReviewer: false } } };
    expect((await reviewCompletionForDraft("d1", "v1", "me")).complete).toBe(true);
  });
});

describe("source pins — the UI and app entry points", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("members page: suspend is the default action, remove is confirmed, both go through revokeMember; no bare delete", () => {
    const s = src("app/(protected)/admin/users/page.tsx");
    expect(s).toMatch(/revokeMember\(\{ memberId: member\.id, mode: 'suspend'/);
    expect(s).toMatch(/revokeMember\(\{ memberId: member\.id, mode: 'remove'/);
    expect(s).toMatch(/revokeMember\(\{ memberId: member\.id, mode: 'restore'/);
    expect(s).not.toMatch(/from\('org_members'\)\.delete\(\)/);
    expect(s).toMatch(/becomes UNOWNED \(cleared and audited — never silently reassigned\)/);
  });

  it("force-release goes through the atomic RPC; the stale-lock repair is a CHECKED write", () => {
    const s = src("lib/checkoutEpisodes.ts");
    expect(s).toMatch(/supabase\.rpc\("force_release_document", \{/);
    expect(s).toMatch(/Force release was refused — the lock was NOT cleared/);
    expect(s).toMatch(/\[reconcileDocumentCheckoutState\] stale lock NOT cleared/);
  });

  it("legal hold and retention writes assert authority app-side; disposal is a checked write", () => {
    const s = src("lib/retention.ts");
    expect(s).toMatch(/await assertLegalHoldAuthority\(input\.orgId, input\.actorId, "placed"\);/);
    expect(s).toMatch(/await assertLegalHoldAuthority\(input\.orgId, input\.actorId, "released"\);/);
    expect(s).toMatch(/await assertRetentionAuthority\(\{ orgId: input\.orgId, actorId: input\.actorId, documentId: input\.documentId \}\);/);
    expect(s).toMatch(/if \(!disposed \|\| disposed\.length === 0\) return \{ ok: false, reason: "refused" \};/);
  });

  it("permissions drawer: delegation mode bounds owner grants and the index is expiry-aware", () => {
    const s = src("components/permissions/PermissionDrawer.tsx");
    expect(s).toMatch(/delegationOnly\?: boolean;/);
    expect(s).toMatch(/Owner-issued grants must have an expiry/);
    expect(s).toMatch(/Owners cannot delegate/);
    expect(s).toMatch(/buildAclIndexFromChain\(chain, Date\.now\(\)\)/);
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(page).toMatch(/canEdit=\{isController \|\| drawerDelegationAuthority\}/);
    expect(page).toMatch(/delegationOnly=\{!isController && drawerDelegationAuthority\}/);
    expect(page).toMatch(/canWithAclChain\(\{ principal, action: "managePermissions", aclChain: chain, defaultAllow: false \}\)/);
  });

  it("admin settings gate is Admin-only by collection; teams picker is constrained; review modal exposes independence", () => {
    expect(src("app/(protected)/admin/settings/page.tsx")).toMatch(/const ADMIN_ROLES = new Set\(\["Admin"\]\);/);
    const teams = src("app/(protected)/admin/teams/page.tsx");
    expect(teams).toMatch(/supervisorOverride \|\| teamMemberIds\.includes\(m\.uid\)/);
    expect(teams).toMatch(/setTeamSupervisor\(\{ teamId: selected\.id/);
    expect(src("components/documents/ReviewControlModal.tsx")).toMatch(/requireIndependentReviewer: requireIndependent/);
  });
});
