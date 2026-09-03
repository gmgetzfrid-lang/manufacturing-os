// lib/roleHeld.ts
//
// ADD-1 / ADD-3: a member's authority is the role COLLECTION (`org_members.roles`),
// never the headline (`org_members.role`) alone — the headline is the highest-
// ranked role, so consulting it alone SUBTRACTS authority from anyone holding an
// additive role. These helpers are the one place server routes and pool
// resolvers ask "does this member hold any of these roles?" and the one place
// the PostgREST filter for "members holding any of these roles" is spelled.
// Pure — no imports — so both server routes and client modules can use it.

/** Every role the member holds: the headline plus the additive collection,
 *  de-duplicated, blanks dropped. */
export function heldRoles(member: { role?: unknown; roles?: unknown } | null | undefined): string[] {
  if (!member) return [];
  const out = new Set<string>();
  const head = typeof member.role === "string" ? member.role.trim() : "";
  if (head) out.add(head);
  if (Array.isArray(member.roles)) {
    for (const r of member.roles) if (typeof r === "string" && r.trim()) out.add(r.trim());
  }
  return [...out];
}

/** True when the member holds ANY of `allowed` — headline or additive. */
export function memberHoldsAny(
  member: { role?: unknown; roles?: unknown } | null | undefined,
  allowed: readonly string[],
): boolean {
  const held = heldRoles(member);
  return allowed.some((a) => held.includes(a));
}

/** The PostgREST `.or(...)` filter for "active members holding any of these
 *  roles": the headline column OR the collection overlaps. Values are quoted
 *  so role names with a hyphen (`Engineer-1`) survive both list syntaxes.
 *  Usage: `.or(roleFilter(["Admin", "DocCtrl"]))`. */
export function roleFilter(roles: readonly string[]): string {
  const q = [...new Set(roles.map((r) => r.trim()).filter(Boolean))]
    .map((r) => `"${r.replace(/"/g, "")}"`);
  if (q.length === 0) return "role.in.()";
  return `role.in.(${q.join(",")}),roles.ov.{${q.join(",")}}`;
}
