// lib/membershipSelection.ts
//
// Deterministic choice among a person's active memberships (audit finding
// ORGSEL-1). The workspace self-heal used `LIMIT 1` with no ORDER BY — which
// returns whichever row the executor reaches first, a function of the query
// plan and heap layout — and then persisted that accident as the new default
// workspace. A member of several orgs could land somewhere different on each
// sign-in.
//
// The rule, chosen deliberately: highest-ranked role first (when in doubt,
// land the person where they are MOST capable, never least — an Admin
// stranded in a workspace where they are a Viewer reads as a permissions
// loss), then oldest membership, then org id as a final total-order
// tiebreak so the same inputs always produce the same answer.

import type { Role } from "@/types/schema";
import { normalizeRoles, primaryRole, roleRank } from "@/lib/roleCapabilities";

export type MembershipPick = {
  /** The chosen raw org_members row. */
  row: Record<string, unknown>;
  orgId: string;
  /** How many rows were in the running. >1 means a CHOICE was made among
   *  several workspaces — the caller must not silently persist it as the
   *  new default, and should tell the user where they landed (ORGSEL-4). */
  candidateCount: number;
};

function rankOf(row: Record<string, unknown>): number {
  const collection = normalizeRoles(row.roles, row.role as Role | undefined);
  return roleRank(primaryRole(collection));
}

function createdAtOf(row: Record<string, unknown>): number {
  const raw = row.created_at;
  if (typeof raw !== "string") return Number.POSITIVE_INFINITY; // unknown age sorts last
  const t = Date.parse(raw);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** Pick the best membership deterministically. Returns null when `rows` is
 *  empty. Rows without an org_id are ignored (they cannot become a
 *  workspace). */
export function pickBestMembership(rows: Array<Record<string, unknown>>): MembershipPick | null {
  const candidates = rows.filter((r) => typeof r.org_id === "string" && r.org_id);
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const byRank = rankOf(b) - rankOf(a);
    if (byRank !== 0) return byRank;
    const byAge = createdAtOf(a) - createdAtOf(b);
    if (byAge !== 0) return byAge;
    return String(a.org_id).localeCompare(String(b.org_id));
  });
  const row = sorted[0];
  return { row, orgId: row.org_id as string, candidateCount: candidates.length };
}
