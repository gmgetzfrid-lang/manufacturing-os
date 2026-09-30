// lib/downloadDeny.ts — SERVER-ONLY. The explicit ACL "deny download" rule,
// in one place.
//
// A download deny names users, roles or teams under
// acl_index.deny.{users,roles,teams}.download. acl_index is chain-resolved
// (library → folder lineage → document), so a deny set on an ancestor is
// already on the document's own index. Two surfaces enforce it:
//
//   * /api/storage/download-url — against the signed-in MEMBER asking for a
//     URL ("URL issuance is the enforcement point for bytes"). It carried the
//     rule inline until this module; the evaluation is unchanged.
//   * lib/shareServe.ts (both public share routes) — against the share's
//     CREATOR, so a link never lets out a copy its creator may not download
//     (public-surfaces SHR-3, criterion 3).
//
// There is no SQL twin. The database decides visibility (node_visible) and
// publish authority, never download, so the share INSERT policy (20261080)
// does not refuse a mint by a creator who is denied download: that row is
// inserted and can never serve. Public-surfaces SHR-14 records the remainder.

import type { supabase } from "@/lib/supabase";
import { normalizeRoles } from "@/lib/roleCapabilities";

/** Any client with `.from()` — the route's supabaseAdmin, the share routes' service-role client. */
export type DownloadDenyClient = Pick<typeof supabase, "from">;

type DenyBucket = Record<string, string[] | undefined>;

/** The slice of acl_index this rule reads (tolerant of a null / partial index). */
export type DownloadDenyIndex = {
  deny?: { users?: DenyBucket; roles?: DenyBucket; teams?: DenyBucket } | null;
} | null | undefined;

/** Does this index carry any download deny at all? No I/O is needed when it does not. */
export function downloadDenyPresent(idx: DownloadDenyIndex): boolean {
  const dl = idx?.deny;
  return !!dl && (
    (dl.users?.download?.length ?? 0) > 0
    || (dl.roles?.download?.length ?? 0) > 0
    || (dl.teams?.download?.length ?? 0) > 0
  );
}

/** Pure: does a download deny on this index name this principal — by uid, by
 *  ANY role in the collection (CHAIN-1: a restriction binds whether or not a
 *  higher role sits above it), or by any team? Controllers are not exempt:
 *  the member route never exempted them. */
export function downloadDeniedTo(
  idx: DownloadDenyIndex,
  who: { uid: string; roles: readonly string[]; teamIds: readonly string[] },
): boolean {
  const dl = idx?.deny;
  if (!dl) return false;
  return (dl.users?.download ?? []).includes(who.uid)
    || who.roles.some((r) => (dl.roles?.download ?? []).includes(r))
    || who.teamIds.some((t) => (dl.teams?.download ?? []).includes(t));
}

/** Is this member denied download under this index? Reads the member's role
 *  collection (active membership of `orgId`) and teams only when the index
 *  carries a download deny. `unreadable` reports a read error — the caller
 *  decides: the member route keeps its fail-open posture (the evaluation
 *  runs on what was read, a missing role set reading as Viewer, exactly as
 *  before), the share routes refuse. */
export async function memberDownloadDenied(
  sb: DownloadDenyClient,
  input: { orgId: string; uid: string; aclIndex: DownloadDenyIndex },
): Promise<{ denied: boolean; unreadable: boolean }> {
  if (!downloadDenyPresent(input.aclIndex)) return { denied: false, unreadable: false };
  const [{ data: mem, error: memError }, { data: teams, error: teamError }] = await Promise.all([
    sb.from("org_members").select("role, roles").eq("org_id", input.orgId).eq("uid", input.uid).eq("status", "active").maybeSingle(),
    sb.from("team_members").select("team_id").eq("uid", input.uid),
  ]);
  // `??` only caught null: a row with roles: [] dropped the headline and every
  // role-based download deny stopped matching. normalizeRoles seeds from the
  // headline unconditionally.
  const roles: string[] = normalizeRoles(mem?.roles, mem?.role);
  if (roles.length === 0) roles.push("Viewer");
  const teamIds = ((teams ?? []) as Array<{ team_id: unknown }>).map((t) => t.team_id as string);
  return {
    denied: downloadDeniedTo(input.aclIndex, { uid: input.uid, roles, teamIds }),
    unreadable: !!(memError || teamError),
  };
}
