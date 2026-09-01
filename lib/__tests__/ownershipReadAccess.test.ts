// GAP-15 / DEC-7 — ownership carries READ access, and only read access.
//
// The DB's node_visible now returns an owner's private-library rows; these
// client mirrors must not re-hide them — and must not hand the owner any
// WRITE authority they don't otherwise hold.

import { describe, it, expect } from "vitest";
import { canDiscover, canWithAclChain, type Principal } from "@/lib/permissions";

const member: Principal = {
  uid: "owner-1", role: "Editor" as Principal["role"], orgId: "org1",
  teamIds: [], isActiveMember: true,
};

describe("canDiscover ownership branch", () => {
  it("the effective owner sees a private node with no ACL grant", () => {
    expect(canDiscover({ principal: member, visibility: "private", effectiveOwnerUserId: "owner-1" }))
      .toBe(true);
  });

  it("a non-owner member still cannot", () => {
    expect(canDiscover({ principal: member, visibility: "private", effectiveOwnerUserId: "someone-else" }))
      .toBe(false);
    expect(canDiscover({ principal: member, visibility: "private" })).toBe(false);
  });

  it("normal visibility is unchanged either way", () => {
    expect(canDiscover({ principal: member, visibility: "normal" })).toBe(true);
  });
});

describe("canWithAclChain ownership branch", () => {
  it("grants the owner read and discover only", () => {
    const base = { principal: member, effectiveOwnerUserId: "owner-1", defaultAllow: false } as const;
    expect(canWithAclChain({ ...base, action: "read" })).toBe(true);
    expect(canWithAclChain({ ...base, action: "discover" })).toBe(true);
    // Write-shaped authority keeps its own rules — ownership's write half
    // lives in the publish guard, not here.
    expect(canWithAclChain({ ...base, action: "write" })).toBe(false);
    expect(canWithAclChain({ ...base, action: "managePermissions" })).toBe(false);
  });

  it("a non-owner is unchanged", () => {
    expect(canWithAclChain({
      principal: member, action: "read", defaultAllow: false, effectiveOwnerUserId: "someone-else",
    })).toBe(false);
  });
});
