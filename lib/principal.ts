// lib/principal.ts
//
// The ONE place the app resolves "who is acting" into a full Principal for
// authority decisions: the headline role, the ADDITIVE role collection, and
// team memberships — read from the same rows the database evaluators read
// (org_members.role/roles, team_members). OWN-3 / OWN-6 / CHAIN-1: before
// this, every mutator built `{ uid, role }` from a caller-supplied headline,
// so an additively-held DocCtrl was not a controller, a team publish grant
// the database honored was refused by the app, and a restriction on an
// additively-held role stopped matching.
//
// Fail-SAFE, never fail-open: if the membership read errors, the principal
// falls back to exactly what the caller supplied (headline only, no teams) —
// authority can only be what it was before, never wider on a hiccup.

import { supabase } from "@/lib/supabase";
import { getMyTeamIds } from "@/lib/teams";
import { normalizeRoles } from "@/lib/roleCapabilities";
import type { Principal } from "@/lib/permissions";
import type { Role } from "@/types/schema";

export async function resolveActorPrincipal(input: {
  uid: string;
  orgId?: string;
  /** The caller's notion of the headline role — used verbatim when the
   *  membership row cannot be read. */
  headlineRole?: string | null;
}): Promise<Principal> {
  const fallback: Principal = {
    uid: input.uid,
    role: ((input.headlineRole ?? "Viewer") as Role),
    orgId: input.orgId,
  };
  if (!input.uid) return fallback;
  try {
    const [memberRes, teamIds] = await Promise.all([
      input.orgId
        ? supabase
            .from("org_members")
            .select("role, roles")
            .eq("org_id", input.orgId)
            .eq("uid", input.uid)
            .eq("status", "active")
            .maybeSingle()
        : Promise.resolve({ data: null, error: null } as { data: null; error: null }),
      getMyTeamIds(input.uid),
    ]);
    if (memberRes.error || !memberRes.data) {
      // Unknown membership: keep the caller's headline, still carry teams
      // (team grants are additive and evaluated against the ACL, so this
      // cannot widen beyond what the database itself grants).
      return { ...fallback, teamIds };
    }
    const row = memberRes.data as { role?: string | null; roles?: unknown };
    const roles = normalizeRoles(row.roles, row.role ?? input.headlineRole);
    return {
      uid: input.uid,
      role: ((row.role as Role | null | undefined) ?? fallback.role),
      roles,
      orgId: input.orgId,
      teamIds,
      isActiveMember: true,
    };
  } catch {
    return fallback;
  }
}
