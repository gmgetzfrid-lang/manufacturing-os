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
import { ALL_ROLES } from "@/types/schema";

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
