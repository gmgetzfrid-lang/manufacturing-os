// Library wizard ACL merge (DB-5).
//
// The wizard rebuilds a library's ACL from role-based form state. On an edit it
// must NOT clobber the permission drawer's granular user/team/org grants — the
// merge preserves them while letting the wizard own role-level access, so a
// metadata edit never silently revokes a drawer grant, and acl/acl_index stay
// derivable from one consistent source.

import { describe, it, expect } from "vitest";
import { mergeWizardLibraryAcl, buildAclIndex } from "@/lib/acl";
import type { AccessControl, AccessRule } from "@/types/schema";

const roleRule = (id: string): AccessRule => ({ effect: "allow", subject: { type: "role", id }, actions: ["read"] });
const userRule = (id: string): AccessRule => ({ effect: "allow", subject: { type: "user", id }, actions: ["publish"] });
const teamRule = (id: string): AccessRule => ({ effect: "allow", subject: { type: "team", id }, actions: ["publish"] });

describe("mergeWizardLibraryAcl (DB-5)", () => {
  it("keeps the wizard's role rules and re-adds the drawer's user/team grants", () => {
    const wizardAcl: AccessControl = { inherit: true, visibility: "normal", rules: [roleRule("DocCtrl")] };
    const existing: AccessRule[] = [roleRule("Viewer"), userRule("u-pub"), teamRule("team-cad")];
    const merged = mergeWizardLibraryAcl(wizardAcl, existing);
    const subjects = merged!.rules.map((r) => `${r.subject.type}:${r.subject.id}`);
    // wizard role rule kept; drawer user/team grants preserved; the OLD role
    // rule (Viewer) is intentionally dropped — the wizard owns role access.
    expect(subjects).toContain("role:DocCtrl");
    expect(subjects).toContain("user:u-pub");
    expect(subjects).toContain("team:team-cad");
    expect(subjects).not.toContain("role:Viewer");
  });

  it("preserves drawer grants even when the wizard produces no ACL", () => {
    const merged = mergeWizardLibraryAcl(null, [userRule("u-pub")]);
    expect(merged?.rules.map((r) => r.subject.id)).toEqual(["u-pub"]);
  });

  it("returns null when there is nothing to write", () => {
    expect(mergeWizardLibraryAcl(null, [])).toBeNull();
    expect(mergeWizardLibraryAcl(null, [roleRule("Viewer")])).toBeNull(); // only a role rule, no wizard acl
  });

  it("acl_index derived from the merge names the preserved user grant", () => {
    const wizardAcl: AccessControl = { inherit: true, visibility: "normal", rules: [roleRule("DocCtrl")] };
    const merged = mergeWizardLibraryAcl(wizardAcl, [userRule("u-pub")]);
    const idx = buildAclIndex(merged ?? undefined);
    expect(idx?.allow.users?.publish).toContain("u-pub");
  });
});
