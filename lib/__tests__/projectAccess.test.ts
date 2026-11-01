// Who may do what on a project: owner, co-owner, editor, viewer, org roles.

import { describe, it, expect } from "vitest";
import { projectAccess, roleLabel, MEMBER_ROLES, needsCoOwnerSql } from "@/lib/projectAccess";

describe("project permissions", () => {
  it("owner and co-owner manage and edit", () => {
    expect(projectAccess({ isOwner: true })).toEqual({ canEdit: true, canManage: true });
    expect(projectAccess({ isOwner: false, memberRole: "co_owner" })).toEqual({ canEdit: true, canManage: true });
  });
  it("an editor updates the work, whatever their org role", () => {
    expect(projectAccess({ isOwner: false, memberRole: "collaborator", orgRoles: ["Viewer"] })).toEqual({ canEdit: true, canManage: false });
    expect(projectAccess({ isOwner: false, memberRole: "collaborator", orgRoles: ["Engineer"] })).toEqual({ canEdit: true, canManage: false });
  });
  it("a viewer reads, unless their org role works schedules", () => {
    expect(projectAccess({ isOwner: false, memberRole: "observer", orgRoles: ["Engineer"] })).toEqual({ canEdit: false, canManage: false });
    expect(projectAccess({ isOwner: false, memberRole: "observer", orgRoles: ["Supervisor"] })).toEqual({ canEdit: true, canManage: false });
  });
  it("not on the project: the org role decides", () => {
    expect(projectAccess({ isOwner: false, orgRoles: ["Admin"] })).toEqual({ canEdit: true, canManage: true });
    expect(projectAccess({ isOwner: false, orgRoles: ["Manager"] })).toEqual({ canEdit: true, canManage: false });
    expect(projectAccess({ isOwner: false, orgRoles: ["Engineer", null] })).toEqual({ canEdit: false, canManage: false });
  });
  it("the names people see", () => {
    expect(MEMBER_ROLES.map((r) => r.label)).toEqual(["Co-owner", "Editor", "Viewer"]);
    expect(roleLabel("owner")).toBe("Owner");
    expect(roleLabel("collaborator")).toBe("Editor");
    expect(roleLabel("observer")).toBe("Viewer");
  });
  it("knows when the co-owner SQL hasn't been run", () => {
    expect(needsCoOwnerSql('new row for relation "project_members" violates check constraint "project_members_role_check"')).toBe(true);
    expect(needsCoOwnerSql("permission denied")).toBe(false);
  });
});
