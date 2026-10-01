// POST /api/admin/restore/begin?orgId=
// Body: { manifest: { orgId, orgName? }, orgMembers: rows[], orgNameChoice? }
//
// Step 1 of the CHUNKED restore (the path that scales past serverless body
// limits — a real org's envelope JSON is tens of MB, far over the ~4.5MB
// request cap that broke the single-shot apply). This call carries ONLY the
// backup's membership list:
//   • links backup members to current members by email — members of any
//     status, so a placeholder an earlier run created is linked again,
//   • creates inactive "restored" placeholders for unknown emails
//     (idempotent — an email that already exists is linked, not duplicated),
//     and maps EVERY backup uid of that address to it (fix pass 5: one
//     address may hold several backup rows, each under its own uid),
//   • lists backup members with no email address that no member here holds
//     the uid of (idRemap.unmappedUids) — rows naming one are refused,
//   • applies the org-name choice,
// and returns the full old→new uid map + org map. The client then streams
// tables through /api/admin/restore/apply-table in FK order.
//
// Fail closed (admin-and-org P1, fix pass 4): the workspace reads are
// checked — an unread member list would plan every backup person as new and
// remap active members' uids to dead placeholders — and so are the rename
// and every placeholder insert. A person whose placeholder cannot be made
// would leave their backup uid unmapped, and their rows would land naming
// it, so /begin answers 500 naming the address before any table is written;
// a re-run links the placeholders already made.
//
// Admin-only, same as apply.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { planRestore, mergeNewUserUids, placeholderProfile, type CurrentMember, RESTORE_LINK_MEMBER_STATUSES, restoredMemberRoles, restoredMemberHeadline } from "@/lib/dataRestore";

export const runtime = "nodejs";

const RESTORE_ROLES = ["Admin"];

export async function POST(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeOrgRole(req, orgId, RESTORE_ROLES);
  if ("error" in actor) return NextResponse.json({ error: actor.error }, { status: actor.status });
  const sb = actor.admin;

  let parsed: {
    manifest?: { orgId?: string; orgName?: string };
    orgMembers?: Array<Record<string, unknown>>;
    orgNameChoice?: "backup" | "current";
  };
  try { parsed = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!parsed.manifest?.orgId) {
    return NextResponse.json({ error: "Not a recognizable backup: missing manifest.orgId." }, { status: 400 });
  }
  const members = Array.isArray(parsed.orgMembers) ? parsed.orgMembers : [];
  if (members.length > 20_000) {
    return NextResponse.json({ error: "org_members list is implausibly large." }, { status: 413 });
  }

  // Current context → plan (reusing the pure planner for the user reconciliation).
  const { data: orgRow, error: orgReadErr } = await sb.from("orgs").select("name").eq("id", orgId).maybeSingle();
  const orgName = (orgRow as { name?: string } | null)?.name ?? "";
  // Fix pass 3: every membership status links by email — a re-run finds the
  // placeholder an earlier run created instead of minting a second one under
  // a new uid (which would land every uid-keyed row again).
  const { data: memberRows, error: memberReadErr } = await sb.from("org_members").select("uid, email, status").eq("org_id", orgId).in("status", [...RESTORE_LINK_MEMBER_STATUSES]);
  // Fix pass 4: checked before anything is written — planned against an
  // unread list, every backup person (active members included) would get a
  // placeholder and every uid would be remapped to a dead one.
  const readErr = memberReadErr ? { what: "members", e: memberReadErr } : orgReadErr ? { what: "name", e: orgReadErr } : null;
  if (readErr) {
    return NextResponse.json({ error: `Could not read this workspace's ${readErr.what} (${readErr.e.message}) — nothing was written.` }, { status: 500 });
  }
  const current: CurrentMember[] = ((memberRows as Array<{ uid: string; email: string | null; status: string | null }> | null) ?? [])
    .map((m) => ({ uid: m.uid, email: m.email, status: m.status })); // fix pass 5: a member with no address links by uid
  const plan = planRestore(
    { manifest: { orgId: parsed.manifest.orgId, orgName: parsed.manifest.orgName }, tables: { org_members: members } },
    { orgId, orgName, members: current },
  );

  // Org-name choice — checked (fix pass 4): the audit row says whether it applied.
  let orgNameApplied = false;
  if (plan.orgNameCollision && parsed.orgNameChoice === "backup") {
    const { error: renameErr } = await sb.from("orgs").update({ name: plan.orgNameCollision.backupName }).eq("id", orgId);
    if (renameErr) {
      return NextResponse.json({ error: `Could not apply the backup's workspace name (${renameErr.message}) — nothing was written.` }, { status: 500 });
    }
    orgNameApplied = true;
  }

  // Restored placeholders for unknown emails (inactive — no seat, no auth).
  const created: Record<string, string> = {};
  let createdUsers = 0;
  let placeholdersWithoutProfile = 0;
  let placeholderFailed: { email: string; message: string } | null = null;
  for (const u of plan.users.filter((x) => x.disposition === "new" && x.oldUid)) {
    const newUid = globalThis.crypto?.randomUUID?.() || `restored-${u.oldUid}`;
    const { error } = await sb.from("org_members").insert({
      // SURF-8: never mint a privileged row from a backup; the role collection
      // is seeded too (ADD-5) so the placeholder is not born with roles = {}.
      org_id: orgId, uid: newUid, email: u.email, role: restoredMemberHeadline(restoredMemberRoles(u.role, u.roles)), roles: restoredMemberRoles(u.role, u.roles),
      status: "inactive", display_name: u.displayName ?? null,
    });
    // Fix pass 4: a person with no placeholder would keep their backup uid,
    // and every row naming them would land naming it. Stop here — no table
    // has been written; a re-run links the placeholders already made.
    if (error) { placeholderFailed = { email: u.email, message: error.message }; break; }
    // admin-and-org P1 (fix pass 2): a profile row exists only for a sign-in
    // account (users.id references auth.users), so the database refuses it
    // for a placeholder. Counted and reported, never swallowed: rows that
    // must name a profile (a team membership) cannot name this person until
    // they accept an invitation — the restore clears or refuses them.
    if (!(await placeholderProfile(sb, newUid, u.email, u.displayName))) placeholdersWithoutProfile++;
    created[u.oldUid] = newUid;
    // Fix pass 5: the backup's other rows for this address name the same person.
    for (const alias of u.aliasUids ?? []) created[alias] = newUid;
    createdUsers++;
  }
  const idRemap = mergeNewUserUids(plan.idRemap, created);

  // XEDGE-3 done-when 2: the chunked restore's FIRST step leaves a trail too —
  // which backup, whose org name won, how many members were linked or minted.
  // Checked write, and audit_logs is itself an IMMUTABLE_TABLES entry the
  // restore refuses to import, so the trail cannot be overwritten by the
  // restore it records.
  const { error: auditErr } = await sb.from("audit_logs").insert({
    action: "RESTORE_BEGIN", resource_type: "org", resource_id: orgId, org_id: orgId,
    user_id: actor.userId, user_email: actor.email,
    details: {
      backupOrgId: parsed.manifest.orgId,
      backupOrgName: parsed.manifest.orgName ?? null,
      orgNameChoice: parsed.orgNameChoice ?? null,
      orgNameApplied,
      membersInBackup: members.length,
      linkedUsers: plan.counts.matchedUsers,
      createdUsers,
      placeholdersWithoutProfile,
      unmappedMembers: plan.counts.unmappedUsers,
      ...(placeholderFailed ? { failed: `placeholder for ${placeholderFailed.email}: ${placeholderFailed.message}` } : {}),
    },
  });
  if (placeholderFailed) {
    return NextResponse.json(
      {
        error:
          `Could not create the restored placeholder for ${placeholderFailed.email} (${placeholderFailed.message}). No table was written. ` +
          `${createdUsers} placeholder(s) made before it${orgNameApplied ? " and the backup's workspace name" : ""} are kept — a re-run links them, never duplicates them.` +
          (auditErr ? ` (And the restore audit row failed: ${auditErr.message}.)` : ""),
        createdUsers,
      },
      { status: 500 },
    );
  }
  if (auditErr) {
    return NextResponse.json(
      { error: `Restore placeholders were created but the restore audit row failed: ${auditErr.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    idRemap,
    createdUsers,
    linkedUsers: plan.counts.matchedUsers,
    placeholdersWithoutProfile,
    unmappedMembers: plan.counts.unmappedUsers,
    warnings: [
      ...plan.warnings,
      ...(placeholdersWithoutProfile > 0
        ? [`${placeholdersWithoutProfile} restored placeholder(s) have no sign-in account yet — a team membership naming one cannot be restored, and a team creator / adder naming one is cleared.`]
        : []),
    ],
  });
}
