// lib/__tests__/permissions.publish.test.ts
//
// Per-library publish authority (canPublishOnLibrary): the single source of truth
// for "who may publish a revision in THIS library", evaluated against the library's
// own ACL. Admin/DocCtrl always; everyone else only where explicitly granted.

import { describe, it, expect } from "vitest";
import { canPublishOnLibrary } from "@/lib/permissions";
import type { AccessControl, AccessRule, Role } from "@/types/schema";

const lib = (rules: AccessRule[]): AccessControl => ({ rules });
const P = (role: Role, uid = "u1", teamIds: string[] = []) => ({
  uid, role, orgId: "org1", teamIds, isActiveMember: true,
});

describe("canPublishOnLibrary", () => {
  it("Admin and DocCtrl may publish anywhere (no acl needed)", () => {
    expect(canPublishOnLibrary({ principal: P("Admin"), libraryAcl: undefined })).toBe(true);
    expect(canPublishOnLibrary({ principal: P("DocCtrl"), libraryAcl: undefined })).toBe(true);
  });

  it("no library acl => only controllers publish", () => {
    expect(canPublishOnLibrary({ principal: P("DraftingSupervisor"), libraryAcl: undefined })).toBe(false);
  });

  it("a role granted publish on this library may publish", () => {
    const acl = lib([{ effect: "allow", subject: { type: "role", id: "DraftingSupervisor" }, actions: ["publish"] }]);
    expect(canPublishOnLibrary({ principal: P("DraftingSupervisor"), libraryAcl: acl })).toBe(true);
  });

  it("a role NOT granted publish here is denied (the procedures-library case)", () => {
    const acl = lib([{ effect: "allow", subject: { type: "role", id: "Engineer-2" }, actions: ["publish"] }]);
    expect(canPublishOnLibrary({ principal: P("DraftingSupervisor"), libraryAcl: acl })).toBe(false);
  });

  it("an explicit deny of publish wins over an allow", () => {
    const acl = lib([
      { effect: "allow", subject: { type: "role", id: "DraftingSupervisor" }, actions: ["publish"] },
      { effect: "deny", subject: { type: "user", id: "u1" }, actions: ["publish"] },
    ]);
    expect(canPublishOnLibrary({ principal: P("DraftingSupervisor", "u1"), libraryAcl: acl })).toBe(false);
  });

  it("a user-subject grant resolves to exactly that user", () => {
    const acl = lib([{ effect: "allow", subject: { type: "user", id: "u-pub" }, actions: ["publish"] }]);
    expect(canPublishOnLibrary({ principal: P("Drafter", "u-pub"), libraryAcl: acl })).toBe(true);
    expect(canPublishOnLibrary({ principal: P("Drafter", "u-other"), libraryAcl: acl })).toBe(false);
  });

  it("a team-subject grant resolves for a member of that team", () => {
    const acl = lib([{ effect: "allow", subject: { type: "team", id: "team-cad" }, actions: ["publish"] }]);
    expect(canPublishOnLibrary({ principal: P("Drafter", "u1", ["team-cad"]), libraryAcl: acl })).toBe(true);
    expect(canPublishOnLibrary({ principal: P("Drafter", "u1", ["team-hr"]), libraryAcl: acl })).toBe(false);
  });

  it("a library 'admin' grant implies publish (intentional — mirrors evaluateAcl)", () => {
    const acl = lib([{ effect: "allow", subject: { type: "role", id: "DraftingSupervisor" }, actions: ["admin"] }]);
    expect(canPublishOnLibrary({ principal: P("DraftingSupervisor"), libraryAcl: acl })).toBe(true);
  });

  it("a plain Engineer with no grant cannot publish even where others are granted", () => {
    const acl = lib([{ effect: "allow", subject: { type: "role", id: "DraftingSupervisor" }, actions: ["publish"] }]);
    expect(canPublishOnLibrary({ principal: P("Engineer-2"), libraryAcl: acl })).toBe(false);
  });
});
