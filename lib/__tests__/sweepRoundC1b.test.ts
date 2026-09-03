// Phase 6 severity sweep, Round C1b — ADD-1 residual: every affordance gate
// and every server-side authority read consults the role COLLECTION, never
// the headline alone. A census pins the converted files so the headline
// pattern cannot creep back, and the shared helpers are tested directly.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { heldRoles, memberHoldsAny, roleFilter } from "@/lib/roleHeld";
import { restoredMemberRoles, restoredMemberHeadline } from "@/lib/dataRestore";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("lib/roleHeld — the one place 'does this member hold any of these roles?' is asked", () => {
  it("heldRoles is the headline plus the additive collection, de-duplicated", () => {
    expect(heldRoles({ role: "Manager", roles: ["Manager", "Drafter", " Safety "] })).toEqual(["Manager", "Drafter", "Safety"]);
    expect(heldRoles({ role: "Viewer" })).toEqual(["Viewer"]);
    expect(heldRoles({ roles: ["DocCtrl"] })).toEqual(["DocCtrl"]);
    expect(heldRoles(null)).toEqual([]);
    expect(heldRoles({ role: 3, roles: "DocCtrl" })).toEqual([]);
  });
  it("memberHoldsAny: an additively held DocCtrl counts; a headline-only Manager does not become Admin", () => {
    expect(memberHoldsAny({ role: "Requester", roles: ["Requester", "DocCtrl"] }, ["Admin", "DocCtrl"])).toBe(true);
    expect(memberHoldsAny({ role: "Manager", roles: ["Manager"] }, ["Admin"])).toBe(false);
    expect(memberHoldsAny({ role: "Admin" }, ["Admin"])).toBe(true);
    expect(memberHoldsAny(null, ["Admin"])).toBe(false);
  });
  it("roleFilter spells the PostgREST or-filter with quoted values so Engineer-1 survives both syntaxes", () => {
    expect(roleFilter(["Admin", "DocCtrl"])).toBe('role.in.("Admin","DocCtrl"),roles.ov.{"Admin","DocCtrl"}');
    expect(roleFilter(["Engineer-1", "Engineer-1", " "])).toBe('role.in.("Engineer-1"),roles.ov.{"Engineer-1"}');
    expect(roleFilter([])).toBe("role.in.()");
  });
});

describe("restore keeps the backup's harmless collection and drops only the privileged roles (SURF-8 + ADD-1)", () => {
  it("restoredMemberRoles / restoredMemberHeadline", () => {
    expect(restoredMemberRoles("Admin", ["Admin", "Requester", "Safety"])).toEqual(["Requester", "Safety"]);
    expect(restoredMemberHeadline(["Requester", "Safety"])).toBe("Requester");
    expect(restoredMemberRoles("Admin", ["Admin"])).toEqual(["Viewer"]);
    expect(restoredMemberRoles("Safety", undefined)).toEqual(["Safety"]);
    expect(restoredMemberRoles(undefined, null)).toEqual(["Viewer"]);
    expect(restoredMemberRoles("DocCtrl", ["Manager", "Supervisor", "DraftingSupervisor"])).toEqual(["Viewer"]);
  });
});

const CLIENT_FILES = [
  "app/(protected)/admin/assets/page.tsx", "app/(protected)/admin/ai-instructions/page.tsx", "app/(protected)/admin/libraries/page.tsx",
  "app/(protected)/admin/branding/page.tsx", "app/(protected)/admin/restore/page.tsx", "app/(protected)/admin/proposed-links/page.tsx",
  "app/(protected)/admin/storage/page.tsx", "app/(protected)/admin/permissions/page.tsx", "app/(protected)/admin/audit/page.tsx",
  "app/(protected)/admin/codebook/page.tsx", "app/(protected)/admin/holds/page.tsx", "app/(protected)/admin/scope/page.tsx",
  "app/(protected)/admin/data-export/page.tsx", "app/(protected)/admin/billing/page.tsx", "app/(protected)/admin/requests/page.tsx",
  "app/(protected)/knowledge/page.tsx", "app/(protected)/knowledge/[id]/page.tsx", "app/(protected)/intelligence/page.tsx",
  "app/(protected)/intelligence/setup/page.tsx", "app/(protected)/intelligence/skills/page.tsx", "app/(protected)/output-templates/page.tsx",
  "app/(protected)/assets/[tag]/page.tsx", "components/providers/OrgBrandingProvider.tsx", "components/providers/KnowledgeIndexIndicator.tsx",
  "components/intelligence/ConnectionSkillsPanel.tsx", "components/onboarding/SetupChecklist.tsx", "components/documents/ReviewGateSection.tsx",
  "app/(protected)/documents/[libraryId]/page.tsx", "app/(protected)/requests/[id]/page.tsx", "app/(protected)/admin/users/page.tsx",
];
// The headline used as an AUTHORITY test. Display uses (`{activeRole} Console`,
// `userRole: activeRole` audit payloads, `userRole={activeRole}` props beside a
// `userRoles={roles}`) and the resolved-membership sentinel (`activeRole &&`)
// are not matched.
const HEADLINE_AUTHORITY = [
  /activeRole\s*===\s*['"]/, /activeRole\s*!==\s*['"]/, /\.includes\(activeRole/, /\.has\(activeRole/,
  /activeRole\??\.includes\(/, /activeRole\??\.startsWith\(/, /shapeRole\s*===/,
];

describe("census — no client affordance gate reads the headline alone", () => {
  for (const f of CLIENT_FILES) {
    it(f, () => {
      const s = src(f);
      for (const re of HEADLINE_AUTHORITY) expect(s, `${f} matches ${re}`).not.toMatch(re);
    });
  }
  it("the two prop-driven components accept the collection and the library page passes it", () => {
    expect(src("components/viewers/FullScreenViewer.tsx")).toMatch(/userRoles\?: string\[\] \| null;/);
    expect(src("components/viewers/FullScreenViewer.tsx")).toMatch(/const heldForAssets = \[userRole \?\? '', \.\.\.\(userRoles \?\? \[\]\)\];/);
    expect(src("components/documents/CollectionsStrip.tsx")).toMatch(/const isAdmin = \[userRole, \.\.\.\(userRoles \?\? \[\]\)\]\.some\(\(r\) => ADMIN_ROLES\.includes\(r\)\);/);
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect((page.match(/userRoles=\{roles\}/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(page).toContain('canManage={hasAnyRole(["Admin", "Manager", "Supervisor"])}');
    expect(page).toContain('canManageAssets={hasAnyRole(["Admin", "Manager", "Supervisor", "Drafter"]) || roles.some((r) => r.includes("Engineer"))}');
  });
  it("the ticket page's admin and requester affordances read the collection; the console's card lens stays display-only", () => {
    const t = src("app/(protected)/requests/[id]/page.tsx");
    expect(t).toContain("const isAdmin = hasAnyRole(['Admin', 'DocCtrl']);");
    expect(t).toContain("{(hasAnyRole(['Drafter', 'Requester', 'Admin']) || uid === ticket.requesterId) && (");
    expect(src("app/(protected)/requests/page.tsx")).toContain("{hasAnyRole(['Manager', 'Admin']) && (");
  });
});

const SERVER_ROUTES = [
  "app/api/tickets/comment/route.ts", "app/api/links/propose/route.ts", "app/api/equipment-bridge/route.ts",
  "app/api/data-export/structured/route.ts", "app/api/companies/quality-manual/route.ts", "app/api/flows/read/route.ts",
  "app/api/graph/shape/route.ts", "app/api/graph/mentions/route.ts", "app/api/projects/cost-docs/route.ts",
  "app/api/codebook/import/route.ts", "app/api/intake/upload/route.ts",
];
describe("census — server routes authorise by the collection", () => {
  for (const f of SERVER_ROUTES) {
    it(f, () => {
      const s = src(f);
      expect(s).toMatch(/memberHoldsAny\(|roleFilter\(/);
      expect(s).not.toMatch(/\.select\("role"\)/);
      expect(s).not.toMatch(/\.select\("role, status"\)/);
      expect(s).not.toMatch(/\.select\("role, email"\)/);
      expect(s).not.toMatch(/\.in\("role", \[/);
      expect(s).not.toMatch(/\b(?:m|member|role)\.role\s*===\s*"Admin"/);
      expect(s).not.toMatch(/\.includes\((?:m|member|role)\.role/);
      expect(s).not.toMatch(/\.has\(String\((?:m|member)\.role\)\)/);
    });
  }
  it("create-user's Admin-grant escalation guard reads the caller's held set; notify pools use roleFilter", () => {
    const cu = src("app/api/admin/create-user/route.ts");
    expect(cu).not.toMatch(/\(callerMember\.role as string\) !== "Admin"/);
    expect((cu.match(/!callerHeld\.has\("Admin"\)/g) ?? []).length).toBe(2);
    for (const f of ["app/api/cron/maintenance/route.ts", "app/api/data-export/run/route.ts"]) {
      expect(src(f)).toMatch(/\.or\(roleFilter\(\["Admin", "DocCtrl"\]\)\)/);
      expect(src(f)).not.toMatch(/\.in\("role", \["Admin", "DocCtrl"\]\)/);
    }
  });
});

describe("census — pool resolvers find additive holders", () => {
  it("reviewControl / acknowledgments resolve a role to everyone holding it and only warn when nobody does", () => {
    for (const f of ["lib/reviewControl.ts", "lib/acknowledgments.ts"]) {
      const s = src(f);
      expect(s).toMatch(/\.select\("uid, display_name, email, role, roles"\)[^\n]*\.or\(roleFilter\(/);
      expect(s).toMatch(/const held = heldRoles\(r as \{ role\?: unknown; roles\?: unknown \}\);/);
      expect(s).toMatch(/for \(const h of held\) if \((?:roleList|roles)\.includes\(h\)\) covered\.add\(h\);/);
      expect(s).not.toMatch(/\.in\("role", (?:roleList|roles)\)/);
    }
  });
  it("ticket routing pools are 'everyone holding the role'", () => {
    const s = src("lib/ticketRouting.ts");
    expect(s).toContain('.select("uid, role, roles, display_name, email")');
    expect(s).toContain("const byRole = (r: Role) => members.filter((m) => m.roles.includes(r));");
    expect(s).toContain("members.filter((m) => m.roles.some((r) => engineerRoles.includes(r)))");
    expect(s).not.toMatch(/members\.filter\(\(m\) => m\.role === r\)/);
  });
  it("restore seeds the surviving collection, both routes", () => {
    for (const f of ["app/api/admin/restore/begin/route.ts", "app/api/admin/restore/apply/route.ts"]) {
      expect(src(f)).toContain("role: restoredMemberHeadline(restoredMemberRoles(u.role, u.roles)), roles: restoredMemberRoles(u.role, u.roles),");
    }
  });
});
