// lib/restoreMembership.ts
//
// notifications NEDGE-16 (admin-and-org Round G, P8): a restore links each
// backup person to a member here by email, or creates a placeholder with
// status "inactive" (/api/admin/restore/begin). Since NEDGE-3 every
// notification reaches only ACTIVE members, and since 20261161 a member
// reads their bell only while active — so until an Admin reactivates them,
// the restored people hear nothing and their bells read empty. The restore
// now ENDS with an explicit membership check: how many members are active,
// how many are not (and so receive nothing), and that the workspace still has
// an active Admin (the restoring Admin is one: the restore surface admits
// only an active Admin, and nothing in the restore changes an existing
// member's status). The check is shown on the restore page and written to
// the audit log (RESTORE_MEMBERSHIP_CHECK).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RestorePost } from "@/lib/dataRestore";

export interface RestoreMembershipSummary {
  activeMembers: number;
  /** Members whose status is not "active" (restored placeholders are
   *  "inactive"; suspended members too) — they receive no notifications. */
  inactiveMembers: number;
  activeAdmins: number;
  /** Whether the restoring Admin is still an active member. */
  actorActive: boolean;
}

export type RestoreMembershipRead = { ok: true; summary: RestoreMembershipSummary } | { ok: false; error: string };

/** Server side: the counts, read as the service client. Checked. */
export async function readRestoreMembership(sb: SupabaseClient, orgId: string, actorUid: string): Promise<RestoreMembershipRead> {
  const rows: Array<{ uid: string; status: string | null; role: string | null; roles: string[] | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("org_members").select("uid, status, role, roles").eq("org_id", orgId).range(from, from + 999);
    if (error) return { ok: false, error: error.message ?? "the member list could not be read" };
    const batch = (data ?? []) as typeof rows;
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  const active = rows.filter((m) => m.status === "active");
  const isAdmin = (m: (typeof rows)[number]) => m.role === "Admin" || (Array.isArray(m.roles) && m.roles.includes("Admin"));
  return {
    ok: true,
    summary: {
      activeMembers: active.length,
      inactiveMembers: rows.length - active.length,
      activeAdmins: active.filter(isAdmin).length,
      actorActive: active.some((m) => m.uid === actorUid),
    },
  };
}

export type RestoreMembershipCheck =
  | { ok: true; summary: RestoreMembershipSummary; auditError: string | null }
  | { ok: false; error: string };

/** Client side: the restore's completion step. Never throws. The page runs
 *  it through withRestoreMembershipCheck, so it runs whether the restore
 *  finished, stopped at a table, or threw. */
export async function completeRestoreMembership(orgId: string, post: RestorePost): Promise<RestoreMembershipCheck> {
  try {
    const res = await post(`/api/admin/restore/complete?orgId=${encodeURIComponent(orgId)}`, {});
    const body = res.body ?? {};
    if (!res.ok || !body.summary) {
      const auditNote = typeof body.auditError === "string" ? ` The membership check could not be written to the audit log: ${body.auditError}` : "";
      return { ok: false, error: `${String(body.error ?? `HTTP ${res.status}`)}${auditNote}` };
    }
    return { ok: true, summary: body.summary as RestoreMembershipSummary, auditError: typeof body.auditError === "string" ? body.auditError : null };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

/** NEDGE-16 (fix pass): runs the restore and ends with the membership check
 *  once the run has STARTED — whether it returns or throws. A /begin that
 *  stops part-way (a refused placeholder, or a response lost on the way
 *  back) keeps the inactive placeholders it already created, which is
 *  exactly when the operator must be told. The check is handed to onCheck
 *  before the run's result is returned or its error is rethrown. */
export async function withRestoreMembershipCheck<T>(
  orgId: string,
  post: RestorePost,
  run: () => Promise<T>,
  onCheck: (check: RestoreMembershipCheck) => void,
): Promise<T> {
  try {
    return await run();
  } finally {
    onCheck(await completeRestoreMembership(orgId, post));
  }
}

/** The sentence the restore page shows (and the test reads). */
export function restoreMembershipSentence(s: RestoreMembershipSummary): string {
  if (s.inactiveMembers === 0) return `All ${s.activeMembers} member(s) of this workspace are active.`;
  return `${s.inactiveMembers} member(s) of this workspace are not active — restored people are created inactive — and will receive no notifications, and cannot read their notification bell, until an Admin reactivates them (Admin → Users → Restore). ${s.activeMembers} member(s) are active, ${s.activeAdmins} of them Admin.`;
}
