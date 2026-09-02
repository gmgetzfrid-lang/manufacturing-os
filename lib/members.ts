// lib/members.ts
//
// Member revocation — SURF-1 / DEC-20 with GAP-5 succession. ONE entry point
// for suspend / restore / remove: the `revoke_member` RPC does the authority
// check, the status write or delete (the last-admin trigger fires inside it),
// and on REMOVE the succession sweep (ownership, team supervision, open
// checkouts, per-person grants, rosters) with one audit row per cleared
// scope. This helper surfaces refusals as errors (never a disappearing row)
// and tells the controllers what just became unowned.

import { supabase } from "@/lib/supabase";
import { notify } from "@/lib/inAppNotifications";
import { getOrgControllers } from "@/lib/ownership";

export type RevokeMode = "suspend" | "restore" | "remove";

export interface ClearedNode { id: string; name: string | null; libraryId?: string | null }
export interface RevokeResult {
  mode: RevokeMode;
  uid: string;
  cleared?: { libraries: ClearedNode[]; collections: ClearedNode[]; documents: ClearedNode[]; teams: ClearedNode[] };
  endedCheckouts?: number;
  revokedGrants?: number;
}

export async function revokeMember(input: {
  memberId: string;
  mode: RevokeMode;
  orgId: string;
  actorUserId: string;
  actorName?: string | null;
  memberLabel?: string | null;
}): Promise<RevokeResult> {
  const { data, error } = await supabase.rpc("revoke_member", { p_member_id: input.memberId, p_mode: input.mode });
  if (error) throw new Error(error.message);
  const result = (data ?? null) as RevokeResult | null;
  if (!result || result.mode !== input.mode) {
    throw new Error("The change was not confirmed by the database — nothing was changed.");
  }

  // GAP-5: never reassign silently — clear, audit (the RPC did), and NOTIFY
  // the controllers with the list of what just became unowned.
  if (input.mode === "remove" && result.cleared) {
    const c = result.cleared;
    const total = c.libraries.length + c.collections.length + c.documents.length + c.teams.length;
    if (total > 0) {
      const who = input.memberLabel || "A removed member";
      const parts = [
        c.libraries.length ? `${c.libraries.length} librar${c.libraries.length === 1 ? "y" : "ies"} (${c.libraries.map((n) => n.name).filter(Boolean).slice(0, 5).join(", ")}${c.libraries.length > 5 ? ", …" : ""})` : null,
        c.collections.length ? `${c.collections.length} folder${c.collections.length === 1 ? "" : "s"}` : null,
        c.documents.length ? `${c.documents.length} document${c.documents.length === 1 ? "" : "s"}` : null,
        c.teams.length ? `${c.teams.length} team${c.teams.length === 1 ? "" : "s"} lost their supervisor` : null,
      ].filter(Boolean).join("; ");
      const controllers = (await getOrgControllers(input.orgId)).filter((u) => u !== input.actorUserId);
      await Promise.all(controllers.map((uid) => notify({
        orgId: input.orgId, userId: uid, kind: "member_revoked",
        title: `${who} was removed — ${total} item${total === 1 ? "" : "s"} now unowned`,
        body: `Ownership was cleared, not reassigned: ${parts}. Assign new owners from the register.`,
        link: "/register?filter=unowned",
        actorUserId: input.actorUserId, actorName: input.actorName ?? undefined,
        metadata: { cleared: c, endedCheckouts: result.endedCheckouts ?? 0, revokedGrants: result.revokedGrants ?? 0 },
      })));
    }
  }
  return result;
}
