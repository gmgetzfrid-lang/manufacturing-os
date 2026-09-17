// Role-picker census — every role in the model is offerable as an ACL subject.
//
// OWN-9: DraftingSupervisor — the role the per-library publish feature was
// built for (20260812_per_library_publish_authority.sql names it in its own
// header) — was missing from both role pickers, so no {type:'role'} rule could
// ever name it from the UI. These tests pin the census: the single-rule picker
// (PermissionDrawer.ROLES) and the bulk selector (RoleTreeSelector.
// ROLE_HIERARCHY) must each offer exactly the roles in ALL_ROLES.
//
// The pickers are client components whose import graph reaches the live
// Supabase client, so the arrays are read from source text rather than
// imported. Extraction is anchored to the declaration, not a substring match —
// "Supervisor" must not satisfy "DraftingSupervisor".

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_ROLES, type Role } from "@/types/schema";
import { pickerRoster, addableRoles, capabilitiesAdded, DORMANT_ROLES, isDormantRole, pickerNote, READ_ONLY_ROLE_NOTE, CONTRACTOR_ROLE_NOTE } from "@/lib/roleCapabilities";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Pull every double-quoted string out of one balanced `[` ... `]` block that
 *  follows the given declaration anchor. */
function rolesInArrayLiteral(source: string, anchor: RegExp): string[] {
  const m = anchor.exec(source);
  if (!m) throw new Error(`anchor not found: ${anchor}`);
  // Search after the whole anchor (which includes the `=`) so the `[` of a
  // type annotation like `Role[]` inside the anchor is never mistaken for
  // the opening of the array literal.
  const start = source.indexOf("[", m.index + m[0].length);
  let depth = 0;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "[") depth++;
    if (source[i] === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error("unbalanced array literal");
  const block = source.slice(start, end + 1);
  return [...block.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("role pickers offer the whole role model (OWN-9)", () => {
  it("PermissionDrawer's single-rule picker lists every role, exactly once", () => {
    const src = read("components/permissions/PermissionDrawer.tsx");
    const roles = rolesInArrayLiteral(src, /const ROLES:\s*Role\[\]\s*=/);
    expect(new Set(roles)).toEqual(new Set(ALL_ROLES));
    expect(roles.length).toBe(ALL_ROLES.length);
  });

  it("RoleTreeSelector's bulk hierarchy covers every role, exactly once", () => {
    // Group display names ("Leadership", …) sit outside the `roles:` arrays,
    // so the census counts only strings inside them. ("Operations" is both a
    // group name and a role — this keeps the two apart.)
    const src = read("components/permissions/RoleTreeSelector.tsx");
    const roleArrays = [...src.matchAll(/roles:\s*\[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    expect(new Set(roleArrays)).toEqual(new Set(ALL_ROLES));
    expect(roleArrays.length).toBe(ALL_ROLES.length);
  });
});

describe("role pickers the first census did not cover", () => {
  it("the members page ROLE_OPTIONS offers every role, exactly once (values, not labels)", () => {
    const src = read("app/(protected)/admin/users/page.tsx");
    const block = between(src, "const ROLE_OPTIONS:", "];");
    const values = [...block.matchAll(/value:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(values)).toEqual(new Set(ALL_ROLES));
    expect(values.length).toBe(ALL_ROLES.length);
  });

  it("the library wizard ROLE_GROUPS covers every role, exactly once (DraftingSupervisor was missing)", () => {
    const src = read("app/(protected)/admin/libraries/LibraryWizard.tsx");
    const block = between(src, "const ROLE_GROUPS = [", "];");
    const roles = [...block.matchAll(/roles:\s*\[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    expect(new Set(roles)).toEqual(new Set(ALL_ROLES));
    expect(roles.length).toBe(ALL_ROLES.length);
  });
});

// ROLE-4: the add-role picker shows the WHOLE roster. `addableRoles` (the
// "never an empty add" guardrail) hid every role that added no capability —
// once a member held anything granting create_requests, all seven of
// Requester / the five department labels / Contractor vanished, and one
// Engineer tier hid the other three, with no explanation. The picker now
// renders `pickerRoster`: three labelled groups whose union is exactly the
// roster minus what is held, every hidden-before role carrying its reason.
describe("the add-role picker offers the whole roster, grouped and explained (ROLE-4)", () => {
  it("for every single-role collection the three groups partition ALL_ROLES minus the held role", () => {
    for (const held of ALL_ROLES) {
      const r = pickerRoster([held]);
      const all = [...r.adds, ...r.addsNothing, ...r.dormant];
      expect(new Set(all).size).toBe(all.length);
      expect(new Set(all)).toEqual(new Set(ALL_ROLES.filter((x) => x !== held)));
      expect(r.dormant).toEqual(DORMANT_ROLES.filter((x) => x !== held));
      for (const x of r.adds) { expect(isDormantRole(x)).toBe(false); expect(capabilitiesAdded(x, [held]).length).toBeGreaterThan(0); }
      for (const x of r.addsNothing) { expect(isDormantRole(x)).toBe(false); expect(capabilitiesAdded(x, [held])).toEqual([]); }
      // the guardrail's answer survives inside the first group
      expect(r.adds).toEqual(addableRoles([held]).filter((x) => !isDormantRole(x)));
    }
    expect(pickerRoster([...ALL_ROLES])).toEqual({ adds: [], addsNothing: [], dormant: [] });
  });
  it("a Drafter is offered the seven that used to vanish, each with its reason; a second Engineer tier says it is a label", () => {
    const r = pickerRoster(["Drafter"]);
    for (const x of ["Requester", "Contractor", "Viewer"] as Role[]) expect(r.addsNothing).toContain(x);
    expect(r.adds).toContain("Auditor"); // adds `audit` over a Drafter — offered, and still explained as a restriction
    for (const x of DORMANT_ROLES) expect(r.dormant).toContain(x);
    expect(pickerNote("Viewer", ["Drafter"])).toBe(READ_ONLY_ROLE_NOTE);
    expect(pickerNote("Auditor", ["Drafter"])).toBe(READ_ONLY_ROLE_NOTE);
    expect(pickerNote("Contractor", ["Drafter"])).toBe(CONTRACTOR_ROLE_NOTE);
    expect(pickerNote("Safety", ["Drafter"])).toMatch(/Use a team instead/);
    expect(pickerNote("Engineer-2", ["Engineer-1"])).toMatch(/tiers are labels/);
    expect(pickerNote("DocCtrl", ["Drafter"])).toBeNull(); // adds something, needs no excuse
    expect(pickerNote("Supervisor", ["Admin"])).toMatch(/Adds nothing this member doesn't already have/);
  });
  it("the members page renders the three groups from pickerRoster (source pin)", () => {
    const src = read("app/(protected)/admin/users/page.tsx");
    expect(src).toContain("const roster = pickerRoster(current);");
    expect(src).toContain("{ title: 'Roles that add new access', hint: null, roles: roster.adds, dim: false },");
    expect(src).toContain("roles: roster.addsNothing, dim: false },");
    expect(src).toContain("{ title: 'Dormant department labels', hint: DORMANT_ROLE_NOTE, roles: roster.dormant, dim: true },");
    expect(src).toContain("const note = pickerNote(r, current) ?? roleDisplayNote(r);");
    expect(src).not.toMatch(/const options = addableRoles\(current\);/);
  });
});

function between(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  if (a < 0) throw new Error(`anchor not found: ${from}`);
  const b = text.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`end not found after ${from}: ${to}`);
  return text.slice(a, b);
}
