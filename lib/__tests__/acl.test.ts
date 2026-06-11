// lib/__tests__/acl.test.ts
//
// Freezes the access-control semantics — deny-wins, admin-grant, rule expiry,
// inheritance, hidden-node blind-drill, and the revoked-member defense-in-depth
// gate. This is security-critical pure logic; a silent change here is a data
// exposure, so it gets pinned hard.

import { describe, it, expect } from "vitest";
import {
  evaluateAcl,
  evaluateAclChain,
  canBlindDrill,
  buildAclIndex,
} from "@/lib/acl";
import type { AccessControl, AccessRule, PermissionAction, PermissionSubjectType, Role } from "@/types/schema";

const rule = (
  effect: "allow" | "deny",
  subjectType: PermissionSubjectType,
  id: string,
  actions: PermissionAction[],
  expiresAt?: string,
): AccessRule =>
  ({ effect, subject: { type: subjectType, id }, actions, ...(expiresAt ? { expiresAt } : {}) }) as AccessRule;

const acl = (rules: AccessRule[], opts: Partial<AccessControl> = {}): AccessControl =>
  ({ rules, ...opts }) as AccessControl;

const ROLE = (r: Role) => r;

describe("evaluateAcl — single node", () => {
  it("returns null for no ACL", () => {
    expect(evaluateAcl(undefined, { uid: "u1" })).toBeNull();
  });

  it("grants an allowed action to the matching role", () => {
    const d = evaluateAcl(acl([rule("allow", "role", ROLE("Drafter"), ["read", "download"])]), { role: "Drafter" });
    expect(d?.can("read")).toBe(true);
    expect(d?.can("download")).toBe(true);
    expect(d?.can("write")).toBe(false);
  });

  it("does not grant to a non-matching subject", () => {
    const d = evaluateAcl(acl([rule("allow", "user", "u1", ["read"])]), { uid: "u2", role: "Drafter" });
    expect(d?.can("read")).toBe(false);
  });

  it("DENY beats ALLOW for the same action", () => {
    const d = evaluateAcl(
      acl([rule("allow", "role", ROLE("Drafter"), ["read", "write"]), rule("deny", "role", ROLE("Drafter"), ["write"])]),
      { role: "Drafter" },
    );
    expect(d?.can("read")).toBe(true);
    expect(d?.can("write")).toBe(false);
  });

  it("an admin grant implies every action…", () => {
    const d = evaluateAcl(acl([rule("allow", "user", "u1", ["admin"])]), { uid: "u1" });
    expect(d?.can("read")).toBe(true);
    expect(d?.can("managePermissions")).toBe(true);
    expect(d?.can("write")).toBe(true);
  });

  it("an admin grant is only revoked by denying 'admin' itself — NOT a specific action", () => {
    // SHARP EDGE (flagged for the security-review slice): denying a specific
    // action does NOT override a blanket admin grant. The current contract is
    // "to strip an admin, deny 'admin'." Frozen here so any future change to
    // this rule is a deliberate, visible diff — not a silent privilege change.
    const adminWithSpecificDeny = evaluateAcl(
      acl([rule("allow", "user", "u1", ["admin"]), rule("deny", "user", "u1", ["write"])]),
      { uid: "u1" },
    );
    expect(adminWithSpecificDeny?.can("write")).toBe(true); // admin still wins

    const adminDenied = evaluateAcl(
      acl([rule("allow", "user", "u1", ["admin"]), rule("deny", "user", "u1", ["admin"])]),
      { uid: "u1" },
    );
    expect(adminDenied?.can("write")).toBe(false); // denying 'admin' strips the blanket grant
    expect(adminDenied?.can("read")).toBe(false);
  });

  it("ignores expired rules", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(evaluateAcl(acl([rule("allow", "user", "u1", ["read"], past)]), { uid: "u1" })?.can("read")).toBe(false);
    expect(evaluateAcl(acl([rule("allow", "user", "u1", ["read"], future)]), { uid: "u1" })?.can("read")).toBe(true);
  });

  it("revoked member (isActiveMember=false) loses ALLOW grants but DENY still bites", () => {
    const d = evaluateAcl(
      acl([rule("allow", "role", ROLE("Admin"), ["read", "admin"]), rule("deny", "role", ROLE("Admin"), ["download"])]),
      { role: "Admin", isActiveMember: false },
    );
    expect(d?.can("read")).toBe(false);
    expect(d?.can("admin")).toBe(false);
    expect(d?.can("download")).toBe(false);
  });

  it("matches team and org subjects", () => {
    const team = evaluateAcl(acl([rule("allow", "team", "team-1", ["read"])]), { teamIds: ["team-1", "team-2"] });
    expect(team?.can("read")).toBe(true);
    const org = evaluateAcl(acl([rule("allow", "org", "org-1", ["read"])]), { orgId: "org-1" });
    expect(org?.can("read")).toBe(true);
  });
});

describe("discoverability", () => {
  it("a normal node is discoverable with any read-ish grant", () => {
    const d = evaluateAcl(acl([rule("allow", "user", "u1", ["read"])], { visibility: "normal" }), { uid: "u1" });
    expect(d?.isDiscoverable()).toBe(true);
  });

  it("a hidden node is only discoverable with an explicit discover grant", () => {
    const readOnly = evaluateAcl(acl([rule("allow", "user", "u1", ["read"])], { visibility: "hidden" }), { uid: "u1" });
    expect(readOnly?.isDiscoverable()).toBe(false);
    const withDiscover = evaluateAcl(
      acl([rule("allow", "user", "u1", ["read", "discover"])], { visibility: "hidden" }),
      { uid: "u1" },
    );
    expect(withDiscover?.isDiscoverable()).toBe(true);
  });
});

describe("evaluateAclChain — inheritance", () => {
  it("a child inherits a parent's grants", () => {
    const parent = acl([rule("allow", "role", ROLE("Drafter"), ["read"])]);
    const child = acl([]);
    expect(evaluateAclChain([parent, child], { role: "Drafter" })?.can("read")).toBe(true);
  });

  it("a child with inherit:false drops the parent's grants", () => {
    const parent = acl([rule("allow", "role", ROLE("Drafter"), ["read"])]);
    const child = acl([], { inherit: false });
    expect(evaluateAclChain([parent, child], { role: "Drafter" })?.can("read")).toBe(false);
  });

  it("a child DENY overrides an inherited parent ALLOW", () => {
    const parent = acl([rule("allow", "role", ROLE("Drafter"), ["read"])]);
    const child = acl([rule("deny", "role", ROLE("Drafter"), ["read"])]);
    expect(evaluateAclChain([parent, child], { role: "Drafter" })?.can("read")).toBe(false);
  });

  it("hidden visibility propagates down the chain", () => {
    const parent = acl([rule("allow", "user", "u1", ["read"])], { visibility: "hidden" });
    const child = acl([]);
    expect(evaluateAclChain([parent, child], { uid: "u1" })?.visibility).toBe("hidden");
  });

  it("returns null when the chain has no ACLs", () => {
    expect(evaluateAclChain([undefined, undefined], { uid: "u1" })).toBeNull();
  });
});

describe("canBlindDrill", () => {
  it("is false for a null decision and for normal-visibility nodes", () => {
    expect(canBlindDrill(null)).toBe(false);
    const normal = evaluateAcl(acl([rule("allow", "user", "u1", ["read", "discover"])]), { uid: "u1" });
    expect(canBlindDrill(normal)).toBe(false);
  });

  it("is true only when a hidden node grants both discover and read", () => {
    const ok = evaluateAcl(acl([rule("allow", "user", "u1", ["discover", "read"])], { visibility: "hidden" }), { uid: "u1" });
    expect(canBlindDrill(ok)).toBe(true);
    const noRead = evaluateAcl(acl([rule("allow", "user", "u1", ["discover"])], { visibility: "hidden" }), { uid: "u1" });
    expect(canBlindDrill(noRead)).toBe(false);
  });
});

describe("buildAclIndex", () => {
  it("buckets allow/deny rules by subject + action", () => {
    const idx = buildAclIndex(acl([
      rule("allow", "role", ROLE("Drafter"), ["read"]),
      rule("deny", "user", "u1", ["write"]),
    ]));
    expect(idx?.allow.roles.read).toContain("Drafter");
    expect(idx?.deny.users.write).toContain("u1");
  });

  it("returns null for an empty rule set", () => {
    expect(buildAclIndex(acl([]))).toBeNull();
  });
});
