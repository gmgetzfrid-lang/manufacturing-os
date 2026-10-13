// POST /api/admin/restore/complete?orgId=
//
// notifications NEDGE-16 (admin-and-org Round G, P8): the chunked restore's
// completion step. After /begin and every /apply-table call, the restore page
// asks for the workspace's membership state and shows it: how many members
// are not active (restored placeholders are created "inactive") and so will
// receive no notifications until an Admin reactivates them, and that an
// active Admin remains. The same numbers are written to the audit log
// (RESTORE_MEMBERSHIP_CHECK), checked — a refused audit row is returned, not
// swallowed. A workspace with no active Admin is refused (409), never
// reported as fine; the restoring Admin is one (this route admits only an
// active Admin), so that answer means something outside the restore changed
// the membership. Admin-only, same as /begin.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { readRestoreMembership } from "@/lib/restoreMembership";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeAdminSurface(req, orgId, "restore", "write");
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });

  const read = await readRestoreMembership(actor.admin, orgId, actor.userId);
  if (!read.ok) {
    return NextResponse.json({ error: `Couldn't read this workspace's members after the restore (${read.error}). Check Admin → Users: restored people are created inactive.` }, { status: 500 });
  }
  const s = read.summary;
  const { error: auditErr } = await actor.admin.from("audit_logs").insert({
    action: "RESTORE_MEMBERSHIP_CHECK", resource_type: "org", resource_id: orgId, org_id: orgId,
    user_id: actor.userId, user_email: actor.email || null, user_role: actor.admittedRole,
    details: { ...s, receiveNoNotifications: s.inactiveMembers },
  });
  if (s.activeAdmins === 0) {
    return NextResponse.json({ error: "This workspace has no active Admin after the restore. Nothing was changed by this check; reactivate an Admin before anyone relies on notifications.", summary: s }, { status: 409 });
  }
  return NextResponse.json({ ok: true, summary: s, ...(auditErr ? { auditError: auditErr.message } : {}) });
}
