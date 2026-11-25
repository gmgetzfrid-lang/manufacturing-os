import { describe, it, expect } from "vitest";
import { accessWords, defaultLibraryAccess } from "@/lib/libraryAccess";
import { canWithAclChain } from "@/lib/permissions";
import type { AccessControl, AccessRule, Role } from "@/types/schema";

const ORG = "org-1";
const W: AccessRule["actions"] = ["upload", "createFolder", "editMetadata", "write", "download", "read", "discover"];
const role = (id: string, actions = W): AccessRule => ({ effect: "allow", subject: { type: "role", id }, actions });
// The shape of the workspace's Procedures library: everyone reads; Engineer-1 and -2 add too.
const procedures: AccessControl = { inherit: true, visibility: "normal", rules: [
  { effect: "allow", subject: { type: "org", id: ORG }, actions: ["discover", "read", "download"] },
  role("DocCtrl"), role("Admin"), role("Engineer-1"), role("Engineer-2"),
  role("Admin", ["admin", "managePermissions"]), role("DocCtrl", ["admin", "managePermissions"]),
] };
const can = (r: Role, acl: AccessControl | undefined) => canWithAclChain({ principal: { uid: "u", role: r, orgId: ORG, teamIds: [] }, action: "upload", aclChain: [acl] });

describe("a new library's access", () => {
  it("is never no rules: everyone sees, Admin and Document Control add", () => {
    const a = defaultLibraryAccess(ORG);
    expect(a.acl.rules.length).toBe(5);
    expect(a.default_new_acl).toEqual(a.acl);
    expect(accessWords(a.acl)).toEqual({ view: "Everyone in the workspace", add: "Admin and Document Control", open: false });
    expect(can("Engineer-1", a.acl)).toBe(false);
    expect(can("Drafter", a.acl)).toBe(false);
    expect(can("DocCtrl", a.acl)).toBe(true);
  });
  it("no rules at all lets every member add (why a library is never made so)", () => {
    expect(can("Viewer", undefined)).toBe(true);
    expect(accessWords(null).open).toBe(true);
  });
});

describe("access in words", () => {
  it("names who adds files", () => {
    expect(accessWords(procedures).add).toBe("Admin, Document Control, Engineer-1 and Engineer-2");
    expect(can("Engineer-1", procedures)).toBe(true);
    expect(can("Supervisor", procedures)).toBe(false);
  });
  it("says when only some roles see it", () => {
    const narrow: AccessControl = { rules: [role("Manager", ["read", "discover"]), role("Admin")] };
    expect(accessWords(narrow).view).toBe("Admin, Document Control and Manager");
  });
});
